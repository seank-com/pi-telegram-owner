import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GroupJournal } from "../src/group-journal.ts";
import { importTelegramGroupExport, ImportValidationError } from "../src/importer.ts";

const GROUP = -1001234567890;
const journalOptions = { bootIdentity: () => ({ id: "synthetic-boot", startedAtMs: 1 }), pidState: (pid: number) => (pid === process.pid ? "alive" as const : "dead" as const) };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const PAGE = `<!DOCTYPE html><html><body><div class="history">
<div class="message service" id="message-1"><div class="body details">Group created</div></div>
<div class="message default clearfix" id="message100"><div class="body"><div class="pull_right date details" title="20.09.2026 10:00:00 UTC+00:00"></div><div class="from_name">Example Owner</div><div class="text">Can anyone look at this?</div></div></div>
<div class="message default clearfix" id="message101"><div class="body"><div class="pull_right date details" title="20.09.2026 10:01:00 UTC+00:00"></div><div class="from_name">Agent A</div><div class="reply_to details"><a href="#go_to_message100" onclick="return GoToMessage(100)">reply</a></div><div class="text">I will.<br>Starting now.</div></div></div>
<div class="message default clearfix joined" id="message102"><div class="body"><div class="pull_right date details" title="20.09.2026 10:02:00 UTC+00:00"></div><div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/photo_1.png"><img class="photo" src="photos/photo_1_thumb.png" style="width: 1px; height: 1px"/></a></div></div></div>
<div class="message default clearfix" id="message103"><div class="body"><div class="pull_right date details" title="20.09.2026 10:03:00 UTC+00:00"></div><div class="from_name">Example Owner</div><div class="media_wrap clearfix"><a class="media clearfix pull_left block_link media_file" href="files/report.json"><div class="fill pull_left"></div><div class="body"><div class="title bold">report.json</div><div class="status details">1 KB</div></div></a></div><div class="text">See attached</div></div></div>
</div></body></html>`;

async function fixture(t: test.TestContext, page = PAGE) {
	const base = await mkdtemp(join(tmpdir(), "group-import-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const exportRoot = join(base, "export");
	const control = join(base, "control");
	const sharedRoot = join(base, "shared");
	await mkdir(join(exportRoot, "photos"), { recursive: true });
	await mkdir(control, { mode: 0o700 });
	await writeFile(join(exportRoot, "messages.html"), page);
	await writeFile(join(exportRoot, "photos", "photo_1.png"), PNG);
	const sourceSetManifestPath = join(control, "source.json");
	const speakerMapPath = join(control, "speakers.json");
	await writeFile(sourceSetManifestPath, JSON.stringify({ schema: "pi-telegram-owner/source-set/v1", sourceSetId: "group-export", pages: [{ path: "messages.html", size: Buffer.byteLength(page), sha256: sha(page) }], messageCount: 4 }), { mode: 0o600 });
	await writeFile(speakerMapPath, JSON.stringify({ schema: "pi-telegram-owner/group-speaker-map/v1", speakers: { [sha("Example Owner")]: { kind: "owner", userId: 7, name: "Owner" }, [sha("Agent A")]: { kind: "agent", userId: 201, name: "Agent A" } } }), { mode: 0o600 });
	return { exportRoot, sourceSetManifestPath, speakerMapPath, sharedRoot, chatId: GROUP, journalOptions };
}

test("a group export restores only messages missing from the shared journal, after a dry run", async (t) => {
	const options = await fixture(t);
	const journal = new GroupJournal(options.sharedRoot, journalOptions);
	await journal.recordMessage({ chatId: GROUP, messageId: 100, senderId: 7, sender: "Owner", senderKind: "owner", date: 1_789_898_400, text: "Can anyone look at this? (live)", entities: [] }, "agent_a_bot");

	const dryRun = await importTelegramGroupExport(options);
	assert.deepEqual(dryRun, { schema: "pi-telegram-owner/group-import-report/v1", mode: "dry-run", messages: 4, alreadyPresent: 1, imported: 3, photos: 1 });
	assert.equal((await journal.events()).length, 1, "a dry run writes nothing");

	const committed = await importTelegramGroupExport({ ...options, commit: true });
	assert.equal(committed.imported, 3);
	const timeline = await journal.timeline({ chatId: GROUP, limit: 10 });
	assert.deepEqual(timeline.map((message) => [message.messageId, message.senderKind, message.sender]), [[100, "owner", "Owner"], [101, "agent", "Agent A"], [102, "agent", "Agent A"], [103, "owner", "Owner"]]);
	assert.equal(timeline[0]!.text, "Can anyone look at this? (live)", "a live record is never overwritten");
	assert.equal(timeline[1]!.text, "I will.\nStarting now.");
	assert.equal(timeline[1]!.replyToMessageId, 100);
	assert.equal(timeline[1]!.date, 1_789_898_460);
	assert.deepEqual(timeline[3]!.media, { kind: "document", fileName: "report.json" });
	assert.equal(timeline[3]!.text, "See attached");
	const photo = timeline[2]!.media!;
	assert.equal(photo.kind, "photo");
	assert.deepEqual(await readFile(join(options.sharedRoot, photo.attachment!)), PNG);
	assert.equal((await journal.events()).filter((event) => event.kind === "conflict").length, 0);

	const repeated = await importTelegramGroupExport({ ...options, commit: true });
	assert.deepEqual([repeated.alreadyPresent, repeated.imported], [4, 0], "repeating an import is idempotent");
});

test("unknown senders and changed export pages fail without writing", async (t) => {
	const unknown = await fixture(t, PAGE.replace("Agent A", "Someone Else"));
	await assert.rejects(importTelegramGroupExport({ ...unknown, commit: true }), (error: Error) => error instanceof ImportValidationError && error.code === "DIRECTION_UNKNOWN");
	assert.equal((await new GroupJournal(unknown.sharedRoot, journalOptions).events()).length, 0);

	const changed = await fixture(t);
	await writeFile(join(changed.exportRoot, "messages.html"), `${PAGE} `);
	await assert.rejects(importTelegramGroupExport({ ...changed, commit: true }), (error: Error) => error instanceof ImportValidationError && error.code === "SOURCE_CHANGED");
});
