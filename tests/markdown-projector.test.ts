import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ArchiveCorruptionError, ArchiveSafetyError, TelegramMarkdownProjector } from "../src/markdown-projector.ts";
import { outboundPhotoDeliveryKey, turnFailureNotice, type TurnFailureCode, type JournalRecord } from "../src/core.ts";

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string, timestamp: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: role === "user"
			? { role, content: text, timestamp: Date.parse(timestamp) }
			: { role, content: [{ type: "text", text }], timestamp: Date.parse(timestamp), api: "synthetic", provider: "synthetic", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" },
	} as SessionEntry;
}

function session(root: string, entries: SessionEntry[]): ReadonlySessionManager {
	return {
		getSessionId: () => "session-1",
		getSessionFile: () => join(root, "session.jsonl"),
		getBranch: () => entries,
	} as ReadonlySessionManager;
}

async function persistSession(root: string, entries: SessionEntry[]): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(join(root, "session.jsonl"), `${[{ type: "session", version: 3, id: "session-1", timestamp: "2026-09-22T00:00:00.000Z", cwd: "/synthetic" }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

function createProjector(root: string, sessionRoot: string): TelegramMarkdownProjector {
	return new TelegramMarkdownProjector({ enabled: true, root, sessionRoot, rootId: "pi-sessions" }, { bootIdentity: () => ({ id: "synthetic-boot", startedAtMs: 1 }), pidState: (pid) => pid === process.pid ? "alive" : "dead" });
}

function records(): JournalRecord[] {
	return [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: "2026-09-22T01:00:00.000Z", jobId: "job-1", messageId: 10, text: "hello", rawText: "hello", chatId: 70, userId: 7 },
		{ type: "dispatched", jobId: "job-1", sessionId: "session-1" },
		{ type: "reply_ready", jobId: "job-1", text: "**world**", timestamp: "2026-09-22T01:00:02.000Z" },
		{ type: "reply_plan", jobId: "job-1", renderer: "telegram-html-v1", rawSha256: "0".repeat(64), chunks: [{ index: 0, format: "HTML", payload: "<b>world</b>", plainFallback: "world", payloadSha256: "0".repeat(64) }] },
		{ type: "reply_chunk_sent", jobId: "job-1", index: 0, messageId: "11", format: "HTML", timestamp: "2026-09-22T01:00:03.000Z" },
		{ type: "reply_sent", jobId: "job-1", messageIds: ["11"], timestamp: "2026-09-22T01:00:03.000Z" },
	];
}

function frontmatter(note: string): Record<string, any> {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(note);
	assert.ok(match);
	return parseYaml(match[1]!) as Record<string, any>;
}

function noteBody(note: string): string {
	const match = /^---\n[\s\S]*?\n---\n\n([\s\S]*?)\n\n---\nPrevious:/.exec(note);
	assert.ok(match);
	return match[1]!;
}

for (const lifecycle of [false,true]) test(`interruption notices survive projector restart without impersonating Pi entries (lifecycle=${lifecycle})`, async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-interrupted-reply-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"), message("asst0001", "user0001", "assistant", "Partial answer", "2026-09-22T01:00:02.000Z")];
	(entries[1] as any).message.stopReason = "aborted";
	await persistSession(sessionRoot, entries);
	const original = await readFile(join(sessionRoot, "session.jsonl"), "utf8");
	const journal = records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type));
	journal.push({ type: "interrupted", jobId: "job-1", reason: "Stopped by Telegram owner command" });
	if(lifecycle)journal.push({type:'task_output',taskId:'job-1',jobId:'job-1',mode:'terminal',disposition:'failed',timestamp:'2026-09-22T01:00:03.000Z'});
	journal.push({ type: "reply_ready", jobId: "job-1", text: "Stopped by /stop." }, { type: "reply_sent", jobId: "job-1", messageIds: ["11"] });
	const append = async (record: JournalRecord) => { journal.push(record); };
	assert.deepEqual(await createProjector(archiveRoot, sessionRoot).reconcile(journal, session(sessionRoot, entries), append), { projected: 2, unchanged: 0, deferred: 0 });
	const restarted = createProjector(archiveRoot, sessionRoot);
	assert.deepEqual(await restarted.reconcile(journal, session(sessionRoot, entries), append), { projected: 0, unchanged: 2, deferred: 0 });
	const recent = await restarted.timeline({ operation: "recent", limit: 2 });
	const notice = recent.messages!.find((item) => item.content === "Stopped by /stop.")!;
	assert.equal(notice.messageId, "tgmsg:v1:telegram-job:job-1:local-response");
	assert.equal(await readFile(join(sessionRoot, "session.jsonl"), "utf8"), original);
	entries.push(message("user0002", "asst0001", "user", "[telegram-job:job-2]\nhello", "2026-09-22T02:00:01.000Z"), message("asst0002", "user0002", "assistant", "**world**", "2026-09-22T02:00:02.000Z"));
	await persistSession(sessionRoot, entries);
	journal.push(...records().map((record) => ({ ...record, ...("jobId" in record ? { jobId: "job-2" } : {}), ...(record.type === "update" ? { updateId: 2, messageId: 12 } : {}) })));
	assert.deepEqual(await restarted.reconcile(journal, session(sessionRoot, entries), append), { projected: 2, unchanged: 2, deferred: 0 });
	const replayed = createProjector(archiveRoot, sessionRoot);
	assert.deepEqual(await replayed.reconcile(journal, session(sessionRoot, entries), append), { projected: 0, unchanged: 4, deferred: 0 });
	assert.equal((await replayed.timeline({ operation: "recent", limit: 1 })).messages![0].messageId, "tgmsg:v1:pi:session-1:asst0002");
	// An interruption alone must not exempt an earlier assistant reply from validation.
	const invalid = records();
	invalid.push({ type: "interrupted", jobId: "job-1", reason: "later interruption without a notice" });
	await assert.rejects(() => createProjector(join(base, "invalid"), sessionRoot).reconcile(invalid, session(sessionRoot, entries), async () => undefined), /Canonical Pi assistant content changed/);
});

for (const failure of [false,true]) test(`generated work-item notice recovers later private backlog across lifecycle metadata (modelFailure=${failure})`,async t=>{
 const base=await mkdtemp(join(tmpdir(),'telegram-stop-work-item-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=join(base,'archive'),sessions=join(base,'sessions');
 const item={itemId:'11111111-2222-4333-8444-555555555555',channel:'endpoint' as const,authority:'owner' as const,sender:'fixture',text:'Compute the fixture.',reply:{kind:'private' as const},timestamp:'2026-09-22T01:00:00.000Z'};
 const {renderWorkItemPrompt}=await import('../src/core.ts');
 const entries=[message('u1',null,'user',`[telegram-item:${item.itemId}]\n${renderWorkItemPrompt(item)}`,'2026-09-22T01:00:01.000Z'),message('a1','u1','assistant','','2026-09-22T01:00:02.000Z')];
 Object.assign((entries[1] as any).message,{stopReason:failure?'error':'aborted',content:failure?[]:[{type:'thinking',thinking:'Synthetic placeholder only.'}]});
 const notice=failure?turnFailureNotice('MODEL_ERROR'):'Stopped by /stop.';
 const terminal:JournalRecord=failure?{type:'turn_failed',jobId:item.itemId,code:'MODEL_ERROR',timestamp:'2026-09-22T01:00:03.000Z'}:{type:'interrupted',jobId:item.itemId,reason:'Stopped by Telegram owner command'};
 await persistSession(sessions,entries);const journal:JournalRecord[]=[{type:'work_item',schemaVersion:1,...item},{type:'dispatched',jobId:item.itemId,sessionId:'session-1'},terminal,{type:'task_output',taskId:item.itemId,jobId:item.itemId,mode:'terminal',disposition:'failed',timestamp:'2026-09-22T01:00:03.000Z'},{type:'reply_ready',jobId:item.itemId,text:notice},{type:'reply_sent',jobId:item.itemId,messageIds:['11']}];
 const append=async(r:JournalRecord)=>{journal.push(r);};
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:1,unchanged:0,deferred:0});
 const first=await createProjector(root,sessions).timeline({operation:'recent',limit:5});assert.equal(first.messages!.length,1);assert.equal(first.messages![0].messageId,`tgmsg:v1:telegram-job:${item.itemId}:local-response`);assert.equal(first.messages![0].content,notice);
 const originalNote=await readFile(join(root,first.messages![0].path));
 entries.push(message('u2','a1','user','[telegram-job:job-1]\nhello','2026-09-22T02:00:01.000Z'),message('a2','u2','assistant','**world**','2026-09-22T02:00:02.000Z'));await persistSession(sessions,entries);journal.push(...records());
 const source=await readFile(join(sessions,'session.jsonl')),prefix=JSON.stringify(journal);
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:2,unchanged:1,deferred:0});
 assert.deepEqual(await readFile(join(root,first.messages![0].path)),originalNote);assert.deepEqual(await readFile(join(sessions,'session.jsonl')),source);assert.equal(JSON.stringify(journal.slice(0,JSON.parse(prefix).length)),prefix);
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:0,unchanged:3,deferred:0});
 const all=await createProjector(root,sessions).timeline({operation:'recent',limit:5});assert.equal(all.messages!.length,3);assert.equal(all.messages!.some(m=>m.messageId==='tgmsg:v1:pi:session-1:a1'),false);
});

for(const staleInterruption of [false,true])test(`task output never exempts a changed canonical answer (stale interruption=${staleInterruption})`,async t=>{
 const base=await mkdtemp(join(tmpdir(),'telegram-stop-integrity-'));t.after(()=>rm(base,{recursive:true,force:true}));const root=join(base,'archive'),sessions=join(base,'sessions');
 const entries=[message('u1',null,'user','[telegram-job:job-1]\nhello','2026-09-22T01:00:01.000Z'),message('a1','u1','assistant','Changed answer.','2026-09-22T01:00:02.000Z')];await persistSession(sessions,entries);
 const journal=records();journal.splice(1,0,...(staleInterruption?[{type:'interrupted' as const,jobId:'job-1',reason:'Earlier stopped attempt'}]:[]));
 journal.splice(journal.findIndex(r=>r.type==='reply_ready'),0,{type:'task_output',taskId:'job-1',jobId:'job-1',mode:'terminal',disposition:'completed',timestamp:'2026-09-22T01:00:03.000Z'});
 await assert.rejects(createProjector(root,sessions).reconcile(journal,session(sessions,entries),async()=>undefined),/Canonical Pi assistant content changed/);
});

for (const code of ['LENGTH','ABORTED','MODEL_ERROR','NO_REPLY'] as TurnFailureCode[]) for (const lifecycle of [false,true]) test(`generated ${code} notice recovers backlog without impersonating model text (lifecycle=${lifecycle})`, async t => {
 const base=await mkdtemp(join(tmpdir(),'telegram-failure-notice-'));t.after(()=>rm(base,{recursive:true,force:true}));const root=join(base,'archive'),sessions=join(base,'sessions');
 const entries=[message('u1',null,'user','[telegram-job:job-1]\nhello','2026-09-22T01:00:01.000Z'),message('a1','u1','assistant',code==='LENGTH'?'Partial synthetic answer':'','2026-09-22T01:00:02.000Z')];
 (entries[1] as any).message.stopReason=code==='LENGTH'?'length':code==='ABORTED'?'aborted':code==='MODEL_ERROR'?'error':'stop';
 await persistSession(sessions,entries);
 const journal:JournalRecord[]=records().filter(r=>!['reply_ready','reply_plan','reply_chunk_sent','reply_sent'].includes(r.type));
 journal.push({type:'turn_failed',jobId:'job-1',code,timestamp:'2026-09-22T01:00:03.000Z'});
 if(lifecycle)journal.push({type:'task_output',taskId:'job-1',jobId:'job-1',mode:'terminal',disposition:'failed',timestamp:'2026-09-22T01:00:03.001Z'});
 journal.push({type:'reply_ready',jobId:'job-1',text:turnFailureNotice(code)},{type:'reply_sent',jobId:'job-1',messageIds:['11']});
 const append=async(r:JournalRecord)=>{journal.push(r);};
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:2,unchanged:0,deferred:0});
 const first=await createProjector(root,sessions).timeline({operation:'recent',limit:5});const notice=first.messages!.find(m=>m.direction==='out')!;
 assert.equal(notice.messageId,'tgmsg:v1:telegram-job:job-1:local-response');assert.equal(notice.content,turnFailureNotice(code));const note=await readFile(join(root,notice.path));
 entries.push(message('u2','a1','user','[telegram-job:job-2]\nhello','2026-09-22T02:00:01.000Z'),message('a2','u2','assistant','**world**','2026-09-22T02:00:02.000Z'));await persistSession(sessions,entries);
 journal.push(...records().map(r=>({...r,...('jobId'in r?{jobId:'job-2'}:{}),...(r.type==='update'?{updateId:2,messageId:12}:{})})));
 const source=await readFile(join(sessions,'session.jsonl')),prefix=JSON.stringify(journal);
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:2,unchanged:2,deferred:0});
 assert.deepEqual(await readFile(join(root,notice.path)),note);assert.deepEqual(await readFile(join(sessions,'session.jsonl')),source);assert.equal(JSON.stringify(journal.slice(0,JSON.parse(prefix).length)),prefix);
 assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:0,unchanged:4,deferred:0});
});
for (const variant of ['changed-notice','earlier-failure','later-failure'] as const) test(`failure metadata does not excuse canonical changes: ${variant}`,async t=>{
 const base=await mkdtemp(join(tmpdir(),'telegram-failure-integrity-'));t.after(()=>rm(base,{recursive:true,force:true}));const root=join(base,'archive'),sessions=join(base,'sessions');
 const entries=[message('u1',null,'user','[telegram-job:job-1]\nhello','2026-09-22T01:00:01.000Z'),message('a1','u1','assistant','Canonical answer differs.','2026-09-22T01:00:02.000Z')];await persistSession(sessions,entries);
 const journal=records();const failure:JournalRecord={type:'turn_failed',jobId:'job-1',code:'MODEL_ERROR',timestamp:'2026-09-22T01:00:02.000Z'};
 if(variant==='changed-notice')journal.splice(journal.findIndex(r=>r.type==='reply_ready'),0,failure);
 else if(variant==='earlier-failure')journal.splice(1,0,failure);
 else journal.push(failure);
 if(variant!=='changed-notice')(journal.find(r=>r.type==='reply_ready') as any).text=turnFailureNotice('MODEL_ERROR');
 await assert.rejects(createProjector(root,sessions).reconcile(journal,session(sessions,entries),async()=>undefined),/Canonical Pi assistant content changed/);
});

test("projector writes Pi-entry notes atomically and converges metadata idempotently", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive");
	const sessionRoot = join(base, "sessions");
	const entries = [
		message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"),
		message("asst0001", "user0001", "assistant", "**world**", "2026-09-22T01:00:02.000Z"),
	];
	await persistSession(sessionRoot, entries);
	const journal = records();
	const append = async (record: Extract<JournalRecord, { type: "projection_needed" | "projection_committed" | "projection_deferred" }>) => { journal.push(record); };
	const projector = createProjector(archiveRoot, sessionRoot);
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), append), { projected: 2, unchanged: 0, deferred: 0 });
	const year = join(archiveRoot, "messages", "2026", "09");
	const files = await readdir(year);
	assert.equal(files.length, 2);
	const outgoingPath = join(year, files.find((file) => file.endsWith("-assistant.md"))!);
	const outgoing = await readFile(outgoingPath, "utf8");
	const metadata = frontmatter(outgoing);
	assert.equal(metadata.messageId, "tgmsg:v1:pi:session-1:asst0001");
	assert.equal(metadata.sessionSource.rootId, "pi-sessions");
	assert.equal(metadata.sessionSource.path, "session.jsonl");
	assert.equal(metadata.sessionSource.entryLine, 3);
	assert.equal(typeof metadata.sessionSource.entryByteOffset, "number");
	assert.match(metadata.sessionSource.entrySha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(metadata.telegramMessageIds, ["11"]);
	assert.equal(metadata.chunk.transportCompleteness, "complete");
	assert.match(outgoing, /\n\*\*world\*\*\n/);
	const incomingName = files.find((file) => file.endsWith("-user.md"))!.replace(/\.md$/, "");
	assert.match(outgoing, new RegExp(`Previous: \\[\\[${incomingName}\\]\\]`));

	const second = await projector.reconcile(journal, session(sessionRoot, entries), append);
	assert.deepEqual(second, { projected: 0, unchanged: 2, deferred: 0 });
	assert.equal((await readdir(year)).length, 2);

	const recent = await projector.timeline({ operation: "recent", unit: "messages", limit: 1 });
	assert.equal(recent.timezone, "UTC");
	assert.equal(recent.count, 1);
	assert.equal(recent.messages?.[0]?.messageId, "tgmsg:v1:pi:session-1:asst0001");
	assert.equal(recent.messages?.[0]?.content, "**world**");
	const exchanges = await projector.timeline({ operation: "recent", unit: "exchanges", limit: 1 });
	assert.equal(exchanges.count, 1);
	assert.equal(exchanges.exchanges?.[0]?.request.content, "hello");
	assert.deepEqual(exchanges.exchanges?.[0]?.responses.map((item) => item.content), ["**world**"]);
	const count = await projector.timeline({ operation: "count", start: "2026-09-22T01:00:00Z", end: "2026-09-22T01:00:02Z" });
	assert.equal(count.count, 1, "the half-open end excludes the assistant message at exactly 01:00:02Z");
	await assert.rejects(() => projector.timeline({ operation: "range", start: "2026-09-22", end: "2026-09-23" }), /explicit offset/);
	await assert.rejects(() => projector.timeline({ operation: "recent", unit: "exchanges", direction: "in" }), /bounds/);
	await writeFile(outgoingPath, outgoing.replace("**world**", "tampered"));
	await assert.rejects(() => projector.timeline({ operation: "recent", limit: 1 }), ArchiveCorruptionError);
});

test("projector emits one Pi note for a coalesced inbound batch with segment provenance", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-markdown-batch-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const batchId = "00000000-0000-4000-8000-000000000001";
	const entries = [message("user0001", null, "user", `[telegram-batch:${batchId}]\nfirst\n\nsecond`, "2026-09-22T01:00:01.000Z")];
	await persistSession(sessionRoot, entries);
	const firstHash = "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e";
	const secondHash = "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4";
	const journal: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: "2026-09-22T01:00:00.000Z", jobId: "member-1", messageId: 10, text: "first", chatId: 70, userId: 7 },
		{ type: "inbound_batch", schemaVersion: 1, batchId, revision: 1, state: "open", openedAt: "2026-09-22T01:00:00.000Z", readyAt: "2026-09-22T01:00:00.500Z", memberJobIds: ["member-1"], messageIds: [10], segmentSha256: [firstHash], boundaries: [{ start: 0, end: 5 }], text: "first", finalMessageId: 10 },
		{ type: "update", schemaVersion: 2, updateId: 2, disposition: "accepted", timestamp: "2026-09-22T01:00:00.100Z", jobId: "member-2", messageId: 20, text: "second", chatId: 70, userId: 7 },
		{ type: "inbound_batch", schemaVersion: 1, batchId, revision: 2, state: "dispatching", openedAt: "2026-09-22T01:00:00.000Z", readyAt: "2026-09-22T01:00:00.600Z", memberJobIds: ["member-1", "member-2"], messageIds: [10, 20], segmentSha256: [firstHash, secondHash], boundaries: [{ start: 0, end: 5 }, { start: 7, end: 13 }], text: "first\n\nsecond", finalMessageId: 20 },
		{ type: "dispatched", jobId: batchId, sessionId: "session-1" },
	];
	const projector = createProjector(archiveRoot, sessionRoot);
	assert.equal((await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); })).projected, 1);
	const directory = join(archiveRoot, "messages", "2026", "09");
	const files = await readdir(directory);
	assert.equal(files.length, 1);
	assert.equal(files[0], "20260922-010001000-user.md");
	const metadata = frontmatter(await readFile(join(directory, files[0]!), "utf8"));
	assert.equal(metadata.inboundBatch.batchId, batchId);
	assert.deepEqual(metadata.inboundBatch.memberJobIds, ["member-1", "member-2"]);
	assert.deepEqual(metadata.telegramMessageIds, ["10", "20"]);
	assert.equal(metadata.chunk.transportCount, 2);
});

test("batched and unbatched projection preserves deterministic update chronology", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-projector-order-")); t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions"); const batchId = "00000000-0000-4000-8000-000000000001";
	const entries = [
		message("user-before", null, "user", "[telegram-job:job-before]\nbefore", "2026-09-22T01:00:01.000Z"),
		message("user-batch", "user-before", "user", `[telegram-batch:${batchId}]\nfirst\n\nsecond`, "2026-09-22T01:00:02.000Z"),
		message("user-after", "user-batch", "user", "[telegram-job:job-after]\nafter", "2026-09-22T01:00:03.000Z"),
	];
	await persistSession(sessionRoot, entries);
	const journal: JournalRecord[] = [
		{ type: "update", updateId: 1, disposition: "accepted", timestamp: "2026-09-22T01:00:01.000Z", jobId: "job-before", messageId: 10, text: "before" }, { type: "dispatched", jobId: "job-before", sessionId: "session-1" },
		{ type: "update", updateId: 2, disposition: "accepted", timestamp: "2026-09-22T01:00:02.000Z", jobId: "member-1", messageId: 20, text: "first" },
		{ type: "update", updateId: 3, disposition: "accepted", timestamp: "2026-09-22T01:00:02.100Z", jobId: "member-2", messageId: 30, text: "second" },
		{ type: "inbound_batch", schemaVersion: 1, batchId, revision: 1, state: "dispatching", openedAt: "2026-09-22T01:00:02.000Z", readyAt: "2026-09-22T01:00:02.600Z", memberJobIds: ["member-1", "member-2"], messageIds: [20, 30], segmentSha256: ["a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e", "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4"], boundaries: [{ start: 0, end: 5 }, { start: 7, end: 13 }], text: "first\n\nsecond", finalMessageId: 30 }, { type: "dispatched", jobId: batchId, sessionId: "session-1" },
		{ type: "update", updateId: 4, disposition: "accepted", timestamp: "2026-09-22T01:00:03.000Z", jobId: "job-after", messageId: 40, text: "after" }, { type: "dispatched", jobId: "job-after", sessionId: "session-1" },
	];
	await createProjector(archiveRoot, sessionRoot).reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); });
	const manifest = JSON.parse(await readFile(join(archiveRoot, "messages", ".telegram-archive", "manifest.json"), "utf8"));
	assert.equal(manifest.messages["tgmsg:v1:pi:session-1:user-before"].predecessor, null);
	assert.equal(manifest.messages["tgmsg:v1:pi:session-1:user-batch"].predecessor, "tgmsg:v1:pi:session-1:user-before");
	assert.equal(manifest.messages["tgmsg:v1:pi:session-1:user-after"].predecessor, "tgmsg:v1:pi:session-1:user-batch");
});

test("missing projection commit is recovered without rewriting canonical note", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-crash-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive");
	const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")];
	await persistSession(sessionRoot, entries);
	const journal = records().filter((record) => record.type !== "reply_ready" && record.type !== "reply_plan" && record.type !== "reply_chunk_sent" && record.type !== "reply_sent");
	let failCommit = true;
	const projector = createProjector(archiveRoot, sessionRoot);
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async (record) => {
		if (record.type === "projection_committed" && failCommit) { failCommit = false; throw new Error("synthetic journal fsync failure"); }
		journal.push(record);
	}), /synthetic journal/);
	assert.equal((await readdir(join(archiveRoot, "messages", "2026", "09"))).length, 1);
	const recovered: JournalRecord[] = [];
	await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); recovered.push(record); });
	assert.equal(recovered.some((record) => record.type === "projection_committed"), true);
});

test("note-before-manifest and stale writer lock recover without duplicating notes", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-recovery-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")];
	await persistSession(sessionRoot, entries);
	const journal = records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type));
	const projector = createProjector(archiveRoot, sessionRoot);
	await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); });
	await unlink(join(archiveRoot, "messages", ".telegram-archive", "manifest.json"));
	const recovered = await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); });
	assert.equal(recovered.projected, 1);
	assert.equal((await readdir(join(archiveRoot, "messages", "2026", "09"))).length, 1);
	const stateRoot = join(archiveRoot, "messages", ".telegram-archive");
	await writeFile(join(stateRoot, "lock"), `${JSON.stringify({ pid: 999_999, nonce: "00000000-0000-4000-8000-000000000000", bootId: "synthetic-boot" })}\n`, { mode: 0o600 });
	const staleTemporary = join(stateRoot, ".manifest.json.999999.0123456789abcdef.tmp");
	await writeFile(staleTemporary, "incomplete", { mode: 0o600 });
	assert.equal((await projector.reconcile(journal, session(sessionRoot, entries), async () => undefined)).unchanged, 1);
	await assert.rejects(() => lstat(staleTemporary), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("tampered notes and manifests fail closed", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-tamper-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")];
	await persistSession(sessionRoot, entries);
	const journal = records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type));
	const projector = createProjector(archiveRoot, sessionRoot);
	await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); });
	const notePath = join(archiveRoot, "messages", "2026", "09", (await readdir(join(archiveRoot, "messages", "2026", "09")))[0]!);
	await writeFile(notePath, (await readFile(notePath, "utf8")).replace("Previous: none (conversation start)", "Previous: [[wrong-note]]"), { mode: 0o600 });
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), /navigation/i);
	await rm(archiveRoot, { recursive: true, force: true });
	await projector.reconcile(journal.filter((record) => !record.type.startsWith("projection_")), session(sessionRoot, entries), async () => undefined);
	await writeFile(join(archiveRoot, "messages", ".telegram-archive", "manifest.json"), "{\"schema\":\"pi-telegram-owner/archive-manifest/v1\"}\n", { mode: 0o600 });
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), /manifest/i);
});

test("durable receipts converge metadata only and remain idempotent", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-metadata-")); t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"), message("asst0001", "user0001", "assistant", "**world**", "2026-09-22T01:00:02.000Z")];
	await persistSession(sessionRoot, entries);
	const full = records(); const journal = full.filter((record) => !["reply_chunk_sent", "reply_sent"].includes(record.type));
	const projector = createProjector(archiveRoot, sessionRoot); const append = async (record: JournalRecord) => { journal.push(record); };
	await projector.reconcile(journal, session(sessionRoot, entries), append);
	const directory = join(archiveRoot, "messages", "2026", "09"); const outgoingPath = join(directory, (await readdir(directory)).find((file) => file.endsWith("-assistant.md"))!);
	const beforeText = await readFile(outgoingPath, "utf8"); const before = frontmatter(beforeText); const beforeBody = noteBody(beforeText);
	assert.equal(before.chunk.transportCompleteness, "pending"); assert.deepEqual(before.telegramMessageIds, []); assert.equal(before.contentRevision, 1);
	journal.push(...full.filter((record) => ["reply_chunk_sent", "reply_sent"].includes(record.type)));
	await projector.reconcile(journal, session(sessionRoot, entries), append);
	const afterText = await readFile(outgoingPath, "utf8"); const after = frontmatter(afterText); const afterBody = noteBody(afterText);
	assert.equal(afterBody, beforeBody); assert.equal(after.contentRevision, 1); assert.equal(after.contentSha256, before.contentSha256);
	assert.equal(after.metadataRevision, before.metadataRevision + 1); assert.equal(after.chunk.transportCompleteness, "complete"); assert.deepEqual(after.telegramMessageIds, ["11"]);
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), append), { projected: 0, unchanged: 2, deferred: 0 });
});

test("import publication resumes after manifest commit precedes checkpoint progress", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-publication-recovery-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const projector = createProjector(root, join(base, "unused-sessions"));
	const items = [1, 2].map((ordinal) => ({ messageId: `tgmsg:v1:telegram-export-history:set:${ordinal}`, identityKind: "telegram-export-history" as const, direction: "in" as const, markdown: `message ${ordinal}`, occurredAt: "2026-01-01T00:00:01.000Z", confidence: "historical-html-sequence" as const, html: { page: "messages.html", globalMessageOrdinal: ordinal, pageSha256: "a".repeat(64) }, ...(ordinal === 1 ? { htmlSegments: [1, 2].map((segment) => ({ page: "messages.html", globalMessageOrdinal: segment, pageSha256: "a".repeat(64), sourceRange: { startOffset: segment, endOffset: segment + 1, startLine: segment, startCol: 1, endLine: segment, endCol: 2 }, sourceTextSha256: String(segment).repeat(64) })) } : {}), attachments: [] }));
	const binding = { sourceSetId: "set", sourceSetManifestSha256: "b".repeat(64), speakerMapRevision: 1, boundaryManifestSha256: "c".repeat(64) };
	await assert.rejects(() => projector.publishImport(items, binding, async (nextIndex) => { if (nextIndex === 1) throw new Error("synthetic checkpoint failure"); }), /checkpoint failure/);
	assert.equal((await readdir(join(root, "messages", "2026", "01"))).length, 1);
	const resumed = await projector.publishImport(items, binding);
	assert.deepEqual(resumed, { published: 1, unchanged: 1, attachments: 0, mediaEvents: 0 });
	const publishedNames = (await readdir(join(root, "messages", "2026", "01"))).sort();
	assert.equal(publishedNames.length, 2);
	assert.equal(publishedNames.includes("20260101-000001000-user.md"), true);
	assert.equal(publishedNames.some((name) => /^20260101-000001000-user-[0-9a-f]{8}\.md$/.test(name)), true);
	const firstPublished = frontmatter(await readFile(join(root, "messages", "2026", "01", publishedNames.find((name) => name === "20260101-000001000-user.md")!), "utf8"));
	assert.deepEqual(firstPublished.import.segments.map((segment: { globalMessageOrdinal: number }) => segment.globalMessageOrdinal), [1, 2]);
	assert.equal((await readdir(join(root, "messages", ".telegram-archive"))).includes("manifest.json"), true);
	await assert.rejects(() => projector.publishImport([{ ...items[0]!, messageId: "tgmsg:v1:telegram-export-history:other:1" }], { ...binding, sourceSetId: "other" }), /empty root or an exact plan prefix/);

	const archivedMessages = join(base, "archived-messages");
	await rename(join(root, "messages"), archivedMessages);
	assert.equal((await readdir(join(archivedMessages, ".telegram-archive"))).includes("manifest.json"), true);
	assert.deepEqual(await projector.publishImport(items, binding), { published: 2, unchanged: 0, attachments: 0, mediaEvents: 0 });
	assert.equal((await readdir(join(root, "messages", ".telegram-archive"))).includes("manifest.json"), true);
});

test("live projection reconciles imported Pi identity without replacing import provenance", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-import-live-reconcile-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")];
	await persistSession(sessionRoot, entries);
	const lines = (await readFile(join(sessionRoot, "session.jsonl"), "utf8")).trimEnd().split("\n");
	const entryLine = lines[1]!; const entryByteOffset = Buffer.byteLength(`${lines[0]!}\n`); const entryByteLength = Buffer.byteLength(entryLine);
	const item = {
		messageId: "tgmsg:v1:pi:session-1:user0001", identityKind: "pi-session-entry" as const, direction: "in" as const, markdown: "hello", occurredAt: "2026-09-22T01:00:01.000Z", confidence: "exact-pi" as const, exportStatus: "present" as const,
		html: { page: "messages.html", globalMessageOrdinal: 1, pageSha256: "a".repeat(64) },
		pi: { sessionId: "session-1", entryId: "user0001", parentId: null, sourceRootId: "pi-sessions", sourcePath: "session.jsonl", entryLine: 2, entryByteOffset, entryByteLength, entrySha256: createHash("sha256").update(entryLine).digest("hex") }, attachments: [],
	};
	const projector = createProjector(root, sessionRoot);
	await projector.publishImport([item], { sourceSetId: "set", sourceSetManifestSha256: "b".repeat(64), speakerMapRevision: 1, boundaryManifestSha256: "c".repeat(64) });
	const journal = records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type));
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); }), { projected: 1, unchanged: 0, deferred: 0 });
	const manifest = JSON.parse(await readFile(join(root, "messages", ".telegram-archive", "manifest.json"), "utf8"));
	const manifestEntry = manifest.messages[item.messageId];
	assert.equal(manifestEntry.import.source, "telegram-desktop-html-pi");
	assert.equal(manifestEntry.metadataRevision, 2);
	const metadata = frontmatter(await readFile(join(root, manifestEntry.path), "utf8"));
	assert.equal(metadata.import.source, "telegram-desktop-html-pi");
	assert.deepEqual(metadata.telegramMessageIds, ["10"]);
	assert.equal(metadata.contentRevision, 1);
});

test("attachment publication is content-addressed, direction-aware, and deduplicated", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-attachment-names-")); t.after(() => rm(base, { recursive: true, force: true }));
	const one = join(base, "one"); const two = join(base, "two"); await Promise.all([mkdir(one), mkdir(two)]);
	const firstBytes = Buffer.from("first-image"); const secondBytes = Buffer.from("second-image");
	const firstPath = join(one, "My Photo.png"); const secondPath = join(two, "My Photo.png"); await writeFile(firstPath, firstBytes); await writeFile(secondPath, secondBytes);
	const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const attachment = (sourcePath: string, bytes: Buffer) => ({ sourcePath, sha256: digest(bytes), mimeType: "image/png", size: bytes.length });
	const items = [attachment(firstPath, firstBytes), attachment(secondPath, secondBytes), attachment(firstPath, firstBytes)].map((current, index) => ({ messageId: `tgmsg:v1:telegram-export-history:attachments:${index + 1}`, identityKind: "telegram-export-history" as const, direction: (index === 1 ? "out" : "in") as "in" | "out", markdown: `image ${index + 1}`, occurredAt: `2026-01-01T00:00:0${index + 1}.000Z`, confidence: "historical-html-sequence" as const, html: { page: "messages.html", globalMessageOrdinal: index + 1, pageSha256: "a".repeat(64) }, attachments: [current] }));
	const root = join(base, "archive"); await createProjector(root, join(base, "sessions")).publishImport(items, { sourceSetId: "attachments", sourceSetManifestSha256: "b".repeat(64), speakerMapRevision: 1, boundaryManifestSha256: "c".repeat(64) });
	const names = (await readdir(join(root, "messages", "_attachments"))).sort();
	assert.deepEqual(names, [`${digest(firstBytes)}.png`, `${digest(secondBytes)}.png`].sort());
	const notes = await readdir(join(root, "messages", "2026", "01"));
	const bodies = await Promise.all(notes.map((name) => readFile(join(root, "messages", "2026", "01", name), "utf8")));
	assert.equal(bodies.filter((body) => body.includes(`![[${digest(firstBytes)}.png|512]]`)).length, 2);
	assert.equal(bodies.some((body) => body.includes(`![[${digest(secondBytes)}.png|512]]`)), true);
	assert.equal(bodies.every((body) => /sha256: [0-9a-f]{64}/.test(body)), true);
	assert.equal(bodies.every((body) => /source: telegram-desktop-import/.test(body)), true);
	assert.equal(bodies.some((body) => /direction: out/.test(body)), true);
});

test("repeat import migrates readable attachment names without rewriting legacy notes", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-legacy-attachment-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const source = join(base, "Readable Photo.png"); const bytes = Buffer.from("legacy-readable-image"); await writeFile(source, bytes);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const item = { messageId: "tgmsg:v1:telegram-export-history:legacy:1", identityKind: "telegram-export-history" as const, direction: "in" as const, markdown: "legacy image", occurredAt: "2026-01-01T00:00:01.000Z", confidence: "historical-html-sequence" as const, html: { page: "messages.html", globalMessageOrdinal: 1, pageSha256: "a".repeat(64) }, attachments: [{ sourcePath: source, sha256: digest, mimeType: "image/png", size: bytes.length }] };
	const binding = { sourceSetId: "legacy", sourceSetManifestSha256: "b".repeat(64), speakerMapRevision: 1, boundaryManifestSha256: "c".repeat(64) };
	const projector = createProjector(root, join(base, "sessions")); await projector.publishImport([item], binding);
	const stateRoot = join(root, "messages", ".telegram-archive"); const manifestPath = join(stateRoot, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")); const entry = manifest.messages[item.messageId]; const notePath = join(root, entry.path); const current = await readFile(notePath, "utf8");
	const parsed = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)(\n\n---\nPrevious: [^\n]+\n)$/.exec(current)!; const metadata = parseYaml(parsed[1]!) as Record<string, any>;
	const legacyName = "Readable-Photo.png"; const legacyPath = `messages/_attachments/${legacyName}`; await writeFile(join(root, legacyPath), bytes, { mode: 0o600 });
	metadata.attachments[0].path = legacyPath; delete metadata.attachments[0].source; delete metadata.attachments[0].direction;
	const body = parsed[2]!.replace(`${digest}.png`, legacyName); metadata.contentSha256 = createHash("sha256").update(body).digest("hex"); delete metadata.metadataSha256; metadata.metadataSha256 = createHash("sha256").update(canonical(metadata)).digest("hex");
	const legacyNote = `---\n${stringifyYaml(metadata, { lineWidth: 0 })}---\n\n${body}${parsed[3]}`; await writeFile(notePath, legacyNote, { mode: 0o600 });
	entry.contentSha256 = metadata.contentSha256; entry.metadataSha256 = metadata.metadataSha256; await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 }); await unlink(join(stateRoot, "media-events.jsonl"));
	assert.deepEqual(await projector.publishImport([item], binding), { published: 0, unchanged: 1, attachments: 0, mediaEvents: 1 });
	assert.equal(await readFile(notePath, "utf8"), legacyNote, "legacy canonical history remains byte-for-byte unchanged");
	assert.equal((await projector.readMediaEvents())[0]?.attachment.path, `messages/_attachments/${digest}.png`);
	assert.deepEqual(await projector.publishImport([item], binding), { published: 0, unchanged: 1, attachments: 0, mediaEvents: 0 });
});

test("live media capture deduplicates bytes, survives reads, and reconciles with imported media", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-live-media-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const sessions = join(base, "sessions"); const source = join(base, "photo.png");
	const bytes = Buffer.from("same-image-bytes"); await writeFile(source, bytes);
	const projector = createProjector(root, sessions);
	const inbound = await projector.captureLiveMedia(bytes, "image/png", "in");
	const outbound = await projector.captureLiveMedia(bytes, "image/png", "out");
	assert.equal(inbound.path, outbound.path);
	assert.equal(inbound.sha256, createHash("sha256").update(bytes).digest("hex"));
	assert.equal((await readdir(join(root, "messages", "_attachments"))).length, 1);
	assert.deepEqual(await projector.readLiveMedia(inbound), { data: bytes.toString("base64"), mimeType: "image/png" });
	const item = { messageId: "tgmsg:v1:telegram-export-history:media:1", identityKind: "telegram-export-history" as const, direction: "out" as const, markdown: "imported", occurredAt: "2026-01-01T00:00:01.000Z", confidence: "historical-html-sequence" as const, html: { page: "messages.html", globalMessageOrdinal: 1, pageSha256: "a".repeat(64) }, attachments: [{ sourcePath: source, sha256: inbound.sha256, mimeType: "image/png", size: bytes.length }] };
	assert.deepEqual(await projector.publishImport([item], { sourceSetId: "media", sourceSetManifestSha256: "b".repeat(64), speakerMapRevision: 1, boundaryManifestSha256: "c".repeat(64) }), { published: 1, unchanged: 0, attachments: 0, mediaEvents: 1 });
	assert.equal((await readdir(join(root, "messages", "_attachments"))).length, 1);
	await writeFile(join(root, inbound.path), Buffer.from("corrupt"));
	await assert.rejects(() => projector.readLiveMedia(inbound), ArchiveCorruptionError);
});

test("live inbound and outbound photo journal records project stable attachment references", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-live-photo-projection-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"), message("asst0001", "user0001", "assistant", "done", "2026-09-22T01:00:04.000Z")];
	await persistSession(sessionRoot, entries);
	const projector = createProjector(root, sessionRoot);
	const sharedBytes = Buffer.from("same-live-image");
	const inbound = await projector.captureLiveMedia(sharedBytes, "image/png", "in");
	const outbound = await projector.captureLiveMedia(sharedBytes, "image/png", "out");
	const journal: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: "2026-09-22T01:00:00.000Z", jobId: "job-1", messageId: 10, text: "hello", rawText: "hello", chatId: 70, userId: 7, images: [{ fileId: "telegram-file", mimeType: "image/png", fileSize: sharedBytes.length }] },
		{ type: "media_captured", schemaVersion: 1, mediaId: `in:job-1:0:${inbound.sha256}`, jobId: "job-1", direction: "in", attachment: inbound, telegram: { updateId: 1, messageId: 10, fileId: "telegram-file" }, timestamp: "2026-09-22T01:00:00.500Z" },
		{ type: "dispatched", jobId: "job-1", sessionId: "session-1" },
		{ type: "photo_send_planned", schemaVersion: 1, photoId: "tool-photo-1", deliveryKey: outboundPhotoDeliveryKey(outbound, "caption", 10), jobId: "job-1", caption: "caption", replyToMessageId: 10, attachment: outbound, timestamp: "2026-09-22T01:00:02.000Z" },
		{ type: "media_captured", schemaVersion: 1, mediaId: `out:tool-photo-1:${outbound.sha256}`, jobId: "job-1", direction: "out", attachment: outbound, telegram: {}, timestamp: "2026-09-22T01:00:02.000Z" },
		{ type: "reply_ready", jobId: "job-1", text: "done", timestamp: "2026-09-22T01:00:04.000Z" },
		{ type: "reply_sent", jobId: "job-1", messageId: "12", timestamp: "2026-09-22T01:00:05.000Z" },
	];
	assert.equal(await projector.reconcileMediaEvents(journal), 1);
	assert.deepEqual((await projector.readMediaEvents()).map((event) => event.provenance.kind), ["live-inbound"], "an outbound plan is not a delivered occurrence");
	journal.splice(journal.length - 2, 0, { type: "photo_sent", schemaVersion: 1, photoId: "tool-photo-1", jobId: "job-1", messageId: "11", timestamp: "2026-09-22T01:00:03.000Z" });
	assert.equal(await projector.reconcileMediaEvents(journal), 1, "restart reconciliation backfills the durable receipt");
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); }), { projected: 3, unchanged: 0, deferred: 0 });
	const mediaEvents = await projector.readMediaEvents();
	assert.equal(mediaEvents.length, 2, "pre-event live journal records must backfill into one shared stream");
	assert.deepEqual(mediaEvents.map((event) => event.provenance.kind).sort(), ["live-inbound", "live-outbound"]);
	assert.equal(new Set(mediaEvents.map((event) => event.attachment.sha256)).size, 1, "same bytes dedupe while provenance events remain distinct");
	const files = await readdir(join(root, "messages", "2026", "09"));
	const notes = await Promise.all(files.map((file) => readFile(join(root, "messages", "2026", "09", file), "utf8")));
	const inboundNote = notes.find((body) => frontmatter(body).direction === "in")!;
	const photoNote = notes.find((body) => frontmatter(body).identityKind === "telegram-live-photo")!;
	assert.equal(frontmatter(inboundNote).attachments[0].sha256, inbound.sha256);
	assert.equal(frontmatter(inboundNote).attachments[0].direction, "in");
	assert.equal(frontmatter(photoNote).attachments[0].sha256, outbound.sha256);
	assert.deepEqual(frontmatter(photoNote).telegramMessageIds, ["11"]);
	assert.deepEqual(frontmatter(photoNote).import, { source: "live", confidence: "exact-live-telegram" });
	assert.equal(noteBody(photoNote).includes(`![[${outbound.sha256}.png|512]]`), true);
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); }), { projected: 0, unchanged: 3, deferred: 0 });
});

test("shared media-event reader rejects malformed provenance and identity mutation", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-media-events-corrupt-")); t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive"); const sessionRoot = join(base, "sessions"); const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")]; await persistSession(sessionRoot, entries);
	const projector = createProjector(root, sessionRoot); const attachment = await projector.captureLiveMedia(Buffer.from("image"), "image/png", "in");
	const journal: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: "2026-09-22T01:00:00.000Z", jobId: "job-1", messageId: 10, text: "hello", images: [{ fileId: "file", mimeType: "image/png", fileSize: 5 }] },
		{ type: "media_captured", schemaVersion: 1, mediaId: `in:job-1:0:${attachment.sha256}`, jobId: "job-1", direction: "in", attachment, telegram: { updateId: 1, messageId: 10, fileId: "file" }, timestamp: "2026-09-22T01:00:00.500Z" },
	];
	await projector.reconcileMediaEvents(journal);
	const path = join(root, "messages", ".telegram-archive", "media-events.jsonl"); const durable = await readFile(path, "utf8"); const partial = `${durable}{\"schema\":\"pi-telegram-owner/media-event/v1\"`;
	await writeFile(path, partial, { mode: 0o600 });
	assert.equal((await projector.readMediaEvents()).length, 1);
	assert.equal(await readFile(path, "utf8"), partial, "ordinary reads must never repair a writer's incomplete tail");
	assert.equal(await projector.reconcileMediaEvents(journal), 0);
	assert.equal(await readFile(path, "utf8"), durable, "lock-held reconciliation repairs the incomplete tail");
	const event = JSON.parse(durable.trim());
	event.provenance.messageId = 11;
	await writeFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	await assert.rejects(() => projector.readMediaEvents(), /identity is invalid/);
});

test("manifest and Pi sources reject symlinks, duplicate keys, and invalid timestamps", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-source-safety-")); t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")]; await persistSession(sessionRoot, entries);
	const projector = createProjector(archiveRoot, sessionRoot); const journal = records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type));
	await projector.reconcile(journal, session(sessionRoot, entries), async () => undefined);
	const manifest = join(archiveRoot, "messages", ".telegram-archive", "manifest.json"); const savedManifest = join(base, "manifest.json"); await rename(manifest, savedManifest); await symlink(savedManifest, manifest);
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), ArchiveSafetyError);
	await unlink(manifest); await writeFile(manifest, `{"schema":"pi-telegram-owner/archive-manifest/v1","schema":"pi-telegram-owner/archive-manifest/v1"}\n`, { mode: 0o600 });
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), /duplicate-key JSON/);

	await rm(archiveRoot, { recursive: true, force: true }); await persistSession(sessionRoot, entries);
	const sessionPath = join(sessionRoot, "session.jsonl"); const savedSession = join(base, "session.jsonl"); await rename(sessionPath, savedSession); await symlink(savedSession, sessionPath);
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), ArchiveSafetyError);
	await unlink(sessionPath);
	const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-09-22T00:00:00.000Z", cwd: "/synthetic" });
	await writeFile(sessionPath, `${header}\n{"type":"message","id":"user0001","id":"duplicate","parentId":null,"timestamp":"2026-09-22T01:00:01.000Z","message":{"role":"user","content":"[telegram-job:job-1]\\nhello"}}\n`, { mode: 0o600 });
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), /duplicate-key JSON/);
	await writeFile(sessionPath, `${header}\n${JSON.stringify({ ...entries[0], timestamp: "not-a-time" })}\n`, { mode: 0o600 });
	await assert.rejects(() => projector.reconcile(journal, session(sessionRoot, entries), async () => undefined), /timestamp/i);
});

test("unavailable sessions defer durably and symlink ancestors fail closed", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-defer-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	await persistSession(sessionRoot, []);
	const foreign = records().map((record) => record.type === "dispatched" ? { ...record, sessionId: "foreign-session" } : record) as JournalRecord[];
	const captured: JournalRecord[] = [];
	const projector = createProjector(archiveRoot, sessionRoot);
	const result = await projector.reconcile(foreign, session(sessionRoot, []), async (record) => { captured.push(record); });
	assert.equal(result.deferred, 2);
	assert.deepEqual(captured.filter((record) => record.type === "projection_deferred").map((record: any) => record.code), ["PI_SESSION_NOT_SUPPLIED", "PI_SESSION_NOT_SUPPLIED"]);
	const outside = join(base, "outside"); await mkdir(outside, { mode: 0o700 });
	await rm(join(archiveRoot, "messages"), { recursive: true, force: true });
	await symlink(outside, join(archiveRoot, "messages"));
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")]; await persistSession(sessionRoot, entries);
	await assert.rejects(() => projector.reconcile(records().filter((record) => !["reply_ready", "reply_plan", "reply_chunk_sent", "reply_sent"].includes(record.type)), session(sessionRoot, entries), async () => undefined), ArchiveSafetyError);
});

test("projector rejects insecure archive roots and session path escape", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-archive-safety-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "archive");
	const sessionRoot = join(base, "sessions");
	await persistSession(sessionRoot, []);
	const projector = createProjector(root, sessionRoot);
	await projector.reconcile([], session(sessionRoot, []), async () => undefined);
	await chmod(root, 0o755);
	assert.equal((await projector.reconcile([], session(sessionRoot, []), async () => undefined)).projected, 0);
	await chmod(root, 0o777);
	await assert.rejects(() => projector.reconcile([], session(sessionRoot, []), async () => undefined), ArchiveSafetyError);
	await chmod(root, 0o700);
	const outsideEntries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z")];
	await persistSession(join(base, "other"), outsideEntries);
	await assert.rejects(() => projector.reconcile(records(), session(join(base, "other"), outsideEntries), async () => undefined), ArchiveSafetyError);
});

for (const [channel,sender] of [['endpoint','fixture'],['endpoint','fixture\nsecond'],['endpoint','fixture\r\nTask: sender label'],['group','fixture\nsecond']] as const) test(`historical ${channel} envelope ${JSON.stringify(sender)} recovers backlog without rewriting source or existing notes`, async t => {
	const base=await mkdtemp(join(tmpdir(),'telegram-legacy-recovery-'));t.after(()=>rm(base,{recursive:true,force:true}));
	const root=join(base,'archive'),sessions=join(base,'sessions');
	const entries=[message('u1',null,'user','[telegram-job:job-1]\nhello','2026-09-22T01:00:01.000Z'),message('a1','u1','assistant','**world**','2026-09-22T01:00:02.000Z')];
	await persistSession(sessions,entries);const journal=records(),append=async(record:JournalRecord)=>{journal.push(record);};
	await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append);
	const before=await createProjector(root,sessions).timeline({operation:'recent',limit:10});
	const oldNotes=await Promise.all(before.messages!.map(async m=>({path:m.path,bytes:await readFile(join(root,m.path))})));
	const item={itemId:'11111111-2222-4333-8444-555555555555',channel,authority:'owner' as const,sender,text:'Read the fixture.',reply:{kind:'private' as const,messageId:42},context:['Task: literal context, not a lifecycle header.'],timestamp:'2026-09-22T01:30:00.000Z'};
	if(channel==='endpoint')assert.equal((await import('../src/endpoint.ts')).parseQueueRequest({kind:'instruction',text:item.text,reply:'private',source:sender}).ok,true);
	// Literal persisted pre-upgrade logical fields, independent of the current renderer.
	const legacy=`Channel: ${channel==='group'?'group chat':'queue endpoint'}\nFrom: ${sender} (owner authority)\nYour final reply goes to the private chat with the owner, as a reply to message 42.\n${channel==='group'?'The owner and every configured agent can read the group chat.\n':''}Task: literal context, not a lifecycle header.\n\nRead the fixture.`;
	entries.push(message('u2','a1','user',`[telegram-item:${item.itemId}]\n${legacy}`,'2026-09-22T01:30:01.000Z'),message('a2','u2','assistant','Fixture reviewed.','2026-09-22T01:30:02.000Z'),message('u3','a2','user','[telegram-job:later]\nNew private message.','2026-09-22T01:40:01.000Z'),message('a3','u3','assistant','New private answer.','2026-09-22T01:40:02.000Z'));
	journal.push({type:'work_item',schemaVersion:1,...item},{type:'dispatched',jobId:item.itemId,sessionId:'session-1'},{type:'reply_ready',jobId:item.itemId,text:'Fixture reviewed.',timestamp:'2026-09-22T01:30:03.000Z'},{type:'reply_sent',jobId:item.itemId,messageIds:['13'],timestamp:'2026-09-22T01:30:03.000Z'},{type:'update',schemaVersion:2,updateId:2,disposition:'accepted',timestamp:'2026-09-22T01:40:00.000Z',jobId:'later',messageId:14,text:'New private message.',rawText:'New private message.',chatId:70,userId:7},{type:'dispatched',jobId:'later',sessionId:'session-1'},{type:'reply_ready',jobId:'later',text:'New private answer.',timestamp:'2026-09-22T01:40:03.000Z'},{type:'reply_sent',jobId:'later',messageIds:['15'],timestamp:'2026-09-22T01:40:03.000Z'});
	await persistSession(sessions,entries);const source=await readFile(join(sessions,'session.jsonl')),journalPrefix=JSON.stringify(journal);
	assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:3,unchanged:2,deferred:0});
	assert.deepEqual(await readFile(join(sessions,'session.jsonl')),source);assert.equal(JSON.stringify(journal.slice(0,JSON.parse(journalPrefix).length)),journalPrefix);
	for(const note of oldNotes)assert.deepEqual(await readFile(join(root,note.path)),note.bytes);
	const recovered=await createProjector(root,sessions).timeline({operation:'recent',limit:10});assert.equal(recovered.messages!.length,5);assert.deepEqual(recovered.messages!.slice(0,3).map(m=>m.content),['New private answer.','New private message.','Fixture reviewed.']);
	const manifest=await readFile(join(root,'messages/.telegram-archive/manifest.json'));
	assert.deepEqual(await createProjector(root,sessions).reconcile(journal,session(sessions,entries),append),{projected:0,unchanged:5,deferred:0});
	assert.deepEqual(await readFile(join(root,'messages/.telegram-archive/manifest.json')),manifest);
	assert.deepEqual(await readFile(join(sessions,'session.jsonl')),source);
});

for(const variant of ['body','header','lifecycle-metadata'] as const)test(`legacy compatibility still rejects changed ${variant}`,async t=>{
	const base=await mkdtemp(join(tmpdir(),'telegram-legacy-reject-'));t.after(()=>rm(base,{recursive:true,force:true}));
	const root=join(base,'archive'),sessions=join(base,'sessions');
	const item={itemId:'11111111-2222-4333-8444-555555555555',channel:'endpoint' as const,authority:'owner' as const,sender:'fixture',text:'Original task.',reply:{kind:'private' as const},timestamp:'2026-09-22T01:00:00.000Z',...(variant==='lifecycle-metadata'?{taskId:'explicit-task'}:{})};
	const legacy=`Channel: queue endpoint\nFrom: ${variant==='header'?'different':'fixture'} (owner authority)\nYour final reply goes to the private chat with the owner.\n\n${variant==='body'?'Changed task.':'Original task.'}`;
	const entries=[message('u1',null,'user',`[telegram-item:${item.itemId}]\n${legacy}`,'2026-09-22T01:00:01.000Z')];await persistSession(sessions,entries);
	await assert.rejects(createProjector(root,sessions).reconcile([{type:'work_item',schemaVersion:1,...item},{type:'dispatched',jobId:item.itemId,sessionId:'session-1'}],session(sessions,entries),async()=>undefined),/Canonical Pi user content changed/);
});

test("private-chat replies to work items are archived as outbound messages; group items are not", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-item-archive-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const itemId = "11111111-2222-4333-8444-555555555555";
	const groupItemId = "66666666-7777-4888-8999-000000000000";
	const item = { itemId, channel: "endpoint" as const, authority: "owner" as const, sender: "nightly-calendar", text: "Tell the owner about the early meeting.", reply: { kind: "private" as const }, timestamp: "2026-09-22T01:30:00.000Z" };
	const groupItem = { itemId: groupItemId, channel: "group" as const, authority: "peer" as const, sender: "Agent B", text: "Status?", reply: { kind: "group" as const, chatId: -100, messageId: 5 }, timestamp: "2026-09-22T01:40:00.000Z" };
	const { renderWorkItemPrompt } = await import("../src/core.ts");
	const entries = [
		message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"),
		message("asst0001", "user0001", "assistant", "**world**", "2026-09-22T01:00:02.000Z"),
		message("user0002", "asst0001", "user", `[telegram-item:${itemId}]\n${renderWorkItemPrompt(item)}`, "2026-09-22T01:30:01.000Z"),
		message("asst0002", "user0002", "assistant", "You have an 8:00 meeting; set an early alarm.", "2026-09-22T01:30:02.000Z"),
		message("user0003", "asst0002", "user", `[telegram-item:${groupItemId}]\n${renderWorkItemPrompt(groupItem)}`, "2026-09-22T01:40:01.000Z"),
		message("asst0003", "user0003", "assistant", "All green.", "2026-09-22T01:40:02.000Z"),
	];
	await persistSession(sessionRoot, entries);
	const journal: JournalRecord[] = [
		...records(),
		{ type: "work_item", schemaVersion: 1, ...item },
		{ type: "dispatched", jobId: itemId, sessionId: "session-1" },
		{ type: "reply_ready", jobId: itemId, text: "You have an 8:00 meeting; set an early alarm.", timestamp: "2026-09-22T01:30:03.000Z" },
		{ type: "reply_sent", jobId: itemId, messageIds: ["13"], timestamp: "2026-09-22T01:30:03.000Z" },
		{ type: "work_item", schemaVersion: 1, ...groupItem },
		{ type: "dispatched", jobId: groupItemId, sessionId: "session-1" },
		{ type: "reply_ready", jobId: groupItemId, text: "All green.", timestamp: "2026-09-22T01:40:03.000Z" },
		{ type: "reply_sent", jobId: groupItemId, messageIds: ["14"], timestamp: "2026-09-22T01:40:03.000Z" },
	];
	const append = async (record: JournalRecord) => { journal.push(record); };
	const projector = createProjector(archiveRoot, sessionRoot);
	assert.deepEqual(await projector.reconcile(journal, session(sessionRoot, entries), append), { projected: 3, unchanged: 0, deferred: 0 });
	const recent = await projector.timeline({ operation: "recent", limit: 3 });
	assert.deepEqual(recent.messages!.map((item) => item.content), ["You have an 8:00 meeting; set an early alarm.", "**world**", "hello"]);
	assert.equal(recent.messages![0].direction, "out");
	assert.equal(recent.messages![0].messageId, "tgmsg:v1:pi:session-1:asst0002");
	assert.equal(journal.some((record) => record.type === "projection_deferred"), false);
	assert.deepEqual(await createProjector(archiveRoot, sessionRoot).reconcile(journal, session(sessionRoot, entries), append), { projected: 0, unchanged: 3, deferred: 0 });
});

test("a reply that posted nothing is not archived", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "telegram-empty-reply-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const archiveRoot = join(base, "archive"); const sessionRoot = join(base, "sessions");
	const entries = [message("user0001", null, "user", "[telegram-job:job-1]\nhello", "2026-09-22T01:00:01.000Z"), message("asst0001", "user0001", "assistant", "", "2026-09-22T01:00:02.000Z")];
	await persistSession(sessionRoot, entries);
	const journal: JournalRecord[] = [
		records()[0]!,
		{ type: "dispatched", jobId: "job-1", sessionId: "session-1" },
		{ type: "responded_by_request", jobId: "job-1", messageId: 0, timestamp: "2026-09-22T01:00:02.000Z" },
		{ type: "reply_ready", jobId: "job-1", text: "Asked again in the group.", timestamp: "2026-09-22T01:00:02.000Z" },
		{ type: "reply_sent", jobId: "job-1", messageIds: [], timestamp: "2026-09-22T01:00:02.000Z" },
	];
	assert.deepEqual(await createProjector(archiveRoot, sessionRoot).reconcile(journal, session(sessionRoot, entries), async (record) => { journal.push(record); }), { projected: 1, unchanged: 0, deferred: 0 });
});
