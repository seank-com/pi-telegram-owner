import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTelegramToolActivity } from "../src/activity.ts";
import { telegramOwnerMenuCommands } from "../src/commands.ts";
import {
	JsonlJournal,
	MemoryJournal,
	TelegramOwnerBridge,
	type JournalRecord,
	type TelegramUpdate,
} from "../src/core.ts";
import {
	ConfigurationError,
	ImageSafetyError,
	loadTelegramOwnerConfig,
	LongPollSource,
	PollerLock,
	PollerLockError,
	projectTelegramOwnerConfigPath,
	readSafeOutboundImage,
	reconnectDelay,
	sanitizeError,
	TelegramActivityMessage,
	TelegramApiClient,
	TelegramParseError,
	TelegramReplyAnchorError,
	TelegramTypingActivity,
	type BootIdentity,
	type Sleep,
} from "../src/runtime.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";
import { TelegramMarkdownProjector } from "../src/markdown-projector.ts";
import { TOOL_INTENT_ENTRY_TYPE } from "../src/observability.ts";

const OWNER = 7;
const CHAT = 70;
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

function accepted(jobId: string, updateId: number): JournalRecord {
	return {
		type: "update",
		updateId,
		disposition: "accepted",
		timestamp: "2026-09-15T00:00:00Z",
		jobId,
		messageId: updateId * 10,
		chatId: CHAT,
		userId: OWNER,
		text: jobId,
	};
}

async function waitFor(predicate: () => boolean, timeout = 1_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

const TEST_BOOT: BootIdentity = { id: "test-boot-current", startedAtMs: 1 };
const testBoot = () => TEST_BOOT;

async function initializeGuard(lockPath: string, pid = 9_000): Promise<void> {
	const lock = await PollerLock.acquire(lockPath, pid, () => "alive", testBoot);
	await lock.release();
}

async function writeGuardOwner(
	lockPath: string,
	pid: number,
	nonce: string,
	bootId = TEST_BOOT.id,
): Promise<string> {
	const path = join(`${lockPath}.guard`, `owner-${nonce}`);
	await writeFile(path, `${JSON.stringify({ version: 1, pid, nonce, bootId })}\n`, { mode: 0o600 });
	return path;
}

test("Telegram owner menu reconciliation registers five private-chat commands and clears the group fallback", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const api = new TelegramApiClient("menu-secret", CHAT, async (url, init) => {
		calls.push({ url, init: init as RequestInit });
		return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as Response;
	});
	assert.equal(calls.length, 0, "client construction alone must not contact Telegram");

	await api.setOwnerCommandMenu();
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url.endsWith("/setMyCommands"), true);
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(String(calls[0].init.body)), { commands: telegramOwnerMenuCommands(), scope: { type: "all_private_chats" } });
	assert.equal(calls[1].url.endsWith("/deleteMyCommands"), true);
	assert.deepEqual(JSON.parse(String(calls[1].init.body)), {});
	assert.deepEqual(telegramOwnerMenuCommands(), [
		{ command: "help", description: "Show available commands." },
		{ command: "status", description: "Show runtime and context status." },
		{ command: "stop", description: "Stop the current run." },
		{ command: "compact", description: "Compact the current session context." },
		{ command: "new", description: "Start a fresh session." },
	]);
});

test("Telegram identity lookup returns a validated first name and sanitizes failures", async () => {
	let calls = 0;
	const api = new TelegramApiClient("identity-secret", CHAT, async (url) => {
		calls += 1;
		assert.equal(url.endsWith("/getMe"), true);
		return { ok: true, status: 200, json: async () => ({ ok: true, result: { first_name: " Example Agent " } }) } as Response;
	});
	assert.equal(await api.getBotFirstName(), "Example Agent");
	assert.equal(calls, 1);

	const leaking = new TelegramApiClient("123:identity-secret", CHAT, async () => {
		throw new Error("https://api.telegram.org/bot123:identity-secret/getMe token=identity-secret");
	});
	await assert.rejects(leaking.getBotFirstName(), (error: Error) => {
		assert.equal(error.message.includes("identity-secret"), false);
		assert.equal(error.message.includes("[redacted]"), true);
		return true;
	});

	const malformed = new TelegramApiClient("safe-token", CHAT, async () => ({
		ok: true,
		status: 200,
		json: async () => ({ ok: true, result: { first_name: "line one\nline two" } }),
	}) as Response);
	await assert.rejects(malformed.getBotFirstName(), /single-line plain text/);
});

test("configured extension startup reconciles its menu once before polling", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-menu-startup-"));
	const configDir = join(root, ".pi", "telegram-owner");
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(configDir, 0o700);
	await writeFile(
		join(configDir, "config.json"),
		JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "MENU_TEST_TOKEN", agentLabel: " Configured Agent " }),
		{ mode: 0o600 },
	);
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const request = { url: String(url), init };
		calls.push(request);
		if (request.url.endsWith("/setMyCommands") || request.url.endsWith("/deleteMyCommands")) {
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as Response);
		}
		return new Promise((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) reject(signal.reason);
			else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}) as typeof fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await rm(root, { recursive: true, force: true });
	});

	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ projectRoot: root, environment: { MENU_TEST_TOKEN: "offline-menu-token" } })(pi);
	const ctx = {
		cwd: root,
		isIdle: () => true,
		sessionManager: { getSessionId: () => "menu-startup", getBranch: () => [] },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	await emit("session_start", { type: "session_start", reason: "startup" });
	await waitFor(() => calls.some(({ url }) => url.endsWith("/getUpdates")));
	const menuCalls = calls.filter(({ url }) => url.endsWith("/setMyCommands"));
	assert.equal(menuCalls.length, 1, "one startup must perform exactly one idempotent reconciliation");
	assert.deepEqual(JSON.parse(String(menuCalls[0]?.init?.body)), { commands: telegramOwnerMenuCommands(), scope: { type: "all_private_chats" } });
	assert.equal(calls.filter(({ url }) => url.endsWith("/deleteMyCommands")).length, 1);
	assert.equal(calls[0]?.url.endsWith("/setMyCommands"), true);
	assert.equal(calls.some(({ url }) => url.endsWith("/getMe")), false, "configured override must skip identity lookup");
	await emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
});

test("menu reconciliation failure is sanitized and visible without preventing polling", async () => {
	let reconciliations = 0;
	let sourceStarts = 0;
	let statusMessage = "";
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {}, sendUserMessage() {},
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal: new MemoryJournal(), ownerUserId: OWNER, privateChatId: CHAT,
		async reconcileCommandMenu() {
			reconciliations += 1;
			throw new Error("setMyCommands failed token=menu-secret");
		},
		source: { async start() { sourceStarts += 1; return async () => {}; } },
		async sendReply() { return "reply"; },
	} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "menu-failure", getBranch: () => [] },
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
	assert.equal(reconciliations, 1);
	assert.equal(sourceStarts, 1);
	assert.equal(statusMessage.includes("menuError=setMyCommands failed token=[redacted]"), true);
	assert.equal(statusMessage.includes("menu-secret"), false);
});

test("Telegram API uses long-poll, typing, and sanitized sendMessage payloads", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
	let messageId = 40;
	const api = new TelegramApiClient("mock-secret", CHAT, async (url, init) => {
		requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal });
		if (url.endsWith("/getUpdates")) {
			return { ok: true, status: 200, async json() { return { ok: true, result: [] }; } };
		}
		messageId += 1;
		return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: messageId } }; } };
	});
	await api.getUpdates(90);
	assert.deepEqual(requests[0]?.body, { offset: 91, timeout: 25, allowed_updates: ["message"] });
	assert.ok(requests[0]?.signal);
	await api.sendChatAction();
	assert.equal(requests[1]?.url.endsWith("/sendChatAction"), true);
	assert.deepEqual(requests[1]?.body, { chat_id: CHAT, action: "typing" });
	assert.ok(requests[1]?.signal);
	await api.sendMessage("Thinking…");
	assert.deepEqual(requests[2]?.body, { chat_id: CHAT, text: "Thinking…" });

	const journal = new MemoryJournal([accepted("reply", 1), { type: "reply_ready", jobId: "reply", text: "x".repeat(4_100) }]);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true });
	await bridge.initialize();
	await bridge.retryReadyReplies((text, replyTo, format) => api.sendMessage(text, replyTo, undefined, format));
	const sends = requests.filter((request) => request.url.endsWith("/sendMessage") && request.body.text !== "Thinking…");
	assert.equal(sends.length, 2);
	assert.deepEqual(sends[0]?.body, { chat_id: CHAT, text: "x".repeat(4_000), reply_to_message_id: 10, parse_mode: "HTML" });
	assert.deepEqual(sends[1]?.body, { chat_id: CHAT, text: "x".repeat(100), parse_mode: "HTML" });
	assert.ok(sends.every((request) => !request.url.includes("mock-secret") || request.url.includes("botmock-secret")));
});

test("Telegram API narrowly classifies HTML parse and missing reply-anchor rejections", async () => {
	let body: Record<string, unknown> | undefined;
	const acceptedApi = new TelegramApiClient("123:mock-secret", CHAT, async (_url, init) => {
		body = JSON.parse(init.body) as Record<string, unknown>;
		return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 91 } }; } };
	});
	assert.equal(await acceptedApi.sendMessage("<b>safe</b>", 10, undefined, "HTML"), "91");
	assert.deepEqual(body, { chat_id: CHAT, text: "<b>safe</b>", reply_to_message_id: 10, parse_mode: "HTML" });

	const rejectedApi = new TelegramApiClient("123:mock-secret", CHAT, async () => ({
		ok: false,
		status: 400,
		async json() { return { ok: false, description: "Bad Request: can't parse entities" }; },
	}));
	await assert.rejects(() => rejectedApi.sendMessage("<b>bad", undefined, undefined, "HTML"), TelegramParseError);
	await assert.rejects(() => rejectedApi.sendMessage("plain"), (error: Error) => {
		assert.equal(error instanceof TelegramParseError, false);
		assert.equal(error instanceof TelegramReplyAnchorError, false);
		return true;
	});

	const staleAnchorApi = new TelegramApiClient("123:mock-secret", CHAT, async () => ({
		ok: false,
		status: 400,
		async json() { return { ok: false, description: "Bad Request: message to be replied not found" }; },
	}));
	await assert.rejects(() => staleAnchorApi.sendMessage("recover", 10), TelegramReplyAnchorError);
	await assert.rejects(() => staleAnchorApi.sendMessage("recover"), (error: Error) => {
		assert.equal(error instanceof TelegramReplyAnchorError, false);
		return true;
	});

	const unrelatedApi = new TelegramApiClient("123:mock-secret", CHAT, async () => ({
		ok: false,
		status: 400,
		async json() { return { ok: false, description: "Bad Request: reply message not found somewhere else" }; },
	}));
	await assert.rejects(() => unrelatedApi.sendMessage("recover", 10), (error: Error) => {
		assert.equal(error instanceof TelegramReplyAnchorError, false);
		return true;
	});
});

test("Telegram API edits and deletes a bot-owned message with bounded, sanitized requests", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal }> = [];
	const api = new TelegramApiClient("123:mock-secret", CHAT, async (url, init) => {
		requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal });
		return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
	}, 50);
	await api.editMessageText("41", "Reading ~/pi/…");
	await api.deleteMessage("41");
	assert.deepEqual(requests.map(({ url, body }) => [url.split("/").at(-1), body]), [
		["editMessageText", { chat_id: CHAT, message_id: 41, text: "Reading ~/pi/…" }],
		["deleteMessage", { chat_id: CHAT, message_id: 41 }],
	]);
	assert.ok(requests.every((request) => request.signal));
	await assert.rejects(() => api.deleteMessage("not-an-id"), /Invalid Telegram message ID/);

	const leaking = new TelegramApiClient("123:mock-secret", CHAT, async () => {
		throw new Error("https://api.telegram.org/bot123:mock-secret/editMessageText leaked");
	});
	await assert.rejects(leaking.editMessageText("41", "safe"), (error: Error) => {
		assert.equal(error.message.includes("mock-secret"), false);
		return true;
	});
});

test("activity message sends once, coalesces parallel updates, rate limits edits, and deletes on stop", async () => {
	let now = 0;
	const sleeps: Array<{ delay: number; signal: AbortSignal; resolve(): void }> = [];
	const calls: string[] = [];
	const journal: string[] = [];
	const activity = new TelegramActivityMessage("job-1", {
		async send(text) { calls.push(`send:${text}`); return "51"; },
		async edit(_id, text) { calls.push(`edit:${text}`); },
		async delete(id) { calls.push(`delete:${id}`); },
		async onStarted(job, id) { journal.push(`start:${job}:${id}`); },
		async onCleared(job, id) { journal.push(`clear:${job}:${id}`); },
		onFailure: (operation) => assert.fail(`unexpected ${operation} failure`),
		now: () => now,
		sleep: (delay, signal) => new Promise((resolve, reject) => {
			sleeps.push({ delay, signal, resolve });
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		}),
		minimumEditIntervalMs: 1_000,
	});
	activity.start();
	await waitFor(() => calls.length === 1 && journal.length === 1);
	activity.update("Reading ~/one");
	activity.update("Reading ~/two");
	activity.update("Writing ~/latest");
	await waitFor(() => sleeps.length === 1);
	assert.equal(sleeps[0]?.delay, 1_000);
	now = 1_000;
	sleeps[0]?.resolve();
	await waitFor(() => calls.length === 2);
	assert.deepEqual(calls, ["send:Thinking…", "edit:Writing ~/latest"]);
	activity.update("Writing ~/latest");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(calls.length, 2);
	await activity.stopAndDelete();
	assert.deepEqual(calls, ["send:Thinking…", "edit:Writing ~/latest", "delete:51"]);
	assert.deepEqual(journal, ["start:job-1:51", "clear:job-1:51"]);
});

test("activity messages preserve full audit-length text in sends, updates and annotations", async () => {
	const initial = `Inspect ${"a".repeat(991)}.`;
	const updated = `Inspect ${"b".repeat(991)}.`;
	const annotated = `Inspect ${"c".repeat(991)}.`;
	assert.equal(initial.length, 1_000);
	const prefix = "RE: A peer request";
	const calls: string[] = [];
	const activity = new TelegramActivityMessage("full-intent", {
		async send(text) { calls.push(text); return "51"; },
		async edit(_id, text) { calls.push(text); },
		async delete() {},
		async onStarted() {},
		async onCleared() {},
		onFailure: (operation) => assert.fail(`unexpected ${operation} failure`),
		minimumEditIntervalMs: 0,
		prefix,
	}, initial);
	activity.start();
	await waitFor(() => calls.length === 1);
	activity.update(updated);
	await waitFor(() => calls.length === 2);
	await activity.halt();
	await activity.annotate(annotated);
	assert.deepEqual(calls, [initial, updated, annotated].map((text) => `${prefix}\n${text}`));
	await activity.stopAndDelete();
});

test("Telegram activity renders full safe versioned observability entries up to the audit limit", () => {
	const long = `Inspect ${"a".repeat(991)}.`;
	const entries = [{
		type: "custom",
		customType: TOOL_INTENT_ENTRY_TYPE,
		data: {
			version: 1,
			toolCallId: "long",
			toolName: "read",
			intent: long,
			timestamp: "2026-09-16T00:00:00Z",
		},
	}];
	const status = formatTelegramToolActivity(entries, "long", "read");
	assert.equal(status.length, 1_000);
	assert.equal(status, long);
	assert.equal(formatTelegramToolActivity([{
		...entries[0],
		data: { ...entries[0].data, intent: `${long}x` },
	}], "long", "read"), "Using read…");
	assert.equal(formatTelegramToolActivity(entries, "missing", "bash"), "Using bash…");
	assert.equal(formatTelegramToolActivity(entries, "missing", "bad name; secret"), "Using tool…");
	assert.equal(formatTelegramToolActivity([{
		...entries[0],
		data: { ...entries[0].data, intent: "Expose https://example.test/private" },
	}], "long", "read"), "Using read…");
	assert.equal(formatTelegramToolActivity([{
		...entries[0],
		data: { ...entries[0].data, version: 2 },
	}], "long", "read"), "Using read…");
	assert.equal(formatTelegramToolActivity([{
		...entries[0],
		data: { ...entries[0].data, intent: "Inspect token=raw-secret" },
	}], "long", "read"), "Using read…");
	assert.equal(formatTelegramToolActivity([{
		...entries[0],
		data: { ...entries[0].data, intent: "Inspect token=[redacted] safely" },
	}], "long", "read"), "Inspect token=[redacted] safely");
});

test("Telegram image download and upload enforce type, size, safe paths, and multipart fields", async (t) => {
	const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
	const requests: Array<{ url: string; body?: unknown }> = [];
	const api = new TelegramApiClient("mock-secret", CHAT, async (url, init) => {
		requests.push({ url, body: init.body });
		if (url.endsWith("/getFile")) {
			return { ok: true, async json() { return { ok: true, result: { file_path: "photos/safe.png", file_size: png.length } }; } };
		}
		if (url.includes("/file/")) {
			return {
				ok: true,
				async json() { return {}; },
				async arrayBuffer() { return Uint8Array.from(png).buffer; },
			};
		}
		return { ok: true, async json() { return { ok: true, result: { message_id: 88 } }; } };
	});
	const image = await api.downloadImage({ fileId: "telegram-file", mimeType: "image/png", fileSize: png.length });
	assert.deepEqual(image, { data: png.toString("base64"), mimeType: "image/png" });
	assert.equal(requests[1]?.url.endsWith("/photos/safe.png"), true);

	await api.sendPhoto({ bytes: png, filename: "result.png", mimeType: "image/png" }, "done", 45);
	const form = requests[2]?.body as FormData;
	assert.equal(form.get("chat_id"), String(CHAT));
	assert.equal(form.get("caption"), "done");
	assert.equal(form.get("reply_to_message_id"), "45");
	assert.equal((form.get("photo") as File).name, "result.png");

	const root = await mkdtemp(join(tmpdir(), "telegram-image-root-"));
	const outside = await mkdtemp(join(tmpdir(), "telegram-image-outside-"));
	t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
	await writeFile(join(root, "good.png"), png);
	await writeFile(join(root, "spoof.png"), "not a png");
	await writeFile(join(outside, "outside.png"), png);
	assert.equal((await readSafeOutboundImage("good.png", root)).mimeType, "image/png");
	await assert.rejects(() => readSafeOutboundImage("spoof.png", root), ImageSafetyError);
	await assert.rejects(() => readSafeOutboundImage(join(outside, "outside.png"), root), ImageSafetyError);
	await assert.rejects(
		() => api.downloadImage({ fileId: "large", mimeType: "image/png", fileSize: 10 * 1024 * 1024 + 1 }),
		ImageSafetyError,
	);
});

test("Telegram rejects unsafe getFile paths and mismatched downloaded bytes", async () => {
	const unsafe = new TelegramApiClient("mock-secret", CHAT, async () => ({
		ok: true,
		async json() { return { ok: true, result: { file_path: "../token", file_size: 20 } }; },
	}));
	await assert.rejects(() => unsafe.downloadImage({ fileId: "x", mimeType: "image/png" }), ImageSafetyError);

	let call = 0;
	const mismatch = new TelegramApiClient("mock-secret", CHAT, async () => {
		call += 1;
		if (call === 1) return { ok: true, async json() { return { ok: true, result: { file_path: "photos/x.png", file_size: 3 } }; } };
		return { ok: true, async json() { return {}; }, async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };
	});
	await assert.rejects(() => mismatch.downloadImage({ fileId: "x", mimeType: "image/png" }), ImageSafetyError);
});

test("Telegram API calls honor caller abort and redact sendChatAction failures", async () => {
	let observedAbort = false;
	const api = new TelegramApiClient("mock-secret", CHAT, async (_url, init) =>
		await new Promise((resolve) => {
			const finish = () => {
				observedAbort = true;
				resolve({ ok: false, status: 499, async json() { return { ok: false }; } });
			};
			if (init.signal?.aborted) finish();
			else init.signal?.addEventListener("abort", finish, { once: true });
		}),
	);
	const controller = new AbortController();
	controller.abort(new Error("mock shutdown"));
	const pending = api.sendChatAction(controller.signal);
	await assert.rejects(pending, (error: Error) => {
		assert.equal(error.message.includes("mock-secret"), false);
		assert.match(error.message, /sendChatAction failed/);
		return true;
	});
	assert.equal(observedAbort, true);

	const leaking = new TelegramApiClient("123:secret", CHAT, async () => {
		throw new Error("fetch https://api.telegram.org/bot123:secret/sendChatAction failed");
	});
	await assert.rejects(leaking.sendChatAction(), (error: Error) => {
		assert.equal(error.message.includes("123:secret"), false);
		assert.equal(error.message.includes("bot[redacted]/"), true);
		return true;
	});
});

test("typing activity refreshes sequentially and aborts its timer/request on stop", async () => {
	const sleeps: Array<{ milliseconds: number; signal: AbortSignal; resolve(): void }> = [];
	const sleep: Sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
		const entry = { milliseconds, signal, resolve };
		sleeps.push(entry);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	const requestSignals: AbortSignal[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const activity = new TelegramTypingActivity(async (signal) => {
		requestSignals.push(signal);
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		inFlight -= 1;
	}, () => assert.fail("typing request should succeed"), sleep);

	activity.start();
	activity.start();
	await waitFor(() => sleeps.length === 1);
	assert.equal(requestSignals.length, 1);
	assert.equal(sleeps[0]?.milliseconds, 4_000);
	sleeps[0]?.resolve();
	await waitFor(() => requestSignals.length === 2 && sleeps.length === 2);
	assert.equal(maxInFlight, 1);
	const stopping = activity.stop();
	assert.equal(requestSignals[1]?.aborted, true);
	assert.equal(sleeps[1]?.signal.aborted, true);
	await stopping;
	assert.equal(requestSignals.length, 2);
});

test("long poll advances offset only after full durable callback success, backs off, and aborts cleanly", async () => {
	const cursors: Array<number | undefined> = [];
	let calls = 0;
	let blockedAborted = false;
	const updates: TelegramUpdate[] = [{ update_id: 10 }, { update_id: 14 }];
	const client = {
		async getUpdates(cursor: number | undefined, signal?: AbortSignal): Promise<TelegramUpdate[]> {
			cursors.push(cursor);
			calls += 1;
			if (calls <= 2) return updates;
			return await new Promise((resolve) => {
				signal?.addEventListener("abort", () => {
					blockedAborted = true;
					resolve([]);
				}, { once: true });
			});
		},
	};
	const statuses: string[] = [];
	const delays: number[] = [];
	let callbackCalls = 0;
	const source = new LongPollSource(
		client,
		(status) => statuses.push(`${status.phase}:${status.retryDelayMs ?? ""}`),
		async (delay) => { delays.push(delay); },
		() => 0,
	);
	const stop = await source.start(async () => {
		callbackCalls += 1;
		if (callbackCalls === 1) throw new Error("mock journal failure");
		return 14;
	}, undefined);
	await waitFor(() => calls >= 3);
	await stop();
	assert.deepEqual(cursors.slice(0, 3), [undefined, undefined, 14]);
	assert.deepEqual(delays, [750]);
	assert.ok(statuses.includes("backoff:750"));
	assert.ok(statuses.some((status) => status.startsWith("connected:")));
	assert.ok(statuses.some((status) => status.startsWith("stopping:")));
	assert.equal(blockedAborted, true);
});

test("successful empty polls run maintenance so pending replies do not require new updates", async () => {
	let calls = 0;
	let maintenance = 0;
	const client = {
		async getUpdates(_cursor?: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
			calls += 1;
			if (calls === 1) return [];
			return await new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve([]), { once: true });
			});
		},
	};
	const source = new LongPollSource(client, () => undefined);
	const stop = await source.start(async (updates) => {
		assert.deepEqual(updates, []);
		maintenance += 1;
		return undefined;
	});
	await waitFor(() => maintenance === 1 && calls >= 2);
	await stop();
	assert.equal(maintenance, 1);
});

test("project config path follows Pi's default and non-default config directory names", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-config-directory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(CONFIG_DIR_NAME, ".pi", "the current Pi default remains backwards compatible");
	assert.equal(
		projectTelegramOwnerConfigPath(root),
		join(root, CONFIG_DIR_NAME, "telegram-owner", "config.json"),
	);

	const customBase = join(root, ".pi-regression", "telegram-owner");
	const customConfigPath = projectTelegramOwnerConfigPath(root, ".pi-regression");
	assert.equal(customConfigPath, join(customBase, "config.json"));
	await mkdir(customBase, { recursive: true, mode: 0o700 });
	await writeFile(
		customConfigPath,
		JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "CUSTOM_CONFIG_TOKEN" }),
		{ mode: 0o600 },
	);
	const loaded = await loadTelegramOwnerConfig(customConfigPath, { CUSTOM_CONFIG_TOKEN: "test-only" });
	assert.equal(loaded.kind, "configured");
	assert.equal(loaded.config?.baseDir, customBase);
	await assert.rejects(() => stat(join(root, CONFIG_DIR_NAME)), { code: "ENOENT" });
});

test("project configuration is absent without writes and validates the protected token source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const base = join(root, CONFIG_DIR_NAME, "telegram-owner");
	const configPath = projectTelegramOwnerConfigPath(root);
	assert.equal(configPath, join(base, "config.json"));
	assert.equal((await loadTelegramOwnerConfig(configPath, {})).kind, "absent");
	await assert.rejects(() => stat(base), { code: "ENOENT" });

	await mkdir(base, { recursive: true, mode: 0o700 });
	await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN" }), {
		mode: 0o644,
	});
	await assert.rejects(() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" }), ConfigurationError);
	await chmod(configPath, 0o600);
	await chmod(base, 0o755);
	await assert.rejects(() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" }), /directory permissions/);
	await chmod(base, 0o700);
	await writeFile(configPath, JSON.stringify({ ownerUserId: 0, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN" }), { mode: 0o600 });
	await assert.rejects(() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" }), /ownerUserId/);

	await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT }), { mode: 0o600 });
	await assert.rejects(() => loadTelegramOwnerConfig(configPath, {}), /conventional environment variable name/);
	for (const tokenEnv of ["", "9TOKEN", "TOKEN-NAME", "TOKEN NAME", "TOKEN.NAME"]) {
		await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv }), { mode: 0o600 });
		await assert.rejects(() => loadTelegramOwnerConfig(configPath, {}), /conventional environment variable name/);
	}
	await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN" }), { mode: 0o600 });
	await assert.rejects(() => loadTelegramOwnerConfig(configPath, {}), /FIXTURE_TELEGRAM_BOT_TOKEN is not set or empty/);
	await assert.rejects(
		() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "contains whitespace" }),
		/FIXTURE_TELEGRAM_BOT_TOKEN must contain one non-empty token/,
	);
	for (const agentLabel of ["", "   ", "line one\nline two", "tab\tname", "x".repeat(65), 42]) {
		await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN", agentLabel }), { mode: 0o600 });
		await assert.rejects(
			() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" }),
			/agentLabel must/,
		);
	}
	const secret = "test-only-environment-secret";
	await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN", agentLabel: " Example Agent " }), { mode: 0o600 });
	const loaded = await loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: secret });
	assert.equal(loaded.kind, "configured");
	assert.equal(loaded.config?.agentLabel, "Example Agent");
	assert.equal(loaded.config?.formattedDelivery, true);
	assert.deepEqual(loaded.config?.markdownProjection, { enabled: true, root, rootId: "pi-sessions" });
	assert.equal(loaded.config?.inboundQuietWindowMs, 4_000);
	assert.equal(loaded.config?.journalPath, join(base, "state.jsonl"));
	assert.equal(JSON.stringify(loaded).includes(secret), false);
	assert.equal(Object.keys(loaded.config ?? {}).includes("token"), false);
	assert.equal(JSON.stringify(loaded.config?.createApiClient()).includes(secret), false);

	for (const extra of [
		{ formattedDelivery: "yes" },
		{ markdownProjection: true },
		{ markdownProjection: { enabled: true, root: "relative" } },
		{ markdownProjection: { enabled: true, sessionRoot: "relative" } },
		{ markdownProjection: { enabled: true, roleSlugs: { user: "User", assistant: "assistant", command: "command" } } },
		{ inboundQuietWindowMs: 99 },
	]) {
		await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN", ...extra }), { mode: 0o600 });
		await assert.rejects(() => loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" }), ConfigurationError);
	}
	await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN", formattedDelivery: true, inboundQuietWindowMs: 750, markdownProjection: { enabled: true, roleSlugs: { user: "owner", assistant: "agent", command: "command" } } }), { mode: 0o600 });
	const enabled = await loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" });
	assert.equal(enabled.config?.formattedDelivery, true);
	assert.equal(enabled.config?.inboundQuietWindowMs, 750);
	assert.deepEqual(enabled.config?.markdownProjection, { enabled: true, root, rootId: "pi-sessions", roleSlugs: { user: "owner", assistant: "agent", command: "command" } });
	for (const markdownProjection of [false, { enabled: false }]) {
		await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN", formattedDelivery: false, markdownProjection }), { mode: 0o600 });
		const optedOut = await loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only" });
		assert.equal(optedOut.config?.formattedDelivery, false);
		assert.equal(optedOut.config?.markdownProjection, undefined);
	}

	const configured = await loadTelegramOwnerConfig(configPath, { FIXTURE_TELEGRAM_BOT_TOKEN: "test-only-token" });
	assert.equal(configured.kind, "configured");
	assert.equal(JSON.stringify(configured).includes("test-only-token"), false);
	assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("independent project roots keep configuration and durable state isolated", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-projects-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const projects = [join(root, "agent-one"), join(root, "agent-two")];
	const names = ["FIXTURE_TELEGRAM_BOT_TOKEN", "SECOND_FIXTURE_TELEGRAM_BOT_TOKEN"];
	const loaded = [];
	for (const [index, project] of projects.entries()) {
		const base = join(project, CONFIG_DIR_NAME, "telegram-owner");
		await mkdir(base, { recursive: true, mode: 0o700 });
		const configPath = projectTelegramOwnerConfigPath(project);
		await writeFile(configPath, JSON.stringify({ ownerUserId: OWNER + index, privateChatId: CHAT + index, tokenEnv: names[index] }), { mode: 0o600 });
		loaded.push(await loadTelegramOwnerConfig(configPath, { [names[index]!]: `isolated-secret-${index}` }));
	}
	assert.notEqual(loaded[0]?.config?.baseDir, loaded[1]?.config?.baseDir);
	assert.deepEqual(
		loaded.map((entry) => entry.config?.baseDir),
		projects.map((project) => join(project, CONFIG_DIR_NAME, "telegram-owner")),
	);
	assert.ok(loaded.every((entry, index) => entry.config?.journalPath.startsWith(projects[index]!)));
	assert.ok(loaded.every((entry) => !entry.config?.baseDir.includes(join(CONFIG_DIR_NAME, "agent", "telegram-owner"))));

	const first = new JsonlJournal(loaded[0]!.config!.journalPath);
	const second = new JsonlJournal(loaded[1]!.config!.journalPath);
	await first.append(accepted("agent-one-only", 101));
	await second.append(accepted("agent-two-only", 202));
	assert.deepEqual((await first.load()).map((record) => record.type === "update" && record.jobId), ["agent-one-only"]);
	assert.deepEqual((await second.load()).map((record) => record.type === "update" && record.jobId), ["agent-two-only"]);
	for (const project of projects) {
		await assert.rejects(() => stat(join(project, CONFIG_DIR_NAME, "agent")), { code: "ENOENT" });
	}
});

test("errors redact token-bearing URLs and reconnect jitter remains bounded", () => {
	const secret = "123:secret";
	const sanitized = sanitizeError(new Error(`fetch failed https://api.telegram.org/bot${secret}/getUpdates ${"x".repeat(800)}`), secret);
	assert.equal(sanitized.includes(secret), false);
	assert.equal(sanitized.includes("bot[redacted]/"), true);
	assert.ok(sanitized.length <= 500);
	assert.equal(reconnectDelay(0, () => 0), 750);
	assert.equal(reconnectDelay(99, () => 1), 30_000);
});

test("poller lock handles live contention, dead-owner recovery, and concurrent stale reclaim", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lockPath = join(root, "poller.lock");
	const first = await PollerLock.acquire(lockPath, 100, () => "alive", testBoot);
	await assert.rejects(() => PollerLock.acquire(lockPath, 101, () => "alive", testBoot), PollerLockError);
	await first.release();
	await assert.rejects(() => readFile(lockPath), { code: "ENOENT" });

	await writeFile(lockPath, `${JSON.stringify({ pid: 200, nonce: "dead" })}\n`, { mode: 0o600 });
	const recovered = await PollerLock.acquire(lockPath, 201, (pid) => pid === 200 ? "dead" : "alive", testBoot);
	assert.equal((JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid, 201);
	await recovered.release();

	await writeFile(lockPath, `${JSON.stringify({ pid: 300, nonce: "dead-again" })}\n`, { mode: 0o600 });
	const attempts = await Promise.allSettled([
		PollerLock.acquire(lockPath, 301, (pid) => pid === 300 ? "dead" : "alive", testBoot),
		PollerLock.acquire(lockPath, 302, (pid) => pid === 300 ? "dead" : "alive", testBoot),
	]);
	const concurrentWinners = attempts.filter((result): result is PromiseFulfilledResult<PollerLock> => result.status === "fulfilled");
	assert.ok(concurrentWinners.length <= 1);
	if (concurrentWinners.length === 1) {
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
		assert.ok(owner.pid === 301 || owner.pid === 302);
		await concurrentWinners[0]?.value.release();
	} else {
		// Simultaneous candidates may conservatively reject one another. Once
		// they clean their claims, a retry must recover the original stale lock.
		const retry = await PollerLock.acquire(lockPath, 303, (pid) => pid === 300 ? "dead" : "alive", testBoot);
		await retry.release();
	}

	const old = await PollerLock.acquire(lockPath, 400, () => "alive", testBoot);
	const releaseAndAcquire = await Promise.allSettled([
		old.release(),
		PollerLock.acquire(lockPath, 401, (pid) => pid === 400 ? "alive" : "alive", testBoot),
	]);
	const next = releaseAndAcquire[1];
	if (next?.status === "fulfilled") {
		assert.equal((JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid, 401);
		await next.value.release();
	} else if (releaseAndAcquire[0]?.status === "fulfilled") {
		await assert.rejects(() => readFile(lockPath), { code: "ENOENT" });
	} else {
		// Guard contention may conservatively reject both operations; it must
		// leave the original lock rather than unlinking an unproven replacement.
		assert.equal((JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid, 400);
		await old.release();
	}
});

test("poller guard recovers an empty legacy directory only when it predates this boot", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-legacy-guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const staleLockPath = join(root, "stale.lock");
	await mkdir(`${staleLockPath}.guard`, { mode: 0o700 });
	const simulatedReboot: BootIdentity = { id: "test-boot-after-reboot", startedAtMs: Date.now() + 10_000 };
	const recovered = await PollerLock.acquire(staleLockPath, 501, () => "alive", () => simulatedReboot);
	assert.deepEqual(await readdir(`${staleLockPath}.guard`), ["protocol-v1"]);
	await recovered.release();

	const currentLockPath = join(root, "current.lock");
	await mkdir(`${currentLockPath}.guard`, { mode: 0o700 });
	const currentBoot: BootIdentity = { id: "test-boot-current-gap", startedAtMs: Date.now() - 10_000 };
	await assert.rejects(
		() => PollerLock.acquire(currentLockPath, 502, () => "dead", () => currentBoot),
		/ownership cannot be proven stale/,
	);
	assert.deepEqual(await readdir(`${currentLockPath}.guard`), []);
});

test("poller guard reclaims a recorded dead owner", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-dead-guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lockPath = join(root, "poller.lock");
	await initializeGuard(lockPath);
	const deadClaim = await writeGuardOwner(lockPath, 510, "00000000-0000-4000-8000-000000000510");
	const recovered = await PollerLock.acquire(lockPath, 511, (pid) => pid === 510 ? "dead" : "alive", testBoot);
	await assert.rejects(() => stat(deadClaim), { code: "ENOENT" });
	await recovered.release();

	const priorBootClaim = await writeGuardOwner(
		lockPath,
		512,
		"00000000-0000-4000-8000-000000000512",
		"test-boot-before-reboot",
	);
	const afterReboot = await PollerLock.acquire(lockPath, 513, () => "alive", testBoot);
	await assert.rejects(() => stat(priorBootClaim), { code: "ENOENT" });
	await afterReboot.release();
	assert.deepEqual(await readdir(`${lockPath}.guard`), ["protocol-v1"]);
});

test("poller guard never steals a recorded live owner", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-live-guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lockPath = join(root, "poller.lock");
	await initializeGuard(lockPath);
	const liveClaim = await writeGuardOwner(lockPath, 520, "00000000-0000-4000-8000-000000000520");
	await assert.rejects(
		() => PollerLock.acquire(lockPath, 521, () => "alive", testBoot),
		/already in progress/,
	);
	assert.equal((JSON.parse(await readFile(liveClaim, "utf8")) as { pid: number }).pid, 520);
	assert.deepEqual((await readdir(`${lockPath}.guard`)).sort(), [
		"owner-00000000-0000-4000-8000-000000000520",
		"protocol-v1",
	]);
});

test("poller guard refuses malformed, unreadable, insecure, and unknown owner metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-unsafe-guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const malformedPath = join(root, "malformed.lock");
	await initializeGuard(malformedPath);
	await writeFile(
		join(`${malformedPath}.guard`, "owner-00000000-0000-4000-8000-000000000530"),
		"not-json\n",
		{ mode: 0o600 },
	);
	await assert.rejects(() => PollerLock.acquire(malformedPath, 531, () => "dead", testBoot), /cannot be proven stale/);

	const unreadablePath = join(root, "unreadable.lock");
	await initializeGuard(unreadablePath);
	const unreadableClaim = await writeGuardOwner(
		unreadablePath,
		532,
		"00000000-0000-4000-8000-000000000532",
	);
	await chmod(unreadableClaim, 0o000);
	await assert.rejects(() => PollerLock.acquire(unreadablePath, 533, () => "dead", testBoot), /cannot be proven stale/);

	const insecurePath = join(root, "insecure.lock");
	await initializeGuard(insecurePath);
	const insecureClaim = await writeGuardOwner(insecurePath, 536, "00000000-0000-4000-8000-000000000536");
	await chmod(insecureClaim, 0o644);
	await assert.rejects(() => PollerLock.acquire(insecurePath, 537, () => "dead", testBoot), /cannot be proven stale/);

	const unknownPath = join(root, "unknown.lock");
	await initializeGuard(unknownPath);
	const unknownClaim = await writeGuardOwner(unknownPath, 534, "00000000-0000-4000-8000-000000000534");
	await assert.rejects(() => PollerLock.acquire(unknownPath, 535, () => "unknown", testBoot), /already in progress/);
	assert.equal((await stat(unknownClaim)).isFile(), true);
});

test("concurrent poller guard recovery cannot admit two lock owners", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-concurrent-guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lockPath = join(root, "poller.lock");
	await initializeGuard(lockPath);
	await writeGuardOwner(lockPath, 540, "00000000-0000-4000-8000-000000000540");
	const attempts = await Promise.allSettled([
		PollerLock.acquire(lockPath, 541, (pid) => pid === 540 ? "dead" : "alive", testBoot),
		PollerLock.acquire(lockPath, 542, (pid) => pid === 540 ? "dead" : "alive", testBoot),
	]);
	const acquired = attempts.filter((result): result is PromiseFulfilledResult<PollerLock> => result.status === "fulfilled");
	assert.ok(acquired.length <= 1);
	if (acquired.length === 1) {
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
		assert.ok(owner.pid === 541 || owner.pid === 542);
		await acquired[0]?.value.release();
	} else {
		const retry = await PollerLock.acquire(lockPath, 543, (pid) => pid === 540 ? "dead" : "alive", testBoot);
		await retry.release();
	}
	assert.deepEqual(await readdir(`${lockPath}.guard`), ["protocol-v1"]);
});

test("poller guard cleans operation claims and temporary artifacts on success and refusal", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-guard-cleanup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lockPath = join(root, "poller.lock");
	const lock = await PollerLock.acquire(lockPath, 550, () => "alive", testBoot);
	assert.deepEqual(await readdir(`${lockPath}.guard`), ["protocol-v1"]);
	await assert.rejects(() => PollerLock.acquire(lockPath, 551, () => "alive", testBoot), PollerLockError);
	assert.deepEqual(await readdir(`${lockPath}.guard`), ["protocol-v1"]);
	assert.equal((await readdir(root)).some((entry) => entry.includes(".tmp-")), false);
	await lock.release();
	assert.deepEqual(await readdir(`${lockPath}.guard`), ["protocol-v1"]);
	assert.equal((await readdir(root)).some((entry) => entry.includes(".tmp-")), false);
});

test("live projection coalesces lexical refresh requests and exposes timeout without blocking startup", async () => {
	const journal = new MemoryJournal([]); let projected = true; let reconcileCalls = 0; let refreshCalls = 0; let sourceStarts = 0; let statusMessage = "";
	type Handler = (event: any, ctx: ExtensionContext) => unknown; const handlers = new Map<string, Handler[]>();
	const pi = { events: { emit() {} }, on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ projectionRefreshDebounceMs: 5, dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT,
		markdownProjector: { async reconcile() { reconcileCalls += 1; return { projected: projected ? 1 : 0, unchanged: 0, deferred: 0 }; } } as any,
		async requestLexicalRefresh() { refreshCalls += 1; throw new Error("TIMEOUT"); },
		source: { async start() { sourceStarts += 1; return async () => {}; } },
		async sendReply() { return "1"; },
	} })(pi);
	const ctx = { isIdle: () => true, signal: new AbortController().signal, sessionManager: { getSessionId: () => "session" }, ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} } } as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(sourceStarts, 1); assert.ok(reconcileCalls >= 2); await waitFor(() => refreshCalls === 1 && statusMessage.includes("indexError=TIMEOUT")); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(refreshCalls, 1);
	projected = false; for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "new" }, ctx); assert.equal(sourceStarts, 2); assert.equal(statusMessage.includes("indexError="), false);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "test" }, ctx);
});

test("projection refresh skips unchanged reconciliation, follows in-flight projection, and cancels on shutdown", async () => {
	const journal = new MemoryJournal([]); let projected = false; let refreshCalls = 0; let aborted = 0; const releases: Array<() => void> = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown; const handlers = new Map<string, Handler[]>();
	const pi = { events: { emit() {} }, on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ projectionRefreshDebounceMs: 5, dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT,
		markdownProjector: { async reconcile() { return { projected: projected ? 1 : 0, unchanged: projected ? 0 : 1, deferred: 0 }; } } as any,
		requestLexicalRefresh(signal) { refreshCalls += 1; return new Promise<void>((resolve, reject) => { const onAbort = () => { aborted += 1; reject(new Error("CANCELLED")); }; signal?.addEventListener("abort", onAbort, { once: true }); releases.push(() => { signal?.removeEventListener("abort", onAbort); resolve(); }); }); },
		source: { async start() { return async () => {}; } }, async sendReply() { return "1"; },
	} })(pi);
	const ctx = { isIdle: () => true, signal: new AbortController().signal, sessionManager: { getSessionId: () => "session" }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(refreshCalls, 0);
	projected = true; for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx); await waitFor(() => refreshCalls === 1); for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx); releases[0]?.(); await waitFor(() => refreshCalls === 2);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "test" }, ctx); assert.equal(aborted, 1); assert.equal(refreshCalls, 2);
});

test("startup stale-anchor recovery durably settles the old reply and dispatches newer work", async () => {
	const journal = new MemoryJournal([
		accepted("stale", 80),
		{ type: "reply_ready", jobId: "stale", text: "old answer" },
		accepted("newer", 81),
	]);
	let sourceStarted = false;
	let injectedPrompt = "";
	const calls: Array<{ text: string; replyTo?: number }> = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage(text: string) { injectedPrompt = text; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: {
			async start() {
				sourceStarted = true;
				return async () => {};
			},
		},
		async sendReply(text, replyTo) {
			calls.push({ text, replyTo });
			if (replyTo !== undefined) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
			return "801";
		},
	} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "replacement" },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);

	assert.equal(sourceStarted, true);
	assert.deepEqual(calls.map((call) => call.replyTo), [800, undefined]);
	assert.equal(journal.records.filter((record) => record.type === "reply_anchor_rejected" && record.jobId === "stale").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent" && record.jobId === "stale").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_ready" && record.jobId === "stale").length, 1);
	assert.equal(injectedPrompt, "[telegram-job:newer]\nnewer");
	const recovered = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await recovered.initialize();
	assert.equal(recovered.pendingReplyCount, 0);
	assert.equal(recovered.queueDepth, 0);
});

test("startup reply failure remains retryable and does not prevent polling startup", async () => {
	const records: JournalRecord[] = [
		accepted("uncertain", 1),
		{ type: "dispatch_requested", jobId: "uncertain", sessionId: "old" },
	];
	const journal = new MemoryJournal(records);
	let sourceStarted = false;
	let statusMessage = "";
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: {
			async start() {
				sourceStarted = true;
				return async () => {};
			},
		},
		async sendReply() { throw new Error("temporary Telegram outage"); },
	} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "new" },
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
	assert.equal(sourceStarted, true);
	assert.equal(statusMessage.includes("temporary Telegram outage"), true);
	const recovered = new TelegramOwnerBridge(journal, OWNER, CHAT);
	const state = await recovered.initialize();
	assert.equal(state.repliesToRetry.length, 1);
	assert.equal(state.queued.length, 0);
});

test("typing failure is locally visible and does not block or duplicate the durable reply", async () => {
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let injectedPrompt = "";
	let statusMessage = "";
	let typingCalls = 0;
	const replies: Array<{ text: string; replyTo?: number }> = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage(text: string) { injectedPrompt = text; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: {
			async start(handler) {
				onBatch = handler;
				return async () => {};
			},
		},
		async sendReply(text, replyTo) {
			replies.push({ text, replyTo });
			return "telegram-reply";
		},
		async sendTyping() {
			typingCalls += 1;
			throw new Error("mock typing unavailable");
		},
	} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "typing-failure" },
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{
		update_id: 9,
		message: { message_id: 90, text: "hello", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	assert.equal(typingCalls, 1);
	await waitFor(() => statusMessage.includes("typingError=mock typing unavailable"));
	await emit("input", { type: "input", source: "extension", text: injectedPrompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt: injectedPrompt });
	await waitFor(() => typingCalls === 2 && statusMessage.includes("typingError=mock typing unavailable"));
	await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
	await emit("agent_settled", { type: "agent_settled" });

	assert.equal(typingCalls, 2);
	assert.deepEqual(replies, [{ text: "done", replyTo: 90 }]);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent").length, 1);
});

test("each durable model input queues one sequential typing refresh while duplicates do not", async () => {
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let typingCalls = 0;
	const releases: Array<() => void> = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage() { assert.fail("quiet batch must not dispatch during receipt test"); },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({
		dependencies: {
			journal,
			ownerUserId: OWNER,
			privateChatId: CHAT,
			inboundQuietWindowMs: 1_500,
			source: {
				async start(handler) {
					onBatch = handler;
					return async () => {};
				},
			},
			async sendReply() { return "unused"; },
			async sendTyping(signal) {
				typingCalls += 1;
				await new Promise<void>((resolve) => {
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						resolve();
					};
					releases.push(finish);
					if (signal.aborted) finish();
					else signal.addEventListener("abort", finish, { once: true });
				});
			},
		},
	})(pi);
	const ctx = {
		isIdle: () => false,
		sessionManager: { getSessionId: () => "receipt-typing" },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{
		update_id: 10,
		message: { message_id: 100, date: 200, text: "x".repeat(4_072), chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	await waitFor(() => typingCalls === 1);
	await onBatch?.([{
		update_id: 11,
		message: { message_id: 110, date: 200, text: "final", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	await onBatch?.([{
		update_id: 11,
		message: { message_id: 110, date: 200, text: "duplicate", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}, {
		update_id: 12,
		message: { message_id: 120, text: "intruder", chat: { id: CHAT, type: "private" }, from: { id: OWNER + 1 } },
	}]);
	await onBatch?.([{
		update_id: 13,
		message: { message_id: 130, date: 201, text: "later while request hangs", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	assert.equal(typingCalls, 1);
	releases[0]?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await onBatch?.([{
		update_id: 14,
		message: { message_id: 140, date: 202, text: "after settlement", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	assert.equal(typingCalls, 2);
	releases[1]?.();
	await waitFor(() => typingCalls === 3);
	releases[2]?.();
	await waitFor(() => typingCalls === 4);
	releases[3]?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(journal.records.filter((record) => record.type === "update").map((record) => [record.updateId, record.disposition]), [[10, "accepted"], [11, "accepted"], [12, "unauthorized"], [13, "accepted"], [14, "accepted"]]);
	await emit("session_shutdown", { type: "session_shutdown", reason: "test" });
});

test("legacy uncaptured images do not block startup but forward-required captures fail closed and retry", async () => {
	const image = { fileId: "telegram-file", mimeType: "image/jpeg" as const, fileSize: 20 };
	const archived = { sha256: "a".repeat(64), size: 20, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"a".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const };
	const startHarness = (journal: MemoryJournal, idle = false) => {
		let sourceStarts = 0; let resolverCalls = 0; let fail = true; let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
		type Handler = (event: any, ctx: ExtensionContext) => unknown; const handlers = new Map<string, Handler[]>();
		const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool() {}, sendUserMessage() { assert.fail("busy startup must not dispatch"); } } as unknown as ExtensionAPI;
		createTelegramOwnerExtension({ dependencies: { journal, ownerUserId: OWNER, privateChatId: CHAT, source: { async start(handler) { sourceStarts += 1; onBatch = handler; return async () => {}; } }, async sendReply() { return "unused"; }, async resolveImages() { resolverCalls += 1; if (fail) throw new Error("capture unavailable"); return [{ image: { data: "archived", mimeType: "image/jpeg" }, attachment: archived }]; } } })(pi);
		const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => "capture-boundary" }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
		const emit = async (name: string, event: object) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
		return { emit, setAvailable() { fail = false; }, get sourceStarts() { return sourceStarts; }, get resolverCalls() { return resolverCalls; }, get onBatch() { return onBatch; } };
	};

	const legacy = new MemoryJournal([{ type: "update", schemaVersion: 2, updateId: 19, disposition: "accepted", timestamp: "2026-09-30T00:00:00.000Z", jobId: "legacy", messageId: 190, text: "legacy", images: [image] }]);
	const legacyHarness = startHarness(legacy, true);
	await legacyHarness.emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(legacyHarness.sourceStarts, 1);
	assert.equal(legacyHarness.resolverCalls, 0);

	const required = new MemoryJournal([{ type: "update", schemaVersion: 3, updateId: 20, disposition: "accepted", timestamp: "2026-10-01T00:00:00.000Z", jobId: "required", messageId: 200, text: "required", images: [image] }]);
	const requiredHarness = startHarness(required);
	await requiredHarness.emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(requiredHarness.sourceStarts, 0, "polling must not start before required bytes are durable");
	assert.equal(requiredHarness.resolverCalls, 1);
	requiredHarness.setAvailable();
	await requiredHarness.emit("session_start", { type: "session_start", reason: "startup" });
	assert.equal(requiredHarness.sourceStarts, 1);
	assert.equal(requiredHarness.resolverCalls, 2);
	assert.equal(required.records.filter((record) => record.type === "media_captured").length, 1);

	const admitted = new MemoryJournal();
	const admittedHarness = startHarness(admitted);
	await admittedHarness.emit("session_start", { type: "session_start", reason: "startup" });
	const update: TelegramUpdate = { update_id: 30, message: { message_id: 300, caption: "new", photo: [{ file_id: "telegram-file", file_size: 20 }], chat: { id: CHAT, type: "private" }, from: { id: OWNER } } };
	await assert.rejects(() => admittedHarness.onBatch!([update]), /capture unavailable/);
	assert.equal(admitted.records.find((record) => record.type === "update")?.schemaVersion, 3);
	assert.equal(admitted.records.some((record) => record.type === "media_captured"), false);
	admittedHarness.setAvailable();
	assert.equal(await admittedHarness.onBatch!([update]), 30);
	assert.equal(admittedHarness.resolverCalls, 2);
	assert.equal(admitted.records.filter((record) => record.type === "update").length, 1);
	assert.equal(admitted.records.filter((record) => record.type === "media_captured").length, 1);
});

test("projection-disabled extension durably receives and sends photos within a confirmed Telegram turn", async (t) => {
	const mediaRoot = await mkdtemp(join(tmpdir(), "telegram-projection-disabled-media-")); t.after(() => rm(mediaRoot, { recursive: true, force: true }));
	const mediaProjector = new TelegramMarkdownProjector({ enabled: true, root: mediaRoot, rootId: "pi-sessions" });
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let tool: any;
	let injected: any;
	let idle = false;
	let imageDownloads = 0;
	let archivedReads = 0;
	const photoCalls: unknown[][] = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool(value: unknown) { tool = value; },
		sendUserMessage(content: unknown) { injected = content; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		mediaProjector,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: {
			async start(handler) {
				onBatch = handler;
				return async () => {};
			},
		},
		async sendReply() { return "reply"; },
		async resolveImages(images, archived) {
			assert.equal(images[0]?.fileId, "photo-file");
			const attachment = { sha256: "a".repeat(64), size: 20, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"a".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const };
			if (archived.length) { archivedReads += 1; assert.deepEqual(archived, [attachment]); }
			else imageDownloads += 1;
			return [{ image: { data: "image-data", mimeType: "image/jpeg" }, attachment }];
		},
		async stageOutboundPhoto(path, root) {
			assert.deepEqual([path, root], ["out.png", resolve(PROJECT_ROOT)]);
			return { image: { bytes: Buffer.from("outbound"), filename: "out.png", mimeType: "image/png" }, attachment: { sha256: "b".repeat(64), size: 8, mimeType: "image/png", path: `messages/_attachments/${"b".repeat(64)}.png`, source: "live", direction: "out" } };
		},
		async sendPhoto(...args) {
			photoCalls.push(args);
			return "301";
		},
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "image-extension" },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await assert.rejects(() => tool.execute("early", { path: "x.png" }, undefined, undefined, ctx), /only available/);
	await onBatch?.([{
		update_id: 30,
		message: {
			message_id: 300,
			caption: "look",
			photo: [{ file_id: "photo-file", file_size: 20 }],
			chat: { id: CHAT, type: "private" },
			from: { id: OWNER },
		},
	}]);
	assert.equal(injected, undefined, "busy Pi must queue the image turn");
	assert.equal(imageDownloads, 1, "poll completion must durably capture image bytes");
	assert.equal(journal.records.filter((record) => record.type === "media_captured" && record.direction === "in").length, 1);
	idle = true;
	await onBatch?.([]);
	assert.equal(imageDownloads, 1, "dispatch must not download already captured bytes");
	assert.equal(archivedReads, 1);
	assert.deepEqual(injected.slice(1), [{ type: "image", data: "image-data", mimeType: "image/jpeg" }]);
	const prompt = injected[0].text;
	await emit("input", { type: "input", source: "extension", text: prompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt });
	const result = await tool.execute("send", { path: "out.png", caption: "finished" }, undefined, undefined, ctx);
	assert.equal(result.content[0].text.includes("301"), true);
	const retried = await tool.execute("send", { path: "out.png", caption: "finished" }, undefined, undefined, ctx);
	assert.equal(retried.content[0].text.includes("already sent"), true);
	assert.deepEqual(photoCalls, [[{ bytes: Buffer.from("outbound"), filename: "out.png", mimeType: "image/png" }, "finished", 300, undefined]]);
	assert.equal(journal.records.filter((record) => record.type === "photo_send_planned").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "photo_sent").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "media_captured").length, 2);
	assert.deepEqual((await mediaProjector.readMediaEvents()).map((event) => event.provenance.kind).sort(), ["live-inbound", "live-outbound"]);
});

test("equivalent outbound photo is not resent under a new tool ID after send timeout", async (t) => {
	const mediaRoot = await mkdtemp(join(tmpdir(), "telegram-timeout-media-")); t.after(() => rm(mediaRoot, { recursive: true, force: true })); const mediaProjector = new TelegramMarkdownProjector({ enabled: true, root: mediaRoot, rootId: "pi-sessions" });
	const journal = new MemoryJournal(); let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined; let tool: any; let injected = ""; let sends = 0;
	type Handler = (event: any, ctx: ExtensionContext) => unknown; const handlers = new Map<string, Handler[]>();
	const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool(value: unknown) { tool = value; }, sendUserMessage(content: string) { injected = content; } } as unknown as ExtensionAPI;
	const attachment = { sha256: "9".repeat(64), size: 8, mimeType: "image/png" as const, path: `messages/_attachments/${"9".repeat(64)}.png`, source: "live" as const, direction: "out" as const };
	createTelegramOwnerExtension({ dependencies: { journal, mediaProjector, ownerUserId: OWNER, privateChatId: CHAT, inboundQuietWindowMs: 0, source: { async start(handler) { onBatch = handler; return async () => {}; } }, async sendReply() { return "unused"; }, async stageOutboundPhoto() { return { image: { bytes: Buffer.from("outbound"), filename: "out.png", mimeType: "image/png" }, attachment }; }, async sendPhoto() { sends += 1; throw new Error("send timeout"); } } })(pi);
	const ctx = { cwd: PROJECT_ROOT, isIdle: () => true, sessionManager: { getSessionId: () => "photo-timeout" }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start", { type: "session_start", reason: "startup" }); await onBatch?.([{ update_id: 49, message: { message_id: 490, text: "send it", chat: { id: CHAT, type: "private" }, from: { id: OWNER } } }]);
	await emit("input", { type: "input", source: "extension", text: injected }); await emit("before_agent_start", { type: "before_agent_start", prompt: injected });
	await assert.rejects(() => tool.execute("timeout-first", { path: "out.png", caption: "same" }, undefined, undefined, ctx), /send timeout/);
	await assert.rejects(() => tool.execute("timeout-second", { path: "out.png", caption: "same" }, undefined, undefined, ctx), /Equivalent outbound photo delivery is uncertain/);
	assert.equal(sends, 1);
	assert.deepEqual(await mediaProjector.readMediaEvents(), [], "an uncertain send is not a canonical outbound occurrence");
});

test("equivalent outbound photo is not resent under a new tool ID after receipt persistence fails", async (t) => {
	class ReceiptFailJournal extends MemoryJournal {
		failed = false;
		override async append(record: JournalRecord): Promise<void> {
			if (record.type === "photo_sent" && !this.failed) { this.failed = true; throw new Error("receipt fsync failed"); }
			await super.append(record);
		}
	}
	const mediaRoot = await mkdtemp(join(tmpdir(), "telegram-receipt-failure-media-")); t.after(() => rm(mediaRoot, { recursive: true, force: true })); const mediaProjector = new TelegramMarkdownProjector({ enabled: true, root: mediaRoot, rootId: "pi-sessions" });
	const journal = new ReceiptFailJournal(); let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined; let tool: any; let injected = ""; let sends = 0;
	type Handler = (event: any, ctx: ExtensionContext) => unknown; const handlers = new Map<string, Handler[]>();
	const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool(value: unknown) { tool = value; }, sendUserMessage(content: string) { injected = content; } } as unknown as ExtensionAPI;
	const attachment = { sha256: "f".repeat(64), size: 8, mimeType: "image/png" as const, path: `messages/_attachments/${"f".repeat(64)}.png`, source: "live" as const, direction: "out" as const };
	createTelegramOwnerExtension({ dependencies: { journal, mediaProjector, ownerUserId: OWNER, privateChatId: CHAT, inboundQuietWindowMs: 0, source: { async start(handler) { onBatch = handler; return async () => {}; } }, async sendReply() { return "unused"; }, async stageOutboundPhoto() { return { image: { bytes: Buffer.from("outbound"), filename: "out.png", mimeType: "image/png" }, attachment }; }, async sendPhoto() { sends += 1; return "301"; } } })(pi);
	const ctx = { cwd: PROJECT_ROOT, isIdle: () => true, sessionManager: { getSessionId: () => "photo-uncertain" }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{ update_id: 50, message: { message_id: 500, text: "send it", chat: { id: CHAT, type: "private" }, from: { id: OWNER } } }]);
	await emit("input", { type: "input", source: "extension", text: injected }); await emit("before_agent_start", { type: "before_agent_start", prompt: injected });
	await assert.rejects(() => tool.execute("first-tool", { path: "out.png", caption: "same" }, undefined, undefined, ctx), /receipt fsync failed/);
	await assert.rejects(() => tool.execute("second-tool", { path: "out.png", caption: "same" }, undefined, undefined, ctx), /Equivalent outbound photo delivery is uncertain/);
	assert.equal(sends, 1);
	assert.equal(journal.records.filter((record) => record.type === "photo_send_planned").length, 1);
	assert.deepEqual(await mediaProjector.readMediaEvents(), [], "a failed receipt append cannot publish a delivered occurrence");
});

test("the durable reply precedes activity cleanup and delete failure is best effort and locally visible", async () => {
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let injectedPrompt = "";
	let statusMessage = "";
	const calls: string[] = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage(text: string) { injectedPrompt = text; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply(text, replyTo) { calls.push(`reply:${replyTo}:${text}`); return "61"; },
		async sendActivity(text) { calls.push(`activity:${text}`); return "60"; },
		async editActivity(_id, text) { calls.push(`edit:${text}`); },
		async deleteActivity(id) { calls.push(`delete:${id}`); throw new Error("mock delete unavailable token=hidden"); },
	} })(pi);
	const ctx = {
		cwd: PROJECT_ROOT,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 41_600, contextWindow: 100_000, percent: 41.6 }),
		sessionManager: {
			getSessionId: () => "activity-order",
			getBranch: () => [{
				type: "custom",
				customType: TOOL_INTENT_ENTRY_TYPE,
				data: {
					version: 1,
					toolCallId: "activity-call",
					toolName: "bash",
					intent: "Inspect the persisted state safely",
					timestamp: "2026-09-16T00:00:00Z",
				},
			}],
		},
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{
		update_id: 40,
		message: { message_id: 400, text: "work", chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}]);
	await emit("input", { type: "input", source: "extension", text: injectedPrompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt: injectedPrompt });
	await waitFor(() => calls.includes("activity:Thinking (42%)"));
	assert.equal(calls[0], "activity:Thinking (42%)");
	assert.equal((journal.records.find((record) => record.type === "activity_started") as any)?.messageId, "60");
	await emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "activity-call",
		toolName: "bash",
		args: { command: "do-not-leak --token hidden" },
	});
	await waitFor(() => calls.includes("edit:Inspect the persisted state safely"), 1_500);
	assert.equal(calls.some((call) => call.includes("do-not-leak") || call.includes("hidden")), false);
	await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
	await emit("agent_settled", { type: "agent_settled" });
	assert.deepEqual(calls.slice(-2), ["reply:400:done", "delete:60"]);
	assert.equal(statusMessage.includes("activityError=delete: mock delete unavailable"), true);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent").length, 1);
	assert.equal(journal.records.some((record) => record.type === "activity_cleared"), false);
});

test("activity send failure cannot suppress or duplicate the final reply", async () => {
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let prompt = "";
	let replies = 0;
	let status = "";
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {}, sendUserMessage(text: string) { prompt = text; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply() { replies += 1; return "reply"; },
		async sendActivity() { throw new Error("mock status send failed"); },
		async editActivity() {}, async deleteActivity() {},
	} })(pi);
	const ctx = {
		isIdle: () => true, cwd: PROJECT_ROOT,
		sessionManager: { getSessionId: () => "activity-send-failure" },
		ui: { setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{ update_id: 41, message: { message_id: 410, text: "work", chat: { id: CHAT, type: "private" }, from: { id: OWNER } } }]);
	await emit("input", { type: "input", source: "extension", text: prompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt });
	await waitFor(() => status.includes("activityError=send: mock status send failed"));
	await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "answer" }] });
	await emit("agent_settled", { type: "agent_settled" });
	assert.equal(replies, 1);
});

test("shutdown deletes a known activity and restart cleans a journaled orphan", async () => {
	const journal = new MemoryJournal();
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let prompt = "";
	const deleted: string[] = [];
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {}, sendUserMessage(text: string) { prompt = text; },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal, ownerUserId: OWNER, privateChatId: CHAT,
		source: { async start(handler) { onBatch = handler; return async () => {}; } },
		async sendReply() { return "reply"; }, async sendActivity() { return "70"; }, async editActivity() {},
		async deleteActivity(id) { deleted.push(id); },
	} })(pi);
	const ctx = {
		isIdle: () => true, cwd: PROJECT_ROOT,
		sessionManager: { getSessionId: () => "shutdown" },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([{ update_id: 42, message: { message_id: 420, text: "work", chat: { id: CHAT, type: "private" }, from: { id: OWNER } } }]);
	await emit("input", { type: "input", source: "extension", text: prompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt });
	await waitFor(() => journal.records.some((record) => record.type === "activity_started"));
	await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
	assert.deepEqual(deleted, ["70"]);
	assert.equal(journal.records.some((record) => record.type === "activity_cleared"), true);
	assert.equal(journal.records.some((record) => record.type === "interrupted"), true);

	const orphanJournal = new MemoryJournal([
		accepted("old", 50),
		{ type: "activity_started", jobId: "old", messageId: "71" },
		{ type: "interrupted", jobId: "old", reason: "crash" },
	]);
	const restartDeletes: string[] = [];
	const restartHandlers = new Map<string, Handler[]>();
	const restartPi = {
		on(name: string, handler: Handler) { restartHandlers.set(name, [...(restartHandlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {}, sendUserMessage() {},
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal: orphanJournal, ownerUserId: OWNER, privateChatId: CHAT,
		source: { async start() { return async () => {}; } }, async sendReply() { return "reply"; },
		async deleteActivity(id) { restartDeletes.push(id); },
	} })(restartPi);
	for (const handler of restartHandlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(restartDeletes, ["71"]);
	assert.equal(orphanJournal.records.some((record) => record.type === "activity_cleared" && record.messageId === "71"), true);
});

test("overlapping empty-poll maintenance and lifecycle work serialize pending reply delivery", async () => {
	const journal = new MemoryJournal([
		accepted("ready", 1),
		{ type: "reply_ready", jobId: "ready", text: "once" },
	]);
	let background: Promise<number | undefined> | undefined;
	let releaseSend: (() => void) | undefined;
	const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
	let sends = 0;
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ dependencies: {
		journal,
		ownerUserId: OWNER,
		privateChatId: CHAT,
		source: {
			async start(onBatch) {
				background = onBatch([]);
				return async () => { await background; };
			},
		},
		async sendReply() {
			sends += 1;
			await sendGate;
			return "sent-once";
		},
	} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "overlap" },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	const startup = Promise.all((handlers.get("session_start") ?? []).map((handler) =>
		handler({ type: "session_start", reason: "startup" }, ctx),
	));
	await waitFor(() => sends === 1);
	releaseSend?.();
	await startup;
	await background;
	assert.equal(sends, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent").length, 1);
});

test("default extension derives an absent project config without writes or Telegram contact", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-disabled-"));
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("absent configuration must not contact Telegram");
	}) as typeof fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await rm(root, { recursive: true, force: true });
	});
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	let statusMessage = "";
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		registerTool() {},
		sendUserMessage() { throw new Error("must remain disabled"); },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ projectRoot: root, environment: {} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "disabled" },
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
	assert.equal(statusMessage.includes(`configuration absent (${join(root, ".pi", "telegram-owner", "config.json")})`), true);
	assert.equal(fetchCalls, 0);
	assert.deepEqual(await readdir(root), []);
});

test("missing selected environment token disables visibly before state, locks, or Telegram requests", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-missing-env-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const base = join(root, ".pi", "telegram-owner");
	await mkdir(base, { recursive: true, mode: 0o700 });
	await writeFile(
		join(base, "config.json"),
		JSON.stringify({ ownerUserId: OWNER, privateChatId: CHAT, tokenEnv: "FIXTURE_TELEGRAM_BOT_TOKEN" }),
		{ mode: 0o600 },
	);
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	let statusMessage = "";
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {}, registerTool() {}, sendUserMessage() { throw new Error("must remain disabled"); },
	} as unknown as ExtensionAPI;
	createTelegramOwnerExtension({ projectRoot: root, environment: {} })(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "missing-env" },
		ui: { setStatus: (_key: string, value?: string) => { statusMessage = value ?? ""; }, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(statusMessage.includes("FIXTURE_TELEGRAM_BOT_TOKEN is not set or empty"), true);
	assert.deepEqual(await readdir(base), ["config.json"]);
});
