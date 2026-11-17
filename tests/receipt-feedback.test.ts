import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryJournal, recover, TelegramOwnerBridge, type TelegramUpdate } from "../src/core.ts";
import { createTelegramOwnerExtension, type PrototypeDependencies } from "../src/index.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function input(id: number, text = "synthetic input", date = 123): TelegramUpdate {
	return { update_id: id, message: { message_id: id * 10, date, text, chat: { id: 2, type: "private" }, from: { id: 1 } } };
}
function host(overrides: Partial<PrototypeDependencies> = {}) {
	const journal = new MemoryJournal(), calls: string[] = [], prompts: string[] = [], dispatched = gate();
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	let onBatch!: (updates: TelegramUpdate[]) => Promise<number | undefined>, idle = true, contextReads = 0;
	const pi = { on(name: string, fn: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerCommand() {}, registerTool() {},
		sendUserMessage(text: string) { prompts.push(text); dispatched.release(); } } as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: 1, privateChatId: 2, inboundQuietWindowMs: 4_000,
		source: { async start(fn) { onBatch = fn; return async () => {}; } },
		async sendTyping() { calls.push("typing"); }, async sendActivity(text, _signal, anchor) { calls.push(`send:${anchor}:${text}`); return String(calls.length); },
		async editActivity(id, text) { calls.push(`edit:${id}:${text}`); }, async deleteActivity(id) { calls.push(`delete:${id}`); },
		async sendReply() { return "reply"; }, ...overrides,
	} })(pi);
	const ctx = { isIdle: () => idle, getContextUsage() { contextReads += 1; return { percent: 10, tokens: 100, contextWindow: 1_000 }; },
		sessionManager: { getSessionId: () => "receipt-test", getBranch: () => [] }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	const emit = async (name: string, event: object = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
	return { journal, calls, prompts, ctx, emit, dispatched: dispatched.promise, batch: (updates: TelegramUpdate[]) => onBatch(updates),
		start: () => emit("session_start", { reason: "startup" }), setIdle(value: boolean) { idle = value; }, get contextReads() { return contextReads; } };
}

test("one early Collecting receipt and typing precede the quiet window and context calculation", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const h = host(); t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start();
	await h.batch([input(1)]); await flush();
	assert.equal(h.contextReads, 0); assert.deepEqual(h.calls.filter((x) => x.startsWith("send:")), ["send:10:Collecting..."]);
	assert.equal(h.calls.filter((x) => x === "typing").length, 1); assert.equal(h.prompts.length, 0);
	t.mock.timers.tick(3_999); await flush(); assert.equal(h.prompts.length, 0);
	t.mock.timers.tick(1); await h.dispatched;
	await h.emit("input", { source: "extension", text: h.prompts[0] }); await h.emit("before_agent_start", { prompt: h.prompts[0] });
	t.mock.timers.tick(1_000); await flush();
	assert.ok(h.calls.some((x) => x.endsWith(":Thinking (10%)"))); assert.equal(h.calls.filter((x) => x.startsWith("send:")).length, 1);
	const batch = h.journal.records.find((r) => r.type === "inbound_batch")!;
	const receipt = h.journal.records.find((r) => r.type === "activity_started")!;
	assert.equal(receipt.type === "activity_started" && receipt.jobId, batch.type === "inbound_batch" && batch.batchId);
});

test("same-date fragments share their canonical batch receipt and duplicate or unauthorized updates add none", async (t) => {
	const h = host(); h.setIdle(false); t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start();
	await h.batch([input(1, "part one"), input(2, "part two")]);
	await h.batch([input(1), { ...input(3), message: { ...input(3).message!, from: { id: 9 } } }]); await flush();
	assert.equal(h.calls.filter((x) => x.startsWith("send:")).length, 1); assert.equal(h.calls.filter((x) => x === "typing").length, 2);
	assert.equal(h.journal.records.filter((r) => r.type === "activity_started").length, 1);
});

test("an open busy batch does not falsely promise to start next ahead of an older queued request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const h = host(); h.setIdle(false); t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start();
	await h.batch([input(1)]); await flush(); t.mock.timers.tick(4_000); await flush();
	assert.equal(recover(h.journal.records).queued.length, 1);
	await h.batch([input(2, "Synthetic later input", 124)]); await flush();
	assert.deepEqual(h.calls.filter((call) => call.startsWith("send:20:")), ["send:20:Queued: The agent is busy."]);
	assert.equal(recover(h.journal.records).queued.length, 1, "the new batch is still being collected, not positioned in the ready queue");
});

test("early feedback starts only after durable authentication and batch admission", async (t) => {
	const journal = new MemoryJournal(), entered = gate(), held = gate(), append = journal.append.bind(journal);
	journal.append = async (record) => { if (record.type === "update" && record.disposition === "accepted") { entered.release(); await held.promise; } await append(record); };
	const h = host({ journal }); t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	const admission = h.batch([input(1)]); await entered.promise; assert.deepEqual(h.calls, []);
	held.release(); await admission; assert.ok(h.calls.includes("typing")); assert.ok(h.calls.some((x) => x.startsWith("send:")));
});

test("background projection does not hold new admission or receipt feedback", async (t) => {
	const entered = gate(), held = gate(); let armed = false;
	const h = host({ markdownProjector: { async reconcile() { if (armed) { armed = false; entered.release(); await held.promise; } return { projected: 0, paths: [], unchanged: 0, deferred: 0 }; } } as any });
	t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); });
	await h.start(); await flush(); armed = true; await h.batch([]); await entered.promise;
	let admitted = false; const admission = h.batch([input(1)]).then(() => { admitted = true; }); await flush();
	assert.equal(admitted, true); assert.ok(h.calls.includes("typing")); assert.ok(h.calls.some((x) => x.startsWith("send:")));
	held.release(); await admission;
});

test("a held previous reply cannot hold the next durable receipt", async (t) => {
	const entered = gate(), held = gate();
	const h = host({ inboundQuietWindowMs: 0, async sendReply() { entered.release(); await held.promise; return "reply"; } });
	t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	await h.batch([input(1)]); await h.dispatched;
	await h.emit("input", { source: "extension", text: h.prompts[0] }); await h.emit("before_agent_start", { prompt: h.prompts[0] });
	await h.emit("agent_end", { messages: [{ role: "assistant", content: "synthetic answer" }] });
	const settlement = h.emit("agent_settled"); await entered.promise; h.setIdle(false);
	let admitted = false; const admission = h.batch([input(2)]).then(() => { admitted = true; }); await flush();
	assert.equal(admitted, true); assert.ok(h.calls.some((x) => x.startsWith("send:20:")));
	held.release(); await admission; await settlement;
});

test("settling a held previous reply cannot consume the next input's full collection window", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const entered = gate(), held = gate();
	const h = host({ async sendReply() { entered.release(); await held.promise; return "reply"; } });
	t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	await h.batch([input(1)]); await flush(); t.mock.timers.tick(4_000); await h.dispatched;
	await h.emit("input", { source: "extension", text: h.prompts[0] }); await h.emit("before_agent_start", { prompt: h.prompts[0] });
	await h.emit("agent_end", { messages: [{ role: "assistant", content: "synthetic answer" }] });
	const settlement = h.emit("agent_settled"); await entered.promise;
	await h.batch([input(2)]); t.mock.timers.tick(60_000); await flush();
	assert.equal(h.prompts.length, 1);
	held.release(); await settlement; await flush(); assert.equal(h.prompts.length, 1);
	t.mock.timers.tick(3_999); await flush(); assert.equal(h.prompts.length, 1);
	t.mock.timers.tick(1); await flush(); assert.equal(h.prompts.length, 2);
});

for (const command of ["/new", "/compact"]) test(`${command} receives feedback behind a held reply and reuses it for the host phase`, async (t) => {
	const entered = gate(), held = gate(); let compacts = 0;
	const h = host({ inboundQuietWindowMs: 0, async sendReply() { entered.release(); await held.promise; return "reply"; } });
	h.ctx.compact = () => { compacts += 1; };
	t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	await h.batch([input(1)]); await h.dispatched;
	await h.emit("input", { source: "extension", text: h.prompts[0] }); await h.emit("before_agent_start", { prompt: h.prompts[0] });
	await h.emit("agent_end", { messages: [{ role: "assistant", content: "synthetic answer" }] });
	const settlement = h.emit("agent_settled"); await entered.promise; const contextReads = h.contextReads;
	assert.equal(await h.batch([input(2, command)]), 2); await flush();
	assert.ok(h.calls.includes("send:20:Received.")); assert.equal(h.contextReads, contextReads);
	assert.equal(compacts, 0); assert.equal(h.prompts.length, 1);
	held.release(); await settlement; await flush();
	assert.equal(h.calls.filter((call) => call.startsWith("send:20:")).length, 1);
	assert.ok(h.calls.some((call) => call.endsWith(command === "/compact" ? ":Compaction requested..." : ":Starting new session...")));
	if (command === "/compact") {
		assert.equal(compacts, 1); await h.emit("session_before_compact", { reason: "manual" });
		assert.ok(h.calls.some((call) => call.startsWith("edit:") && call.endsWith(":Compacting")));
		assert.equal(h.calls.filter((call) => call.startsWith("send:20:")).length, 1);
	} else assert.equal(h.prompts.length, 2);
});

test("automatic compaction reuses the active input receipt and leaves it for Thinking", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const h = host({ inboundQuietWindowMs: 0 }); t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start();
	await h.batch([input(1)]); await h.dispatched; await h.emit("input", { source: "extension", text: h.prompts[0] });
	t.mock.timers.tick(1_000); await h.emit("session_before_compact", { reason: "threshold" });
	assert.ok(h.calls.some((call) => call.startsWith("edit:") && call.endsWith(":Compacting")));
	await h.emit("session_compact"); assert.equal(h.calls.filter((call) => call.startsWith("delete:")).length, 0);
	t.mock.timers.tick(1_000); await h.emit("before_agent_start", { prompt: h.prompts[0] }); await flush();
	assert.ok(h.calls.some((call) => call.startsWith("edit:") && call.endsWith(":Thinking (10%)")));
	assert.equal(h.calls.filter((call) => call.startsWith("send:")).length, 1);
	await h.emit("agent_end", { messages: [{ role: "assistant", content: "Synthetic answer" }] }); await h.emit("agent_settled");
	assert.equal(h.calls.filter((call) => call.startsWith("delete:")).length, 1);
});

test("a pending receipt send neither holds the cursor nor duplicates a fragment receipt", async (t) => {
	let release!: (id: string) => void; const pending = new Promise<string>((resolve) => { release = resolve; }); let sends = 0;
	const h = host({ async sendActivity() { sends += 1; return pending; } });
	t.after(async () => { release("42"); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	assert.equal(await h.batch([input(1)]), 1); assert.equal(await h.batch([input(2)]), 2);
	assert.equal(sends, 1); assert.equal(h.journal.records.filter((r) => r.type === "activity_started").length, 0);
	release("42"); await flush(); assert.equal(h.journal.records.filter((r) => r.type === "activity_started").length, 1);
});

test("image receipt precedes slow capture while dispatch still requires durable image bytes", async (t) => {
	const entered = gate(), held = gate();
	const attachment = { sha256: "a".repeat(64), size: 5, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"a".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const };
	const h = host({ async resolveImages(_images, archived) { if (!archived.length) { entered.release(); await held.promise; } return [{ image: { data: "aW1hZ2U=", mimeType: "image/jpeg" }, attachment }]; } });
	t.after(async () => { held.release(); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	await h.batch([{ update_id: 1, message: { message_id: 10, caption: "Synthetic photo", photo: [{ file_id: "fixture-photo", file_size: 5 }], chat: { id: 2, type: "private" }, from: { id: 1 } } }]);
	await entered.promise; assert.ok(h.calls.includes("send:10:Received.")); assert.ok(h.calls.includes("typing"));
	assert.equal(h.prompts.length, 0); assert.equal(h.journal.records.some((r) => r.type === "media_captured"), false);
	held.release(); await h.dispatched; assert.equal(h.journal.records.some((r) => r.type === "media_captured"), true);
});

test("concurrent sealing cannot consume the window while a durable batch append is held", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const journal = new MemoryJournal(), entered = gate(), held = gate(), append = journal.append.bind(journal);
	let first = true; journal.append = async (record) => { if (first && record.type === "inbound_batch") { first = false; entered.release(); await held.promise; } await append(record); };
	const bridge = new TelegramOwnerBridge(journal, 1, 2); await bridge.initialize(); t.after(() => held.release());
	const admission = bridge.ingestBatch([input(1)]); await entered.promise;
	const seal = bridge.sealReadyBatches(); t.mock.timers.tick(5_000); held.release(); await admission;
	assert.equal(await seal, 0); assert.equal(recover(journal.records).queued.length, 0);
	t.mock.timers.tick(4_000); assert.equal(await bridge.sealReadyBatches(), 1); assert.equal(recover(journal.records).queued.length, 1);
});

test("failed queued feedback is not retried by housekeeping, but a new phase may attempt its current text", async (t) => {
	const attempts: string[] = []; const h = host({ inboundQuietWindowMs: 0, async sendActivity(text) { attempts.push(text); throw new Error("synthetic unavailable status"); } });
	h.setIdle(false); t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start();
	await h.batch([input(1)]); await flush(); assert.equal(attempts.length, 1);
	await h.batch([]); await flush(); assert.equal(attempts.length, 1);
	h.setIdle(true); await h.batch([]); await h.dispatched;
	await h.emit("input", { source: "extension", text: h.prompts[0] }); await h.emit("before_agent_start", { prompt: h.prompts[0] }); await flush();
	assert.equal(attempts.length, 2); assert.equal(attempts[1], "Thinking (10%)"); assert.equal(h.prompts.length, 1);
});

test("a pending initial send failure cannot discard the newer phase already requested", async (t) => {
	let reject!: (error: Error) => void; const pending = new Promise<string>((_resolve, fail) => { reject = fail; }); const attempts: string[] = [];
	const h = host({ inboundQuietWindowMs: 0, async sendActivity(text) { attempts.push(text); return attempts.length === 1 ? pending : "42"; } });
	t.after(async () => { reject(new Error("test cleanup")); await h.emit("session_shutdown", { reason: "test" }); }); await h.start();
	await h.batch([input(1)]); await h.dispatched; await h.emit("input", { source: "extension", text: h.prompts[0] });
	await h.emit("before_agent_start", { prompt: h.prompts[0] }); reject(new Error("synthetic unavailable status")); await flush();
	assert.deepEqual(attempts, ["Received.", "Thinking (10%)"]); assert.equal(h.prompts.length, 1);
});

test("feedback transport failure does not lose input or prevent model dispatch", async (t) => {
	const h = host({ inboundQuietWindowMs: 0, async sendActivity() { throw new Error("synthetic receipt failure"); } });
	t.after(() => h.emit("session_shutdown", { reason: "test" })); await h.start(); await h.batch([input(1)]); await h.dispatched;
	assert.equal(h.prompts.length, 1); assert.ok(h.journal.records.some((r) => r.type === "update" && r.disposition === "accepted"));
	assert.equal(h.journal.records.filter((r) => r.type === "activity_started").length, 0);
});
