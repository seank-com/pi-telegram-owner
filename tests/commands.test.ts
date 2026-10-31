import assert from "node:assert/strict";
import test from "node:test";

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
) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const replies: Array<{ text: string; replyTo?: number }> = [];
	const sentMessages: Array<{ content: any; options: any }> = [];
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

	createTelegramOwnerExtension({ dependencies: dependencies as any, projectRoot: "/tmp/telegram-owner-command-test" })(api as any);

	return {
		journal,
		commands,
		replies,
		sentMessages,
		ctx,
		statuses,
		get aborts() { return aborts; },
		get compactOptions() { return compactOptions; },
		get activePollers() { return activePollers; },
		get maxActivePollers() { return maxActivePollers; },
		get stops() { return stops; },
		setIdle(value: boolean) { idle = value; },
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

test("the owner command registry is exact and parsing rejects arguments locally", () => {
	assert.deepEqual(TELEGRAM_OWNER_COMMANDS.map(({ name }) => name), ["help", "status", "stop", "compact", "new"]);
	assert.deepEqual(parseTelegramOwnerCommand(" /status "), { kind: "known", name: "status" });
	assert.deepEqual(parseTelegramOwnerCommand("/status extra"), { kind: "unknown", token: "/status" });
	assert.deepEqual(parseTelegramOwnerCommand("/session"), { kind: "unknown", token: "/session" });
	assert.equal(parseTelegramOwnerCommand("ordinary text"), undefined);
	assert.equal(telegramOwnerHelpText(), [
		"Available commands:",
		"/help - Show available commands.",
		"/status - Show runtime and context status.",
		"/stop - Stop the current run.",
		"/compact - Compact the current session context.",
		"/new - Start a fresh session.",
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
	await harness.poll([update(10, "/help"), update(11, "/status"), update(12, "/model")]);

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
