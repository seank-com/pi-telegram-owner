import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initialThinkingText,
	parseTelegramOwnerCommand,
	TELEGRAM_OWNER_COMMANDS,
	telegramOwnerHelpText,
} from "../src/commands.ts";
import {
	MemoryJournal,
	recover,
	TelegramOwnerBridge,
	type TelegramUpdate,
} from "../src/core.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";
import { TelegramActivityMessage } from "../src/runtime.ts";

const owner = 71;
const privateChat = 81;

function update(updateId: number, text: string, userId = owner, chatId = privateChat): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: updateId + 1_000,
			chat: { id: chatId, type: "private" },
			from: { id: userId },
			text,
		},
	};
}

function createHarness(
	journal = new MemoryJournal(),
	identity: { agentLabel?: string; resolveAgentLabel?: () => Promise<string> } = {},
	projectRoot = "/tmp/telegram-owner-command-test",
) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const replies: Array<{ text: string; replyTo?: number }> = [];
	const sentMessages: Array<{ content: any; options: any }> = [];
	const activityEvents: string[] = [];
	let activitySends = 0;
	let failActivity = false;
	let failEdits = 0;
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let activePollers = 0;
	let maxActivePollers = 0;
	let stops = 0;
	let idle = true;
	let aborts = 0;
	let compactOptions: any;
	const statuses: string[] = [];

	const api = {
		on(name: string, handler: (event: any, ctx: any) => any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
		registerTool() {},
		getThinkingLevel() { return ctx.thinkingLevel; },
		sendUserMessage(content: any, options: any) {
			sentMessages.push({ content, options });
		},
	};

	const dependencies = {
		journal,
		ownerUserId: owner,
		privateChatId: privateChat,
		...identity,
		source: {
			async start(callback: typeof onBatch) {
				onBatch = callback;
				activePollers += 1;
				maxActivePollers = Math.max(maxActivePollers, activePollers);
				let stopped = false;
				return async () => {
					if (stopped) return;
					stopped = true;
					activePollers -= 1;
					stops += 1;
				};
			},
		},
		async sendReply(text: string, replyTo?: number) {
			replies.push({ text, replyTo });
			return String(replies.length);
		},
		async sendActivity(text: string) {
			if (failActivity) throw new Error("activity transport down");
			activitySends += 1;
			activityEvents.push(`send:${text}`);
			return `activity-${activitySends}`;
		},
		async editActivity(_id: string, text: string) {
			if (failEdits > 0) {
				failEdits -= 1;
				throw new Error("activity edit down");
			}
			activityEvents.push(`edit:${text}`);
		},
		async deleteActivity(id: string) {
			activityEvents.push(`delete:${id}`);
		},
		async resolveImages(images: Array<{ mimeType: string }>, attachments: Array<{ sha256: string; mimeType: string }>) {
			if (attachments.length > 0) return attachments.map((attachment) => ({ data: "aW1hZ2U=", mimeType: attachment.mimeType, attachment }));
			return images.map((image) => ({
				data: "aW1hZ2U=",
				mimeType: image.mimeType,
				attachment: {
					sha256: "a".repeat(64),
					size: 5,
					mimeType: image.mimeType,
					path: `messages/_attachments/${"a".repeat(64)}.png`,
					source: "live",
					direction: "in",
				},
			}));
		},
	};

	const ctx: any = {
		ui: {
			setStatus(_key: string, value: string | undefined) {
				if (value) statuses.push(value);
			},
			notify() {},
		},
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "medium",
		sessionManager: {
			getSessionId: () => "session-test",
			getBranch: () => [],
		},
		isIdle: () => idle,
		getContextUsage: () => ({ tokens: 25_100, contextWindow: 100_000, percent: 25.1 }),
		abort: () => {
			aborts += 1;
		},
		compact: (options: any) => {
			compactOptions = options;
		},
	};

	createTelegramOwnerExtension({ dependencies: dependencies as any, projectRoot })(api as any);

	return {
		journal,
		commands,
		replies,
		sentMessages,
		activityEvents,
		ctx,
		statuses,
		get aborts() { return aborts; },
		get compactOptions() { return compactOptions; },
		get activePollers() { return activePollers; },
		get maxActivePollers() { return maxActivePollers; },
		get stops() { return stops; },
		setIdle(value: boolean) { idle = value; },
		failNextActivity() { failActivity = true; },
		failNextEdits(count: number) { failEdits = count; },
		async emit(name: string, event: any, context = ctx) {
			let result: any;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
			return result;
		},
		async poll(updates: TelegramUpdate[]) {
			assert.ok(onBatch, "source callback is installed");
			return onBatch(updates);
		},
	};
}

async function saveHarness(t: { after(fn: () => Promise<unknown>): void }, body = '{"sessionDir":"native-sessions"}') {
	const root = await mkdtemp(join(tmpdir(), "telegram-save-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".pi"));
	const path = join(root, ".pi/settings.json"); await writeFile(path, body);
	const h = createHarness(new MemoryJournal(), {}, root);
	await h.emit("session_start", { reason: "startup" });
	t.after(() => h.emit("session_shutdown", { reason: "test" }));
	return { h, path, body, root };
}

test("save snapshots this project's current preferences without inference, even while the agent is busy", async t => {
	const { h, path, root } = await saveHarness(t); h.setIdle(false); h.ctx.thinkingLevel = "off";
	const other = join(root, "other"); await mkdir(join(other, ".pi"), { recursive: true });
	const otherSettings = join(other, ".pi/settings.json"); await writeFile(otherSettings, '{"unchanged":true}'); h.ctx.cwd = other;
	await h.poll([update(1, "/save")]);
	const settings = JSON.parse(await readFile(path, "utf8"));
	assert.equal(settings.defaultProvider, "test-provider"); assert.equal(settings.defaultModel, "test-model"); assert.equal(settings.defaultThinkingLevel, "off"); assert.equal(settings.sessionDir, "native-sessions");
	assert.equal(settings.modelThinkingLevels["test-provider/test-model"], "off");
	assert.equal(await readFile(otherSettings, "utf8"), '{"unchanged":true}');
	assert.match(h.replies[0].text, /Saved project defaults/); assert.ok(h.replies[0].text.includes(path));
	assert.equal(h.sentMessages.length, 0); assert.equal(h.journal.records.some(r => r.type === "dispatch_requested"), false);
	await h.poll([update(1, "/save")]); assert.equal(h.replies.length, 1);
});

test("save rejects other senders, other chats and command arguments without changing settings", async t => {
	const { h, path, body } = await saveHarness(t);
	await h.poll([update(1, "/save", owner + 1), update(2, "/save", owner, privateChat + 1), update(3, "/save extra")]);
	assert.equal(await readFile(path, "utf8"), body); assert.equal(h.sentMessages.length, 0);
	assert.equal(h.replies.length, 1); assert.match(h.replies[0].text, /Unsupported command/);
});

test("save reports invalid project JSON without overwriting it or starting a model turn", async t => {
	const { h, path, body } = await saveHarness(t, "{invalid");
	await h.poll([update(1, "/save")]);
	assert.equal(await readFile(path, "utf8"), body); assert.match(h.replies[0].text, /^Save failed:/); assert.equal(h.sentMessages.length, 0);
});

test("save with no current model leaves project settings untouched", async t => {
	const { h, path, body } = await saveHarness(t); h.ctx.model = undefined;
	await h.poll([update(1, "/save")]);
	assert.equal(await readFile(path, "utf8"), body); assert.match(h.replies[0].text, /nothing was saved/); assert.equal(h.sentMessages.length, 0);
});

test("ordinary command parsing stays separate from advertised local selectors", () => {
	assert.deepEqual(TELEGRAM_OWNER_COMMANDS.map(({ name }) => name), ["help", "status", "stop", "compact", "new", "save"]);
	assert.deepEqual(parseTelegramOwnerCommand("/save"), { kind: "known", name: "save" });
	assert.deepEqual(parseTelegramOwnerCommand("/save extra"), { kind: "unknown", token: "/save" });
	assert.deepEqual(parseTelegramOwnerCommand(" /status "), { kind: "known", name: "status" });
	assert.deepEqual(parseTelegramOwnerCommand("/status extra"), { kind: "unknown", token: "/status" });
	assert.deepEqual(parseTelegramOwnerCommand("/session"), { kind: "unknown", token: "/session" });
	assert.deepEqual(parseTelegramOwnerCommand("/model"), { kind: "unknown", token: "/model" });
	assert.deepEqual(parseTelegramOwnerCommand("/thinking"), { kind: "unknown", token: "/thinking" });
	assert.equal(parseTelegramOwnerCommand("ordinary text"), undefined);
	assert.equal(telegramOwnerHelpText(), [
		"Available commands:",
		"/help - Show available commands.",
		"/status - Show runtime and context status.",
		"/stop - Stop the current run.",
		"/compact - Compact the current session context.",
		"/new - Start a fresh session.",
		"/save - Save this project's model and thinking defaults.",
		"/model - Choose the active model.",
		"/thinking - Choose the thinking level.",
	].join("\n"));
	assert.equal(initialThinkingText(24.6), "Thinking (25%)");
	assert.equal(initialThinkingText(null), "Thinking (context recalculating)");
});

test("authorized slash commands are durable local jobs and unauthorized commands remain rejected", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, owner, privateChat, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const state = await bridge.ingestBatch([
		update(1, "/help"),
		update(2, "/future"),
		update(3, "/stop", owner + 1),
		update(4, "ordinary"),
	]);
	assert.deepEqual(state.pendingCommands.map((job) => job.command), ["help", "unknown"]);
	assert.deepEqual(state.queued.map((job) => job.text), ["ordinary"]);
	assert.equal(journal.records.find((record) => record.type === "update" && record.updateId === 3)?.disposition, "unauthorized");

	const command = state.pendingCommands[0];
	await bridge.startCommand(command);
	assert.deepEqual(recover(journal.records).uncertainCommands.map((job) => job.jobId), [command.jobId]);
	await bridge.completeCommand(command, "done");
	assert.deepEqual(recover(journal.records).repliesToRetry.map((job) => job.reply), ["done"]);
});

test("slash captions on authorized images are handled locally and never dispatched to the model", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([
		{
			update_id: 7,
			message: {
				message_id: 1_007,
				chat: { id: privateChat, type: "private" },
				from: { id: owner },
				caption: "/help",
				photo: [{ file_id: "known-photo", file_size: 100 }],
			},
		},
		{
			update_id: 8,
			message: {
				message_id: 1_008,
				chat: { id: privateChat, type: "private" },
				from: { id: owner },
				caption: "/future",
				document: { file_id: "unknown-document", mime_type: "image/png", file_size: 100 },
			},
		},
	]);

	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.replies.map((reply) => reply.text), [
		telegramOwnerHelpText(),
		"Unsupported command. Use /help to list available commands.",
	]);
});

test("help, status, and unknown commands bypass model dispatch and reply in update order", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(10, "/help"), update(11, "/status"), update(12, "/future")]);

	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.replies.length, 3);
	assert.equal(harness.replies[0].text, telegramOwnerHelpText());
	assert.match(harness.replies[1].text, /State: idle\nContext: 25% of 100k\nModel: test-provider\/test-model, medium/);
	assert.equal(harness.replies[2].text, "Unsupported command. Use /help to list available commands.");
	assert.deepEqual(harness.replies.map((reply) => reply.replyTo), [1010, 1011, 1012]);

	harness.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 100_000, percent: null });
	await harness.poll([update(13, "/status")]);
	assert.match(harness.replies[3].text, /Context: recalculating/);
});

test("stop bypasses busy waiting, aborts the run, and durably settles the active Telegram job", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(20, "long request")]);
	assert.equal(harness.sentMessages.length, 1);
	harness.setIdle(false);
	await harness.poll([update(21, "/stop")]);

	assert.equal(harness.aborts, 1);
	assert.equal(harness.sentMessages.length, 1);
	assert.deepEqual(harness.replies.map((reply) => reply.text), ["Stopped by /stop.", "Stop requested."]);
	const state = recover(harness.journal.records);
	assert.equal(state.uncertain.length, 0);
	assert.equal(state.pendingCommands.length, 0);

	harness.setIdle(true);
	await harness.poll([update(22, "/stop")]);
	assert.equal(harness.aborts, 1);
	assert.equal(harness.replies.at(-1)?.text, "The agent is idle; nothing to stop.");
});

test("compact is idle-only, coalesces overlap, and completes through its callback without a model turn", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(30, "/compact"), update(31, "/compact"), update(32, "queued while compacting")]);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.replies.length, 1);
	assert.equal(harness.replies[0].text, "The agent is busy; /compact was not started.");
	assert.ok(harness.compactOptions);

	harness.compactOptions.onComplete({});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.replies.map((reply) => reply.text), [
		"The agent is busy; /compact was not started.",
		"Compaction complete.\nContext: 25% of 100k",
	]);
	assert.equal(harness.sentMessages.length, 1);
});

test("accepted /compact and /new emit working activity before the held host call, and a refusal does not", async () => {
	const order: string[] = [];
	const compacting = createHarness();
	const recordCompact = compacting.ctx.compact;
	compacting.ctx.compact = (options: any) => {
		order.push(...compacting.activityEvents, "compact");
		recordCompact(options);
	};
	await compacting.emit("session_start", { reason: "startup" });
	await compacting.poll([update(70, "/compact")]);
	assert.deepEqual(order, [
		"send:Received /compact. Working on it. This is not proof compaction has started.",
		"compact",
	]);
	assert.ok(compacting.compactOptions);
	compacting.setIdle(false);
	const beforeRefusal = compacting.activityEvents.length;
	await compacting.poll([update(71, "/compact")]);
	assert.equal(compacting.activityEvents.length, beforeRefusal);
	assert.equal(compacting.replies.at(-1)?.text, "The agent is busy; /compact was not started.");

	const replacing = createHarness();
	let releaseNew: ((value: { cancelled: boolean }) => void) | undefined;
	const started = new Promise<{ cancelled: boolean }>((resolve) => { releaseNew = resolve; });
	await replacing.emit("session_start", { reason: "startup" });
	await replacing.poll([update(72, "/new")]);
	assert.equal(replacing.activityEvents[0], "send:Received /new. Working on it. This is not proof a new session has started.");
	const jobId = String(replacing.sentMessages[0].content).split(":")[1];
	const pending = replacing.commands.get("telegram-status")?.(`__new-session__:${jobId}`, {
		...replacing.ctx,
		newSession: () => {
			assert.ok(replacing.activityEvents.some((event) => event.startsWith("send:Received /new")));
			return started;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(replacing.replies.length, 0, "receipt is not the durable new-session result");
	releaseNew?.({ cancelled: false });
	await pending;
});

test("session_before_compact shows Compacting before agent start and edits an existing command receipt once", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(80, "/compact")]);
	assert.equal(harness.activityEvents.length, 1);
	await harness.emit("session_before_compact", { reason: "manual", willRetry: false });
	assert.deepEqual(harness.activityEvents, [
		"send:Received /compact. Working on it. This is not proof compaction has started.",
		"edit:Compacting",
	]);
	await harness.emit("session_before_compact", { reason: "manual", willRetry: false });
	assert.equal(harness.activityEvents.length, 2, "a repeated start does not send a second indicator");

	const automatic = createHarness();
	await automatic.emit("session_start", { reason: "startup" });
	await automatic.emit("session_before_compact", { reason: "threshold", willRetry: false });
	assert.deepEqual(automatic.activityEvents, ["send:Compacting"]);
	await automatic.emit("session_compact", { reason: "threshold", willRetry: false });
	assert.equal(automatic.activityEvents.at(-1), "delete:activity-1");
});

test("a failed compaction retitle is retried while the receipt is still the visible text", async () => {
	const harness = createHarness();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(85, "/compact")]);
	harness.failNextEdits(1);
	await harness.emit("session_before_compact", { reason: "manual", willRetry: false });
	assert.equal(harness.activityEvents.filter((event) => event.startsWith("edit:")).length, 0);
	await harness.emit("session_before_compact", { reason: "manual", willRetry: false });
	assert.deepEqual(harness.activityEvents.filter((event) => event.startsWith("edit:")), ["edit:Compacting"]);
});

test("a failed activity send does not suppress compaction or its durable result", async () => {
	const harness = createHarness();
	harness.failNextActivity();
	await harness.emit("session_start", { reason: "startup" });
	await harness.poll([update(90, "/compact")]);
	assert.equal(harness.activityEvents.length, 0);
	assert.ok(harness.compactOptions);
	harness.compactOptions.onError(new Error("provider unavailable"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(harness.replies.at(-1)?.text ?? "", /Compaction failed/);
});

test("compact rejects an active run and reports provider failure without replay", async () => {
	const busy = createHarness();
	busy.setIdle(false);
	await busy.emit("session_start", { reason: "startup" });
	await busy.poll([update(35, "/compact")]);
	assert.equal(busy.compactOptions, undefined);
	assert.equal(busy.replies[0].text, "The agent is busy; /compact was not started.");

	const failed = createHarness();
	await failed.emit("session_start", { reason: "startup" });
	await failed.poll([update(36, "/compact")]);
	failed.compactOptions.onError(new Error("provider unavailable token=secret"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(failed.replies.length, 1);
	assert.equal(failed.replies[0].text.includes("provider unavailable"), true);
	assert.equal(failed.replies[0].text.includes("secret"), false);
});

test("configured and Telegram-derived labels are cached once and used only as grammatical subjects", async () => {
	let skippedLookups = 0;
	const configured = createHarness(new MemoryJournal(), {
		agentLabel: "Configured Agent",
		resolveAgentLabel: async () => (skippedLookups += 1, "wrong"),
	});
	await configured.emit("session_start", { reason: "startup" });
	await configured.poll([update(37, "/stop")]);
	assert.equal(configured.replies[0].text, "Configured Agent is idle; nothing to stop.");
	assert.equal(skippedLookups, 0);

	let fallbackLookups = 0;
	const fallback = createHarness(new MemoryJournal(), {
		resolveAgentLabel: async () => (fallbackLookups += 1, "Example Agent"),
	});
	await fallback.emit("session_start", { reason: "startup" });
	await fallback.poll([update(38, "/stop"), update(39, "/stop")]);
	assert.deepEqual(fallback.replies.map(({ text }) => text), [
		"Example Agent is idle; nothing to stop.",
		"Example Agent is idle; nothing to stop.",
	]);
	assert.equal(fallbackLookups, 1);
});

test("identity lookup failure is sanitized, uses a generic label, and does not stop polling", async () => {
	const harness = createHarness(new MemoryJournal(), {
		resolveAgentLabel: async () => { throw new Error("getMe failed token=identity-secret"); },
	});
	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.activePollers, 1);
	await harness.poll([update(39, "/stop")]);
	assert.equal(harness.replies[0].text, "The agent is idle; nothing to stop.");
	assert.equal(harness.statuses.some((status) => status.includes("identity-secret")), false);
	assert.equal(harness.statuses.some((status) => status.includes("identityError=getMe failed token=[redacted]")), true);
});

test("new replaces the session and visibly cancels queued private work without replaying it", async () => {
	const journal = new MemoryJournal();
	const first = createHarness(journal);
	await first.emit("session_start", { reason: "startup" });
	await first.poll([update(40, "/new"), update(41, "preserve this update")]);
	assert.equal(first.replies.length, 0);
	assert.equal(first.sentMessages.length, 1);
	const internal = String(first.sentMessages[0].content);
	const jobId = internal.split(":")[1];
	assert.match(internal, /^\/telegram-status __new-session__:/);

	let replacements = 0;
	await first.commands.get("telegram-status")?.(`__new-session__:${jobId}`, {
		...first.ctx,
		newSession: async () => {
			replacements += 1;
			return { cancelled: false };
		},
	});
	assert.equal(replacements, 1);
	await first.emit("session_shutdown", { reason: "new" });
	assert.equal(first.activePollers, 0);

	const second = createHarness(journal);
	await second.emit("session_start", { reason: "new" });
	assert.equal(second.activePollers, 1);
	assert.equal(second.maxActivePollers, 1);
	assert.equal(second.replies.length, 2);
	assert.match(second.replies[0].text, /^Started a new session\.\nSession: session-test/);
	assert.match(second.replies[1].text, /owner reset/);
	assert.equal(second.sentMessages.length, 0, "queued private work is cancelled, not replayed after reset");
	await second.poll([update(40, "/new"), update(41, "preserve this update")]);
	assert.equal(second.replies.length, 2, "duplicate updates do not duplicate reset or cancellation replies");
	assert.equal(second.sentMessages.length, 0, "duplicate updates do not revive cancelled work");
});

test("an uncertain state-changing command is not replayed after an ordinary restart", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, owner, privateChat, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const state = await bridge.ingestBatch([update(50, "/compact")]);
	await bridge.startCommand(state.pendingCommands[0]);

	const harness = createHarness(journal);
	await harness.emit("session_start", { reason: "startup" });
	assert.equal(harness.compactOptions, undefined);
	assert.equal(harness.replies.length, 1);
	assert.match(harness.replies[0].text, /outcome is uncertain/);
});

test("activity initial context is immutable while later activity edits remain intent-only", async () => {
	const events: string[] = [];
	const activity = new TelegramActivityMessage("job", {
		async send(text) {
			events.push(`send:${text}`);
			return "activity-id";
		},
		async edit(_id, text) {
			events.push(`edit:${text}`);
		},
		async delete() {},
		async onStarted() {},
		async onCleared() {},
	}, "Thinking (37%)");
	activity.start();
	activity.update("Reading config.ts");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events[0], "send:Thinking (37%)");
	assert.ok(events.every((event) => !event.includes("37%") || event.startsWith("send:")));
	await activity.stopAndDelete();
});
