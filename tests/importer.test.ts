import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { markdownCompatibilityKey, TELEGRAM_FORMAT_COMPAT_VERSION } from "../src/format.ts";
import { ImportValidationError, TelegramArchiveImporter, type BoundaryManifest, type SourceSetManifest, type SpeakerMap } from "../src/importer.ts";
import { TelegramMarkdownProjector } from "../src/markdown-projector.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

async function fixture(t: TestContext, postText = "answer") {
	const root = await mkdtemp(join(tmpdir(), "telegram-import-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const exportRoot = join(root, "export");
	const sessionRoot = join(root, "sessions");
	const control = join(root, "control");
	await Promise.all([mkdir(join(exportRoot, "photos"), { recursive: true, mode: 0o700 }), mkdir(sessionRoot, { mode: 0o700 }), mkdir(control, { mode: 0o700 })]);
	const html = `<!doctype html><html><body>
<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-02-24T10:00:00Z"></div><div class="text"><strong>old</strong><br>one</div><a class="photo_wrap" href="photos/a.png"><img src="photos/a.png"></a></div>
<div class="message default joined"><div class="date" title="2026-02-24T10:01:00Z"></div><div class="text"><pre>old code</pre></div></div>
<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:00:00Z"></div><div class="text">first pi.</div></div>
<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T10:01:00Z"></div><div class="text"><em>${postText}</em> <a href="tel:+15550100">call</a></div><a class="photo_wrap" href="photos/b.png"><img src="photos/b.png"></a></div>
</body></html>`;
	await writeFile(join(exportRoot, "messages.html"), html);
	const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
	await writeFile(join(exportRoot, "photos", "a.png"), photoBytes);
	await writeFile(join(exportRoot, "photos", "b.png"), photoBytes);
	const source: SourceSetManifest = { schema: "pi-telegram-owner/source-set/v1", sourceSetId: "pre-pi-v1", pages: [{ path: "messages.html", size: Buffer.byteLength(html), sha256: sha(html) }], messageCount: 4 };
	const sourcePath = join(control, "source.json");
	await writeFile(sourcePath, JSON.stringify(source), { mode: 0o600 });
	const speaker: SpeakerMap = { schema: "pi-telegram-owner/speaker-map/v1", revision: 1, speakers: { [sha("Owner")]: "in", [sha("Agent")]: "out" } };
	const speakerPath = join(control, "speakers.json");
	await writeFile(speakerPath, JSON.stringify(speaker), { mode: 0o600 });
	const boundary: BoundaryManifest = { schema: "pi-telegram-owner/first-pi-boundary/v1", admittedPiSessionIds: ["pi-session"], sourceSetManifestSha256: sha(await readFile(sourcePath)), firstPi: { matchKind: "markdown-semantic", sessionId: "pi-session", entryId: "user0001", globalMessageOrdinal: 3, direction: "in", compatibility: TELEGRAM_FORMAT_COMPAT_VERSION, normalizedSha256: sha(markdownCompatibilityKey("first pi\\.")) } };
	const boundaryPath = join(control, "boundary.json");
	await writeFile(boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const session = [
		JSON.stringify({ type: "session", version: 3, id: "pi-session", timestamp: "2026-09-20T09:59:00Z", cwd: "/synthetic" }),
		JSON.stringify({ type: "message", id: "user0001", parentId: null, timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "[telegram-job:synthetic-job]\nfirst pi.", timestamp: 0 } }),
		JSON.stringify({ type: "message", id: "asst0001", parentId: "user0001", timestamp: "2026-09-20T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: `_${postText}_ [call](tel:+15550100)` }], timestamp: 0 } }),
	].join("\n") + "\n";
	await writeFile(join(sessionRoot, "pi.jsonl"), session);
	return { root, exportRoot, sessionRoot, sourcePath, speakerPath, boundaryPath, checkpointPath: join(control, "checkpoint.json"), archiveRoot: join(root, "archive"), photoBytes };
}

test("dry-run admits pre-Pi ordinals and monotonically aligns Pi entries", async (t) => {
	const current = await fixture(t);
	const importer = new TelegramArchiveImporter();
	const report = await importer.run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath });
	assert.equal(report.schema, "pi-telegram-owner/import-report/v1");
	assert.equal(report.historical, 2);
	assert.equal(report.piAligned, 2);
	assert.equal(report.unresolvedPostBoundary, 0);
	assert.deepEqual(report.items.map((item) => item.messageId), ["tgmsg:v1:telegram-export-history:pre-pi-v1:1", "tgmsg:v1:telegram-export-history:pre-pi-v1:2", "tgmsg:v1:pi:pi-session:user0001", "tgmsg:v1:pi:pi-session:asst0001"]);
	assert.equal(report.items[0]?.markdown, "**old**\none");
	assert.equal(report.items[1]?.markdown, "```\nold code\n```");
	assert.equal(report.items[0]?.attachments[0]?.mimeType, "image/png");
	assert.equal(report.items[2]?.markdown, "first pi.");
	assert.equal(report.items[3]?.direction, "out");
	assert.equal(report.items[3]?.attachments[0]?.sha256, report.items[0]?.attachments[0]?.sha256);
	assert.equal(report.items[2]?.pi?.sourceRootId, "pi-sessions");
	assert.equal(report.items[2]?.pi?.entryLine, 2);
	assert.equal(typeof report.items[2]?.pi?.entryByteOffset, "number");
	const checkpoint = await readFile(current.checkpointPath, "utf8");
	assert.equal(JSON.parse(checkpoint).schema, "pi-telegram-owner/import-checkpoint/v1");
	assert.equal(checkpoint.includes("first pi"), false);
	assert.match(checkpoint, /"piFiles"/);
	assert.match(checkpoint, /"planSha256"/);
	await assert.rejects(() => stat(current.archiveRoot), { code: "ENOENT" });
});

test("raw-source anchor normalizes an unjournaled transport marker only after export proof", async (t) => {
	const current = await fixture(t);
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8"));
	boundary.admittedPiSessionIds = ["pi-session"]; boundary.firstPi.matchKind = "raw-source-text"; boundary.firstPi.normalizedSha256 = sha("first pi.");
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], checkpointPath: current.checkpointPath });
	assert.equal(report.piAligned, 2);
	assert.equal(report.items[2]?.markdown, "first pi.");
	assert.equal(report.items[2]?.pi?.entrySha256, sha((await readFile(join(current.sessionRoot, "pi.jsonl"), "utf8")).trimEnd().split("\n")[1]!));
});

test("session-root discovery aligns across multiple Pi sessions and rejects duplicate session identities", async (t) => {
	const current = await fixture(t);
	const original = (await readFile(join(current.sessionRoot, "pi.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	await writeFile(join(current.sessionRoot, "01-first.jsonl"), `${[original[0], original[1]].map(JSON.stringify).join("\n")}\n`);
	await writeFile(join(current.sessionRoot, "02-second.jsonl"), `${[
		{ type: "session", version: 3, id: "pi-session-2", timestamp: "2026-09-20T10:00:30Z", cwd: "/synthetic" },
		{ ...original[2], id: "asst0002", parentId: null },
	].map(JSON.stringify).join("\n")}\n`);
	await rm(join(current.sessionRoot, "pi.jsonl"));
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.firstPi.matchKind = "markdown-semantic"; boundary.admittedPiSessionIds = ["pi-session", "pi-session-2"];
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	await writeFile(join(current.sessionRoot, "03-unrelated.jsonl"), `${[
		{ type: "session", version: 3, id: "unrelated-session", timestamp: "2026-09-20T10:01:00Z", cwd: "/synthetic" },
		{ ...original[1], id: "unrelated-user", parentId: null, timestamp: "2026-09-20T10:01:00Z" },
	].map(JSON.stringify).join("\n")}\n`);
	const importer = new TelegramArchiveImporter();
	const options = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], checkpointPath: current.checkpointPath } as const;
	const report = await importer.run(options);
	assert.equal(report.piAligned, 2);
	assert.deepEqual(report.items.slice(2).map((item) => item.messageId), ["tgmsg:v1:pi:pi-session:user0001", "tgmsg:v1:pi:pi-session-2:asst0002"]);
	const checkpoint = JSON.parse(await readFile(current.checkpointPath, "utf8"));
	assert.deepEqual(checkpoint.piFiles.map((file: { path: string }) => file.path), ["01-first.jsonl", "02-second.jsonl"]);

	await writeFile(join(current.sessionRoot, "04-duplicate.jsonl"), `${[original[0], original[1]].map(JSON.stringify).join("\n")}\n`);
	await assert.rejects(() => importer.run(options), (error: ImportValidationError) => error.code === "PI_SESSION_DUPLICATE");
});

test("multi-session discovery rejects overlapping chronological ranges", async (t) => {
	const current = await fixture(t);
	const original = (await readFile(join(current.sessionRoot, "pi.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	await writeFile(join(current.sessionRoot, "01-first.jsonl"), `${[original[0], original[1]].map(JSON.stringify).join("\n")}\n`);
	await writeFile(join(current.sessionRoot, "02-overlap.jsonl"), `${[
		{ type: "session", version: 3, id: "pi-session-2", timestamp: "2026-09-20T10:00:20Z", cwd: "/synthetic" },
		{ ...original[2], id: "asst0002", parentId: null, timestamp: original[1].timestamp },
	].map(JSON.stringify).join("\n")}\n`);
	await rm(join(current.sessionRoot, "pi.jsonl"));
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.firstPi.matchKind = "markdown-semantic"; boundary.admittedPiSessionIds = ["pi-session", "pi-session-2"];
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	await assert.rejects(() => new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "PI_SESSION_ORDER_AMBIGUOUS");
});

test("dry-run reports only short-gap transport-sized chunk candidates without merging them", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const longText = "x".repeat(3_600);
	let html = await readFile(htmlPath, "utf8");
	html = html.replace("<strong>old</strong><br>one", longText).replace('title="2026-02-24T10:01:00Z"', 'title="2026-02-24T10:00:01Z"');
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8"));
	source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl");
	const session = (await readFile(sessionPath, "utf8")).trimEnd();
	await writeFile(sessionPath, `${session}\n${JSON.stringify({ type: "message", id: "user0002", parentId: "asst0001", timestamp: "2026-09-20T10:02:00Z", message: { role: "user", content: `${longText}\nold code`, timestamp: 0 } })}\n`);

	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], checkpointPath: current.checkpointPath });
	assert.equal(report.chunkCandidates.length, 1);
	assert.deepEqual({ ...report.chunkCandidates[0], leftCompatibilityKeySha256: "hash", rightCompatibilityKeySha256: "hash" }, {
		leftGlobalMessageOrdinal: 1,
		rightGlobalMessageOrdinal: 2,
		direction: "in",
		gapMs: 1_000,
		leftMarkdownLength: 3_600,
		rightMarkdownLength: 8,
		leftCompatibilityKeySha256: "hash",
		rightCompatibilityKeySha256: "hash",
		signals: ["adjacent-same-direction", "gap-within-threshold", "source-text-length-at-least-threshold"],
		exactPiReconstruction: { sessionId: "pi-session", entryId: "user0002", separator: "newline", reconstructedSha256: sha(`${longText}\nold code`) },
	});
	assert.deepEqual(report.items.slice(0, 2).map((item) => item.messageId), ["tgmsg:v1:telegram-export-history:pre-pi-v1:1", "tgmsg:v1:telegram-export-history:pre-pi-v1:2"], "candidate reporting must not merge canonical import items");
	const checkpoint = await readFile(current.checkpointPath, "utf8");
	assert.equal(checkpoint.includes(longText), false);
	assert.match(checkpoint, /"chunkCandidates"/);
});

test("exact post-boundary chunks consume one Pi entry and retain every HTML boundary", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html"); const longText = "z".repeat(3_600);
	let html = await readFile(htmlPath, "utf8");
	html = html.replace("</body></html>", `<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:02:00Z"></div><div class="text">chunk request</div></div>\n<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T10:03:00Z"></div><div class="text">${longText}</div></div>\n<div class="message default joined"><div class="date" title="2026-09-20T10:03:01Z"></div><div class="text">tail</div></div></body></html>`);
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); source.messageCount = 7;
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).trimEnd();
	await writeFile(sessionPath, `${session}\n${JSON.stringify({ type: "message", id: "user0002", parentId: "asst0001", timestamp: "2026-09-20T10:02:00Z", message: { role: "user", content: "chunk request", timestamp: 0 } })}\n${JSON.stringify({ type: "message", id: "asst0002", parentId: "user0002", timestamp: "2026-09-20T10:03:00Z", message: { role: "assistant", content: `${longText}\ntail`, timestamp: 0 } })}\n`);
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], checkpointPath: current.checkpointPath });
	assert.equal(report.piAligned, 4);
	assert.equal(report.unresolvedPostBoundary, 0);
	const reconstructed = report.items.find((item) => item.messageId === "tgmsg:v1:pi:pi-session:asst0002");
	assert.deepEqual(reconstructed?.htmlSegments?.map((segment) => segment.globalMessageOrdinal), [6, 7]);
	assert.equal(reconstructed?.htmlSegments?.every((segment) => /^[0-9a-f]{64}$/.test(segment.sourceTextSha256)), true);
});

test("unique single-message matches take precedence over broader multi-chunk candidates", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace("</body></html>", '<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:02:00Z"></div><div class="text">alpha</div></div><div class="message default joined"><div class="date" title="2026-09-20T10:02:01Z"></div><div class="text">beta</div></div></body></html>');
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); source.messageCount = 6; await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath)); await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).trimEnd();
	await writeFile(sessionPath, `${session}\n${JSON.stringify({ type: "message", id: "user0002", parentId: "asst0001", timestamp: "2026-09-20T10:02:00Z", message: { role: "user", content: "[telegram-job:job-alpha]\nalpha", timestamp: 0 } })}\n${JSON.stringify({ type: "message", id: "user0003", parentId: "user0002", timestamp: "2026-09-20T10:03:00Z", message: { role: "user", content: "[telegram-job:job-alpha-beta]\nalpha beta", timestamp: 0 } })}\n`);
	const journalPath = join(current.root, "control", "single-before-multi.jsonl"); const records = [{ type: "update", disposition: "accepted", jobId: "synthetic-job", text: "first pi." }, { type: "dispatched", jobId: "synthetic-job", sessionId: "pi-session" }, { type: "reply_ready", jobId: "synthetic-job", text: "_answer_ [call](tel:+15550100)" }, { type: "update", disposition: "accepted", jobId: "job-alpha", text: "alpha" }, { type: "dispatched", jobId: "job-alpha", sessionId: "pi-session" }, { type: "update", disposition: "accepted", jobId: "job-alpha-beta", text: "alpha beta" }, { type: "dispatched", jobId: "job-alpha-beta", sessionId: "pi-session" }];
	await writeFile(journalPath, `${records.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], journalPath, checkpointPath: current.checkpointPath, chunkCandidateGapMs: 5_000 });
	assert.deepEqual({ aligned: report.piAligned, unresolved: report.unresolvedPostBoundary, missing: report.coverageMissing }, { aligned: 3, unresolved: 1, missing: 1 });
	assert.equal(report.items.find((item) => item.html?.globalMessageOrdinal === 5)?.pi?.entryId, "user0002");
	assert.equal(report.items.find((item) => item.html?.globalMessageOrdinal === 6)?.identityKind, "telegram-export-history");
	assert.equal(report.items.find((item) => item.pi?.entryId === "user0003")?.exportStatus, "missing");
});

test("commit requires an exact dry-run plan and publishes idempotent notes and attachments", async (t) => {
	const current = await fixture(t);
	const importer = new TelegramArchiveImporter();
	const base = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath, archiveRoot: current.archiveRoot } as const;
	await assert.rejects(() => importer.run({ ...base, dryRun: false }), (error: ImportValidationError) => error.code === "CHECKPOINT_REQUIRED");
	await importer.run(base);
	const mediaProjector = new TelegramMarkdownProjector({ enabled: true, root: current.archiveRoot, rootId: "pi-sessions" });
	const live = await mediaProjector.captureLiveMedia(current.photoBytes, "image/png", "in");
	const committed = await importer.run({ ...base, dryRun: false });
	assert.deepEqual(committed.publication, { published: 4, unchanged: 0, attachments: 0, mediaEvents: 2 });
	const monthDirectories = [join(current.archiveRoot, "messages", "2026", "02"), join(current.archiveRoot, "messages", "2026", "09")];
	assert.equal((await Promise.all(monthDirectories.map((directory) => readdir(directory)))).flat().length, 4);
	const attachmentNames = await readdir(join(current.archiveRoot, "messages", "_attachments"));
	assert.equal(attachmentNames.length, 1);
	assert.match(attachmentNames[0]!, /^[0-9a-f]{64}\.png$/);
	const historical = await readFile(join(monthDirectories[0], (await readdir(monthDirectories[0]))[0]!), "utf8");
	assert.equal(historical.includes(`![[${attachmentNames[0]}|512]]`), true);
	assert.match(historical, /source: telegram-desktop-import/);
	assert.match(historical, /direction: in/);
	assert.match(historical, /sha256: [0-9a-f]{64}/);
	assert.equal(attachmentNames[0], `${live.sha256}.png`);
	const septemberNotes = await Promise.all((await readdir(monthDirectories[1])).map((name) => readFile(join(monthDirectories[1], name), "utf8")));
	const outboundPhotoNote = septemberNotes.find((note) => note.includes("direction: out") && note.includes("attachments:"));
	assert.ok(outboundPhotoNote);
	assert.match(outboundPhotoNote, /source: telegram-desktop-import/);
	assert.equal(outboundPhotoNote.includes(`![[${live.sha256}.png|512]]`), true);
	assert.equal(JSON.parse(await readFile(current.checkpointPath, "utf8")).publication.phase, "complete");
	const eventPath = join(current.archiveRoot, "messages", ".telegram-archive", "media-events.jsonl");
	const importEvents = await mediaProjector.readMediaEvents();
	assert.equal(importEvents.length, 2);
	assert.deepEqual(importEvents.map((event) => event.direction).sort(), ["in", "out"]);
	assert.equal(new Set(importEvents.map((event) => event.attachment.sha256)).size, 1, "same bytes retain distinct import provenance events");
	assert.equal(importEvents.every((event) => event.provenance.kind === "desktop-import"), true);
	const completedCheckpoint = await readFile(current.checkpointPath, "utf8");
	const resumed = await importer.run({ ...base, dryRun: false });
	assert.deepEqual(resumed.publication, { published: 0, unchanged: 4, attachments: 0, mediaEvents: 0 });
	assert.equal(await readFile(current.checkpointPath, "utf8"), completedCheckpoint, "planned media events must not invalidate or mutate the completed checkpoint");
	await writeFile(eventPath, '{"schema":"pi-telegram-owner/media-event/v1"', { mode: 0o600 });
	const migrated = await importer.run({ ...base, dryRun: false });
	assert.deepEqual(migrated.publication, { published: 0, unchanged: 4, attachments: 0, mediaEvents: 2 });
	assert.equal((await mediaProjector.readMediaEvents()).length, 2, "partial event tails and pre-event imports converge idempotently");
	assert.deepEqual((await importer.run({ ...base, dryRun: false })).publication, { published: 0, unchanged: 4, attachments: 0, mediaEvents: 0 });
	await writeFile(current.speakerPath, JSON.stringify({ schema: "pi-telegram-owner/speaker-map/v1", revision: 2, speakers: { [sha("Owner")]: "in", [sha("Agent")]: "out" } }), { mode: 0o600 });
	await assert.rejects(() => importer.run({ ...base, dryRun: false }), (error: ImportValidationError) => error.code === "PLAN_BINDING_MISMATCH");
});

test("CLI dry-run accepts realistic multi-page wrappers and journal-correlated Pi markers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-import-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
	const exportRoot = join(root, "export"); const sessionRoot = join(root, "sessions"); const control = join(root, "control");
	await Promise.all([mkdir(join(exportRoot, "photos"), { recursive: true, mode: 0o700 }), mkdir(sessionRoot, { mode: 0o700 }), mkdir(control, { mode: 0o700 })]);
	const page1 = `<!doctype html><html><body>
<div class="message default clearfix" id="message1"><div class="pull_left userpic_wrap"><div class="userpic initials" style="width:42px">O</div></div><div class="body"><div class="pull_right date details" title="24.02.2026 10:00:00 UTC+00:00"></div><div class="from_name">Owner</div><div class="text"><strong>old</strong><br># literal <s>gone</s> <code>x\`y</code></div><div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/a.png" style="width:1px"><img class="photo" src="photos/a.png" style="width:1px"></a></div></div></div>
<div class="message default joined clearfix" id="message2"><div class="body"><div class="pull_right date details" title="24.02.2026 10:01:00 UTC+00:00"></div><div class="text"><pre>old code</pre></div></div></div>
<div class="message service" id="message3"><div class="body details">service</div></div></body></html>`;
	const page2 = `<!doctype html><html><body>
<div class="message default clearfix" id="message4"><div class="body"><div class="pull_right date details" title="20.09.2026 10:00:00 UTC+00:00"></div><div class="from_name">Owner</div><div class="text">first pi.</div></div></div>
<div class="message default clearfix" id="message5"><div class="body"><div class="pull_right date details" title="20.09.2026 10:01:00 UTC+00:00"></div><div class="from_name">Agent</div><div class="reply_to details"><a href="#go_to_message4">reply</a></div><div class="text"><em>answer</em> <a href="tel:+15550100">call</a></div></div></div></body></html>`;
	await writeFile(join(exportRoot, "messages.html"), page1); await writeFile(join(exportRoot, "messages2.html"), page2);
	await writeFile(join(exportRoot, "photos", "a.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]));
	const source: SourceSetManifest = { schema: "pi-telegram-owner/source-set/v1", sourceSetId: "realistic-v1", pages: [{ path: "messages.html", size: Buffer.byteLength(page1), sha256: sha(page1) }, { path: "messages2.html", size: Buffer.byteLength(page2), sha256: sha(page2) }], messageCount: 4 };
	const sourcePath = join(control, "source.json"); await writeFile(sourcePath, JSON.stringify(source), { mode: 0o600 });
	const speakerPath = join(control, "speakers.json"); await writeFile(speakerPath, JSON.stringify({ schema: "pi-telegram-owner/speaker-map/v1", revision: 1, speakers: { [sha("Owner")]: "in", [sha("Agent")]: "out" } }), { mode: 0o600 });
	const boundaryPath = join(control, "boundary.json"); await writeFile(boundaryPath, JSON.stringify({ schema: "pi-telegram-owner/first-pi-boundary/v1", admittedPiSessionIds: ["pi-session"], sourceSetManifestSha256: sha(await readFile(sourcePath)), firstPi: { matchKind: "markdown-semantic", sessionId: "pi-session", entryId: "user0001", globalMessageOrdinal: 3, direction: "in", compatibility: TELEGRAM_FORMAT_COMPAT_VERSION, normalizedSha256: sha(markdownCompatibilityKey("first pi\\.")) } }), { mode: 0o600 });
	const session = [{ type: "session", version: 3, id: "pi-session", timestamp: "2026-09-20T09:59:00Z", cwd: "/synthetic" }, { type: "message", id: "user0001", parentId: null, timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "[telegram-job:job-1]\nfirst pi.", timestamp: 0 } }, { type: "message", id: "asst0001", parentId: "user0001", timestamp: "2026-09-20T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "_answer_ [call](tel:+15550100)" }], timestamp: 0 } }];
	await writeFile(join(sessionRoot, "pi.jsonl"), `${session.map(JSON.stringify).join("\n")}\n`);
	const journalPath = join(control, "state.jsonl"); await writeFile(journalPath, `${JSON.stringify({ type: "update", disposition: "accepted", jobId: "job-1", text: "first pi." })}\n${JSON.stringify({ type: "dispatched", jobId: "job-1", sessionId: "pi-session" })}\n${JSON.stringify({ type: "reply_ready", jobId: "job-1", text: "_answer_ [call](tel:+15550100)" })}\n`, { mode: 0o600 });
	const checkpointPath = join(control, "checkpoint.json");
	const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), "src/cli/telegram-archive-import.ts"), "--export-root", exportRoot, "--source-set-manifest", sourcePath, "--first-pi-anchor", boundaryPath, "--speaker-map", speakerPath, "--pi-session-root", sessionRoot, "--pi-session", "pi.jsonl", "--journal", journalPath, "--checkpoint", checkpointPath]);
	assert.deepEqual(JSON.parse(stdout), { sourceSetId: "realistic-v1", historical: 2, piAligned: 2, unresolvedPostBoundary: 0, ambiguous: 0, coverageMissing: 0, chunkCandidates: 0, gaps: 0, mode: "dry-run" });
	const checkpoint = await readFile(checkpointPath, "utf8"); assert.match(checkpoint, /"sourceRange"/); assert.equal(checkpoint.includes("first pi"), false);
});

test("journal-backed import excludes local users and intermediate assistant entries", async (t) => {
	const current = await fixture(t);
	const path = join(current.sessionRoot, "pi.jsonl");
	const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	lines.splice(2, 0,
		{ type: "message", id: "toolonly", parentId: "user0001", timestamp: "2026-09-20T10:00:20Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], timestamp: 0 } },
		{ type: "message", id: "interim1", parentId: "toolonly", timestamp: "2026-09-20T10:00:30Z", message: { role: "assistant", content: [{ type: "text", text: "intermediate narration" }], timestamp: 0 } },
	);
	lines[4].parentId = "interim1";
	lines.push(
		{ type: "message", id: "localuser", parentId: lines[4].id, timestamp: "2026-09-20T10:02:00Z", message: { role: "user", content: "local prompt", timestamp: 0 } },
		{ type: "message", id: "localasst", parentId: "localuser", timestamp: "2026-09-20T10:03:00Z", message: { role: "assistant", content: [{ type: "text", text: "local answer" }], timestamp: 0 } },
	);
	await writeFile(path, `${lines.map(JSON.stringify).join("\n")}\n`);
	const journalPath = join(current.root, "control", "journal.jsonl");
	await writeFile(journalPath, `${JSON.stringify({ type: "update", disposition: "accepted", jobId: "synthetic-job", text: "first pi." })}\n${JSON.stringify({ type: "dispatched", jobId: "synthetic-job", sessionId: "pi-session" })}\n${JSON.stringify({ type: "reply_ready", jobId: "synthetic-job", text: "_answer_ [call](tel:+15550100)" })}\n`, { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], journalPath, checkpointPath: current.checkpointPath });
	assert.equal(report.piAligned, 2);
	assert.equal(report.coverageMissing, 0);
	assert.deepEqual(report.items.slice(2).map((item) => item.pi?.entryId), ["user0001", "asst0001"]);
});

test("journal-proven busy-queue crossings align without classifying the earlier reply as missing", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const assistantOne = '<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T10:01:00Z"></div><div class="text"><em>answer</em> <a href="tel:+15550100">call</a></div><a class="photo_wrap" href="photos/b.png"><img src="photos/b.png"></a></div>';
	const userTwo = '<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:00:30Z"></div><div class="text">second pi.</div></div>';
	const assistantTwo = '<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T10:02:00Z"></div><div class="text">second answer</div></div>';
	const html = (await readFile(htmlPath, "utf8")).replace(assistantOne, `${userTwo}\n${assistantOne}`).replace("</body></html>", `${assistantTwo}</body></html>`);
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); source.messageCount = 6;
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	session.push(
		{ type: "message", id: "user0002", parentId: "asst0001", timestamp: "2026-09-20T10:01:30Z", message: { role: "user", content: "[telegram-job:synthetic-job-2]\nsecond pi.", timestamp: 0 } },
		{ type: "message", id: "asst0002", parentId: "user0002", timestamp: "2026-09-20T10:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 0 } },
	);
	await writeFile(sessionPath, `${session.map(JSON.stringify).join("\n")}\n`);
	const journalPath = join(current.root, "control", "busy-journal.jsonl");
	const records = [{ type: "update", disposition: "accepted", jobId: "synthetic-job", text: "first pi." }, { type: "dispatched", jobId: "synthetic-job", sessionId: "pi-session" }, { type: "reply_ready", jobId: "synthetic-job", text: "_answer_ [call](tel:+15550100)" }, { type: "update", disposition: "accepted", jobId: "synthetic-job-2", text: "second pi." }, { type: "dispatched", jobId: "synthetic-job-2", sessionId: "pi-session" }, { type: "reply_ready", jobId: "synthetic-job-2", text: "second answer" }];
	await writeFile(journalPath, `${records.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], journalPath, checkpointPath: current.checkpointPath });
	assert.deepEqual({ aligned: report.piAligned, ambiguous: report.ambiguous, missing: report.coverageMissing, unresolved: report.unresolvedPostBoundary }, { aligned: 4, ambiguous: 0, missing: 0, unresolved: 0 });
	assert.deepEqual(report.items.slice(2).map((item) => item.pi?.entryId), ["user0001", "user0002", "asst0001", "asst0002"]);
});

test("rendered plain-text alignment requires durable journal proof", async (t) => {
	const current = await fixture(t); const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace('<em>answer</em> <a href="tel:+15550100">call</a>', "<strong>answer</strong>"); await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath)); await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).replace("_answer_ [call](tel:+15550100)", "# answer"); await writeFile(sessionPath, session);
	const base = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"] } as const;
	const unproven = await new TelegramArchiveImporter().run({ ...base, checkpointPath: current.checkpointPath });
	assert.deepEqual({ aligned: unproven.piAligned, unresolved: unproven.unresolvedPostBoundary, missing: unproven.coverageMissing }, { aligned: 1, unresolved: 1, missing: 1 });
	const journalPath = join(current.root, "control", "proof-journal.jsonl"); const records = [{ type: "update", disposition: "accepted", jobId: "synthetic-job", text: "first pi." }, { type: "dispatched", jobId: "synthetic-job", sessionId: "pi-session" }, { type: "reply_ready", jobId: "synthetic-job", text: "# answer" }]; await writeFile(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
	const proven = await new TelegramArchiveImporter().run({ ...base, journalPath, checkpointPath: join(current.root, "control", "proof-checkpoint.json") });
	assert.deepEqual({ aligned: proven.piAligned, unresolved: proven.unresolvedPostBoundary, missing: proven.coverageMissing }, { aligned: 2, unresolved: 0, missing: 0 });
	assert.equal(proven.items.find((item) => item.pi?.entryId === "asst0001")?.markdown, "# answer");
});

test("journal-proven formatted replies align by exact plain projection while retaining Pi Markdown", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace('<em>answer</em> <a href="tel:+15550100">call</a>', "<strong>answer</strong>");
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	session[2].message.content = [{ type: "text", text: "# answer" }]; await writeFile(sessionPath, `${session.map(JSON.stringify).join("\n")}\n`);
	const journalPath = join(current.root, "control", "formatted-journal.jsonl");
	await writeFile(journalPath, `${JSON.stringify({ type: "update", disposition: "accepted", jobId: "synthetic-job", text: "first pi." })}\n${JSON.stringify({ type: "dispatched", jobId: "synthetic-job", sessionId: "pi-session" })}\n${JSON.stringify({ type: "reply_ready", jobId: "synthetic-job", text: "# answer" })}\n`, { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], journalPath, checkpointPath: current.checkpointPath });
	assert.equal(report.piAligned, 2);
	assert.equal(report.coverageMissing, 0);
	assert.equal(report.items[3]?.markdown, "# answer");
});

test("explicit positive and negative HTML-to-Pi timestamp offsets disambiguate repeated journal-proven text", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const repeated = '<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T11:00:00Z"></div><div class="text">first pi.</div></div>\n<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T11:01:00Z"></div><div class="text"><em>answer</em> <a href="tel:+15550100">call</a></div></div>';
	const html = (await readFile(htmlPath, "utf8")).replace("</body></html>", `${repeated}</body></html>`);
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); source.messageCount = 6;
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const sessionPath = join(current.sessionRoot, "pi.jsonl"); const session = (await readFile(sessionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	session[1].timestamp = "2026-09-20T09:00:00Z"; session[2].timestamp = "2026-09-20T09:01:00Z";
	session.push(
		{ type: "message", id: "user0002", parentId: "asst0001", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "[telegram-job:synthetic-job-2]\nfirst pi.", timestamp: 0 } },
		{ type: "message", id: "asst0002", parentId: "user0002", timestamp: "2026-09-20T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "_answer_ [call](tel:+15550100)" }], timestamp: 0 } },
	);
	await writeFile(sessionPath, `${session.map(JSON.stringify).join("\n")}\n`);
	const journalPath = join(current.root, "control", "repeated-journal.jsonl");
	const records = ["synthetic-job", "synthetic-job-2"].flatMap((jobId) => [{ type: "update", disposition: "accepted", jobId, text: "first pi." }, { type: "dispatched", jobId, sessionId: "pi-session" }, { type: "reply_ready", jobId, text: "_answer_ [call](tel:+15550100)" }]);
	await writeFile(journalPath, `${records.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
	const base = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], journalPath } as const;
	const ambiguous = await new TelegramArchiveImporter().run({ ...base, checkpointPath: current.checkpointPath });
	assert.equal(ambiguous.ambiguous > 0, true);
	const resolved = await new TelegramArchiveImporter().run({ ...base, checkpointPath: join(current.root, "control", "offset-checkpoint.json"), htmlPiTimestampOffsetsMs: [-3_600_000, 3_600_000] });
	assert.deepEqual({ aligned: resolved.piAligned, ambiguous: resolved.ambiguous, missing: resolved.coverageMissing, unresolved: resolved.unresolvedPostBoundary }, { aligned: 4, ambiguous: 0, missing: 0, unresolved: 0 });
});

test("commit and resume preserve authoritative Desktop-only content and canonical missing-export Pi notes", async (t) => {
	const current = await fixture(t);
	const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace("</body></html>", '<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:02:00Z"></div><div class="text">desktop only</div></div></body></html>');
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html); source.messageCount = 5; await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath)); await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const path = join(current.sessionRoot, "pi.jsonl");
	const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	lines[2].parentId = "asst-gap";
	lines.splice(2, 0, { type: "message", id: "asst-gap", parentId: "user0001", timestamp: "2026-09-20T10:00:30Z", message: { role: "assistant", content: [{ type: "text", text: "unexported" }], timestamp: 0 } });
	await writeFile(path, `${lines.map(JSON.stringify).join("\n")}\n`);
	const importer = new TelegramArchiveImporter();
	const options = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath, archiveRoot: current.archiveRoot } as const;
	const report = await importer.run(options);
	assert.equal(report.coverageMissing, 1);
	assert.deepEqual(report.gaps, [{ kind: "pi-unmatched", startHtmlOrdinal: 4, endHtmlOrdinal: 4, piEntryIds: ["asst-gap"] }, { kind: "html-unresolved", startHtmlOrdinal: 5, endHtmlOrdinal: 5, piEntryIds: [] }]);
	assert.equal(report.piAligned, 2);
	assert.equal(report.items.some((item) => item.messageId === "tgmsg:v1:pi:pi-session:asst-gap" && item.exportStatus === "missing"), true);
	assert.equal(report.items.some((item) => item.messageId?.endsWith(":5") && item.identityKind === "telegram-export-history" && item.exportStatus === "historical-authority" && item.markdown === "desktop only"), true);
	const committed = await importer.run({ ...options, dryRun: false });
	assert.equal(committed.publication?.published, report.items.length);
	const monthFiles = (await Promise.all(["02", "09"].map(async (month) => { const directory = join(current.archiveRoot, "messages", "2026", month); return (await readdir(directory)).map((name) => join(directory, name)); }))).flat();
	const notes = await Promise.all(monthFiles.map((notePath) => readFile(notePath, "utf8")));
	const missing = notes.find((note) => note.includes("sessionEntryId: asst-gap")); assert.ok(missing); assert.match(missing, /exportStatus: missing/); assert.match(missing, /entrySha256: [0-9a-f]{64}/);
	const desktopOnly = notes.find((note) => note.includes("desktop only")); assert.ok(desktopOnly); assert.match(desktopOnly, /identityKind: telegram-export-history/); assert.match(desktopOnly, /exportStatus: historical-authority/);
	assert.equal(notes.filter((note) => /exportStatus: present/.test(note)).length, 2);
	assert.deepEqual((await importer.run({ ...options, dryRun: false })).publication, { published: 0, unchanged: report.items.length, attachments: 0, mediaEvents: 0 });
});

test("duplicate manifest keys fail closed", async (t) => {
	const current = await fixture(t);
	const duplicate = `{"schema":"pi-telegram-owner/speaker-map/v1","schema":"pi-telegram-owner/speaker-map/v1","revision":1,"speakers":{}}`;
	await writeFile(current.speakerPath, duplicate, { mode: 0o600 });
	await assert.rejects(() => new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "MANIFEST_INVALID");
});

test("Telegram Desktop nested spoiler accessibility spans are transparent only for aria-hidden true", async (t) => {
	const current = await fixture(t); const htmlPath = join(current.exportRoot, "messages.html");
	const original = await readFile(htmlPath, "utf8");
	const withSpoiler = original.replace("<strong>old</strong><br>one", '<strong>old</strong><br>one <span class="spoiler hidden" onclick="ShowSpoiler(this)"><span aria-hidden="true">hidden</span></span>');
	await writeFile(htmlPath, withSpoiler);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(withSpoiler); source.pages[0].sha256 = sha(withSpoiler);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const options = { exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath } as const;
	const report = await new TelegramArchiveImporter().run(options);
	assert.equal(report.items[0]?.markdown, "**old**\none ||hidden||");

	const invalid = withSpoiler.replace('aria-hidden="true"', 'aria-hidden="false"');
	await writeFile(htmlPath, invalid);
	source.pages[0].size = Buffer.byteLength(invalid); source.pages[0].sha256 = sha(invalid);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	await assert.rejects(() => new TelegramArchiveImporter().run(options), (error: ImportValidationError) => error.code === "HTML_STRUCTURE_UNSUPPORTED");
});

test("WebP sticker wrappers are preserved as exact attachments", async (t) => {
	const current = await fixture(t); const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace('<a class="photo_wrap" href="photos/a.png"><img src="photos/a.png"></a>', '<a class="photo_wrap" href="photos/a.png"><img src="photos/a.png"></a><a class="sticker_wrap" href="stickers/reaction.webp"></a>');
	await mkdir(join(current.exportRoot, "stickers"));
	const webp = Buffer.alloc(30); webp.write("RIFF", 0); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16); webp[24] = 1; webp[27] = 1;
	await writeFile(join(current.exportRoot, "stickers", "reaction.webp"), webp); await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const report = await new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath });
	const sticker = report.items[0]?.attachments.find((attachment) => attachment.sourcePath === "stickers/reaction.webp");
	assert.equal(sticker?.mimeType, "image/webp"); assert.equal(sticker?.size, webp.length); assert.equal(sticker?.sha256, sha(webp));
});

test("Telegram timestamps reject calendar rollover", async (t) => {
	const current = await fixture(t); const htmlPath = join(current.exportRoot, "messages.html");
	const html = (await readFile(htmlPath, "utf8")).replace("2026-02-24T10:00:00Z", "31.02.2026 10:00:00 UTC+00:00");
	await writeFile(htmlPath, html);
	const source = JSON.parse(await readFile(current.sourcePath, "utf8")); source.pages[0].size = Buffer.byteLength(html); source.pages[0].sha256 = sha(html);
	await writeFile(current.sourcePath, JSON.stringify(source), { mode: 0o600 });
	const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); boundary.sourceSetManifestSha256 = sha(await readFile(current.sourcePath));
	await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	await assert.rejects(() => new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "HTML_DATE_INVALID");
});

test("Pi entry timestamps reject calendar rollover", async (t) => {
	const current = await fixture(t); const sessionPath = join(current.sessionRoot, "pi.jsonl");
	await writeFile(sessionPath, (await readFile(sessionPath, "utf8")).replace("2026-09-20T10:00:00Z", "2026-02-31T10:00:00Z"));
	await assert.rejects(() => new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "PI_SESSION_CORRUPT");
});

test("source changes, bad boundaries, unsafe manifests, and cancellation fail closed", async (t) => {
	const current = await fixture(t);
	const importer = new TelegramArchiveImporter();
	await writeFile(join(current.exportRoot, "messages.html"), "changed");
	await assert.rejects(() => importer.run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "SOURCE_CHANGED");
	await chmod(current.sourcePath, 0o644);
	await assert.rejects(() => importer.run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "SOURCE_UNSAFE");
	const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
	await assert.rejects(() => importer.run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath, signal: aborted.signal }), /cancelled/);
});

for (const [name, mutate] of Object.entries({
    missingSessions: (b: any) => { delete b.admittedPiSessionIds; },
    missingMatchKind: (b: any) => { delete b.firstPi.matchKind; },
    invalidMatchKind: (b: any) => { b.firstPi.matchKind = "guess"; },
    unsupportedVersion: (b: any) => { b.schema = "pi-telegram-owner/first-pi-boundary/v2"; },
    otherNamespace: (b: any) => { b.schema = "example-agent/first-pi-boundary/v1"; },
    emptySessions: (b: any) => { b.admittedPiSessionIds = []; },
    duplicateSessions: (b: any) => { b.admittedPiSessionIds = ["pi-session", "pi-session"]; },
    missingAnchorSession: (b: any) => { b.admittedPiSessionIds = ["other-session"]; },
})) test(`single boundary contract rejects ${name} before publication`, async t => {
    const current = await fixture(t);
    const boundary = JSON.parse(await readFile(current.boundaryPath, "utf8")); mutate(boundary);
    await writeFile(current.boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
    await assert.rejects(new TelegramArchiveImporter().run({ exportRoot: current.exportRoot, sourceSetManifestPath: current.sourcePath, boundaryManifestPath: current.boundaryPath, speakerMapPath: current.speakerPath, piSessionRoot: current.sessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: ["pi.jsonl"], checkpointPath: current.checkpointPath }), (error: ImportValidationError) => error.code === "BOUNDARY_INVALID");
    await assert.rejects(stat(current.checkpointPath), { code: "ENOENT" });
    await assert.rejects(stat(current.archiveRoot), { code: "ENOENT" });
});
