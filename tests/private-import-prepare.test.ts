import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { defaultPrivateControlDir, ImportValidationError, prepareTelegramPrivateImport, TelegramArchiveImporter, type BoundaryManifest, type ReadableSpeakerMap } from "../src/importer.ts";

const exec = promisify(execFile);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const message = (name: string | undefined, text: string, time: string) => `<div class="message default${name ? "" : " joined"}">${name ? `<div class="from_name">${name}</div>` : ""}<div class="date" title="${time}"></div><div class="text">${text}</div></div>`;

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "private-import-prepare-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const exportRoot = join(root, "export");
	const piSessionRoot = join(root, "sessions");
	await mkdir(exportRoot, { mode: 0o700 }); await mkdir(piSessionRoot, { mode: 0o700 });
	const pages = {
		"messages.html": message("Owner", "old", "2026-01-01T10:00:00Z") + message(undefined, "older", "2026-01-01T10:01:00Z"),
		"messages2.html": message("Owner", "first pi.", "2026-09-20T10:00:00Z") + message("Agent", "<em>answer</em>", "2026-09-20T10:01:00Z"),
		"messages10.html": '<div class="message service"><div class="body details">service</div></div>',
	};
	for (const [path, html] of Object.entries(pages)) await writeFile(join(exportRoot, path), html);
	const session = [
		{ type: "session", version: 3, id: "session-1", timestamp: "2026-09-20T09:59:00Z", cwd: "/synthetic" },
		{ type: "message", id: "user-1", parentId: null, timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "[telegram-job:synthetic]\nfirst pi." } },
		{ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-09-20T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "_answer_" }] } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await writeFile(join(piSessionRoot, "one.jsonl"), session);
	const controlDir = defaultPrivateControlDir(exportRoot);
	const prepare = { exportRoot, piSessionRoot };
	const paths = { source: join(controlDir, "source.json"), speakers: join(controlDir, "speakers.json"), boundary: join(controlDir, "first-pi-boundary.json"), candidates: join(controlDir, "boundary-candidates.json") };
	const run = { exportRoot, piSessionRoot, piSessionRootId: "pi-sessions", piSessionPaths: [], sourceSetManifestPath: paths.source, speakerMapPath: paths.speakers, boundaryManifestPath: paths.boundary, checkpointPath: join(controlDir, "checkpoint.json"), archiveRoot: join(root, "archive") };
	return { root, exportRoot, piSessionRoot, pages, session, controlDir, prepare, paths, run };
}

async function fillAndConfirm(current: Awaited<ReturnType<typeof fixture>>) {
	await prepareTelegramPrivateImport(current.prepare);
	const speakers = await json(current.paths.speakers) as ReadableSpeakerMap;
	speakers.speakers.Owner = "in"; speakers.speakers.Agent = "out";
	await save(current.paths.speakers, speakers);
	const prepared = await prepareTelegramPrivateImport(current.prepare);
	const boundary = await json(current.paths.boundary);
	const candidates = (await json(current.paths.candidates)).candidates as BoundaryManifest["firstPi"][];
	boundary.firstPi = candidates.find((candidate) => candidate.entryId === "user-1" && candidate.matchKind === "markdown-semantic");
	assert.ok(boundary.firstPi);
	await save(current.paths.boundary, boundary);
	return { prepared, boundary, candidates };
}

test("prepare pins every export page, lists readable senders, and leaves all source evidence unchanged", async (t) => {
	const current = await fixture(t);
	const report = await prepareTelegramPrivateImport(current.prepare);
	assert.deepEqual({ pages: report.pages, messages: report.messages, senders: report.senders, placeholders: report.placeholders, candidates: report.candidates, sessions: report.admittedPiSessionIds }, { pages: 3, messages: 4, senders: ["Agent", "Owner"], placeholders: ["Owner", "Agent"], candidates: 0, sessions: ["session-1"] });
	assert.match(report.nextStep, /Fill directions.*--prepare/);
	const source = await json(current.paths.source);
	assert.deepEqual(source.pages, Object.entries(current.pages).map(([path, html]) => ({ path, size: Buffer.byteLength(html), sha256: sha(html) })));
	assert.equal(source.messageCount, 4);
	assert.deepEqual((await json(current.paths.speakers)).speakers, { Owner: "<placeholder>", Agent: "<placeholder>" });
	assert.equal((await json(current.paths.speakers)).keyEncoding, "display-name");
	const boundary = await json(current.paths.boundary);
	assert.equal(boundary.sourceSetManifestSha256, sha(await readFile(current.paths.source)));
	assert.equal(boundary.firstPi, "<placeholder>");
	for (const path of Object.values(current.paths)) assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(current.controlDir)).mode & 0o777, 0o700);
	assert.deepEqual((await readdir(current.exportRoot)).sort(), Object.keys(current.pages).sort());
	for (const [path, html] of Object.entries(current.pages)) assert.equal(await readFile(join(current.exportRoot, path), "utf8"), html);
	assert.equal(await readFile(join(current.piSessionRoot, "one.jsonl"), "utf8"), current.session);
});

test("dry-run and commit refuse placeholders with the file and entry identified", async (t) => {
	const current = await fixture(t); await prepareTelegramPrivateImport(current.prepare);
	const importer = new TelegramArchiveImporter();
	for (const dryRun of [true, false]) await assert.rejects(() => importer.run({ ...current.run, dryRun }), (error: ImportValidationError) => error.code === "MANIFEST_INCOMPLETE" && error.message.includes(current.paths.boundary) && error.message.includes('firstPi'));
	// The placeholder refusal is before shape validation, so another file's
	// unfinished entry is reported even when this boundary is not yet valid.
	const boundary = await json(current.paths.boundary); boundary.firstPi = {};
	await save(current.paths.boundary, boundary);
	await assert.rejects(() => importer.run(current.run), (error: ImportValidationError) => error.code === "MANIFEST_INCOMPLETE" && error.message.includes(current.paths.speakers) && error.message.includes('Owner'));
	await assert.rejects(() => stat(current.run.checkpointPath), { code: "ENOENT" });
	await assert.rejects(() => stat(current.run.archiveRoot), { code: "ENOENT" });
});

test("confirmed generated anchors dry-run and commit end to end; repeated commit is unchanged", async (t) => {
	const current = await fixture(t);
	const { candidates, boundary } = await fillAndConfirm(current);
	assert.ok(candidates.some((candidate) => candidate.entryId === "user-1" && candidate.matchKind === "raw-source-text"));
	assert.equal(boundary.firstPi.globalMessageOrdinal, 3);
	const reprepare = await prepareTelegramPrivateImport(current.prepare);
	assert.deepEqual((await json(current.paths.boundary)).firstPi, boundary.firstPi);
	assert.deepEqual(reprepare.placeholders, []);
	const importer = new TelegramArchiveImporter();
	const report = await importer.run(current.run);
	assert.deepEqual({ historical: report.historical, aligned: report.piAligned, unresolved: report.unresolvedPostBoundary, missing: report.coverageMissing }, { historical: 2, aligned: 2, unresolved: 0, missing: 0 });
	assert.equal(report.items[2]?.pi?.entrySha256, sha(current.session.trimEnd().split("\n")[1]!));
	const committed = await importer.run({ ...current.run, dryRun: false });
	assert.equal(committed.publication?.published, 4);
	assert.deepEqual((await importer.run({ ...current.run, dryRun: false })).publication, { published: 0, unchanged: 4, attachments: 0, mediaEvents: 0 });
});

test("prepared imports refuse source mutation after reviewed dry-run", async (t) => {
	const current = await fixture(t); await fillAndConfirm(current);
	const importer = new TelegramArchiveImporter(); await importer.run(current.run);
	await writeFile(join(current.exportRoot, "messages2.html"), current.pages["messages2.html"] + "\n");
	await assert.rejects(() => importer.run({ ...current.run, dryRun: false }), (error: ImportValidationError) => error.code === "SOURCE_CHANGED");
	await assert.rejects(() => stat(current.run.archiveRoot), { code: "ENOENT" });
});

test("prepare preserves operator edits and admits only the selected session input scope", async (t) => {
	const current = await fixture(t);
	await writeFile(join(current.piSessionRoot, "unselected.jsonl"), "not a session\n");
	const options = { ...current.prepare, piSessionPaths: ["one.jsonl"] };
	await prepareTelegramPrivateImport(options);
	const speakers = await json(current.paths.speakers); speakers.revision = 7; speakers.speakers.Owner = "in";
	await save(current.paths.speakers, speakers);
	await writeFile(join(current.exportRoot, "messages10.html"), message("New sender", "new", "2026-10-01T10:00:00Z"));
	const report = await prepareTelegramPrivateImport(options);
	assert.deepEqual(report.admittedPiSessionIds, ["session-1"]);
	assert.deepEqual((await json(current.paths.speakers)).speakers, { Owner: "in", Agent: "<placeholder>", "New sender": "<placeholder>" });
	assert.equal((await json(current.paths.speakers)).revision, 7);
	assert.equal((await json(current.paths.source)).messageCount, 5);
});

test("prepare preserves reviewed session exclusions and existing admission validation", async (t) => {
	const current = await fixture(t);
	await writeFile(join(current.piSessionRoot, "two.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "session-2" })}\n`);
	await prepareTelegramPrivateImport(current.prepare);
	assert.deepEqual((await json(current.paths.boundary)).admittedPiSessionIds, ["session-1", "session-2"]);
	const boundary = await json(current.paths.boundary); boundary.admittedPiSessionIds = ["session-1"];
	await save(current.paths.boundary, boundary);
	await prepareTelegramPrivateImport(current.prepare);
	assert.deepEqual((await json(current.paths.boundary)).admittedPiSessionIds, ["session-1"]);
	boundary.admittedPiSessionIds = ["missing-session"]; await save(current.paths.boundary, boundary);
	await assert.rejects(() => prepareTelegramPrivateImport(current.prepare), (error: ImportValidationError) => error.code === "PI_SESSION_COVERAGE_UNSUPPORTED");
});

test("no exact candidates produces actionable guidance, not a fuzzy or automatic anchor", async (t) => {
	const current = await fixture(t); await fillAndConfirm(current);
	await writeFile(join(current.piSessionRoot, "one.jsonl"), current.session.replace("first pi.", "different").replace("_answer_", "unrelated"));
	const boundary = await json(current.paths.boundary); boundary.firstPi = "<placeholder>"; await save(current.paths.boundary, boundary);
	const report = await prepareTelegramPrivateImport(current.prepare);
	assert.equal(report.candidates, 0); assert.match(report.nextStep, /No exact boundary candidates.*selected Pi sessions/);
	assert.equal((await json(current.paths.boundary)).firstPi, "<placeholder>");
});

test("control directory cannot modify the export, including through a symlinked parent", async (t) => {
	const current = await fixture(t);
	await symlink(current.exportRoot, join(current.root, "alias"));
	for (const controlDir of [current.exportRoot, join(current.exportRoot, "controls"), join(current.root, "alias", "controls")]) await assert.rejects(() => prepareTelegramPrivateImport({ ...current.prepare, controlDir }), /outside the export root/);
	assert.deepEqual((await readdir(current.exportRoot)).sort(), Object.keys(current.pages).sort());
});

test("a generated raw-source-text candidate is accepted without manual hashes", async (t) => {
	const current = await fixture(t); const { candidates, boundary } = await fillAndConfirm(current);
	boundary.firstPi = candidates.find((candidate) => candidate.entryId === "user-1" && candidate.matchKind === "raw-source-text");
	await save(current.paths.boundary, boundary);
	assert.equal((await new TelegramArchiveImporter().run(current.run)).piAligned, 2);
});

test("existing hashed speaker controls remain usable and can be prepared without losing filled directions", async (t) => {
	const current = await fixture(t); await fillAndConfirm(current);
	await save(current.paths.speakers, { schema: "pi-telegram-owner/speaker-map/v1", revision: 3, speakers: { [sha("Owner")]: "in", [sha("Agent")]: "out" } });
	assert.equal((await new TelegramArchiveImporter().run(current.run)).piAligned, 2);
	const report = await prepareTelegramPrivateImport(current.prepare);
	assert.deepEqual(report.placeholders, []);
	assert.deepEqual((await json(current.paths.speakers)).speakers, { Owner: "in", Agent: "out" });
	assert.equal((await json(current.paths.speakers)).revision, 3);
	assert.equal((await new TelegramArchiveImporter().run(current.run)).piAligned, 2);
});

test("custom control directory is used by all private CLI phases", async (t) => {
	const current = await fixture(t);
	const controlDir = join(current.root, "custom-controls");
	const common = [join(process.cwd(), "src/cli/telegram-archive-import.ts"), "--export-root", current.exportRoot, "--pi-session-root", current.piSessionRoot, "--control-dir", controlDir];
	await exec(process.execPath, [...common, "--prepare"]);
	const speakerPath = join(controlDir, "speakers.json");
	const speakers = await json(speakerPath); speakers.speakers.Owner = "in"; speakers.speakers.Agent = "out"; await save(speakerPath, speakers);
	await exec(process.execPath, [...common, "--prepare"]);
	const boundaryPath = join(controlDir, "first-pi-boundary.json");
	const boundary = await json(boundaryPath); boundary.firstPi = (await json(join(controlDir, "boundary-candidates.json"))).candidates[0]; await save(boundaryPath, boundary);
	assert.equal(JSON.parse((await exec(process.execPath, common)).stdout).piAligned, 2);
	assert.equal(JSON.parse((await exec(process.execPath, [...common, "--commit", "--output-root", current.run.archiveRoot])).stdout).publication.published, 4);
	await assert.rejects(() => stat(current.controlDir), { code: "ENOENT" });
});

test("private CLI supports prepare, fill, re-prepare, dry-run, review and commit with default controls", async (t) => {
	const current = await fixture(t);
	const cli = join(process.cwd(), "src/cli/telegram-archive-import.ts");
	const common = [cli, "--export-root", current.exportRoot, "--pi-session-root", current.piSessionRoot];
	assert.equal(JSON.parse((await exec(process.execPath, [...common, "--prepare"])).stdout).messages, 4);
	const speakers = await json(current.paths.speakers); speakers.speakers.Owner = "in"; speakers.speakers.Agent = "out"; await save(current.paths.speakers, speakers);
	await exec(process.execPath, [...common, "--prepare"]);
	const boundary = await json(current.paths.boundary); boundary.firstPi = (await json(current.paths.candidates)).candidates[0]; await save(current.paths.boundary, boundary);
	const dry = JSON.parse((await exec(process.execPath, common)).stdout);
	assert.equal(dry.mode, "dry-run"); assert.equal(dry.piAligned, 2);
	const commit = JSON.parse((await exec(process.execPath, [...common, "--commit", "--output-root", current.run.archiveRoot])).stdout);
	assert.equal(commit.publication.published, 4);
	await assert.rejects(() => exec(process.execPath, [...common, "--prepare", "--commit"]), /Choose --prepare/);
});
