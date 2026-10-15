import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryJournal, type TelegramUpdate } from "../src/core.ts";
import { createTelegramOwnerExtension, type PrototypeDependencies } from "../src/index.ts";

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

function ownerText(updateId: number, messageId: number, text: string): TelegramUpdate {
	return { update_id: updateId, message: { message_id: messageId, date: updateId, text, chat: { id: CHAT, type: "private" }, from: { id: OWNER } } };
}

/** A synthetic host whose idle state the test controls. */
function harness(overrides: Partial<PrototypeDependencies> = {}) {
	const journal = new MemoryJournal();
	const calls: string[] = [];
	const prompts: string[] = [];
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let idle = true;
	let nextMessageId = 900;
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {},
		sendUserMessage(text: string) { prompts.push(text); },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT, agentLabel: "Agent",
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply(text, replyTo) { calls.push(`reply:${replyTo}:${text}`); return String(nextMessageId++); },
		async sendActivity(text, _signal, replyTo) { const id = String(nextMessageId++); calls.push(`activity:${id}:${replyTo}:${text}`); return id; },
		async editActivity(id, text) { calls.push(`edit:${id}:${text}`); },
		async deleteActivity(id) { calls.push(`delete:${id}`); },
		...overrides,
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT,
		isIdle: () => idle,
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
		sessionManager: { getSessionId: () => "notices", getBranch: () => [] },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const runTurn = async (answer: string) => {
		const prompt = prompts.at(-1)!;
		await emit("input", { type: "input", source: "extension", text: prompt });
		await emit("before_agent_start", { type: "before_agent_start", prompt });
		idle = false;
		await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: answer }] });
		idle = true;
		await emit("agent_settled", { type: "agent_settled" });
	};
	return {
		journal, calls, prompts, emit, runTurn,
		setIdle(value: boolean) { idle = value; },
		batch: (updates: TelegramUpdate[]) => onBatch!(updates),
	};
}

test("activity messages reply to the message being worked on", async () => {
	const host = harness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	await host.batch([ownerText(1, 100, "first")]);
	const prompt = host.prompts.at(-1)!;
	await host.emit("input", { type: "input", source: "extension", text: prompt });
	await host.emit("before_agent_start", { type: "before_agent_start", prompt });
	await waitFor(() => host.calls.some((call) => call.startsWith("activity:")));
	assert.match(host.calls.find((call) => call.startsWith("activity:"))!, /^activity:\d+:100:Thinking \(10%\)$/);
});

test("work accepted while busy gets a queued notice that becomes its activity and is deleted after the reply", async () => {
	const host = harness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	host.setIdle(false);
	await host.batch([ownerText(1, 100, "first"), ownerText(2, 101, "second")]);
	assert.equal(host.prompts.length, 0, "nothing dispatches while the host is busy");
	assert.deepEqual(host.calls, [
		"activity:900:100:Queued: Agent is busy and will start this next.",
		"activity:901:101:Queued: Agent is busy and will start this after 1 earlier request.",
	]);
	assert.equal(host.journal.records.filter((record) => record.type === "activity_started").length, 2);

	await host.batch([]);
	assert.equal(host.calls.length, 2, "a queued notice is sent once");

	host.setIdle(true);
	await host.emit("agent_settled", { type: "agent_settled" });
	assert.equal(host.prompts.length, 1);
	const prompt = host.prompts[0]!;
	await host.emit("input", { type: "input", source: "extension", text: prompt });
	await host.emit("before_agent_start", { type: "before_agent_start", prompt });
	await waitFor(() => host.calls.includes("edit:900:Thinking (10%)"));
	assert.equal(host.calls.filter((call) => call.startsWith("activity:")).length, 2, "the queued notice is reused, not resent");
	host.setIdle(false);
	await host.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "one" }] });
	host.setIdle(true);
	await host.emit("agent_settled", { type: "agent_settled" });
	const replyIndex = host.calls.indexOf("reply:100:one");
	assert.ok(replyIndex >= 0);
	assert.ok(host.calls.indexOf("delete:900") > replyIndex, "the activity is deleted after the reply is sent");
	assert.equal(host.calls.includes("delete:901"), false, "the second request's notice stays until it is answered");
});

test("a failed final reply leaves the activity visible until a retry succeeds", async () => {
	let failReply = true;
	const replies: string[] = [];
	const host = harness({
		async sendReply(text, replyTo) {
			if (failReply) throw new Error("mock send failure");
			replies.push(`${replyTo}:${text}`);
			return "950";
		},
	});
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	await host.batch([ownerText(1, 100, "question")]);
	await host.runTurn("answer");
	await waitFor(() => host.calls.some((call) => call.startsWith("edit:") && call.endsWith("Reply delivery failed; it will be retried.")));
	assert.equal(host.calls.some((call) => call.startsWith("delete:")), false);
	assert.equal(host.journal.records.some((record) => record.type === "activity_cleared"), false);

	failReply = false;
	await host.batch([]);
	assert.deepEqual(replies, ["100:answer"]);
	assert.ok(host.calls.some((call) => call.startsWith("delete:")));
	assert.equal(host.journal.records.filter((record) => record.type === "activity_cleared").length, 1);
});

test("a turn that fails gets a visible notice and a diagnostic, and the queue moves on", async () => {
	const host = harness();
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	const cases = [
		{ messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded token=secret-value" }], notice: "Couldn't finish this: the model request failed.", code: "MODEL_ERROR" },
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "partial answ" }], stopReason: "length" }], notice: "Couldn't finish this: the reply was cut off by the model's length limit.", code: "LENGTH" },
		{ messages: [{ role: "user", content: "x" }], notice: "Couldn't finish this: the model produced no reply.", code: "NO_REPLY" },
	];
	for (const [index, item] of cases.entries()) {
		await host.batch([ownerText(10 + index, 200 + index, `question ${index}`)]);
		const prompt = host.prompts.at(-1)!;
		await host.emit("input", { type: "input", source: "extension", text: prompt });
		await host.emit("before_agent_start", { type: "before_agent_start", prompt });
		await host.emit("agent_end", { type: "agent_end", messages: item.messages });
		await host.emit("agent_settled", { type: "agent_settled" });
		assert.ok(host.calls.includes(`reply:${200 + index}:${item.notice}`), `${item.code} notice`);
		const failure = host.journal.records.findLast((record) => record.type === "turn_failed")!;
		assert.equal((failure as { code: string }).code, item.code);
	}
	assert.equal(host.calls.some((call) => call.includes("partial answ")), false, "a cut-off reply is not posted as an answer");
	const detail = (host.journal.records.find((record) => record.type === "turn_failed") as { detail?: string }).detail;
	assert.match(detail!, /provider exploded/);
	assert.doesNotMatch(detail!, /secret-value/);
	assert.equal(host.prompts.length, 3, "each failure released the queue for the next request");
});
