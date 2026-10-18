import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryJournal, type TelegramUpdate } from "../src/core.ts";
import { DEFAULT_INSTRUCTION_SOURCE, parseQueueRequest, startQueueEndpoint } from "../src/endpoint.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";
import { ConfigurationError, loadTelegramOwnerConfig } from "../src/runtime.ts";

const OWNER = 7;
const CHAT = 70;
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

async function waitFor(predicate: () => boolean, timeout = 1_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
	return { status: response.status, body: await response.json() };
}

test("queue requests are validated strictly", () => {
	assert.deepEqual(parseQueueRequest({ kind: "instruction", text: "Remind the owner.", reply: "private" }), { ok: true, value: { kind: "instruction", text: "Remind the owner.", reply: "private", source: DEFAULT_INSTRUCTION_SOURCE } });
	assert.deepEqual(parseQueueRequest({ kind: "instruction", text: "x", reply: "none", source: " nightly ", id: "2026-01-01" }), { ok: true, value: { kind: "instruction", text: "x", reply: "none", source: "nightly", id: "2026-01-01" } });
	assert.deepEqual(parseQueueRequest({ kind: "group-message", messageId: 12 }), { ok: true, value: { kind: "group-message", messageId: 12 } });
	for (const [body, error] of [
		[[], /JSON object/],
		[{ kind: "other" }, /kind must be/],
		[{ kind: "instruction", text: " ", reply: "private" }, /text/],
		[{ kind: "instruction", text: "x", reply: "dm" }, /reply/],
		[{ kind: "instruction", text: "x", reply: "private", replyTo: 3 }, /Unknown instruction field: replyTo/],
		[{ kind: "instruction", text: "x", reply: "private", id: "" }, /id/],
		[{ kind: "group-message", messageId: 0 }, /messageId/],
		[{ kind: "group-message", messageId: 1, text: "x" }, /only kind and messageId/],
	] as const) {
		const result = parseQueueRequest(body);
		assert.equal(result.ok, false);
		assert.match((result as { error: string }).error, error);
	}
});

test("the endpoint listens on 127.0.0.1 and routes paths, methods and malformed bodies", async () => {
	const endpoint = await startQueueEndpoint(0, {
		async queue(body) { return { status: 202, body: { echoed: body } }; },
		async coordinate() { throw new Error("coordination broke"); },
		async status() { return { status: 200, body: { state: "idle" } }; },
	});
	try {
		assert.ok(endpoint.port > 0);
		assert.deepEqual(await post(endpoint.port, "/queue", { a: 1 }), { status: 202, body: { echoed: { a: 1 } } });
		assert.equal((await post(endpoint.port, "/queue", "{not json")).status, 400);
		assert.equal((await post(endpoint.port, "/elsewhere", {})).status, 404);
		assert.equal((await post(endpoint.port, "/status", {})).status, 405);
		assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/queue`)).status, 405);
		assert.deepEqual(await post(endpoint.port, "/coordinate", {}), { status: 500, body: { error: "coordination broke" } });
		const status = await fetch(`http://127.0.0.1:${endpoint.port}/status`);
		assert.deepEqual(await status.json(), { state: "idle" });
	} finally {
		await endpoint.close();
	}
	await assert.rejects(fetch(`http://127.0.0.1:${endpoint.port}/status`));
});

test("queuePort config is optional and must be a usable port", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-queue-port-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "cfg"), { mode: 0o700 });
	const path = join(root, "cfg", "config.json");
	const write = (extra: object) => writeFile(path, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "T", ...extra }), { mode: 0o600 });
	await write({});
	assert.equal((await loadTelegramOwnerConfig(path, { T: "x" })).config?.queuePort, undefined);
	await write({ queuePort: 7351 });
	assert.equal((await loadTelegramOwnerConfig(path, { T: "x" })).config?.queuePort, 7351);
	for (const queuePort of [80, 70000, 7351.5, "7351"]) {
		await write({ queuePort });
		await assert.rejects(loadTelegramOwnerConfig(path, { T: "x" }), ConfigurationError);
	}
});

function extensionHarness() {
	const journal = new MemoryJournal();
	const calls: string[] = [];
	const prompts: string[] = [];
	let status = "";
	let idle = true;
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {},
		sendUserMessage(text: string) { prompts.push(text); },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT, agentLabel: "Agent", queuePort: 0,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply(text, replyTo) { calls.push(`reply:${replyTo}:${text}`); return "500"; },
		async sendActivity(text, _signal, replyTo) { calls.push(`activity:${replyTo}:${text}`); return "600"; },
		async editActivity() {}, async deleteActivity(id) { calls.push(`delete:${id}`); },
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT, isIdle: () => idle,
		sessionManager: { getSessionId: () => "endpoint", getBranch: () => [] },
		ui: { setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return {
		journal, calls, prompts, emit,
		port: () => Number(/endpoint=127\.0\.0\.1:(\d+)/.exec(status)?.[1]),
		status: () => status,
		setIdle(value: boolean) { idle = value; },
		batch: (updates: TelegramUpdate[]) => onBatch!(updates),
	};
}

test("an instruction is durably queued, runs as an owner-authority turn and replies privately without an anchor", async () => {
	const host = extensionHarness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	const port = host.port();
	assert.ok(port > 0, host.status());

	const accepted = await post(port, "/queue", { kind: "instruction", source: "nightly-calendar", id: "alarm-1", reply: "private", text: "Tell the owner tomorrow starts with an 8:00 meeting." });
	assert.equal(accepted.status, 202);
	assert.equal(accepted.body.duplicate, false);
	assert.ok(host.journal.records.some((record) => record.type === "work_item" && record.itemId === accepted.body.itemId), "202 follows a durable record");
	assert.equal(host.prompts.length, 1);
	assert.match(host.prompts[0]!, /^\[telegram-item:[0-9a-f-]{36}\]\nChannel: queue endpoint\nFrom: nightly-calendar \(owner authority\)\nYour final reply goes to the private chat with the owner\.\n\nTell the owner/);

	const repeated = await post(port, "/queue", { kind: "instruction", source: "nightly-calendar", id: "alarm-1", reply: "private", text: "again" });
	assert.deepEqual(repeated, { status: 202, body: { itemId: accepted.body.itemId, duplicate: true } });

	const prompt = host.prompts[0]!;
	await host.emit("input", { type: "input", source: "extension", text: prompt });
	await host.emit("before_agent_start", { type: "before_agent_start", prompt });
	host.setIdle(false);
	assert.equal((await (await fetch(`http://127.0.0.1:${port}/status`)).json()).state, "busy");
	await host.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "Set an early alarm." }] });
	host.setIdle(true);
	await host.emit("agent_settled", { type: "agent_settled" });
	assert.ok(host.calls.includes("reply:undefined:Set an early alarm."));
	assert.ok(host.calls.includes("activity:undefined:Thinking (context recalculating)"));
	assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/status`)).json(), { state: "idle", queue: { owner: 0, peer: 0 }, group: "unconfigured" });
	await host.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
	await assert.rejects(fetch(`http://127.0.0.1:${port}/status`), "the endpoint stops on shutdown");
});

test("an instruction for nobody runs silently, and group requests are refused without a group", async () => {
	const host = extensionHarness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	const port = host.port();
	host.setIdle(false);
	const quiet = await post(port, "/queue", { kind: "instruction", reply: "none", text: "Refresh your notes." });
	assert.equal(quiet.status, 202);
	assert.equal(host.calls.length, 0, "an item with no reply destination gets no queued notice");
	assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/status`)).json(), { state: "busy", queue: { owner: 1, peer: 0 }, group: "unconfigured" });
	assert.equal((await post(port, "/queue", { kind: "instruction", reply: "group", text: "x" })).status, 409);
	assert.equal((await post(port, "/queue", { kind: "group-message", messageId: 4 })).status, 409);
	assert.equal((await post(port, "/queue", { kind: "instruction", reply: "private" })).status, 400);

	host.setIdle(true);
	await host.emit("agent_settled", { type: "agent_settled" });
	const prompt = host.prompts.at(-1)!;
	await host.emit("input", { type: "input", source: "extension", text: prompt });
	await host.emit("before_agent_start", { type: "before_agent_start", prompt });
	await host.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "Done." }] });
	await host.emit("agent_settled", { type: "agent_settled" });
	assert.equal(host.calls.some((call) => call.startsWith("reply:")), false);
	assert.ok(host.journal.records.some((record) => record.type === "reply_sent" && "messageIds" in record && record.messageIds.length === 0));
	await host.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
});

test("an instruction queued while busy gets an unanchored queued notice in the private chat", async () => {
	const host = extensionHarness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	host.setIdle(false);
	assert.equal((await post(host.port(), "/queue", { kind: "instruction", reply: "private", text: "Later." })).status, 202);
	await waitFor(() => host.calls.length > 0);
	assert.deepEqual(host.calls, ["activity:undefined:Queued: Agent is busy and will start this next."]);
	await host.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
});

test("a port that cannot be bound is reported and leaves the transport running", async () => {
	const blocker = await startQueueEndpoint(0, { async queue() { return { status: 200, body: {} }; }, async coordinate() { return { status: 200, body: {} }; }, async status() { return { status: 200, body: {} }; } });
	try {
		let status = "";
		let started = false;
		type Handler = (event: any, ctx: ExtensionContext) => unknown;
		const handlers = new Map<string, Handler[]>();
		const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
		createTelegramOwnerExtension({ dependencies: {
			journal: new MemoryJournal(), ownerUserId: OWNER, privateChatId: CHAT, queuePort: blocker.port,
			source: { async start() { started = true; return async () => {}; } },
			async sendReply() { return "1"; },
		} })(pi);
		const ctx = { cwd: PROJECT_ROOT, isIdle: () => true, sessionManager: { getSessionId: () => "x", getBranch: () => [] }, ui: { setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify() {} } } as unknown as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(started, true);
		assert.match(status, /endpointError=.*EADDRINUSE/);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "exit" }, ctx);
	} finally {
		await blocker.close();
	}
});

test("a peer call to a closed port is reported as unreachable, with no deadline on a live peer", async () => {
	const { postToPeer } = await import("../src/endpoint.ts");
	const endpoint = await startQueueEndpoint(0, {
		async queue() { await new Promise((resolve) => setTimeout(resolve, 300)); return { status: 202, body: { slow: true } }; },
		async coordinate() { return { status: 200, body: {} }; },
		async status() { return { status: 200, body: {} }; },
	});
	const port = endpoint.port;
	assert.deepEqual(await postToPeer(port, "/queue", {}), { status: 202, body: { slow: true } }, "a slow peer is waited for");
	await endpoint.close();
	assert.deepEqual(await postToPeer(port, "/queue", {}), { unreachable: true });
});
