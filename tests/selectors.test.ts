import assert from "node:assert/strict";
import test from "node:test";
import { LocalSelectors, type InlineKeyboard, type SelectorRecord } from "../src/selectors.ts";
import { MemoryJournal, recover, type TelegramUpdate } from "../src/core.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";
import { TelegramApiClient } from "../src/runtime.ts";
import { telegramOwnerMenuCommands, telegramOwnerHelpText } from "../src/commands.ts";

const model = (id: string, reasoning = true): any => ({ id, provider: "fixture", name: `Model ${id}`, api: "openai-completions", baseUrl: "https://private.invalid/secret-routing", reasoning,
	input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null } });
const command = (id: number, text = "/model", user = 7, chat = 70): TelegramUpdate => ({ update_id: id, message: { message_id: id + 100, chat: { id: chat, type: "private" }, from: { id: user }, text } });
const callback = (id: number, data: string | undefined, message = 900, user = 7, chat = 70): TelegramUpdate => ({ update_id: id, callback_query: { id: `callback-${id}`, from: { id: user }, data, message: { message_id: message, chat: { id: chat, type: "private" } } } });
function fixture(records: SelectorRecord[] = []) {
	let now = 100_000, idle = true, current = model("a"), level = "medium", models = [current, model("b")], scoped: any[] = [], calls = 0, reads = 0;
	let setter: (m: any) => Promise<boolean> = async m => { current = m; return true; };
	let thinker: (l: string) => void = l => { level = l; };
	let appendHook: ((record: SelectorRecord) => void) | undefined;
	const sends: Array<{ text: string; keyboard: InlineKeyboard }> = [], edits: typeof sends = [], answers: string[] = [];
	const journal = { records, async append(record: SelectorRecord) { appendHook?.(record); records.push(structuredClone(record)); } };
	const pi: any = {
		getThinkingLevel: () => level,
		setModel: async (m: any) => { calls++; return setter(m); },
		setThinkingLevel: (l: string) => { calls++; thinker(l); },
	};
	const ctx: any = {
		get model() { return current; },
		get scopedModels() { return scoped; },
		modelRegistry: { getAvailable() { reads++; return models; } }, sessionManager: { getSessionId: () => "fixture-session" },
	};
	const transport = {
		async send(text: string, keyboard: InlineKeyboard) { sends.push({ text, keyboard }); return String(899 + sends.length); },
		async edit(_message: string, text: string, keyboard: InlineKeyboard) { edits.push({ text, keyboard }); },
		async answer(id: string) { answers.push(id); },
	};
	const selectors = new LocalSelectors({ owner: 7, chat: 70, journal, transport, pi, context: () => ctx, idle: () => idle, now: () => now });
	return { selectors, journal, transport, pi, ctx, sends, edits, answers,
		get calls() { return calls; }, get reads() { return reads; }, get level() { return level; },
		get current() { return current; }, get models() { return models; },
		setModels(m: any[]) { models = m; }, setScope(s: any[]) { scoped = s; }, setIdle(i: boolean) { idle = i; }, advance() { now += 600_000; },
		setter(s: typeof setter) { setter = s; }, thinker(t: typeof thinker) { thinker = t; }, hook(h: typeof appendHook) { appendHook = h; },
		button(index = 0) { return sends.at(-1)!.keyboard.inline_keyboard.flat()[index].callback_data; },
		outcome() { return records.findLast(r => r.phase === "outcome")?.outcome; },
	};
}

test("model picker uses authenticated catalog, marks active model, mutates once, and journals lifecycle", async () => {
	const f = fixture(); await f.selectors.initialize();
	await f.selectors.handle(command(1));
	assert.match(f.sends[0].text, /Model: fixture\/a/);
	assert.equal(f.sends[0].keyboard.inline_keyboard[0][0].text, "✓ fixture/a");
	const cb = callback(2, f.button(1));
	await f.selectors.handle(cb); await f.selectors.handle(cb);
	assert.equal(f.current.id, "b"); assert.equal(f.calls, 1); assert.equal(f.answers.length, 2);
	assert.equal(f.edits[0].text, "Model: fixture/b\nThinking: medium");
	assert.deepEqual(f.journal.records.filter(r => r.operationId.startsWith("callback:")).map(r => r.phase), ["received", "requested", "mutation_started", "outcome", "duplicate"]);
	assert.ok(!JSON.stringify(f.journal.records).includes("private.invalid"));
	assert.ok(!JSON.stringify(f.sends).includes("private.invalid"));
});

test("session scope intersects available catalog and empty scope falls back to catalog", async () => {
	const f = fixture(); f.setScope([{ model: f.models[1] }, { model: model("unauthenticated") }]);
	await f.selectors.handle(command(1));
	assert.equal(f.sends[0].keyboard.inline_keyboard.length, 1);
	assert.equal(f.sends[0].keyboard.inline_keyboard[0][0].text, "fixture/b");
	f.setScope([]); await f.selectors.handle(command(2)); assert.equal(f.sends[1].keyboard.inline_keyboard.length, 2);
	f.setModels([]); await f.selectors.handle(command(3)); assert.deepEqual(f.sends[2].keyboard.inline_keyboard, []);
	assert.match(f.sends[2].text, /No authenticated/);
});

test("provider-qualified identities distinguish matching display names and provider aliases", async () => {
	const f = fixture();
	f.setModels([{ ...model("a"), provider: "provider-one", name: "Shared" }, { ...model("a"), provider: "provider-two", name: "Shared" }, { ...model("b"), provider: "provider-two", name: "Shared" }]);
	await f.selectors.handle(command(1));
	assert.deepEqual(f.sends[0].keyboard.inline_keyboard.flat().map(button => button.text), ["provider-one/a", "provider-two/a", "provider-two/b"]);
	await f.selectors.handle(callback(2, f.button(1)));
	assert.equal(f.current.provider, "provider-two");
	assert.match(f.edits[0].text, /Model: provider-two\/a/);
});

test("thinking uses active-model capability helper, reports host clamping, and handles non-reasoning models", async () => {
	const f = fixture(); await f.selectors.handle(command(1, "/thinking"));
	assert.deepEqual(f.sends[0].keyboard.inline_keyboard.flat().map(b => b.text), ["off", "low", "✓ medium", "high", "xhigh"]);
	f.thinker(() => {}); await f.selectors.handle(callback(2, f.button(3)));
	assert.equal(f.outcome(), "clamped"); assert.match(f.edits[0].text, /Thinking: medium.*requested high/);
	const g = fixture(); g.current.reasoning = false; await g.selectors.handle(command(1, "/thinking"));
	assert.deepEqual(g.sends[0].keyboard.inline_keyboard.flat().map(b => b.text), ["off"]);
	await g.selectors.handle(callback(2, g.button())); assert.equal(g.level, "off");
});

test("unavailable active model has no selectable thinking levels", async () => {
	const f = fixture(); f.setModels([model("b")]); await f.selectors.handle(command(1, "/thinking"));
	assert.deepEqual(f.sends[0].keyboard.inline_keyboard, []); assert.match(f.sends[0].text, /unavailable/);
});

test("pagination and display bounds satisfy Telegram limits without model changes", async () => {
	const f = fixture(); f.setModels(Array.from({ length: 21 }, (_, i) => ({ ...model(String(i).padStart(2, "0")), name: "<" + "😀".repeat(3000) })));
	await f.selectors.handle(command(1));
	const next = f.sends[0].keyboard.inline_keyboard.at(-1)![0].callback_data;
	await f.selectors.handle(callback(2, next));
	assert.match(f.edits[0].text, /Page 2\/4/); assert.equal(f.calls, 0);
	for (const message of [...f.sends, ...f.edits]) {
		assert.ok(message.text.length < 4096); assert.ok(message.keyboard.inline_keyboard.length <= 7);
		for (const b of message.keyboard.inline_keyboard.flat()) {
			assert.ok(Buffer.byteLength(b.callback_data) <= 64); assert.match(b.callback_data, /^sel:[A-Za-z0-9_-]{22}$/); assert.ok(Array.from(b.text).length <= 82);
		}
	}
	await f.selectors.handle(callback(3, next)); assert.equal(f.outcome(), "stale");
});

for (const change of ["catalog", "capability", "api", "routing", "scope", "model", "thinking", "session", "ttl"] as const) {
	test(`rejects stale ${change} callbacks without invoking setters`, async () => {
		const f = fixture(); await f.selectors.handle(command(1)); const data = f.button(1);
		switch (change) {
			case "catalog": f.setModels([f.models[0]]); break;
			case "capability": f.models[1].thinkingLevelMap.high = null; break;
			case "api": f.models[1].api = "openai-responses"; break;
			case "routing": f.models[1].baseUrl = "https://changed.invalid/secret"; break;
			case "scope": f.setScope([{ model: f.models[0] }]); break;
			case "model": f.current.id = "changed"; break;
			case "thinking": f.pi.getThinkingLevel = () => "low"; break;
			case "session": f.selectors.invalidate(); break;
			case "ttl": f.advance(); break;
		}
		await f.selectors.handle(callback(2, data)); assert.equal(f.outcome(), "stale"); assert.equal(f.calls, 0); assert.equal(f.answers.length, 1);
	});
}

for (const fault of ["sender", "chat", "group", "inline", "message", "data", "oversize", "missing"] as const) {
	test(`rejects ${fault} callback safely and answers it`, async () => {
		const f = fixture(); await f.selectors.handle(command(1)); const before = f.reads;
		const cb = callback(2, f.button()); const c = cb.callback_query!;
		switch (fault) {
			case "sender": c.from.id++; break;
			case "chat": c.message!.chat.id++; break;
			case "group": c.message!.chat.type = "supergroup"; break;
			case "inline": delete c.message; break;
			case "message": c.message!.message_id++; break;
			case "data": c.data = "/model arbitrary"; break;
			case "oversize": c.data = "sel:" + "a".repeat(10000); break;
			case "missing": delete c.data; break;
		}
		await f.selectors.handle(cb); assert.equal(f.calls, 0); assert.equal(f.answers.length, 1); assert.equal(f.reads, before);
		assert.ok(["stale", "rejected"].includes(f.outcome()!));
	});
}

test("busy selection is rejected and cannot be applied later by redelivery", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const cb = callback(2, f.button(1)); f.setIdle(false);
	await f.selectors.handle(cb); assert.equal(f.outcome(), "busy"); f.setIdle(true); await f.selectors.handle(cb); assert.equal(f.calls, 0);
});

test("lifecycle/catalog changes during journal I/O are rechecked before setter invocation", async () => {
	for (const change of ["busy", "stale"]) {
		const f = fixture(); await f.selectors.handle(command(1));
		f.hook(record => { if (record.phase === "mutation_started") { if (change === "busy") f.setIdle(false); else f.selectors.invalidate(); } });
		await f.selectors.handle(callback(2, f.button(1))); assert.equal(f.calls, 0); assert.equal(f.outcome(), change);
	}
});

test("model authentication refusal, throw and unconfirmed mutation are reported without raw diagnostics", async () => {
	for (const behavior of ["auth", "throw", "unconfirmed"]) {
		const f = fixture(); await f.selectors.handle(command(1));
		f.setter(async () => { if (behavior === "throw") throw new Error("https://secret.invalid/api?key=private"); return behavior !== "auth"; });
		await f.selectors.handle(callback(2, f.button(1)));
		assert.equal(f.outcome(), behavior === "auth" ? "rejected" : "failed"); assert.equal(f.calls, 1);
		assert.ok(!JSON.stringify(f.journal.records).includes("secret.invalid"));
	}
});

test("restart marks incomplete requests uncertain, never repeats mutation, expires existing buttons", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const cb = callback(2, f.button(1));
	f.hook(record => { if (record.phase === "outcome" && record.outcome === "applied") throw new Error("disk unavailable"); if (record.phase === "outcome" && record.outcome === "failed") throw new Error("disk unavailable"); });
	await assert.rejects(f.selectors.handle(cb), /disk unavailable/); assert.equal(f.calls, 1);
	const restarted = fixture(f.journal.records); await restarted.selectors.initialize(); assert.equal(restarted.outcome(), "interrupted");
	await restarted.selectors.handle(cb); assert.equal(restarted.calls, 0);
	await restarted.selectors.handle(callback(3, cb.callback_query!.data)); assert.equal(restarted.outcome(), "stale");
});

test("edit and answer failures are durable and do not retry a successful mutation", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const cb = callback(2, f.button(1));
	f.transport.edit = async () => { throw new Error("fixture edit failure"); };
	f.transport.answer = async () => { throw new Error("fixture answer failure"); };
	await f.selectors.handle(cb); await f.selectors.handle(cb); assert.equal(f.calls, 1);
	assert.ok(f.journal.records.some(r => r.phase === "delivery_failed")); assert.ok(f.journal.records.some(r => r.phase === "answer_failed"));
	assert.equal(f.outcome(), "applied");
});

test("missing public host capability fails closed with local explanation", async () => {
	const f = fixture(); delete f.ctx.modelRegistry.getAvailable; await f.selectors.handle(command(1));
	assert.equal(f.outcome(), "failed"); assert.equal(f.calls, 0); assert.match(f.sends[0].text, /Selector unavailable/);
});

test("picker cache evicts oldest selectors and remains bounded", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const old = f.button();
	for (let i = 2; i <= 34; i++) await f.selectors.handle(command(i));
	await f.selectors.handle(callback(100, old)); assert.equal(f.outcome(), "stale"); assert.equal(f.calls, 0);
});

test("commands stay argument-free, private-owner only, and absent from the default menu/help", async () => {
	const f = fixture();
	for (const update of [command(1, "/model", 8), command(2, "/thinking", 7, 71), command(3, "/model extra"), command(4, "/model@fixture")]) {
		assert.equal(await f.selectors.handle(update), false);
	}
	assert.equal(f.reads, 0); assert.equal(f.journal.records.length, 0);
	assert.deepEqual(telegramOwnerMenuCommands().map(c => c.command), ["help", "status", "stop", "compact", "new"]);
	assert.ok(!telegramOwnerHelpText().includes("/model"));
});

function extensionFixture(options: { inboundQuietWindowMs?: number; sendReply?: () => Promise<string> } = {}) {
	const f = fixture(), journal = new MemoryJournal(), handlers = new Map<string, any[]>(), turns: unknown[] = [];
	let batch: (updates: TelegramUpdate[]) => Promise<number | undefined>;
	let compactOptions: any;
	const ctx: any = {};
	Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(f.ctx));
	Object.assign(ctx, { ui: { setStatus() {}, notify() {} }, isIdle: () => true, hasPendingMessages: () => false, compact: (options: any) => { compactOptions = options; } });
	const pi: any = { ...f.pi, on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool() {}, registerCommand() {}, sendUserMessage(text: unknown) { turns.push(text); } };
	createTelegramOwnerExtension({ datastore: { mode: "off" }, dependencies: { journal, ownerUserId: 7, privateChatId: 70, source: { async start(cb) { batch = cb; return async () => {}; } }, selectorTransport: f.transport, inboundQuietWindowMs: options.inboundQuietWindowMs, sendReply: options.sendReply ?? (async () => "42") } })(pi);
	const emit = async (name: string, event: any = {}) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; };
	return { f, journal, turns, ctx, emit, get compactOptions() { return compactOptions; }, poll: (updates: TelegramUpdate[]) => batch(updates) };
}

test("extension routes selector commands and callbacks locally, preserving cursor and queue without jobs", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	await h.poll([command(1), command(2, "/thinking"), command(3, "/model", 8)]);
	await h.poll([callback(4, h.f.button(), 901)]);
	assert.equal(h.turns.length, 0); assert.equal(recover(h.journal.records).cursor, 4);
	assert.equal(recover(h.journal.records).queued.length, 0); assert.equal(recover(h.journal.records).pendingCommands.length, 0);
	assert.ok(!h.journal.records.some(r => "jobId" in r));
	await h.emit("session_shutdown", { reason: "exit" });
});

for (const phase of ["session_before_compact", "session_before_switch", "session_before_fork", "session_before_tree"] as const) {
	test(`extension blocks mutations during ${phase}`, async () => {
		const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
		await h.poll([command(1)]); const token = h.f.button(1); await h.emit(phase);
		await h.poll([callback(2, token)]); assert.equal(h.f.calls, 0);
		await h.emit("session_shutdown", { reason: "exit" });
	});
}

test("callback answer happens promptly before a blocked serialized model mutation completes", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" }); await h.poll([command(1)]);
	let release!: () => void, started!: () => void;
	const began = new Promise<void>(resolve => { started = resolve; });
	h.f.setter(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return false; });
	const first = h.poll([callback(2, h.f.button(1))]); await began;
	const second = h.poll([callback(3, "bad")]);
	assert.deepEqual(h.f.answers, ["callback-2", "callback-3"]);
	release(); await Promise.all([first, second]); assert.equal(h.f.calls, 1);
	await h.emit("session_shutdown", { reason: "exit" });
});

for (const splitBatches of [false, true]) {
	test(`pending callback answer does not block /stop (${splitBatches ? "later poll" : "same poll"})`, async t => {
		const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
		let release!: () => void;
		const hold = new Promise<void>(resolve => { release = resolve; });
		t.signal.addEventListener("abort", release, { once: true });
		h.f.transport.answer = async () => { await hold; };
		let aborts = 0; h.ctx.isIdle = () => false; h.ctx.abort = () => { aborts++; };
		try {
			const cb = callback(1, "unknown");
			if (splitBatches) { await h.poll([cb]); await h.poll([command(2, "/stop")]); }
			else await h.poll([cb, command(2, "/stop")]);
			assert.equal(aborts, 1, "abort must run while the callback answer is still pending");
			assert.equal(recover(h.journal.records).cursor, 2);
		} finally { release(); await h.emit("session_shutdown", { reason: "exit" }); }
	});
}

test("shutdown cancels and drains a callback answer before releasing its journal", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	let aborted = false;
	h.f.transport.answer = async (_id: string, _text?: string, signal?: AbortSignal) => {
		assert.ok(signal);
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => { aborted = true; reject(new Error("synthetic cancellation")); }, { once: true });
		});
	};
	await h.poll([callback(1, "unknown")]);
	await h.emit("session_shutdown", { reason: "exit" });
	assert.equal(aborted, true);
	assert.ok(h.journal.records.some(r => r.type === "selector" && r.phase === "answer_failed"));
});

test("shutdown drains an answer registered while its transport starts teardown", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	let release!: () => void, began!: () => void;
	const hold = new Promise<void>(resolve => { release = resolve; });
	const writing = new Promise<void>(resolve => { began = resolve; });
	let shutdown: Promise<unknown> | undefined, stopped = false, written = false;
	const append = h.journal.append.bind(h.journal);
	h.journal.append = async record => {
		if (record.type === "selector" && record.phase === "answer_failed") { began(); await hold; written = true; }
		await append(record);
	};
	h.f.transport.answer = async (_id: string, _text?: string, signal?: AbortSignal) => {
		// Supported transport injection can synchronously initiate teardown before
		// the receipt loop registers the returned answer promise in its owned set.
		shutdown = h.emit("session_shutdown", { reason: "exit" }).then(() => { stopped = true; });
		assert.equal(signal?.aborted, true);
		throw new Error("synthetic cancellation");
	};
	try {
		await h.poll([callback(1, "unknown")]); await writing;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(stopped, false, "teardown must await the late-registered answer's journal write");
	} finally { release(); await shutdown; }
	assert.equal(written, true);
	assert.equal(stopped, true);
});

test("callback answer journal failure is observed without blocking ordinary command admission", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	const append = h.journal.append.bind(h.journal);
	h.journal.append = async record => { if (record.type === "selector" && record.phase === "answer_failed") throw new Error("synthetic journal failure"); await append(record); };
	h.f.transport.answer = async () => { throw new Error("synthetic answer failure"); };
	let aborts = 0; h.ctx.isIdle = () => false; h.ctx.abort = () => { aborts++; };
	await h.poll([callback(1, "unknown"), command(2, "/stop")]);
	assert.equal(aborts, 1);
	await h.emit("session_shutdown", { reason: "exit" });
});

test("Telegram transport sends/edits inline keyboards and answers callbacks using public endpoints", async () => {
	const requests: Array<{ endpoint: string; body: any }> = [];
	const api = new TelegramApiClient("synthetic-token", 70, async (input, init) => {
		requests.push({ endpoint: input.split("/").at(-1)!, body: JSON.parse(init.body as string) });
		return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 900 } }; } };
	});
	const keyboard = { inline_keyboard: [[{ text: "Synthetic", callback_data: "sel:" + "x".repeat(22) }]] };
	await api.sendMessage("Selector", 100, undefined, "plain", keyboard);
	await api.editMessageText("900", "Changed", undefined, { inline_keyboard: [] }); await api.answerCallbackQuery("fixture-callback");
	assert.deepEqual(requests.map(r => r.endpoint), ["sendMessage", "editMessageText", "answerCallbackQuery"]);
	assert.deepEqual(requests[0].body.reply_markup, keyboard); assert.deepEqual(requests[1].body.reply_markup, { inline_keyboard: [] });
	assert.deepEqual(requests[2].body, { callback_query_id: "fixture-callback" });
	await assert.rejects(api.answerCallbackQuery(""), /Invalid/);
});

test("failed delivery bookkeeping cannot contradict an already durable applied result", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const cb = callback(2, f.button(1));
	f.transport.edit = async () => { throw new Error("edit failure"); };
	f.hook(record => { if (record.phase === "delivery_failed") throw new Error("journal unavailable"); });
	await assert.rejects(f.selectors.handle(cb), /journal unavailable/);
	assert.equal(f.outcome(), "applied"); assert.equal(f.calls, 1);
	await f.selectors.handle(cb); assert.equal(f.calls, 1);
	assert.equal(f.journal.records.filter(r => r.phase === "outcome" && r.operationId.startsWith("callback:")).length, 1);
});

test("uncertain keyboard send is not resent in-process or after restart", async () => {
	const f = fixture(); let sends = 0;
	f.transport.send = async () => { sends++; throw new Error("connection lost after send"); };
	await f.selectors.handle(command(1)); await f.selectors.handle(command(1));
	assert.equal(sends, 1); assert.equal(f.outcome(), "failed");
	const restarted = fixture(f.journal.records); await restarted.selectors.initialize(); await restarted.selectors.handle(command(1));
	assert.equal(restarted.sends.length, 0); assert.equal(restarted.calls, 0);
});

test("a different callback ID cannot reuse a consumed selection", async () => {
	const f = fixture(); await f.selectors.handle(command(1)); const token = f.button(1);
	await f.selectors.handle(callback(2, token)); await f.selectors.handle(callback(3, token));
	assert.equal(f.calls, 1); assert.equal(f.outcome(), "stale"); assert.equal(f.answers.length, 2);
});

test("external compaction completion/failure releases only the compaction guard", async () => {
	for (const event of ["session_compact", "session_compact_failed"]) {
		const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
		await h.emit("session_before_compact"); await h.emit(event);
		await h.poll([command(1)]); await h.poll([callback(2, h.f.button(1))]);
		assert.equal(h.f.calls, 1); await h.emit("session_shutdown", { reason: "exit" });
	}
});

test("in-flight mutation cancels new compaction and session transitions", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" }); await h.poll([command(1)]);
	let release!: () => void, started!: () => void;
	const began = new Promise<void>(resolve => { started = resolve; });
	h.f.setter(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return false; });
	const inFlight = h.poll([callback(2, h.f.button(1))]); await began;
	for (const event of ["session_before_compact", "session_before_switch", "session_before_fork", "session_before_tree"]) {
		assert.deepEqual(await h.emit(event), { cancel: true });
	}
	release(); await inFlight; await h.emit("session_shutdown", { reason: "exit" });
});

test("unknown and unauthorized callbacks receive safe feedback without touching messages", async () => {
	const f = fixture(); const acknowledgements: Array<string | undefined> = [];
	f.transport.answer = async (_id, text?: string) => { acknowledgements.push(text); };
	await f.selectors.handle(callback(1, "invalid")); await f.selectors.handle(callback(2, "invalid", 900, 8));
	assert.match(acknowledgements[0]!, /expired/); assert.equal(acknowledgements[1], "Not authorized.");
	assert.equal(f.edits.length, 0); assert.equal(f.reads, 0);
});

for (const event of ["model_select", "thinking_level_select", "resources_discover"]) {
	test(`host ${event} invalidates existing buttons even if metadata returns to its prior value`, async () => {
		const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
		await h.poll([command(1)]); const token = h.f.button(1); await h.emit(event);
		await h.poll([callback(2, token)]); assert.equal(h.f.calls, 0);
		assert.equal(h.journal.records.findLast(r => r.type === "selector" && r.phase === "outcome")?.outcome, "stale");
		await h.emit("session_shutdown", { reason: "exit" });
	});
}

for (const work of ["command", "inbound", "quiet", "reply", "compact", "new", "host-queued"] as const) {
	test(`extension rejects selection with accepted pending ${work} work`, async () => {
		const h = extensionFixture({
			inboundQuietWindowMs: work === "quiet" ? 5_000 : 0,
			sendReply: work === "reply" ? async () => { throw new Error("synthetic delivery failure"); } : undefined,
		});
		await h.emit("session_start", { reason: "startup" });
		try {
			await h.poll([command(1)]); const token = h.f.button(1);
			if (work === "command" || work === "inbound") {
				// Ingest precedes command processing/dispatch within a real extension poll.
				await h.poll([command(2, work === "command" ? "/help" : "queued inbound"), callback(3, token)]);
			} else {
				if (work === "host-queued") h.ctx.hasPendingMessages = () => true;
				else await h.poll([command(2, work === "quiet" ? "collecting inbound" : work === "reply" ? "/help" : `/${work}`)]);
				if (work === "quiet") assert.equal(h.turns.length, 0, "quiet collection has not dispatched");
				if (work === "reply") assert.equal(recover(h.journal.records).repliesToRetry.length, 1);
				if (work === "compact" || work === "new") assert.equal(recover(h.journal.records).uncertainCommands.length, 1);
				await h.poll([callback(3, token)]);
			}
			assert.equal(h.f.calls, 0);
			assert.equal(h.journal.records.findLast(r => r.type === "selector" && r.phase === "outcome")?.outcome, "busy");
		} finally { await h.emit("session_shutdown", { reason: "exit" }); }
	});
}

test("extension retains prior unknown-command policy for selector arguments", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	await h.poll([command(1, "/model extra"), command(2, "/thinking high")]);
	assert.equal(h.f.sends.length, 0); assert.equal(h.turns.length, 0);
	assert.deepEqual(h.journal.records.filter(r => r.type === "update").map(r => r.command), ["unknown", "unknown"]);
	await h.emit("session_shutdown", { reason: "exit" });
});

test("local compact callback releases its guard without cancelling the host before hook", async () => {
	const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
	await h.poll([command(1, "/compact")]);
	assert.ok(h.compactOptions);
	assert.equal(await h.emit("session_before_compact"), undefined);
	await h.emit("session_compact_failed"); h.compactOptions.onError(new Error("synthetic failure"));
	await new Promise(resolve => setImmediate(resolve));
	await h.poll([command(2)]); await h.poll([callback(3, h.f.button(1))]);
	assert.equal(h.f.calls, 1);
	await h.emit("session_shutdown", { reason: "exit" });
});

test("fresh idempotent selections remain allowed after a restart without replaying old requests", async () => {
	const first = fixture(); await first.selectors.handle(command(1));
	await first.selectors.handle(callback(2, first.button(0))); assert.equal(first.calls, 1);
	const restarted = fixture(first.journal.records); await restarted.selectors.initialize();
	assert.equal(restarted.calls, 0);
	await restarted.selectors.handle(command(3)); await restarted.selectors.handle(callback(4, restarted.button(0)));
	assert.equal(restarted.calls, 1); assert.equal(restarted.outcome(), "applied");
});


test("a background full log's stale busy-compaction assertions are not implemented", async () => {
	// Deliberately pin the current guard's acceptance, not a removed over-broad cancel.
	for (const text of ["/compact", "queued inbound"]) {
		const h = extensionFixture(); await h.emit("session_start", { reason: "startup" });
		await h.poll([command(1, text)]);
		assert.equal(await h.emit("session_before_compact"), undefined);
		await h.emit("session_shutdown", { reason: "exit" });
	}
});
