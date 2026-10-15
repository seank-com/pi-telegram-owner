import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GroupJournal } from "../src/group-journal.ts";
import { GROUP_IMPORT_PLACEHOLDER, importTelegramGroupExport, ImportValidationError, prepareTelegramGroupImport } from "../src/importer.ts";

const GROUP = -1001234567890;
const journalOptions = { bootIdentity: () => ({ id: "synthetic-boot", startedAtMs: 1 }), pidState: (pid: number) => (pid === process.pid ? "alive" as const : "dead" as const) };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const PAGE = `<!DOCTYPE html><html><body><div class="history">
<div class="message service" id="message-1"><div class="body details">Group created</div></div>
<div class="message default clearfix" id="message100"><div class="body"><div class="pull_right date details" title="20.09.2026 10:00:00 UTC+00:00"></div><div class="from_name">Example Owner</div><div class="text">Can anyone look at this?</div></div></div>
<div class="message default clearfix" id="message101"><div class="body"><div class="pull_right date details" title="20.09.2026 10:01:00 UTC+00:00"></div><div class="from_name">Agent A</div><div class="reply_to details"><a href="#go_to_message100" onclick="return GoToMessage(100)">reply</a></div><div class="text">I will.<br>Starting now.</div></div></div>
<div class="message default clearfix joined" id="message102"><div class="body"><div class="pull_right date details" title="20.09.2026 10:02:00 UTC+00:00"></div><div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/photo_1.png"><img class="photo" src="photos/photo_1_thumb.png" style="width: 1px; height: 1px"/></a></div></div></div>
</div></body></html>`;

const PAGE_2 = `<!DOCTYPE html><html><body><div class="history">
<div class="message default clearfix" id="message103"><div class="body"><div class="pull_right date details" title="20.09.2026 10:03:00 UTC+00:00"></div><div class="from_name">Example Owner</div><div class="media_wrap clearfix"><a class="media clearfix pull_left block_link media_file" href="files/report.json"><div class="fill pull_left"></div><div class="body"><div class="title bold">report.json</div><div class="status details">1 KB</div></div></a></div><div class="text">See attached</div></div></div>
</div></body></html>`;

async function exportFixture(t: test.TestContext) {
	const base = await mkdtemp(join(tmpdir(), "group-import-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const exportRoot = join(base, "ChatExport");
	await mkdir(join(exportRoot, "photos"), { recursive: true });
	await writeFile(join(exportRoot, "messages.html"), PAGE);
	await writeFile(join(exportRoot, "messages2.html"), PAGE_2);
	await writeFile(join(exportRoot, "photos", "photo_1.png"), PNG);
	return { base, exportRoot, controlDir: join(base, "ChatExport-import"), sharedRoot: join(base, "shared") };
}

async function fillSpeakers(controlDir: string, speakers: Record<string, { kind: string; userId: number }>): Promise<void> {
	const path = join(controlDir, "group-speakers.json");
	const map = JSON.parse(await readFile(path, "utf8"));
	Object.assign(map.speakers, speakers);
	await writeFile(path, JSON.stringify(map), { mode: 0o600 });
}

test("prepare writes a complete source manifest and a speaker map with placeholders next to the export", async (t) => {
	const { exportRoot, controlDir } = await exportFixture(t);
	const before = (await readdir(exportRoot)).sort();
	const report = await prepareTelegramGroupImport({ exportRoot });
	assert.deepEqual(report, { schema: "pi-telegram-owner/group-import-prepare/v1", controlDir, pages: 2, messages: 4, senders: ["Agent A", "Example Owner"], placeholders: ["Example Owner", "Agent A"] });
	assert.deepEqual((await readdir(exportRoot)).sort(), before, "the export itself is untouched");
	const source = JSON.parse(await readFile(join(controlDir, "source.json"), "utf8"));
	assert.deepEqual(source.pages.map((page: { path: string }) => page.path), ["messages.html", "messages2.html"]);
	assert.equal(source.messageCount, 4);
	const speakers = JSON.parse(await readFile(join(controlDir, "group-speakers.json"), "utf8"));
	assert.deepEqual(speakers.speakers["Agent A"], { kind: GROUP_IMPORT_PLACEHOLDER, userId: GROUP_IMPORT_PLACEHOLDER });
	assert.equal((await stat(join(controlDir, "group-speakers.json"))).mode & 0o777, 0o600);
	assert.equal((await stat(controlDir)).mode & 0o777, 0o700);
});

test("a dry run refuses while placeholders remain and names the senders to fill in", async (t) => {
	const { exportRoot, controlDir, sharedRoot } = await exportFixture(t);
	await prepareTelegramGroupImport({ exportRoot });
	await fillSpeakers(controlDir, { "Example Owner": { kind: "owner", userId: 7 } });
	await assert.rejects(importTelegramGroupExport({ exportRoot, chatId: GROUP, sharedRoot, journalOptions }), (error: Error) => error instanceof ImportValidationError && error.code === "MANIFEST_INCOMPLETE" && /Agent A/.test(error.message) && !/Example Owner/.test(error.message));
});

test("preparing again keeps filled entries and adds new senders as placeholders", async (t) => {
	const { exportRoot, controlDir } = await exportFixture(t);
	await prepareTelegramGroupImport({ exportRoot });
	await fillSpeakers(controlDir, { "Example Owner": { kind: "owner", userId: 7 } });
	await writeFile(join(exportRoot, "messages3.html"), PAGE_2.replace("message103", "message104").replace("Example Owner", "Agent B"));
	const report = await prepareTelegramGroupImport({ exportRoot });
	assert.deepEqual(report.placeholders, ["Agent A", "Agent B"]);
	const speakers = JSON.parse(await readFile(join(controlDir, "group-speakers.json"), "utf8")).speakers;
	assert.deepEqual(speakers["Example Owner"], { kind: "owner", userId: 7 });
});

test("a group export restores only messages missing from the shared journal, after a dry run", async (t) => {
	const { exportRoot, controlDir, sharedRoot } = await exportFixture(t);
	await prepareTelegramGroupImport({ exportRoot });
	await fillSpeakers(controlDir, { "Example Owner": { kind: "owner", userId: 7 }, "Agent A": { kind: "agent", userId: 201 } });
	const journal = new GroupJournal(sharedRoot, journalOptions);
	await journal.recordMessage({ chatId: GROUP, messageId: 100, senderId: 7, sender: "Owner", senderKind: "owner", date: 1_789_898_400, text: "Can anyone look at this? (live)", entities: [] }, "agent_a_bot");
	const options = { exportRoot, chatId: GROUP, sharedRoot, journalOptions };

	const dryRun = await importTelegramGroupExport(options);
	assert.deepEqual(dryRun, { schema: "pi-telegram-owner/group-import-report/v1", mode: "dry-run", messages: 4, alreadyPresent: 1, imported: 3, photos: 1 });
	assert.equal((await journal.events()).length, 1, "a dry run writes nothing");

	assert.equal((await importTelegramGroupExport({ ...options, commit: true })).imported, 3);
	const timeline = await journal.timeline({ chatId: GROUP, limit: 10 });
	assert.deepEqual(timeline.map((message) => [message.messageId, message.senderKind, message.sender]), [[100, "owner", "Owner"], [101, "agent", "Agent A"], [102, "agent", "Agent A"], [103, "owner", "Owner"]]);
	assert.equal(timeline[0]!.text, "Can anyone look at this? (live)", "a live record is never overwritten");
	assert.equal(timeline[1]!.text, "I will.\nStarting now.");
	assert.equal(timeline[1]!.replyToMessageId, 100);
	assert.equal(timeline[1]!.date, 1_789_898_460);
	assert.deepEqual(timeline[3]!.media, { kind: "document", fileName: "report.json" });
	assert.equal(timeline[2]!.media!.kind, "photo");
	assert.deepEqual(await readFile(join(sharedRoot, timeline[2]!.media!.attachment!)), PNG);
	assert.equal((await journal.events()).filter((event) => event.kind === "conflict").length, 0);

	const repeated = await importTelegramGroupExport({ ...options, commit: true });
	assert.deepEqual([repeated.alreadyPresent, repeated.imported], [4, 0], "repeating an import is idempotent");
});

test("a page changed after prepare, or a sender missing from the map, fails without writing", async (t) => {
	const { exportRoot, controlDir, sharedRoot } = await exportFixture(t);
	await prepareTelegramGroupImport({ exportRoot });
	await fillSpeakers(controlDir, { "Example Owner": { kind: "owner", userId: 7 }, "Agent A": { kind: "agent", userId: 201 } });
	await writeFile(join(exportRoot, "messages.html"), `${PAGE} `);
	await assert.rejects(importTelegramGroupExport({ exportRoot, chatId: GROUP, sharedRoot, commit: true, journalOptions }), (error: Error) => error instanceof ImportValidationError && error.code === "SOURCE_CHANGED" && /prepare it again/.test(error.message));

	await prepareTelegramGroupImport({ exportRoot });
	const path = join(controlDir, "group-speakers.json");
	const map = JSON.parse(await readFile(path, "utf8"));
	delete map.speakers["Agent A"];
	await writeFile(path, JSON.stringify(map), { mode: 0o600 });
	await assert.rejects(importTelegramGroupExport({ exportRoot, chatId: GROUP, sharedRoot, commit: true, journalOptions }), (error: Error) => error instanceof ImportValidationError && error.code === "DIRECTION_UNKNOWN");
	assert.equal((await new GroupJournal(sharedRoot, journalOptions).events()).length, 0);
});
