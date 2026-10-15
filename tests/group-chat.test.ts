import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryJournal, type TelegramUpdate, type TelegramMessage } from "../src/core.ts";
import { GroupJournal } from "../src/group-journal.ts";
import type { GroupTelegramApi, WakeResult } from "../src/group-runtime.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";
import { ConfigurationError, loadTelegramOwnerConfig, type GroupAgentConfig, type GroupChatConfig } from "../src/runtime.ts";

const OWNER = 7;
const GROUP = -1001234567890;
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const journalOptions = { bootIdentity: () => ({ id: "synthetic-boot", startedAtMs: 1 }), pidState: (pid: number) => (pid === process.pid ? "alive" as const : "dead" as const), sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)) };

const AGENTS = {
	a: { id: 201, username: "example_agent_a_bot", name: "Agent A", privateChat: 71 },
	b: { id: 202, username: "example_agent_b_bot", name: "Agent B", privateChat: 72 },
} as const;
type AgentKey = keyof typeof AGENTS;

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class FakeGroupApi implements GroupTelegramApi {
	readonly calls: string[] = [];
	readonly sent: Array<{ id: number; text: string; replyTo?: number }> = [];
	members = new Map<number, string>([[OWNER, "creator"], [AGENTS.a.id, "administrator"], [AGENTS.b.id, "administrator"]]);
	count = 3;
	chatType = "supergroup";
	canRestrict = true;
	private readonly self: (typeof AGENTS)[AgentKey];
	private readonly ids: { next: number };
	constructor(self: (typeof AGENTS)[AgentKey], ids: { next: number }) {
		this.self = self;
		this.ids = ids;
	}
	async getMe() { return { id: this.self.id, username: this.self.username, firstName: this.self.name }; }
	async getChat() { return { id: GROUP, type: this.chatType }; }
	async getChatMember(userId: number) {
		const status = this.members.get(userId) ?? "left";
		return { status, canRestrictMembers: this.canRestrict, canDeleteMessages: true };
	}
	async getChatMemberCount() { return this.count; }
	async removeChatMember(userId: number) { this.calls.push(`remove:${userId}`); }
	async leaveChat(chatId: number) { this.calls.push(`leave:${chatId}`); }
	async sendMessage(text: string, replyTo?: number) {
		const id = this.ids.next++;
		this.sent.push({ id, text, ...(replyTo ? { replyTo } : {}) });
		this.calls.push(`send:${id}:${replyTo}:${text}`);
		return String(id);
	}
	async editMessageText(messageId: string, text: string) { this.calls.push(`edit:${messageId}:${text}`); }
	async deleteMessage(messageId: string) { this.calls.push(`delete:${messageId}`); }
}

function peerConfig(key: AgentKey, port = 7000): GroupAgentConfig {
	return { telegramAccount: AGENTS[key].username, telegramName: AGENTS[key].name, botUserId: AGENTS[key].id, queuePort: port };
}

interface Agent {
	key: AgentKey;
	journal: MemoryJournal;
	api: FakeGroupApi;
	prompts: string[];
	privateReplies: string[];
	tools: Map<string, any>;
	status(): string;
	port(): number;
	emit(name: string, event: object): Promise<void>;
	batch(updates: TelegramUpdate[]): Promise<number | undefined>;
	setIdle(value: boolean): void;
	runTurn(answer: string): Promise<string>;
}

function startAgent(key: AgentKey, sharedRoot: string, ids: { next: number }, wake: (peer: GroupAgentConfig, messageId: number) => Promise<WakeResult>, extra: { events?: unknown; datastore?: GroupChatConfig["datastore"] } = {}): Agent {
	const self = AGENTS[key];
	const other: AgentKey = key === "a" ? "b" : "a";
	const journal = new MemoryJournal();
	const api = new FakeGroupApi(self, ids);
	const prompts: string[] = [];
	const privateReplies: string[] = [];
	const tools = new Map<string, any>();
	let status = "";
	let idle = true;
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		...(extra.events ? { events: extra.events } : {}),
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool(definition: any) { tools.set(definition.name, definition); },
		sendUserMessage(text: string) { prompts.push(text); },
	} as unknown as ExtensionAPI;
	const config: GroupChatConfig = { chatId: GROUP, sharedRoot, datastore: extra.datastore ?? { mode: "off", store: "telegram-group" }, electionStepMs: 250, otherAgents: [peerConfig(other)] };
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: self.privateChat, agentLabel: self.name, queuePort: 0,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply(text) { privateReplies.push(text); return "1"; },
		groupChat: { config, api, journalOptions, wake },
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT, isIdle: () => idle,
		sessionManager: { getSessionId: () => `session-${key}`, getBranch: () => [] },
		ui: { setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return {
		key, journal, api, prompts, privateReplies, tools, emit,
		status: () => status,
		port: () => Number(/endpoint=127\.0\.0\.1:(\d+)/.exec(status)?.[1]),
		batch: (updates) => onBatch!(updates),
		setIdle(value) { idle = value; },
		async runTurn(answer) {
			const prompt = prompts.at(-1)!;
			await emit("input", { type: "input", source: "extension", text: prompt });
			await emit("before_agent_start", { type: "before_agent_start", prompt });
			idle = false;
			await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: answer }] });
			idle = true;
			await emit("agent_settled", { type: "agent_settled" });
			return prompt;
		},
	};
}

async function twoAgents(t: test.TestContext, wakeOverride?: (to: AgentKey, messageId: number) => Promise<WakeResult>) {
	const sharedRoot = await mkdtemp(join(tmpdir(), "group-chat-"));
	const ids = { next: 5_000 };
	const agents = {} as Record<AgentKey, Agent>;
	const wakeFor = (from: AgentKey) => async (peer: GroupAgentConfig, messageId: number): Promise<WakeResult> => {
		const to: AgentKey = from === "a" ? "b" : "a";
		assert.equal(peer.telegramAccount, AGENTS[to].username);
		if (wakeOverride) return wakeOverride(to, messageId);
		const response = await fetch(`http://127.0.0.1:${agents[to].port()}/queue`, { method: "POST", body: JSON.stringify({ kind: "group-message", messageId }) });
		return response.status === 202 ? "accepted" : response.status === 409 || response.status === 400 ? "rejected" : "retry";
	};
	agents.a = startAgent("a", sharedRoot, ids, wakeFor("a"));
	agents.b = startAgent("b", sharedRoot, ids, wakeFor("b"));
	for (const agent of Object.values(agents)) await agent.emit("session_start", { type: "session_start", reason: "startup" });
	// Agents stop before their shared root is removed.
	t.after(async () => {
		for (const agent of Object.values(agents)) await agent.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
		await rm(sharedRoot, { recursive: true, force: true });
	});
	return { agents, shared: new GroupJournal(sharedRoot, journalOptions), sharedRoot };
}

let updateId = 100;
function ownerGroupMessage(messageId: number, text: string, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
	return { update_id: updateId++, message: { message_id: messageId, date: 1_790_000_000 + messageId, text, chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER, first_name: "Owner" }, ...extra } };
}

function mention(text: string, account: string) {
	const offset = text.indexOf(`@${account}`);
	return { type: "mention", offset, length: account.length + 1 };
}

test("groupChat config requires a queue port, a negative chat ID and unique peers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "group-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "cfg"), { mode: 0o700 });
	const path = join(root, "cfg", "config.json");
	const groupChat = { chatId: GROUP, sharedRoot: "/srv/group", otherAgents: [{ telegramAccount: "@example_agent_b_bot", telegramName: "Agent B", botUserId: 202, queuePort: 7352 }] };
	const write = (extra: object) => writeFile(path, JSON.stringify({ ownerUserId: OWNER, privateChatId: 71, tokenEnv: "T", ...extra }), { mode: 0o600 });
	await write({ queuePort: 7351, groupChat });
	const loaded = (await loadTelegramOwnerConfig(path, { T: "x" })).config!.groupChat!;
	assert.deepEqual(loaded, { chatId: GROUP, sharedRoot: "/srv/group", datastore: { mode: "auto", store: "telegram-group" }, electionStepMs: 2000, otherAgents: [{ telegramAccount: "example_agent_b_bot", telegramName: "Agent B", botUserId: 202, queuePort: 7352 }] });
	for (const [extra, message] of [
		[{ groupChat }, /requires queuePort/],
		[{ queuePort: 7351, groupChat: { ...groupChat, chatId: 5 } }, /negative/],
		[{ queuePort: 7351, groupChat: { ...groupChat, sharedRoot: "relative" } }, /absolute/],
		[{ queuePort: 7352, groupChat }, /repeats/],
		[{ queuePort: 7351, groupChat: { ...groupChat, otherAgents: [{ ...groupChat.otherAgents[0], botUserId: OWNER }] } }, /repeats/],
		[{ queuePort: 7351, groupChat: { ...groupChat, otherAgents: [] } }, /at least one/],
		[{ queuePort: 7351, groupChat: { ...groupChat, extra: 1 } }, /unknown field extra/],
		[{ queuePort: 7351, groupChat: { ...groupChat, electionStepMs: 10 } }, /electionStepMs/],
	] as const) {
		await write(extra);
		await assert.rejects(loadTelegramOwnerConfig(path, { T: "x" }), (error: Error) => error instanceof ConfigurationError && message.test(error.message));
	}
});

test("an owner mention is published once, runs on the mentioned agent only and its answer is journaled", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified") && agents.b.status().includes("group=verified"));
	const text = "😀 @example_agent_a_bot can you check the build?";
	const update = ownerGroupMessage(10, text, { entities: [mention(text, AGENTS.a.username)] });
	await Promise.all([agents.a.batch([update]), agents.b.batch([update])]);
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /^\[telegram-item:[0-9a-f-]{36}\]\nChannel: group chat\nFrom: the owner \(owner authority\)\nYour final reply goes to the group chat, as a reply to message 10\./);
	assert.ok(agents.a.prompts[0]!.endsWith(text), "UTF-16 entity offsets resolve the mention after an emoji");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(agents.b.prompts.length, 0, "an agent that is not mentioned is not woken");
	assert.equal((await shared.events()).filter((event) => event.kind === "message").length, 1, "both agents observed it; it was recorded once");

	await agents.a.runTurn("The build is green.");
	await waitFor(() => agents.a.api.sent.some((message) => message.text === "The build is green."));
	assert.equal(agents.a.api.sent.find((message) => message.text === "The build is green.")?.replyTo, 10);
	await waitFor(() => (shared as GroupJournal) && agents.a.journal.records.some((record) => record.type === "group_post_recorded"));
	const answer = (await shared.timeline({ chatId: GROUP, limit: 10 })).at(-1)!;
	assert.equal(answer.text, "The build is green.");
	assert.equal(answer.senderKind, "agent");
	assert.equal(answer.replyToMessageId, 10);
	assert.equal(answer.posting?.kind, "answer");
});

test("a request with telegram_group_send wakes the mentioned peer, whose answer wakes the asker", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified") && agents.b.status().includes("group=verified"));
	const send = agents.a.tools.get("telegram_group_send");
	const result = await send.execute("call-1", { text: "@example_agent_b_bot what is the deploy status?" });
	const requestId = result.details.messageId as number;
	await waitFor(() => agents.b.prompts.length === 1);
	assert.match(agents.b.prompts[0]!, /From: Agent A \(@example_agent_a_bot\) \(peer authority\)\nYour final reply goes to the group chat, as a reply to message \d+\./);
	const request = await shared.message(GROUP, requestId);
	assert.equal(request?.posting?.kind, "request");

	await agents.b.runTurn("Deploy finished at noon.");
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /From: Agent B \(@example_agent_b_bot\) \(peer authority\)[\s\S]*Deploy finished at noon\.$/);
	assert.equal(agents.b.api.sent.at(-1)?.replyTo, requestId);
	const repeated = await send.execute("call-1", { text: "@example_agent_b_bot what is the deploy status?" });
	assert.equal(repeated.details.messageId, requestId, "a repeated tool call returns the original message");
	assert.equal(agents.a.api.sent.filter((message) => message.text.startsWith("@example_agent_b_bot")).length, 1);
});

test("a wake-up that fails is retried until the peer accepts it", async (t) => {
	let attempts = 0;
	const { agents } = await twoAgents(t, async (to, messageId) => {
		attempts += 1;
		if (attempts < 3) return "retry";
		const response = await fetch(`http://127.0.0.1:${agents[to].port()}/queue`, { method: "POST", body: JSON.stringify({ kind: "group-message", messageId }) });
		return response.status === 202 ? "accepted" : "rejected";
	});
	await waitFor(() => agents.a.status().includes("group=verified"));
	await agents.a.tools.get("telegram_group_send").execute("call-2", { text: "@example_agent_b_bot ping" });
	await waitFor(() => agents.b.prompts.length === 1, 10_000);
	assert.ok(attempts >= 3);
	await waitFor(() => agents.a.journal.records.some((record) => record.type === "group_wake_done" && record.outcome === "accepted"));
});

test("messages for other agents and from other senders are recorded but not routed here", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified"));
	const forB = "@example_agent_b_bot only you";
	await agents.a.batch([ownerGroupMessage(20, forB, { entities: [mention(forB, AGENTS.b.username)] })]);
	await agents.a.batch([{ update_id: updateId++, message: { message_id: 21, date: 1_790_000_021, text: "@example_agent_a_bot hi", entities: [mention("@example_agent_a_bot hi", AGENTS.a.username)], chat: { id: GROUP, type: "supergroup" }, from: { id: 999, first_name: "Stranger" } } }]);
	await agents.a.batch([{ update_id: updateId++, message: { message_id: 22, date: 1_790_000_022, text: "@example_agent_a_bot hi", entities: [mention("@example_agent_a_bot hi", AGENTS.a.username)], chat: { id: GROUP, type: "supergroup" }, sender_chat: { id: GROUP, type: "supergroup" }, from: { id: 1087968824, first_name: "Group" } } }]);
	await waitFor(() => agents.a.journal.records.filter((record) => record.type === "group_handled" && record.stage === "routed").length >= 3);
	assert.equal(agents.a.prompts.length, 0);
	const timeline = await shared.timeline({ chatId: GROUP, limit: 10 });
	assert.deepEqual(timeline.map((message) => [message.messageId, message.senderKind]), [[20, "owner"], [21, "other"], [22, "other"]]);
});

test("an owner reply to a message missing from the journal repairs it from Telegram's copy", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified"));
	const lost = { message_id: 30, date: 1_790_000_030, text: "@example_agent_a_bot please review", chat: { id: GROUP, type: "supergroup" }, from: { id: AGENTS.b.id, is_bot: true, username: AGENTS.b.username } };
	const text = "@example_agent_a_bot see above";
	await agents.a.batch([ownerGroupMessage(31, text, { entities: [mention(text, AGENTS.a.username)], reply_to_message: lost })]);
	await waitFor(() => agents.a.prompts.length === 1);
	const repaired = await shared.message(GROUP, 30);
	assert.equal(repaired?.sender, "Agent B");
	assert.equal(repaired?.text, "@example_agent_a_bot please review");
	assert.match(agents.a.prompts[0]!, /This replies to Agent B's message 30: @example_agent_a_bot please review/);
});

test("membership mismatches pause group sends, report privately and remove strangers", async (t) => {
	const { agents } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified"));
	agents.a.api.count = 4;
	agents.a.api.members.set(999, "member");
	await agents.a.batch([{ update_id: updateId++, chat_member: { chat: { id: GROUP, type: "supergroup" }, new_chat_member: { status: "member", user: { id: 999, first_name: "Stranger" } } } }]);
	await waitFor(() => agents.a.api.calls.includes("remove:999"));
	await waitFor(() => agents.a.status().includes("group=unverified"));
	assert.match(agents.a.privateReplies.at(-1)!, /Group chat paused: the group has 4 members; expected 3/);
	await assert.rejects(agents.a.tools.get("telegram_group_send").execute("call-3", { text: "hello" }), /not available/);

	agents.a.api.count = 3;
	agents.a.api.members.delete(999);
	await agents.a.batch([{ update_id: updateId++, chat_member: { chat: { id: GROUP, type: "supergroup" }, new_chat_member: { status: "left", user: { id: 999 } } } }]);
	await waitFor(() => agents.a.status().includes("group=verified"));
	assert.match(agents.a.privateReplies.at(-1)!, /verified/);
});

test("an agent leaves other groups it is added to", async (t) => {
	const { agents } = await twoAgents(t);
	await agents.a.batch([{ update_id: updateId++, my_chat_member: { chat: { id: -100999, type: "supergroup" }, new_chat_member: { status: "member", user: { id: AGENTS.a.id } } } }]);
	await waitFor(() => agents.a.api.calls.includes("leave:-100999"));
});

test("a group reply waits while membership is unverified and is sent once it is verified", async (t) => {
	const { agents } = await twoAgents(t);
	await waitFor(() => agents.a.status().includes("group=verified"));
	const text = "@example_agent_a_bot status?";
	await agents.a.batch([ownerGroupMessage(40, text, { entities: [mention(text, AGENTS.a.username)] })]);
	await waitFor(() => agents.a.prompts.length === 1);
	agents.a.api.chatType = "group";
	await agents.a.batch([{ update_id: updateId++, my_chat_member: { chat: { id: GROUP, type: "supergroup" }, new_chat_member: { status: "administrator", user: { id: AGENTS.a.id } } } }]);
	await waitFor(() => agents.a.status().includes("group=unverified"));
	await agents.a.runTurn("All good.");
	assert.equal(agents.a.api.sent.some((message) => message.text === "All good."), false);
	agents.a.api.chatType = "supergroup";
	await agents.a.batch([{ update_id: updateId++, my_chat_member: { chat: { id: GROUP, type: "supergroup" }, new_chat_member: { status: "administrator", user: { id: AGENTS.a.id } } } }]);
	await waitFor(() => agents.a.status().includes("group=verified"));
	await agents.a.batch([]);
	await waitFor(() => agents.a.api.sent.some((message) => message.text === "All good." && message.replyTo === 40));
});

test("journal changes request a coalesced lexical refresh of the group store when it is available", async (t) => {
	const sharedRoot = await mkdtemp(join(tmpdir(), "group-refresh-"));
	const listeners = new Map<string, Array<(value: any) => void>>();
	const requests: any[] = [];
	const events = {
		on(name: string, handler: (value: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== handler)); },
		emit(name: string, value: any) {
			if (name === "pi-markdown-datastore:v1:capability-request") for (const handler of listeners.get("pi-markdown-datastore:v1:capability-reply") ?? []) handler({ version: 1, requestId: value.requestId, capability: { version: 1, contractVersion: 1, ready: true, stores: ["telegram-group"] } });
			if (name === "pi-markdown-datastore:v1:request") {
				requests.push(value.request);
				value.resolve({ contractVersion: 1, operation: value.request.operation, store: value.request.input.store, data: {}, provenance: {}, bounds: {}, warnings: [] });
			}
		},
	};
	const agent = startAgent("a", sharedRoot, { next: 9_000 }, async () => "accepted", { events, datastore: { mode: "auto", store: "telegram-group" } });
	await agent.emit("session_start", { type: "session_start", reason: "startup" });
	t.after(async () => { await agent.emit("session_shutdown", { type: "session_shutdown", reason: "exit" }); await rm(sharedRoot, { recursive: true, force: true }); });
	await waitFor(() => agent.status().includes("group=verified"));
	await agent.batch([ownerGroupMessage(50, "first"), ownerGroupMessage(51, "second")]);
	await waitFor(() => requests.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(requests, [{ operation: "refresh", input: { action: "start", store: "telegram-group", mode: "lexical" } }], "two new messages coalesce into one refresh");
});
