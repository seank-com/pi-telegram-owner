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
import { ConfigurationError, loadTelegramOwnerConfig, TelegramReplyAnchorError, type GroupAgentConfig, type GroupChatConfig } from "../src/runtime.ts";

const OWNER = 7;
const GROUP = -1001234567890;
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const journalOptions = { bootIdentity: () => ({ id: "synthetic-boot", startedAtMs: 1 }), pidState: (pid: number) => (pid === process.pid ? "alive" as const : "dead" as const), sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)) };

const AGENTS = {
	a: { id: 201, username: "example_agent_a_bot", name: "Agent A", privateChat: 71 },
	b: { id: 202, username: "example_agent_b_bot", name: "Agent B", privateChat: 72 },
	c: { id: 203, username: "example_agent_c_bot", name: "Agent C", privateChat: 73 },
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
	private readonly ids: { next: number; senders?: Map<number, number> };
	constructor(self: (typeof AGENTS)[AgentKey], ids: { next: number; senders?: Map<number, number> }) {
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
		// Like Telegram, a bot cannot reply to another bot's message.
		const senders = (this.ids.senders ??= new Map());
		const target = replyTo ? senders.get(replyTo) : undefined;
		if (target !== undefined && target !== this.self.id) throw new TelegramReplyAnchorError("Telegram rejected missing reply target");
		const id = this.ids.next++;
		senders.set(id, this.self.id);
		this.sent.push({ id, text, ...(replyTo ? { replyTo } : {}) });
		this.calls.push(`send:${id}:${replyTo}:${text}`);
		return String(id);
	}
	async editMessageText(messageId: string, text: string) { this.calls.push(`edit:${messageId}:${text}`); }
	async deleteMessage(messageId: string) { this.calls.push(`delete:${messageId}`); }
	downloads = 0;
	failDownloads = false;
	async downloadImage() {
		this.downloads += 1;
		if (this.failDownloads) throw new Error("Telegram image contents do not match the declared type");
		return { data: PNG.toString("base64"), mimeType: "image/png" };
	}
}

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function peerConfig(key: AgentKey, port = 7000): GroupAgentConfig {
	return { telegramAccount: AGENTS[key].username, telegramName: AGENTS[key].name, botUserId: AGENTS[key].id, queuePort: port };
}

interface Agent {
	key: AgentKey;
	journal: MemoryJournal;
	api: FakeGroupApi;
	prompts: string[];
	promptImages: Array<Array<{ data: string; mimeType: string }>>;
	privateReplies: string[];
	privateSends: Array<{ text: string; replyTo?: number }>;
	tools: Map<string, any>;
	startTurn(): Promise<string>;
	finishTurn(answer: string): Promise<void>;
	status(): string;
	port(): number;
	emit(name: string, event: object): Promise<void>;
	batch(updates: TelegramUpdate[]): Promise<number | undefined>;
	setIdle(value: boolean): void;
	runTurn(answer: string): Promise<string>;
}

function startAgent(key: AgentKey, sharedRoot: string, ids: { next: number }, wake: (peer: GroupAgentConfig, messageId: number) => Promise<WakeResult>, extra: { events?: unknown; datastore?: GroupChatConfig["datastore"]; electionStepMs?: number; otherAgents?: GroupAgentConfig[]; retryDelayMs?: (attempt: number) => number; coordinate?: (peer: GroupAgentConfig, body: unknown) => Promise<{ status: number; body: unknown } | undefined> } = {}): Agent {
	const self = AGENTS[key];
	const other: AgentKey = key === "a" ? "b" : "a";
	const journal = new MemoryJournal();
	const api = new FakeGroupApi(self, ids);
	const prompts: string[] = [];
	const promptImages: Array<Array<{ data: string; mimeType: string }>> = [];
	const privateReplies: string[] = [];
	const privateSends: Array<{ text: string; replyTo?: number }> = [];
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
		sendUserMessage(content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
			if (typeof content === "string") { prompts.push(content); promptImages.push([]); return; }
			prompts.push(content.find((part) => part.type === "text")?.text ?? "");
			promptImages.push(content.filter((part) => part.type === "image").map((part) => ({ data: part.data!, mimeType: part.mimeType! })));
		},
	} as unknown as ExtensionAPI;
	const config: GroupChatConfig = { chatId: GROUP, sharedRoot, datastore: extra.datastore ?? { mode: "off", store: "telegram-group" }, electionStepMs: extra.electionStepMs ?? 250, otherAgents: extra.otherAgents ?? [peerConfig(other)] };
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: self.privateChat, agentLabel: self.name, queuePort: 0,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply(text, replyTo) { privateReplies.push(text); privateSends.push({ text, ...(replyTo ? { replyTo } : {}) }); return String(ids.next++); },
		async sendActivity(text, _signal, replyTo) { privateSends.push({ text, ...(replyTo ? { replyTo } : {}) }); return String(ids.next++); },
		async editActivity() {},
		async deleteActivity() {},
		groupChat: { config, api, journalOptions, wake, coordinate: extra.coordinate ?? (async (_peer,body:any)=>({status:200,body:{roster:body.roster,groupLifecycleVersion:1,match:true}})), ...(extra.retryDelayMs ? { retryDelayMs: extra.retryDelayMs } : {}) },
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT, isIdle: () => idle,
		sessionManager: { getSessionId: () => `session-${key}`, getBranch: () => [] },
		ui: { setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const startTurn = async () => {
		const prompt = prompts.at(-1)!;
		await emit("input", { type: "input", source: "extension", text: prompt });
		await emit("before_agent_start", { type: "before_agent_start", prompt });
		idle = false;
		return prompt;
	};
	const finishTurn = async (answer: string) => {
		await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: answer }] });
		idle = true;
		await emit("agent_settled", { type: "agent_settled" });
	};
	return {
		key, journal, api, prompts, promptImages, privateReplies, privateSends, tools, emit, startTurn, finishTurn,
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

async function twoAgents(t: test.TestContext, wakeOverride?: (to: AgentKey, messageId: number) => Promise<WakeResult>, stepFor: Partial<Record<AgentKey, number>> = {}) {
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
	const coordinateFor = (from: AgentKey) => async (_peer: GroupAgentConfig, body: unknown) => {
		const to: AgentKey = from === "a" ? "b" : "a";
		const port = agents[to]?.port();
		if (!port) return undefined;
		try {
			const response = await fetch(`http://127.0.0.1:${port}/coordinate`, { method: "POST", body: JSON.stringify(body) });
			return { status: response.status, body: await response.json() };
		} catch {
			return undefined;
		}
	};
	agents.a = startAgent("a", sharedRoot, ids, wakeFor("a"), { coordinate: coordinateFor("a"), electionStepMs: stepFor.a });
	agents.b = startAgent("b", sharedRoot, ids, wakeFor("b"), { coordinate: coordinateFor("b"), electionStepMs: stepFor.b });
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
	assert.match(agents.a.prompts[0]!, /^\[telegram-item:[0-9a-f-]{36}\]\nChannel: group chat\nFrom: the owner \(owner authority\)\nTask:[^\n]+\n(?:Request obligation:[^\n]+\n)?Your final reply goes to the group chat, as a reply to message 10\./);
	assert.ok(agents.a.prompts[0]!.endsWith(text), "UTF-16 entity offsets resolve the mention after an emoji");
	assert.doesNotMatch(agents.a.prompts[0]!, /You were chosen/, "only elected items get the fan-out instruction");
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
	const result = await send.execute("call-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot what is the deploy status?" });
	const requestId = result.details.messageId as number;
	await waitFor(() => agents.b.prompts.length === 1);
	assert.match(agents.b.prompts[0]!, /From: Agent A \(@example_agent_a_bot\) \(peer authority\)\nTask:[^\n]+\n(?:Request obligation:[^\n]+\n)?Your final reply goes to the group chat, as a reply to message \d+\./);
	const request = await shared.message(GROUP, requestId);
	assert.equal(request?.posting?.kind, "request");

	await agents.b.runTurn("Deploy finished at noon.");
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /From: Agent B \(@example_agent_b_bot\) \(peer authority\)[\s\S]*Deploy finished at noon\.$/);
	// Telegram rejects a bot's reply to another bot, so the answer quotes the request and mentions the asker.
	const answer = agents.b.api.sent.at(-1)!;
	assert.equal(answer.replyTo, undefined);
	assert.match(answer.text, /^> Agent A: @example\\_agent\\_b\\_bot what is the deploy status\?\n\n@example_agent_a_bot\nDeploy finished at noon\.$/);
	assert.equal((await shared.timeline({ chatId: GROUP, limit: 1 }))[0]!.replyToMessageId, requestId, "the journal keeps the reply link");
	const repeated = await send.execute("call-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot what is the deploy status?" });
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
	await agents.a.tools.get("telegram_group_send").execute("call-2", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot ping" });
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
	await assert.rejects(agents.a.tools.get("telegram_group_send").execute("call-3", { kind: "notify", text: "hello" }), /not available/);

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

function ownerPrivate(agent: AgentKey, messageId: number, text: string): TelegramUpdate {
	return { update_id: updateId++, message: { message_id: messageId, date: 1_790_000_000 + messageId, text, chat: { id: AGENTS[agent].privateChat, type: "private" }, from: { id: OWNER } } };
}

async function verified(agents: Record<AgentKey, Agent>): Promise<void> {
	await waitFor(() => agents.a.status().includes("group=verified") && agents.b.status().includes("group=verified"));
}

test("a consultation started privately returns its answer to the owner's private message", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	await agents.a.batch([ownerPrivate("a", 300, "Ask the other agent whether the deploy finished.")]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	const request = await agents.a.tools.get("telegram_group_send").execute("consult-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot did the deploy finish?" });
	await agents.a.finishTurn("I asked Agent B and will report back.");
	assert.deepEqual(agents.a.privateSends.at(-1), { text: "I asked Agent B and will report back.", replyTo: 300 });

	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.runTurn("Yes, at noon.");
	await waitFor(() => agents.a.prompts.length === 2);
	const prompt = agents.a.prompts[1]!;
	assert.match(prompt, /Your final reply goes to the private chat with the owner, as a reply to message 300./);
	assert.match(prompt, /^\[telegram-item:[^\]]+\]\nChannel: private owner chat/);
	assert.ok(prompt.includes(`Request ${request.details.requestId}, recipient 202, completed`));
	assert.match(prompt, /Ask the other agent whether the deploy finished\.[\s\S]*Yes, at noon\./);
	await agents.a.runTurn("The deploy finished at noon.");
	assert.deepEqual(agents.a.privateSends.at(-1), { text: "The deploy finished at noon.", replyTo: 300 });
});

test("an answer to a request made for the owner's group message returns there and wakes nobody else", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await verified(agents);
	const text = "@example_agent_a_bot I need everyone's status";
	await Promise.all([agents.a.batch([ownerGroupMessage(60, text, { entities: [mention(text, AGENTS.a.username)] })]), agents.b.batch([ownerGroupMessage(60, text, { entities: [mention(text, AGENTS.a.username)] })])]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	await agents.a.tools.get("telegram_group_send").execute("fanout-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot the owner needs your status", replyToMessageId: 60 });
	await agents.a.finishTurn("Mine: reviewing the build. Asked Agent B.");
	await waitFor(() => agents.b.prompts.length === 1);
	assert.match(agents.b.prompts[0]!, /This replies to the owner's message 60: @example_agent_a_bot I need everyone's status/);
	await agents.b.runTurn("Mine: idle. @example_agent_a_bot thanks!");
	await waitFor(() => agents.a.prompts.length === 2);
	assert.match(agents.a.prompts[1]!, /Your final reply goes to the group chat, as a reply to message 60./);
	await agents.a.runTurn("Both statuses are in.");
	await waitFor(() => agents.a.api.sent.some((message) => message.text === "Both statuses are in." && message.replyTo === 60));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(agents.b.prompts.length, 1, "neither the answer's mention nor the final summary wakes the other agent");
	assert.equal((await shared.timeline({ chatId: GROUP, limit: 1 }))[0]!.posting?.kind, "answer");
});

test("a clarifying question is a request: it wakes the asker, and answers unwind back to the original origin", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const text = "@example_agent_a_bot fix the flaky test";
	await agents.a.batch([ownerGroupMessage(70, text, { entities: [mention(text, AGENTS.a.username)] })]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	const ask = await agents.a.tools.get("telegram_group_send").execute("ask-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot which test was flaky for you?" });
	await agents.a.finishTurn("Looking into it.");

	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.startTurn();
	const clarify = await agents.b.tools.get("telegram_group_send").execute("clarify-1", { kind: "request", recipients:["@example_agent_a_bot"], text: "Do you mean the unit or the package tests?", replyToMessageId: ask.details.messageId });
	await agents.b.finishTurn("Waiting on your answer.");

	await waitFor(() => agents.a.prompts.length === 2);
	assert.match(agents.a.prompts[1]!, new RegExp(`Your final reply goes to the group chat, as a reply to message ${clarify.details.messageId}\\.`));
	await agents.a.runTurn("The package tests.");

	await waitFor(() => agents.b.prompts.length === 2);
	assert.match(agents.b.prompts[1]!, new RegExp(`Your final reply goes to the group chat, as a reply to message ${ask.details.messageId}\\.`), "the answer to the clarifying question returns to the original request");
	await agents.b.runTurn("The package test timed out on CI twice.");

	await waitFor(() => agents.a.prompts.length === 3);
	assert.match(agents.a.prompts[2]!, /Your final reply goes to the group chat, as a reply to message 70./, "and that answer returns to the owner's message");
});

test("/new ends queued group work with a notice that wakes the requester, and closes outstanding requests", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	agents.b.setIdle(false);
	const queued = await agents.a.tools.get("telegram_group_send").execute("queued-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot please summarize" });
	await waitFor(() => agents.b.api.sent.some((message) => /^RE: Agent A: @example\\_agent\\_b\\_bot please summarize\nQueued:/.test(message.text) || /^RE: Agent A: @example_agent_b_bot please summarize\nQueued:/.test(message.text)));
	assert.equal(agents.b.prompts.length, 0, "the request waits behind B's other work");

	const outstanding = await agents.b.tools.get("telegram_group_send").execute("pending-1", { kind: "request", recipients: ["@example_agent_a_bot"], text: "@example_agent_a_bot can you check logs?" });
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /can you check logs\?$/);

	agents.b.setIdle(true);
	await agents.b.batch([ownerPrivate("b", 400, "/new")]);
	await waitFor(() => agents.b.journal.records.some((record) => record.type === "command_started"));
	await agents.b.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
	await agents.b.emit("session_start", { type: "session_start", reason: "new" });
	await waitFor(() => agents.b.api.sent.some((message) => message.text.endsWith("@example_agent_a_bot\nNot handled: the owner reset Agent B's session.") && message.replyTo === undefined));
	assert.match(agents.b.privateReplies.at(-1)!, /^Started a new session\./);

	await agents.a.runTurn("Logs are clean.");
	await waitFor(() => agents.a.prompts.length === 2);
	assert.match(agents.a.prompts[1]!, /Not handled: the owner reset Agent B's session\.$/, "the notice answers A's request and wakes A");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(agents.b.prompts.some((prompt) => prompt.includes("Logs are clean.")), false, "an answer to a request closed by /new does not start work");
	assert.ok(agents.b.journal.records.some((record) => record.type === "group_requests_closed"));
	assert.ok(outstanding.details.messageId);
});

test("election ranks rotate the roster by message ID", async () => {
	const { GroupRuntime } = await import("../src/group-runtime.ts");
	const runtime = new GroupRuntime({ config: { chatId: GROUP, sharedRoot: "/x", datastore: { mode: "off", store: "telegram-group" }, electionStepMs: 250, otherAgents: [peerConfig("b"), { telegramAccount: "example_agent_c_bot", telegramName: "Agent C", botUserId: 203, queuePort: 7003 }] }, ownerUserId: OWNER, api: new FakeGroupApi(AGENTS.a, { next: 1 }), journal: new GroupJournal("/x"), bridge: () => undefined, admit: async () => undefined, quietWindowMs: 0, report() {}, onError() {} });
	await runtime.start();
	assert.deepEqual([90, 91, 92, 93].map((id) => runtime.electionRank(id)), [0, 2, 1, 0]);
	await runtime.stop();
});

test("an unaddressed owner message is claimed by exactly one idle agent, rotating by message", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await verified(agents);
	for (const [messageId, expected] of [[80, "a"], [81, "b"]] as const) {
		const update = ownerGroupMessage(messageId, "Can anyone look at this?");
		await Promise.all([agents.a.batch([update]), agents.b.batch([update])]);
		const winner = agents[expected];
		const loser = agents[expected === "a" ? "b" : "a"];
		await waitFor(() => winner.prompts.length === 1);
		assert.match(winner.prompts[0]!, /From: the owner \(owner authority\)/);
		const others = expected === "a" ? "@example_agent_b_bot" : "@example_agent_a_bot";
		assert.ok(winner.prompts[0]!.includes(`You were chosen to handle this message because it did not @mention anyone. If it asks for everyone or implies it, answer for yourself, then ask the others (${others}) to answer as well using telegram_group_send, replying to message ${messageId}.`));
		assert.equal(await shared.claimFor(GROUP, messageId), AGENTS[expected].username);
		await waitFor(() => loser.journal.records.some((record) => record.type === "group_candidate_done" && record.firstMessageId === messageId && record.outcome === "lost"));
		assert.equal(loser.prompts.length, 0);
		await winner.runTurn("On it.");
		winner.prompts.length = 0;
	}
});

test("a busy rank-0 agent loses the item to an idle peer after one election step", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await verified(agents);
	agents.a.setIdle(false);
	const update = ownerGroupMessage(82, "Is anybody free?");
	const started = Date.now();
	await Promise.all([agents.a.batch([update]), agents.b.batch([update])]);
	await waitFor(() => agents.b.prompts.length === 1, 3_000);
	assert.ok(Date.now() - started >= 200, "the rank-1 agent waits one step");
	assert.equal(await shared.claimFor(GROUP, 82), AGENTS.b.username);
	agents.a.setIdle(true);
	await agents.a.emit("agent_settled", { type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(agents.a.prompts.length, 0);
});

test("when everyone is busy one notice is posted, and the first agent to become idle claims the item and removes it", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await verified(agents);
	agents.a.setIdle(false);
	agents.b.setIdle(false);
	const update = ownerGroupMessage(84, "Whoever is free: please triage.");
	await Promise.all([agents.a.batch([update]), agents.b.batch([update])]);
	await waitFor(() => [...agents.a.api.sent, ...agents.b.api.sent].some((message) => message.text.startsWith("Everyone is busy")), 3_000);
	await new Promise((resolve) => setTimeout(resolve, 600));
	const notices = [...agents.a.api.sent, ...agents.b.api.sent].filter((message) => message.text.startsWith("Everyone is busy"));
	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.replyTo, 84);
	assert.equal(await shared.noticeFor(GROUP, 84), notices[0]!.id);

	agents.b.setIdle(true);
	await agents.b.emit("agent_settled", { type: "agent_settled" });
	await waitFor(() => agents.b.prompts.length === 1);
	assert.equal(await shared.claimFor(GROUP, 84), AGENTS.b.username);
	await waitFor(() => agents.b.api.calls.includes(`delete:${notices[0]!.id}`));
	agents.a.setIdle(true);
	await agents.a.emit("agent_settled", { type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(agents.a.prompts.length, 0);
});

test("agents that disagree on the roster or election step pause the group", async (t) => {
	const { agents, shared } = await twoAgents(t, undefined, { b: 500 });
	await waitFor(() => agents.a.status().includes("group=unverified") || agents.b.status().includes("group=unverified"), 3_000);
	const paused = agents.b.status().includes("group=unverified") ? agents.b : agents.a;
	assert.match(paused.privateReplies.at(-1)!, /group configuration or lifecycle protocol differs/);
	assert.ok((await shared.events()).some((event) => event.kind === "roster_check" && event.result === "mismatch"));
});

test("an owner photo is stored once in the shared root and given to the addressed agent as an image", async (t) => {
	const { agents, shared, sharedRoot } = await twoAgents(t);
	await verified(agents);
	const caption = "@example_agent_a_bot what is in this picture?";
	const update = ownerGroupMessage(90, "", { text: undefined, caption, caption_entities: [mention(caption, AGENTS.a.username)], photo: [{ file_id: "small", file_size: 10 }, { file_id: "large", file_size: PNG.length }] });
	await agents.a.batch([update]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.b.batch([update]);
	await waitFor(() => agents.b.journal.records.some((record) => record.type === "group_handled" && record.stage === "routed"));
	assert.equal(agents.a.api.downloads + agents.b.api.downloads, 1, "the agent that records the photo downloads it; the other does not");
	const recorded = await shared.message(GROUP, 90);
	assert.match(recorded?.media?.attachment ?? "", /^_attachments\/[0-9a-f]{64}\.jpg$/, "Telegram photos are JPEG");
	const { readFile } = await import("node:fs/promises");
	assert.deepEqual(await readFile(join(sharedRoot, recorded!.media!.attachment!)), PNG);
	assert.ok(agents.a.prompts[0]!.endsWith(caption), "the caption routes and is the item text");
	assert.deepEqual(agents.a.promptImages[0], [{ data: PNG.toString("base64"), mimeType: "image/jpeg" }]);
});

test("an attachment the agent cannot open is recorded and the agent is told to say so", async (t) => {
	const { agents, shared } = await twoAgents(t);
	await verified(agents);
	const caption = "@example_agent_a_bot please review";
	await agents.a.batch([ownerGroupMessage(91, "", { text: undefined, caption, caption_entities: [mention(caption, AGENTS.a.username)], document: { file_id: "doc", file_name: "report.json", mime_type: "application/json", file_size: 1200 } })]);
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /The owner's message includes a document named report\.json that you cannot open; say so in your reply if it matters\./);
	assert.equal(agents.a.api.downloads, 0);
	assert.deepEqual((await shared.message(GROUP, 91))?.media, { kind: "document", fileName: "report.json", mimeType: "application/json", size: 1200 });
});

test("a group turn is told how many group messages it missed since its previous group turn", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const forB = (id: number) => { const text = `@example_agent_b_bot note ${id}`; return ownerGroupMessage(id, text, { entities: [mention(text, AGENTS.b.username)] }); };
	const forA = (id: number) => { const text = `@example_agent_a_bot task ${id}`; return ownerGroupMessage(id, text, { entities: [mention(text, AGENTS.a.username)] }); };
	const routed = () => agents.a.journal.records.filter((record) => record.type === "group_handled" && record.stage === "routed").length;
	await agents.a.batch([forB(110), forB(111)]);
	await waitFor(() => routed() === 2);
	await agents.a.batch([forA(112)]);
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /There are 2 group messages before this one; read them with telegram_group_timeline if they matter\./);
	await agents.a.runTurn("Done.");
	await agents.a.batch([forB(120)]);
	await waitFor(() => routed() === 4);
	await agents.a.batch([forA(121)]);
	await waitFor(() => agents.a.prompts.length === 2);
	assert.match(agents.a.prompts[1]!, /1 group message arrived since your previous group turn/, "its own answer is not counted");
	await agents.a.runTurn("Done again.");
	await agents.a.batch([forA(130)]);
	await waitFor(() => agents.a.prompts.length === 3);
	assert.doesNotMatch(agents.a.prompts[2]!, /group messages? (arrived|before)/);
});

test("a failed peer request gets a visible notice that wakes the requester", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const request = await agents.a.tools.get("telegram_group_send").execute("fail-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot run the migration" });
	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.startTurn();
	await agents.b.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }] });
	agents.b.setIdle(true);
	await agents.b.emit("agent_settled", { type: "agent_settled" });
	await waitFor(() => agents.b.api.sent.some((message) => message.text.endsWith("@example_agent_a_bot\nCouldn't finish this: the model request failed.")));
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /Couldn't finish this: the model request failed\.$/);
});

test("/status in the private chat reports the group, the endpoint and the last failed turn", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const text = "@example_agent_a_bot try this";
	await agents.a.batch([ownerGroupMessage(140, text, { entities: [mention(text, AGENTS.a.username)] })]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	await agents.a.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
	agents.a.setIdle(true);
	await agents.a.emit("agent_settled", { type: "agent_settled" });
	await agents.a.batch([ownerPrivate("a", 500, "/status")]);
	await waitFor(() => agents.a.privateReplies.some((reply) => reply.startsWith("State:")));
	const status = agents.a.privateReplies.find((reply) => reply.startsWith("State:"))!;
	assert.match(status, /Telegram: \w+, queue 0 owner, 0 peer/);
	assert.match(status, /\nGroup: verified/);
	assert.match(status, /\nQueue endpoint: 127\.0\.0\.1:\d+/);
	assert.match(status, /\nLast failed turn: ABORTED at /);
});

async function oneAgent(t: test.TestContext, extra: Parameters<typeof startAgent>[4] = {}, wake: (peer: GroupAgentConfig, messageId: number) => Promise<WakeResult> = async () => "accepted") {
	const sharedRoot = await mkdtemp(join(tmpdir(), "group-one-"));
	const agent = startAgent("a", sharedRoot, { next: 20_000 }, wake, extra);
	await agent.emit("session_start", { type: "session_start", reason: "startup" });
	t.after(async () => { await agent.emit("session_shutdown", { type: "session_shutdown", reason: "exit" }); await rm(sharedRoot, { recursive: true, force: true }); });
	return { agent, sharedRoot, shared: new GroupJournal(sharedRoot, journalOptions) };
}

test("a photo that cannot be downloaded is recorded as unusable and later messages still route", async (t) => {
	const { agent, shared } = await oneAgent(t);
	await waitFor(() => agent.status().includes("group=verified"));
	agent.api.failDownloads = true;
	const caption = "@example_agent_a_bot look";
	await agent.batch([ownerGroupMessage(150, "", { text: undefined, caption, caption_entities: [mention(caption, AGENTS.a.username)], document: { file_id: "bad", mime_type: "image/png", file_size: 10 } })]);
	await waitFor(() => agent.prompts.length === 1);
	assert.match(agent.prompts[0]!, /includes a document that you cannot open/);
	await agent.runTurn("I can't open that image.");
	const next = "@example_agent_a_bot and this?";
	await agent.batch([ownerGroupMessage(151, next, { entities: [mention(next, AGENTS.a.username)] })]);
	await waitFor(() => agent.prompts.length === 2);
	assert.equal((await shared.message(GROUP, 150))?.media?.attachment, undefined);
});

test("a group image that cannot be read is left out without blocking private work", async (t) => {
	const { agent, sharedRoot, shared } = await oneAgent(t);
	await waitFor(() => agent.status().includes("group=verified"));
	agent.setIdle(false);
	const caption = "@example_agent_a_bot see";
	await agent.batch([ownerGroupMessage(160, "", { text: undefined, caption, caption_entities: [mention(caption, AGENTS.a.username)], photo: [{ file_id: "p", file_size: 10 }] })]);
	await waitFor(() => agent.journal.records.some((record) => record.type === "work_item"));
	await rm(join(sharedRoot, (await shared.message(GROUP, 160))!.media!.attachment!));
	await agent.batch([ownerPrivate("a", 600, "private question")]);
	agent.setIdle(true);
	await agent.emit("agent_settled", { type: "agent_settled" });
	await waitFor(() => agent.prompts.length === 1);
	assert.deepEqual(agent.promptImages[0], [], "the unreadable image is left out");
	await agent.runTurn("Answered without the image.");
	await waitFor(() => agent.prompts.length === 2);
	assert.match(agent.prompts[1]!, /private question$/);
});

test("service messages such as pins are not conversation and start no work", async (t) => {
	const { agent, shared } = await oneAgent(t);
	await waitFor(() => agent.status().includes("group=verified"));
	await agent.batch([{ update_id: updateId++, message: { message_id: 170, date: 1_790_000_170, chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER }, pinned_message: { message_id: 1 } } as unknown as TelegramMessage }]);
	await waitFor(() => agent.journal.records.some((record) => record.type === "group_handled" && record.stage === "routed"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(agent.prompts.length, 0);
	assert.equal(await shared.message(GROUP, 170), undefined);
});

test("while the group is paused, group items wait and private queued notices still go out", async (t) => {
	const { agent } = await oneAgent(t);
	await waitFor(() => agent.status().includes("group=verified"));
	agent.setIdle(false);
	const text = "@example_agent_a_bot when you can";
	await agent.batch([ownerGroupMessage(180, text, { entities: [mention(text, AGENTS.a.username)] })]);
	await waitFor(() => agent.journal.records.some((record) => record.type === "work_item"));
	agent.api.chatType = "group";
	await agent.batch([{ update_id: updateId++, my_chat_member: { chat: { id: GROUP, type: "supergroup" }, new_chat_member: { status: "administrator", user: { id: AGENTS.a.id } } } }]);
	await waitFor(() => agent.status().includes("group=unverified"));
	await agent.batch([ownerPrivate("a", 610, "private while busy")]);
	await waitFor(() => agent.privateSends.some((send) => send.text.startsWith("Queued:") && send.replyTo === 610));
	agent.setIdle(true);
	await agent.emit("agent_settled", { type: "agent_settled" });
	await waitFor(() => agent.prompts.length === 1);
	assert.match(agent.prompts[0]!, /private while busy$/, "the private request runs; the group item waits for the group");
});

test("an agent that lists itself among the other agents does not verify", async (t) => {
	const { agent } = await oneAgent(t, { otherAgents: [peerConfig("b"), peerConfig("a", 7001)] });
	await waitFor(() => agent.status().includes("group=unverified"));
	assert.match(agent.privateReplies.at(-1)!, /otherAgents lists this bot \(@example_agent_a_bot\)/);
});

test("a refused peer connection is reported while wake-ups keep retrying", async (t) => {
	let attempts = 0;
	const { agent } = await oneAgent(t, { retryDelayMs: () => 10 }, async () => { attempts += 1; return "unreachable"; });
	await waitFor(() => agent.status().includes("group=verified"));
	await agent.tools.get("telegram_group_send").execute("unreachable-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot are you there?" });
	await waitFor(() => agent.privateReplies.some((reply) => reply.startsWith("Cannot connect to @example_agent_b_bot's queue endpoint on port 7000")), 3_000);
	await waitFor(() => attempts > 6);
	assert.equal(agent.privateReplies.filter((reply) => reply.startsWith("Cannot connect")).length, 1, "reported once");
});

test("a peer that never answers holds no other group work and does not delay shutdown", async (t) => {
	let waiting = 0;
	const sharedRoot = await mkdtemp(join(tmpdir(), "group-slow-"));
	t.after(() => rm(sharedRoot, { recursive: true, force: true }));
	const agent = startAgent("a", sharedRoot, { next: 30_000 }, (_peer, _id, signal) => new Promise<WakeResult>((resolve) => {
		waiting += 1;
		signal?.addEventListener("abort", () => resolve("retry"), { once: true });
	}), {});
	await agent.emit("session_start", { type: "session_start", reason: "startup" });
	await waitFor(() => agent.status().includes("group=verified"));
	await agent.tools.get("telegram_group_send").execute("slow-1", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot take your time" });
	await waitFor(() => waiting === 1);
	const text = "@example_agent_a_bot meanwhile, this";
	await agent.batch([ownerGroupMessage(190, text, { entities: [mention(text, AGENTS.a.username)] })]);
	await waitFor(() => agent.prompts.length === 1);
	const started = Date.now();
	await agent.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
	assert.ok(Date.now() - started < 1_000, "shutdown does not wait for the stalled peer");
	assert.ok(!agent.journal.records.some((record) => record.type === "group_wake_done"), "the wake-up stays pending for the next start");
});

test("an explicit Reply completes its obligation and suppresses only that task's automatic final", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const request = await agents.a.tools.get("telegram_group_send").execute("ask-status", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot what is your status?" });
	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.startTurn();
	const sent = await agents.b.tools.get("telegram_group_send").execute("answer-by-tool", { kind: "reply", requestId:request.details.requestId, text: "Idle; nothing running.", replyToMessageId: request.details.messageId });
	assert.equal(sent.details.kind, 'reply');
	assert.equal(sent.details.requestId, request.details.requestId);
	await agents.b.finishTurn("Status posted to the group.");
	await waitFor(() => agents.b.journal.records.some((record) => record.type === 'turn_finished' && record.mode === 'silent'));
	assert.equal(agents.b.api.sent.some((message) => message.text.includes("Status posted to the group.")), false, "the redundant final is not posted");
	await waitFor(() => agents.a.prompts.length === 1);
	assert.match(agents.a.prompts[0]!, /Idle; nothing running\.$/, "the asker is woken once, by the request");
});

test("an elected agent asking everyone on the owner's behalf still posts its own answer", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const update = ownerGroupMessage(200, "Everyone: quick status please.");
	await Promise.all([agents.a.batch([update]), agents.b.batch([update])]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	const sent = await agents.a.tools.get("telegram_group_send").execute("fanout", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot the owner wants your status", replyToMessageId: 200 });
	assert.equal(sent.details.kind, 'request');
	await agents.a.finishTurn("Mine: idle.");
	await waitFor(() => agents.a.api.sent.some((message) => message.text === "Mine: idle." && message.replyTo === 200));
});

test("an ask-only turn waits durably without an acknowledgment or model-failure notice", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	await agents.a.batch([ownerPrivate("a", 700, "Ask the other agent how many items are on her list.")]);
	await waitFor(() => agents.a.prompts.length === 1);
	await agents.a.startTurn();
	await agents.a.tools.get("telegram_group_send").execute("ask-only", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot how many items are on your list?" });
	await agents.a.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "toolCall", id: "ask-only", name: "telegram_group_send", arguments: {} }], stopReason: "stop" }] });
	agents.a.setIdle(true);
	await agents.a.emit("agent_settled", { type: "agent_settled" });
	await waitFor(() => agents.a.journal.records.some(record=>record.type==='task_state'&&record.state==='waiting'));
	assert.equal(agents.a.privateSends.some(send=>send.text.startsWith('Asked ')),false);
	assert.equal(agents.a.journal.records.some((record) => record.type === "turn_failed"), false);
	assert.equal(agents.a.privateSends.some((send) => send.text.startsWith("Couldn't finish this")), false);
});

test("activity for another agent's request names what it is about", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	await agents.a.tools.get("telegram_group_send").execute("re-line", { kind: "request", recipients: ["@example_agent_b_bot"], text: "@example_agent_b_bot how many items are on your list?" });
	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.startTurn();
	await waitFor(() => agents.b.api.sent.some((message) => message.text.includes("Thinking")));
	const thinking = agents.b.api.sent.find((message) => message.text.includes("Thinking"))!;
	assert.equal(thinking.replyTo, undefined);
	assert.match(thinking.text, /^RE: Agent A: @example_agent_b_bot how many items are on your list\?\nThinking/);
	await agents.b.finishTurn("Nine.");
});

test("repeated delegations on a waiting owner task do not produce waiting acknowledgments", async (t) => {
	const { agents } = await twoAgents(t);
	await verified(agents);
	const askOnly = async (callId: string, text: string, replyToMessageId?: number) => {
		await agents.a.startTurn();
		await agents.a.tools.get("telegram_group_send").execute(callId, { kind:'request',recipients:['@example_agent_b_bot'],text, ...(replyToMessageId ? { replyToMessageId } : {}) });
		await agents.a.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
		agents.a.setIdle(true);
		await agents.a.emit("agent_settled", { type: "agent_settled" });
	};
	await agents.a.batch([ownerPrivate("a", 710, "Ask the other agent how the test went.")]);
	await waitFor(() => agents.a.prompts.length === 1);
	await askOnly("first-ask", "@example_agent_b_bot how did the test go?");
	await waitFor(() => agents.b.prompts.length === 1);
	await agents.b.runTurn("Which test?");
	await waitFor(() => agents.a.prompts.length === 2);
	assert.match(agents.a.prompts[1]!, /Your final reply goes to the private chat with the owner, as a reply to message 710\./);
	await askOnly("second-ask", "@example_agent_b_bot this was the whole test.");
	await waitFor(() => agents.a.journal.records.filter((record) => record.type === 'turn_finished' && record.mode==='waiting').length >= 2);
	const acknowledgements = agents.a.privateSends.filter((send) => send.text.startsWith("Asked @example_agent_b_bot"));
	assert.equal(acknowledgements.length, 0, "waiting is a local disposition, not a repeated Telegram acknowledgment");
	assert.equal(agents.a.privateSends.some((send) => send.text === "Asked again in the group."), false);
});

async function threeAgents(t:test.TestContext){
 const sharedRoot=await mkdtemp(join(tmpdir(),'group-lifecycle-'));const ids={next:40000};const agents={} as Record<AgentKey,Agent>;
 const keys:AgentKey[]=['a','b','c'];
 for(const key of keys){
  agents[key]=startAgent(key,sharedRoot,ids,async(peer,messageId)=>{const target=keys.find(k=>AGENTS[k].id===peer.botUserId)!;const response=await fetch(`http://127.0.0.1:${agents[target].port()}/queue`,{method:'POST',body:JSON.stringify({kind:'group-message',messageId})});return response.status===202?'accepted':'rejected';},{otherAgents:keys.filter(k=>k!==key).map(k=>peerConfig(k)),coordinate:async(peer,body)=>{const target=keys.find(k=>AGENTS[k].id===peer.botUserId)!;const port=agents[target]?.port();if(!port)return undefined;const response=await fetch(`http://127.0.0.1:${port}/coordinate`,{method:'POST',body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}});
  agents[key].api.members.set(203,'administrator');agents[key].api.count=4;
 }
 t.after(async()=>{for(const a of Object.values(agents))await a.emit('session_shutdown',{reason:'exit'});await rm(sharedRoot,{recursive:true,force:true});});
 for(const a of Object.values(agents))await a.emit('session_start',{reason:'startup'});
 await waitFor(()=>Object.values(agents).every(a=>a.status().includes('group=verified')));
 return {agents,shared:new GroupJournal(sharedRoot,journalOptions)};
}
const workSend=(a:Agent,id:string,input:unknown)=>a.tools.get('telegram_group_send').execute(id,input);
async function failTurn(a:Agent){await a.emit('agent_end',{messages:[{role:'assistant',content:[],stopReason:'error',errorMessage:'Synthetic model failure'}]});a.setIdle(true);await a.emit('agent_settled',{});}
async function publications(a:Agent){await waitFor(()=>a.journal.records.filter(r=>r.type==='reply_ready').every(r=>!a.journal.records.some(i=>i.type==='work_item'&&i.itemId===r.jobId&&i.reply.kind==='group')||a.journal.records.some(i=>i.type==='group_post_recorded'&&i.postId===r.jobId)));}

test('strict work kinds and explicit recipients reject ambiguous sends before publication',async(t)=>{
 const {agents}=await twoAgents(t);await verified(agents);const before=agents.a.api.sent.length;
 for(const input of [{text:'implicit request'},{kind:'request',text:'missing recipients'},{kind:'request',text:'unknown',recipients:['@unknown_agent_bot']},{kind:'notify',text:'cross-kind',requestId:'wrong'},{kind:'reply',text:'no obligation',requestId:'unknown'}])await assert.rejects(workSend(agents.a,JSON.stringify(input),input));
 assert.equal(agents.a.api.sent.length,before);
 const result=await workSend(agents.a,'room-only',{kind:'notify',text:'@example_agent_b_bot merely mentioned'});
 assert.equal(result.details.kind,'notify');assert.equal(agents.b.prompts.length,0);
 assert.equal(agents.a.journal.records.some(r=>r.type==='group_wake'),false);
});

test('terminal Reply, informational acknowledgment and substantive late correction terminate without request cascades',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);
 const req=await workSend(agents.a,'initial-report',{kind:'request',text:'Report the result',recipients:['@example_agent_b_bot']});
 await waitFor(()=>agents.b.prompts.length===1);await agents.b.runTurn('Result confirmed.');await waitFor(()=>agents.a.prompts.length===1);
 assert.match(agents.a.prompts[0]!,/Information only/);await agents.a.runTurn('Acknowledged @example_agent_b_bot.');await publications(agents.a);
 assert.equal(agents.b.prompts.length,1);
 await workSend(agents.b,'late-correction',{kind:'reply',requestId:req.details.requestId,text:'Correction: the result changed.'});
 await waitFor(()=>agents.a.prompts.length===2);assert.match(agents.a.prompts[1]!,/Information only/);await agents.a.runTurn('');
 const messages=await shared.timeline({chatId:GROUP,limit:20});assert.deepEqual(messages.map(m=>m.work?.kind),['request','reply','notify','reply']);
 assert.equal(agents.a.journal.records.some(r=>r.type==='turn_failed'),false);
 assert.equal(agents.b.prompts.length,1);
});

test('two fast recipient results coalesce into one owner continuation and remain unconsumed until presented',async(t)=>{
 const {agents,shared}=await threeAgents(t);
 await agents.a.batch([ownerPrivate('a',900,'Ask both agents for results.')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const request=await workSend(agents.a,'both-fast',{kind:'request',text:'Return your independent result',recipients:['@example_agent_b_bot','@example_agent_c_bot']});
 await waitFor(()=>agents.b.prompts.length===1&&agents.c.prompts.length===1);
 await agents.b.runTurn('B result');await agents.c.runTurn('C result');
 await waitFor(()=>agents.a.journal.records.filter(r=>r.type==='task_result').length===2);
 assert.equal(agents.a.prompts.length,1,'the sending turn was not interrupted');assert.equal(agents.a.journal.records.some(r=>r.type==='task_presented'),false);
 await agents.a.finishTurn('');await waitFor(()=>agents.a.prompts.length===2);
 const shown=agents.a.journal.records.findLast(r=>r.type==='task_presented');assert.equal(shown?.type==='task_presented'&&shown.messageIds.length,2);
 assert.match(agents.a.prompts[1]!,/B result/);assert.match(agents.a.prompts[1]!,/C result/);await agents.a.runTurn('Both results reviewed.');
 assert.equal(agents.a.privateSends.at(-1)?.text,'Both results reviewed.');
 const messages=await shared.timeline({chatId:GROUP,limit:20});const replies=messages.filter(m=>m.work?.kind==='reply'&&m.work.requestId===request.details.requestId);
 assert.deepEqual(replies.map(m=>m.work?.kind==='reply'&&m.work.recipientBotId).sort(),[202,203]);
 assert.equal(agents.a.prompts.length,2);
});

test('one recipient cannot complete another obligation and remaining dependencies keep the parent waiting',async(t)=>{
 const {agents}=await threeAgents(t);await agents.a.batch([ownerPrivate('a',901,'Get both results')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const req=await workSend(agents.a,'both-slow',{kind:'request',text:'Report',recipients:['@example_agent_b_bot','@example_agent_c_bot']});await agents.a.finishTurn('');
 await waitFor(()=>agents.b.prompts.length===1&&agents.c.prompts.length===1);await agents.b.runTurn('B done');await waitFor(()=>agents.a.prompts.length===2);await agents.a.runTurn('B is done; C is still pending.');
 const status=await(await fetch(`http://127.0.0.1:${agents.a.port()}/status`)).json() as any;
 assert.ok(status.tasks.some((task:any)=>task.state==='waiting'&&task.pending.some((p:any)=>p.requestId===req.details.requestId&&p.recipientBotId===203)));
 await assert.rejects(workSend(agents.a,'wrong-recipient',{kind:'reply',requestId:req.details.requestId,text:'Cannot answer for C'}),/no recipient obligation/);
 await agents.c.runTurn('C done');await waitFor(()=>agents.a.prompts.length===3);await agents.a.runTurn('All done');assert.equal(agents.a.privateSends.at(-1)?.text,'All done');
});

test('answering older A while handling B does not suppress B empty-output or model-failure disposition',async(t)=>{
 for(const failure of [false,true]){
 const {agents,shared}=await twoAgents(t);await verified(agents);
 const older=await workSend(agents.a,`older-${failure}`,{kind:'request',recipients:['@example_agent_b_bot'],text:'Older request A'});await waitFor(()=>agents.b.prompts.length===1);await agents.b.startTurn();
 await workSend(agents.b,`child-${failure}`,{kind:'request',recipients:['@example_agent_a_bot'],text:'Independent dependency'});await agents.b.finishTurn('');await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const newer=await workSend(agents.a,`newer-${failure}`,{kind:'request',recipients:['@example_agent_b_bot'],text:'New request B'});await waitFor(()=>agents.b.prompts.length===2);await agents.b.startTurn();
 await workSend(agents.b,`finish-older-${failure}`,{kind:'reply',requestId:older.details.requestId,text:'A completed'});
 if(failure)await failTurn(agents.b);else await agents.b.finishTurn('');await publications(agents.b);
 const replies=(await shared.timeline({chatId:GROUP,limit:30})).filter(m=>m.work?.kind==='reply');
 assert.equal(replies.filter(m=>m.work?.kind==='reply'&&m.work.requestId===older.details.requestId&&m.work.disposition==='completed').length,1);
 assert.equal(replies.filter(m=>m.work?.kind==='reply'&&m.work.requestId===newer.details.requestId&&m.work.disposition==='failed').length,1);
 }
});

test('private waiting consultation abandoned by new never resumes its old task when the child replies',async(t)=>{
 const {agents}=await twoAgents(t);await verified(agents);await agents.a.batch([ownerPrivate('a',902,'Consult the other agent')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 await workSend(agents.a,'reset-private',{kind:'request',recipients:['@example_agent_b_bot'],text:'Return later'});await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===1);
 await agents.a.batch([ownerPrivate('a',903,'/new')]);await waitFor(()=>agents.a.journal.records.some(r=>r.type==='command_started'));
 await agents.a.emit('session_shutdown',{reason:'new'});await agents.a.emit('session_start',{reason:'new'});
 assert.ok(agents.a.journal.records.some(r=>r.type==='task_abandoned'));
 await agents.b.runTurn('Late result after reset');await publications(agents.b);await waitFor(()=>agents.a.journal.records.some(r=>r.type==='group_context_recorded'));
 assert.equal(agents.a.prompts.filter(prompt=>!prompt.startsWith('/telegram-status __new-session__:')).length,1);assert.ok(agents.a.privateSends.some(s=>s.replyTo===902&&s.text.includes('owner reset')));
});

test('A to B to C to A independent dependency work progresses with serialized waiting tasks',async(t)=>{
 const {agents,shared}=await threeAgents(t);await agents.a.batch([ownerPrivate('a',904,'Coordinate the dependency chain')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const ab=await workSend(agents.a,'chain-ab',{kind:'request',recipients:['@example_agent_b_bot'],text:'Ask C for its result'});await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===1);await agents.b.startTurn();
 const bc=await workSend(agents.b,'chain-bc',{kind:'request',recipients:['@example_agent_c_bot'],text:'Get an independent fact from A'});await agents.b.finishTurn('');await waitFor(()=>agents.c.prompts.length===1);await agents.c.startTurn();
 const ca=await workSend(agents.c,'chain-ca',{kind:'request',recipients:['@example_agent_a_bot'],text:'Return the independent fact'});await agents.c.finishTurn('');await waitFor(()=>agents.a.prompts.length===2);await agents.a.runTurn('Independent fact');
 await waitFor(()=>agents.c.prompts.length===2);await agents.c.runTurn('C result');await waitFor(()=>agents.b.prompts.length===2);await agents.b.runTurn('B result');await waitFor(()=>agents.a.prompts.length===3);await agents.a.runTurn('Owner result');
 assert.equal(agents.a.privateSends.at(-1)?.replyTo,904);
 const requests=(await shared.timeline({chatId:GROUP,limit:30})).filter(m=>m.work?.kind==='request');
 assert.ok(requests.every(m=>m.work?.kind==='request'&&m.work.chainId===ab.details.requestId));
 assert.equal(requests.find(m=>m.work?.kind==='request'&&m.work.requestId===ca.details.requestId)?.work?.kind==='request'&&(requests.find(m=>m.work?.kind==='request'&&m.work.requestId===ca.details.requestId)!.work as any).parentRequestId,bc.details.requestId);
});

test('a logical circular result dependency is returned as blocked, not silently waited on',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);const req=await workSend(agents.a,'blocked-cycle',{kind:'request',recipients:['@example_agent_b_bot'],text:'Need the unfinished ancestor result'});await waitFor(()=>agents.b.prompts.length===1);await agents.b.startTurn();
 await workSend(agents.b,'blocked-answer',{kind:'reply',requestId:req.details.requestId,disposition:'blocked',text:'This requires the unfinished ancestor result; coordinate that dependency.'});await agents.b.finishTurn('');await waitFor(()=>agents.a.prompts.length===1);
 const replies=(await shared.timeline({chatId:GROUP,limit:10})).filter(m=>m.work?.kind==='reply');assert.equal(replies.length,1);assert.equal(replies[0]!.work?.kind==='reply'&&replies[0]!.work.disposition,'blocked');
});

test('unknown lifecycle support pauses group work while private transport remains usable',async(t)=>{
 const {agent}=await oneAgent(t,{coordinate:async(_peer,body:any)=>({status:200,body:{roster:body.roster,match:true}})});
 await waitFor(()=>agent.status().includes('group=unverified'));assert.match(agent.privateReplies.at(-1)!,/protocol/);
 await assert.rejects(workSend(agent,'incompatible',{kind:'request',recipients:['@example_agent_b_bot'],text:'Do not send'}),/not available/);
 await agent.batch([ownerPrivate('a',905,'/status')]);assert.ok(agent.privateReplies.some(text=>text.includes('State:')));
});

test('an accepted tool Reply followed by model failure is diagnosed locally without a second terminal publication',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);const req=await workSend(agents.a,'reply-before-failure',{kind:'request',recipients:['@example_agent_b_bot'],text:'Return a result'});await waitFor(()=>agents.b.prompts.length===1);await agents.b.startTurn();
 await workSend(agents.b,'accepted-terminal',{kind:'reply',requestId:req.details.requestId,text:'Completed already'});await failTurn(agents.b);await publications(agents.b);
 assert.equal((await shared.timeline({chatId:GROUP,limit:10})).filter(m=>m.work?.kind==='reply').length,1);assert.ok(agents.b.journal.records.some(r=>r.type==='turn_failed'&&r.code==='MODEL_ERROR'));
});

test('concurrent duplicate child deliveries record one result and one pending continuation',async(t)=>{
 let agents:Record<AgentKey,Agent>;const setup=await twoAgents(t,async(to,messageId)=>{if(to==='a')return 'retry';const response=await fetch(`http://127.0.0.1:${agents[to].port()}/queue`,{method:'POST',body:JSON.stringify({kind:'group-message',messageId})});return response.status===202?'accepted':'rejected';});agents=setup.agents;await verified(agents);
 await agents.a.batch([ownerPrivate('a',906,'Consult B')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();await workSend(agents.a,'duplicate-child',{kind:'request',recipients:['@example_agent_b_bot'],text:'Return once'});await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===1);await agents.b.runTurn('One result');await publications(agents.b);
 const message=(await setup.shared.timeline({chatId:GROUP,limit:10})).find(m=>m.work?.kind==='reply')!;
 const responses=await Promise.all(Array.from({length:8},()=>fetch(`http://127.0.0.1:${agents.a.port()}/queue`,{method:'POST',body:JSON.stringify({kind:'group-message',messageId:message.messageId})})));assert.ok(responses.every(r=>r.status===202));await waitFor(()=>agents.a.prompts.length===2);
 assert.equal(agents.a.journal.records.filter(r=>r.type==='task_result').length,1);assert.equal(agents.a.journal.records.filter(r=>r.type==='work_item'&&r.taskId).length,1);
});

test('accepted publication recovers across restart without sending Telegram text again',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);const append=agents.a.journal.append.bind(agents.a.journal);let fail=true;
 agents.a.journal.append=async record=>{if(fail&&record.type==='group_post_recorded'){fail=false;throw new Error('Synthetic publication receipt failure');}await append(record);};
 const first=await workSend(agents.a,'recover-accepted',{kind:'request',recipients:['@example_agent_b_bot'],text:'Accepted once'});agents.a.journal.append=append;
 await agents.a.emit('session_shutdown',{reason:'reload'});await agents.a.emit('session_start',{reason:'reload'});await verified(agents);await waitFor(()=>agents.b.prompts.length===1);
 const repeated=await workSend(agents.a,'recover-accepted',{kind:'request',recipients:['@example_agent_b_bot'],text:'Accepted once'});assert.equal(repeated.details.requestId,first.details.requestId);
 assert.equal(agents.a.api.sent.filter(m=>m.text.includes('Accepted once')).length,1);assert.equal((await shared.timeline({chatId:GROUP,limit:10})).filter(m=>m.work?.kind==='request').length,1);
 await assert.rejects(workSend(agents.a,'recover-accepted',{kind:'notify',text:'Conflicting retry'}),/conflicts/);
});

test('an uncertain group send never resends or fabricates accepted work metadata',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);const append=agents.a.journal.append.bind(agents.a.journal);
 agents.a.journal.append=async record=>{if(record.type==='group_send_accepted')throw new Error('Synthetic acceptance persistence failure');await append(record);};
 const input={kind:'request',recipients:['@example_agent_b_bot'],text:'Uncertain request'};await assert.rejects(workSend(agents.a,'uncertain',input));agents.a.journal.append=append;
 await assert.rejects(workSend(agents.a,'uncertain',input),/uncertain/);assert.equal(agents.a.api.sent.filter(m=>m.text.includes('Uncertain request')).length,1);assert.equal((await shared.timeline({chatId:GROUP,limit:10})).length,0);assert.equal(agents.b.prompts.length,0);
});

test('legacy origin pointers remain history and never synthesize waiting private tasks',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);
 await shared.recordMessage({chatId:GROUP,messageId:60000,date:1790000000,senderKind:'agent',senderId:201,sender:'Agent A',senderAccount:AGENTS.a.username,entities:[],text:'@example_agent_b_bot historical request',posting:{kind:'request',originItemId:'00000000-0000-4000-8000-000000000001'}},AGENTS.a.username);
 await shared.recordMessage({chatId:GROUP,messageId:60001,date:1790000001,senderKind:'agent',senderId:202,sender:'Agent B',senderAccount:AGENTS.b.username,entities:[],text:'Historical answer',replyToMessageId:60000,posting:{kind:'answer'}},AGENTS.b.username);
 const response=await fetch(`http://127.0.0.1:${agents.a.port()}/queue`,{method:'POST',body:JSON.stringify({kind:'group-message',messageId:60001})});assert.equal(response.status,202,await response.text());await waitFor(()=>agents.a.prompts.length===1);
 assert.match(agents.a.prompts[0]!,/Information only/);assert.doesNotMatch(agents.a.prompts[0]!,/Channel: private/);assert.equal(agents.a.journal.records.some(r=>r.type==='task_state'&&r.state==='waiting'),false);
});

test('report, review, correction and acceptance finish a private task without acknowledgment work',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);await agents.a.batch([ownerPrivate('a',907,'Review and accept the corrected report')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const report=await workSend(agents.a,'review-report',{kind:'request',recipients:['@example_agent_b_bot'],text:'Submit the report'});await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===1);await agents.b.runTurn('Initial report');await waitFor(()=>agents.a.prompts.length===2);await agents.a.startTurn();
 const correction=await workSend(agents.a,'review-correction',{kind:'request',recipients:['@example_agent_b_bot'],text:'Correct the stated total'});assert.equal(correction.details.chainId,report.details.chainId);assert.notEqual(correction.details.requestId,report.details.requestId);await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===2);await agents.b.runTurn('Corrected report');await waitFor(()=>agents.a.prompts.length===3);await agents.a.startTurn();
 await workSend(agents.a,'review-accepted',{kind:'notify',text:'Correction accepted. @example_agent_b_bot'});await agents.a.finishTurn('Reviewed and accepted.');assert.equal(agents.a.privateSends.at(-1)?.replyTo,907);
 assert.deepEqual((await shared.timeline({chatId:GROUP,limit:20})).map(m=>m.work?.kind),['request','reply','request','reply','notify']);assert.equal(agents.b.prompts.length,2);
});

test('explicit terminal completion with an outstanding child keeps its late result informational',async(t)=>{
 const {agents,shared}=await twoAgents(t);await verified(agents);await agents.a.batch([ownerPrivate('a',908,'Ask B to report')]);await waitFor(()=>agents.a.prompts.length===1);await agents.a.startTurn();
 const main=await workSend(agents.a,'outstanding-main',{kind:'request',recipients:['@example_agent_b_bot'],text:'Report independently'});await agents.a.finishTurn('');await waitFor(()=>agents.b.prompts.length===1);await agents.b.startTurn();
 await workSend(agents.b,'outstanding-child',{kind:'request',recipients:['@example_agent_a_bot'],text:'Check a supplementary fact'});await waitFor(()=>agents.a.prompts.length===2);
 await workSend(agents.b,'complete-before-child',{kind:'reply',requestId:main.details.requestId,text:'Main report is complete without that fact'});await agents.b.finishTurn('');await waitFor(()=>agents.a.journal.records.some(r=>r.type==='task_result'));
 await agents.a.runTurn('Supplementary fact');await waitFor(()=>agents.b.prompts.length===2);assert.match(agents.b.prompts[1]!,/Information only/);assert.doesNotMatch(agents.b.prompts[1]!,/Continue the recorded waiting task/);await agents.b.runTurn('');
 await waitFor(()=>agents.a.prompts.length===3);await agents.a.runTurn('Main report reviewed');assert.equal(agents.a.privateSends.at(-1)?.replyTo,908);
 const replies=(await shared.timeline({chatId:GROUP,limit:20})).filter(m=>m.work?.kind==='reply'&&m.work.requestId===main.details.requestId);assert.equal(replies.length,1);assert.equal(agents.b.prompts.length,2);
});