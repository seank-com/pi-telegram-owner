import { createHash, randomBytes } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramCallbackQuery, TelegramUpdate } from "./core.ts";

export interface InlineKeyboard {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}
export type SelectorKind = "model" | "thinking";
export type SelectorOutcome = "shown" | "applied" | "clamped" | "rejected" | "stale" | "busy" | "duplicate" | "failed" | "interrupted";
/** Local control evidence, never an agent job or model-context entry. No raw callback payloads or errors. */
export interface SelectorRecord {
	type: "selector";
	schemaVersion: 1;
	operationId: string;
	phase: "received" | "requested" | "mutation_started" | "outcome" | "delivery_failed" | "answer_failed" | "duplicate";
	kind?: SelectorKind;
	selection?: string;
	selectionId?: string;
	outcome?: SelectorOutcome;
	text?: string;
	timestamp: string;
}
export interface SelectorTransport {
	send(text: string, keyboard: InlineKeyboard, replyTo: number): Promise<string>;
	edit(messageId: string, text: string, keyboard: InlineKeyboard): Promise<void>;
	answer(callbackId: string, text?: string, signal?: AbortSignal): Promise<void>;
}
export interface SelectorJournal {
	readonly records: readonly SelectorRecord[];
	append(record: SelectorRecord): Promise<void>;
}

type Model = NonNullable<ExtensionContext["model"]>;
type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface Snapshot {
	stamp: string;
	models: Model[];
	model?: Model;
	level: Level;
	levels: Level[];
}
interface Picker {
	kind: SelectorKind;
	snapshot: Snapshot;
	messageId?: string;
	createdAt: number;
}
interface Button {
	picker: Picker;
	page?: number;
	model?: Model;
	level?: Level;
	used: boolean;
}
const PAGE_SIZE = 6;
const MAX_PICKERS = 32;
const TTL_MS = 10 * 60_000;
const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (model: Model) => JSON.stringify([model.provider, model.id]);
// Public provider/model identities distinguish catalog aliases. Endpoints and
// authentication diagnostics are never displayed.
const display = (text: string) => Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ")).slice(0, 80).join("");
const label = (model: Model | undefined) => model ? display(`${model.provider}/${model.id}`) : "unavailable";
export function selectorCommand(update: TelegramUpdate, owner: number, chat: number): SelectorKind | undefined {
	const message = update.message;
	if (message?.chat.type !== "private" || message.chat.id !== chat || message.from?.id !== owner) return;
	const text = (message.text ?? message.caption)?.trim();
	return text === "/model" ? "model" : text === "/thinking" ? "thinking" : undefined;
}

/** Uses only the public 0.87.1 extension/registry and pi-ai model-capability interfaces. */
export function selectorSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, epoch: number): Snapshot {
	if (!Array.isArray(ctx.scopedModels) || typeof ctx.modelRegistry?.getAvailable !== "function" ||
		typeof pi.getThinkingLevel !== "function" || typeof pi.setModel !== "function" || typeof pi.setThinkingLevel !== "function") {
		throw new Error("Selector host capability unavailable");
	}
	const available = ctx.modelRegistry.getAvailable();
	const scope = new Set(ctx.scopedModels.map(({ model }) => key(model)));
	const models = [...new Map(available.filter(model => scope.size === 0 || scope.has(key(model))).map(model => [key(model), model])).values()]
		.sort((a, b) => key(a).localeCompare(key(b)));
	const model = ctx.model;
	const levels = model && models.some(candidate => key(candidate) === key(model)) ? getSupportedThinkingLevels(model) : [];
	const level = pi.getThinkingLevel();
	const capabilities = (candidate: Model) => [
		key(candidate), candidate.name, candidate.api, candidate.contextWindow, candidate.maxTokens,
		candidate.reasoning, candidate.input, candidate.inputLimits, candidate.cost, candidate.thinkingLevelMap,
		candidate.compat, candidate.promptCache, candidate.samplingParams,
		hash(candidate.baseUrl ?? ""), getSupportedThinkingLevels(candidate),
	];
	return {
		model, models, levels, level,
		stamp: hash(JSON.stringify([epoch, ctx.sessionManager.getSessionId(), models.map(capabilities),
			ctx.scopedModels.map(({ model, thinkingLevel }) => [key(model), thinkingLevel]).sort(), model ? capabilities(model) : null, level])),
	};
}

/** Ephemeral buttons expire on restart; durable requests are never replayed as mutations.
 * The extension serializes handle/initialize; answer is safe at immediate poll receipt. */
export class LocalSelectors {
	private readonly buttons = new Map<string, Button>();
	private readonly pickers: Picker[] = [];
	private epoch = 0;
	private mutation = false;
	private readonly options: {
		owner: number; chat: number;
		journal: SelectorJournal;
		transport?: SelectorTransport;
		pi: ExtensionAPI;
		context(): ExtensionContext;
		idle(): boolean;
		now?: () => number;
	};
	constructor(options: LocalSelectors["options"]) { this.options = options; }
	get mutating(): boolean { return this.mutation; }
	invalidate(): void { this.epoch++; this.buttons.clear(); this.pickers.length = 0; }
	private record(operationId: string, fields: Omit<SelectorRecord, "type" | "schemaVersion" | "operationId" | "timestamp">): Promise<void> {
		return this.options.journal.append({ type: "selector", schemaVersion: 1, operationId, timestamp: new Date(this.now()).toISOString(), ...fields });
	}
	private now(): number { return this.options.now?.() ?? Date.now(); }
	async initialize(): Promise<void> {
		this.invalidate();
		const records = this.options.journal.records;
		const finished = new Set(records.filter(r => r.phase === "outcome").map(r => r.operationId));
		for (const operationId of new Set(records.filter(r => r.phase === "received" && !finished.has(r.operationId)).map(r => r.operationId))) {
			await this.record(operationId, { phase: "outcome", outcome: "interrupted", text: "Selector interrupted; its outcome is uncertain. Inspect /status and open a fresh selector." });
		}
	}
	/** Called at poll receipt, before the extension's serialized work queue. Failure never permits a mutation retry. */
	async answer(callback: TelegramCallbackQuery, signal?: AbortSignal): Promise<void> {
		try {
			const authorized = callback.from?.id === this.options.owner && callback.message?.chat?.type === "private" && callback.message.chat.id === this.options.chat;
			const button = typeof callback.data === "string" && /^sel:[A-Za-z0-9_-]{22}$/.test(callback.data) ? this.buttons.get(callback.data) : undefined;
			const valid = button && button.picker.messageId === String(callback.message?.message_id) && this.now() - button.picker.createdAt < TTL_MS;
			await this.options.transport?.answer(callback.id, !authorized ? "Not authorized." : !valid ? "Selector already handled or expired. Open /model or /thinking again." : undefined, signal);
		} catch { await this.record(`callback:${hash(String(callback.id))}`, { phase: "answer_failed" }); }
	}
	private expire(): void {
		while (this.pickers.length && (this.pickers.length > MAX_PICKERS || this.now() - this.pickers[0].createdAt >= TTL_MS)) {
			const old = this.pickers.shift();
			for (const [token, button] of this.buttons) if (button.picker === old) this.buttons.delete(token);
		}
	}
	private render(picker: Picker, page: number): { text: string; keyboard: InlineKeyboard } {
		// Re-rendering invalidates all older buttons for this message, bounding memory even with pagination.
		for (const [token, button] of this.buttons) if (button.picker === picker) this.buttons.delete(token);
		const button = (text: string, action: Omit<Button, "picker" | "used">) => {
			const token = `sel:${randomBytes(16).toString("base64url")}`;
			this.buttons.set(token, { picker, ...action, used: false });
			return { text, callback_data: token };
		};
		const snapshot = picker.snapshot;
		if (picker.kind === "thinking") {
			return { text: `Thinking: ${snapshot.level}\nModel: ${label(snapshot.model)}${snapshot.levels.length ? "" : "\nActive model unavailable in this session scope."}`,
				keyboard: { inline_keyboard: snapshot.levels.map(level => [button(`${level === snapshot.level ? "✓ " : ""}${level}`, { level })]) } };
		}
		const pages = Math.max(1, Math.ceil(snapshot.models.length / PAGE_SIZE));
		const offset = page * PAGE_SIZE;
		const rows = snapshot.models.slice(offset, offset + PAGE_SIZE).map(model => [button(`${snapshot.model && key(model) === key(snapshot.model) ? "✓ " : ""}${label(model)}`, { model })]);
		const navigation = [];
		if (page > 0) navigation.push(button("Previous", { page: page - 1 }));
		if (page + 1 < pages) navigation.push(button("Next", { page: page + 1 }));
		if (navigation.length) rows.push(navigation);
		return { text: `Model: ${label(snapshot.model)}\nPage ${page + 1}/${pages}${snapshot.models.length ? "" : "\nNo authenticated models available in this session scope."}`, keyboard: { inline_keyboard: rows } };
	}
	async handle(update: TelegramUpdate, answered = false): Promise<boolean> {
		const callback = update.callback_query;
		const kind = selectorCommand(update, this.options.owner, this.options.chat);
		if (!callback && !kind) return false;
		if (callback && !answered) await this.answer(callback);
		const operationId = callback ? `callback:${hash(String(callback.id))}` : `command:${update.update_id}`;
		if (this.options.journal.records.some(r => r.operationId === operationId && (r.phase === "outcome" || r.phase === "received"))) {
			await this.record(operationId, { phase: "duplicate", outcome: "duplicate" });
			return true;
		}
		await this.record(operationId, { phase: "received", ...(kind ? { kind } : {}) });
		const finish = (outcome: SelectorOutcome, text: string) => this.record(operationId, { phase: "outcome", outcome, text });
		if (callback && (callback.from?.id !== this.options.owner || callback.message?.chat?.type !== "private" || callback.message.chat.id !== this.options.chat ||
			!Number.isSafeInteger(callback.message.message_id) || callback.message.message_id <= 0)) {
			await finish("rejected", "Unauthorized selector callback."); return true;
		}
		if (!this.options.transport) { await finish("failed", "Selector transport unavailable."); return true; }
		this.expire();
		if (kind) {
			let sending = false;
			try {
				const snapshot = selectorSnapshot(this.options.pi, this.options.context(), this.epoch);
				const picker: Picker = { kind, snapshot, createdAt: this.now() };
				this.pickers.push(picker); this.expire();
				const rendered = this.render(picker, 0);
				await this.record(operationId, { phase: "requested", kind });
				sending = true;
				picker.messageId = await this.options.transport.send(rendered.text, rendered.keyboard, update.message!.message_id);
				await finish("shown", rendered.text);
			} catch {
				await finish("failed", "Selector unavailable. No change was requested. Check host capabilities and open a fresh selector.");
				// A failed send may have reached Telegram: never send again automatically.
				if (!sending) await this.options.transport.send("Selector unavailable. No change was requested.", EMPTY_KEYBOARD, update.message!.message_id).catch(() => undefined);
			}
			return true;
		}
		const token = callback!.data;
		const selected = typeof token === "string" && /^sel:[A-Za-z0-9_-]{22}$/.test(token) ? this.buttons.get(token) : undefined;
		if (!selected || selected.picker.messageId !== String(callback!.message!.message_id)) {
			await finish("stale", "Invalid or expired selector. Open /model or /thinking again."); return true;
		}
		const picker = selected.picker;
		const showOutcome = async (outcome: SelectorOutcome, text: string) => {
			await finish(outcome, text); // Durable before editing; failed edits must not repeat a mutation.
			for (const [id, button] of this.buttons) if (button.picker === picker) this.buttons.delete(id);
			try { await this.options.transport!.edit(picker.messageId!, text, EMPTY_KEYBOARD); }
			catch { await this.record(operationId, { phase: "delivery_failed" }); }
		};
		if (selected.used) { await finish("duplicate", "Selection was already handled."); return true; }
		selected.used = true;
		let snapshot: Snapshot;
		try { snapshot = selectorSnapshot(this.options.pi, this.options.context(), this.epoch); }
		catch { await showOutcome("failed", "Selector host capability unavailable; no change requested."); return true; }
		if (snapshot.stamp !== picker.snapshot.stamp) { await showOutcome("stale", "Session, model or available catalog changed. Open a fresh selector."); return true; }
		await this.record(operationId, { phase: "requested", kind: picker.kind, selection: selected.model ? label(selected.model) : selected.level ?? `page:${selected.page}`,
			...(selected.model ? { selectionId: hash(key(selected.model)) } : {}) });
		if (selected.page !== undefined) {
			const rendered = this.render(picker, selected.page);
			try {
				await this.options.transport.edit(picker.messageId!, rendered.text, rendered.keyboard);
				await finish("shown", rendered.text);
			} catch { await showOutcome("failed", "Selector update failed. Open a fresh selector."); }
			return true;
		}
		if (!this.options.idle()) { await showOutcome("busy", "The agent is busy; no change requested. Open a fresh selector when idle."); return true; }
		this.mutation = true;
		try {
			await this.record(operationId, { phase: "mutation_started", kind: picker.kind });
			// Journal I/O can yield to lifecycle events. Revalidate immediately before invoking the public setter.
			if (!this.options.idle()) { await showOutcome("busy", "The agent became busy; no change requested."); return true; }
			if (selectorSnapshot(this.options.pi, this.options.context(), this.epoch).stamp !== snapshot.stamp) {
				await showOutcome("stale", "Selector changed before mutation; no change requested."); return true;
			}
			if (selected.model) {
				const model = snapshot.models.find(model => key(model) === key(selected.model!));
				if (!model) { await showOutcome("rejected", "Model is unavailable in this session scope."); return true; }
				if (!await this.options.pi.setModel(model)) { await showOutcome("rejected", "Model authentication is unavailable; no model change confirmed."); return true; }
				const actual = this.options.context().model;
				if (!actual || key(actual) !== key(model)) { await showOutcome("failed", "Model change was not confirmed. Inspect /status."); return true; }
				const actualLevel = this.options.pi.getThinkingLevel();
				await showOutcome("applied", `Model: ${label(actual)}\nThinking: ${actualLevel}${actualLevel === snapshot.level ? "" : ` (was ${snapshot.level}; adjusted by host)`}`);
			} else if (selected.level && snapshot.levels.includes(selected.level) && snapshot.model && snapshot.models.some(model => key(model) === key(snapshot.model!))) {
				this.options.pi.setThinkingLevel(selected.level);
				const actual = this.options.pi.getThinkingLevel();
				await showOutcome(actual === selected.level ? "applied" : "clamped", `Thinking: ${actual}${actual === selected.level ? "" : ` (requested ${selected.level}; clamped by host)`}`);
			} else { await showOutcome("rejected", "Thinking level or active model is unavailable in this session scope."); }
		} catch (error) {
			// Never overwrite an already durable terminal result if subsequent delivery bookkeeping fails.
			if (this.options.journal.records.some(record => record.operationId === operationId && record.phase === "outcome")) throw error;
			await showOutcome("failed", "Change failed or could not be confirmed. Inspect /status before retrying.");
		} finally { this.mutation = false; }
		return true;
	}
}
