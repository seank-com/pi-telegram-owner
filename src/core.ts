import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { parseTelegramOwnerCommand, type TelegramOwnerCommandName } from "./commands.ts";
import { createTelegramTransportPlan, MAX_TELEGRAM_CHUNKS, TELEGRAM_HTML_LIMIT, type TelegramTransportPlan } from "./format.ts";

export type UpdateDisposition = "accepted" | "unauthorized" | "unsupported";

export interface TelegramImageRef {
	fileId: string;
	mimeType: "image/jpeg" | "image/png" | "image/webp";
	fileSize?: number;
}

export interface ResolvedImage {
	data: string;
	mimeType: string;
}

export interface ArchivedTelegramAttachment {
	sha256: string;
	size: number;
	mimeType: "image/jpeg" | "image/png" | "image/webp";
	path: string;
	source: "live" | "telegram-desktop-import";
	direction: "in" | "out";
}

export interface ResolvedArchivedImage {
	image: ResolvedImage;
	attachment: ArchivedTelegramAttachment;
}

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		date?: number;
		edit_date?: number;
		text?: string;
		caption?: string;
		entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string }>;
		caption_entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string }>;
		photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
		document?: { file_id: string; file_size?: number; mime_type?: string };
		chat: { id: number; type: string };
		from?: { id: number };
	};
}

export interface FetchLike {
	(input: string, init: { method: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<{
		ok: boolean;
		status?: number;
		json(): Promise<unknown>;
		arrayBuffer?(): Promise<ArrayBuffer>;
	}>;
}

export async function fetchUpdateBatch(
	fetchImpl: FetchLike,
	token: string,
	cursor?: number,
	signal?: AbortSignal,
	pollTimeoutSeconds = 0,
): Promise<TelegramUpdate[]> {
	const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			offset: cursor === undefined ? undefined : cursor + 1,
			timeout: pollTimeoutSeconds,
			allowed_updates: ["message"],
		}),
		signal,
	});
	const payload = (await response.json()) as { ok?: boolean; result?: unknown };
	if (!response.ok || payload.ok !== true || !Array.isArray(payload.result)) {
		throw new Error("Telegram getUpdates failed");
	}
	return payload.result as TelegramUpdate[];
}

export type JournalRecord =
	| {
			type: "update";
			schemaVersion?: 2 | 3;
			updateId: number;
			disposition: UpdateDisposition;
			timestamp: string;
			jobId?: string;
			messageId?: number;
			chatId?: number;
			userId?: number;
			text?: string;
			rawText?: string;
			telegramDate?: number;
			telegramEditDate?: number;
			entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string }>;
			images?: TelegramImageRef[];
			command?: TelegramOwnerCommandName | "unknown";
	  }
	| { type: "inbound_batch"; schemaVersion: 1; batchId: string; revision: number; state: "open" | "sealed" | "dispatching"; openedAt: string; readyAt: string; memberJobIds: string[]; messageIds: number[]; segmentSha256: string[]; boundaries: Array<{ start: number; end: number }>; text: string; finalMessageId: number }
	| { type: "media_captured"; schemaVersion: 1; mediaId: string; jobId: string; direction: "in" | "out"; attachment: ArchivedTelegramAttachment; telegram: { updateId?: number; messageId?: number; fileId?: string }; timestamp: string }
	| { type: "photo_send_planned"; schemaVersion: 1; photoId: string; deliveryKey: string; jobId: string; caption: string; replyToMessageId: number; attachment: ArchivedTelegramAttachment; timestamp: string }
	| { type: "photo_sent"; schemaVersion: 1; photoId: string; jobId: string; messageId: string; timestamp: string }
	| { type: "dispatch_requested"; jobId: string; sessionId: string; timestamp?: string }
	| { type: "command_started"; jobId: string; command: TelegramOwnerCommandName | "unknown"; timestamp?: string }
	| { type: "dispatched"; jobId: string; sessionId: string; timestamp?: string }
	| { type: "reply_ready"; jobId: string; text: string; sessionEntryId?: string; timestamp?: string }
	| { type: "reply_plan"; jobId: string; renderer: "telegram-html-v1"; rawSha256: string; chunks: Array<{ index: number; format: "HTML" | "plain"; payload: string; plainFallback: string; payloadSha256: string }> }
	| { type: "reply_chunk_rejected"; jobId: string; index: number; code: "HTML_REJECTED"; timestamp: string }
	| { type: "reply_anchor_rejected"; jobId: string; index: 0; code: "REPLY_TARGET_MISSING"; timestamp: string }
	| { type: "reply_chunk_sent"; jobId: string; index: number; messageId: string; format: "HTML" | "plain"; timestamp: string }
	| { type: "reply_sent"; jobId: string; messageId: string; timestamp?: string }
	| { type: "reply_sent"; jobId: string; messageIds: string[]; timestamp: string }
	| { type: "projection_needed"; jobId: string; direction: "in" | "out"; reason: "content" | "metadata"; canonical: { kind: "pi"; sessionId: string; entryId: string } | { kind: "local-response" }; timestamp: string }
	| { type: "projection_committed"; jobId: string; direction: "in" | "out"; messageId: string; contentRevision: number; contentSha256: string; metadataRevision: number; metadataSha256: string; timestamp: string }
	| { type: "projection_deferred"; jobId: string; direction: "in" | "out"; code: string; timestamp: string }
	| { type: "activity_started"; jobId: string; messageId: string }
	| { type: "activity_cleared"; jobId: string; messageId: string }
	| { type: "interrupted"; jobId: string; reason: string };

export interface Job {
	jobId: string;
	updateId: number;
	messageId: number;
	text: string;
	telegramDate?: number;
	images: TelegramImageRef[];
	captureRequired?: boolean;
	command?: TelegramOwnerCommandName | "unknown";
	batchId?: string;
	memberJobIds?: string[];
	messageIds?: number[];
	segmentSha256?: string[];
	boundaries?: Array<{ start: number; end: number }>;
}

export interface TelegramBridgeOptions {
	/** Runtime-selected; false retains exact plain-v1 delivery. */
	formattedDelivery?: boolean;
	/** Same-date text segments are durably coalesced before dispatch. Default 4000ms. */
	inboundQuietWindowMs?: number;
	now?: () => number;
}

export interface Recovery {
	cursor?: number;
	queued: Job[];
	uncertain: Job[];
	pendingCommands: Job[];
	uncertainCommands: Job[];
	repliesToRetry: Array<Job & { reply: string }>;
	orphanedActivities: Array<{ jobId: string; messageId: string }>;
}

export interface Journal {
	load(): Promise<JournalRecord[]>;
	append(record: JournalRecord): Promise<void>;
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type SendReply = (text: string, replyTo?: number, format?: "HTML" | "plain") => Promise<string>;

export class StateCorruptionError extends Error {}

export const DEFAULT_INBOUND_QUIET_WINDOW_MS = 4_000;
export const MIN_INBOUND_QUIET_WINDOW_MS = 100;
export const MAX_INBOUND_QUIET_WINDOW_MS = 5_000;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function outboundPhotoDeliveryKey(attachment: ArchivedTelegramAttachment, caption: string | undefined, replyToMessageId: number): string {
	return sha256(`${attachment.sha256}\n${(caption ?? "").replace(/\r\n?/g, "\n")}\n${replyToMessageId}`);
}

export function validateMediaLifecycle(records: readonly JournalRecord[]): void {
	const validAttachment = (attachment: ArchivedTelegramAttachment): boolean => Boolean(attachment && /^[0-9a-f]{64}$/.test(attachment.sha256) && Number.isSafeInteger(attachment.size) && attachment.size > 0 && attachment.size <= MAX_IMAGE_BYTES && ["image/jpeg", "image/png", "image/webp"].includes(attachment.mimeType) && attachment.path === `messages/_attachments/${attachment.sha256}.${attachment.mimeType === "image/jpeg" ? "jpg" : attachment.mimeType === "image/png" ? "png" : "webp"}` && ["live", "telegram-desktop-import"].includes(attachment.source) && ["in", "out"].includes(attachment.direction));
	const updates = new Map(records.filter((record): record is Extract<JournalRecord, { type: "update" }> => record.type === "update" && record.disposition === "accepted" && Boolean(record.jobId)).map((record) => [record.jobId!, record]));
	const media = new Map<string, Extract<JournalRecord, { type: "media_captured" }>>();
	const inboundBindings = new Set<string>();
	const plans = new Map<string, Extract<JournalRecord, { type: "photo_send_planned" }>>();
	const deliveryKeys = new Map<string, string>();
	const receipts = new Map<string, Extract<JournalRecord, { type: "photo_sent" }>>();
	for (const record of records) {
		if (record.type === "media_captured") {
			if (record.schemaVersion !== 1 || media.has(record.mediaId) || !validAttachment(record.attachment) || record.attachment.source !== "live" || record.attachment.direction !== record.direction || !Number.isFinite(new Date(record.timestamp).valueOf())) throw new StateCorruptionError("Media capture lifecycle is invalid");
			if (record.direction === "in") {
				const update = updates.get(record.jobId);
				const imageIndex = update?.images?.findIndex((image) => image.fileId === record.telegram.fileId) ?? -1;
				const binding = `${record.jobId}:${imageIndex}`;
				if (!update || imageIndex < 0 || record.telegram.updateId !== update.updateId || record.telegram.messageId !== update.messageId || record.mediaId !== `in:${record.jobId}:${imageIndex}:${record.attachment.sha256}` || inboundBindings.has(binding)) throw new StateCorruptionError("Inbound media capture linkage is invalid");
				inboundBindings.add(binding);
			}
			media.set(record.mediaId, record);
		} else if (record.type === "photo_send_planned") {
			if (record.schemaVersion !== 1 || plans.has(record.photoId) || deliveryKeys.has(record.deliveryKey) || !validAttachment(record.attachment) || record.attachment.direction !== "out" || record.attachment.source !== "live" || !/^[0-9a-f]{64}$/.test(record.deliveryKey) || record.deliveryKey !== outboundPhotoDeliveryKey(record.attachment, record.caption, record.replyToMessageId) || !Number.isSafeInteger(record.replyToMessageId) || record.replyToMessageId <= 0 || !Number.isFinite(new Date(record.timestamp).valueOf())) throw new StateCorruptionError("Outbound photo plan lifecycle is invalid");
			plans.set(record.photoId, record);
			deliveryKeys.set(record.deliveryKey, record.photoId);
		} else if (record.type === "photo_sent") {
			if (record.schemaVersion !== 1 || receipts.has(record.photoId) || !/^[1-9][0-9]*$/.test(record.messageId) || !Number.isFinite(new Date(record.timestamp).valueOf())) throw new StateCorruptionError("Outbound photo receipt lifecycle is invalid");
			receipts.set(record.photoId, record);
		}
	}
	for (const plan of plans.values()) {
		const capture = media.get(`out:${plan.photoId}:${plan.attachment.sha256}`);
		if (!capture || capture.jobId !== plan.jobId || JSON.stringify(capture.attachment) !== JSON.stringify(plan.attachment)) throw new StateCorruptionError("Outbound photo plan lacks its matching media capture");
	}
	for (const receipt of receipts.values()) {
		const plan = plans.get(receipt.photoId);
		if (!plan || plan.jobId !== receipt.jobId) throw new StateCorruptionError("Outbound photo receipt is orphaned or mismatched");
	}
}

function isHtmlRejection(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "TELEGRAM_PARSE_REJECTED");
}

function isReplyAnchorRejection(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "TELEGRAM_REPLY_ANCHOR_REJECTED");
}

function journalPlan(jobId: string, text: string, plan: TelegramTransportPlan): Extract<JournalRecord, { type: "reply_plan" }> {
	return {
		type: "reply_plan",
		jobId,
		renderer: plan.renderer,
		rawSha256: sha256(text),
		chunks: plan.chunks.map((chunk) => ({ ...chunk, payloadSha256: sha256(chunk.payload) })),
	};
}

function validateJournalPlan(plan: Extract<JournalRecord, { type: "reply_plan" }>, text: string): void {
	if (plan.renderer !== "telegram-html-v1" || !/^[0-9a-f]{64}$/.test(plan.rawSha256) || plan.rawSha256 !== sha256(text)) throw new StateCorruptionError("Reply plan identity is invalid");
	if (!Array.isArray(plan.chunks) || plan.chunks.length < 1 || plan.chunks.length > MAX_TELEGRAM_CHUNKS) throw new StateCorruptionError("Reply plan chunk count is invalid");
	for (let index = 0; index < plan.chunks.length; index++) {
		const chunk = plan.chunks[index];
		if (!chunk || chunk.index !== index || (chunk.format !== "HTML" && chunk.format !== "plain")) throw new StateCorruptionError("Reply plan indices or formats are invalid");
		if (typeof chunk.payload !== "string" || !chunk.payload || chunk.payload.length > TELEGRAM_HTML_LIMIT || Buffer.byteLength(chunk.payload, "utf8") > TELEGRAM_HTML_LIMIT * 4) throw new StateCorruptionError("Reply plan payload bounds are invalid");
		if (typeof chunk.plainFallback !== "string" || !chunk.plainFallback || chunk.plainFallback.length > TELEGRAM_HTML_LIMIT) throw new StateCorruptionError("Reply plan fallback bounds are invalid");
		if (!/^[0-9a-f]{64}$/.test(chunk.payloadSha256) || chunk.payloadSha256 !== sha256(chunk.payload)) throw new StateCorruptionError("Reply plan payload hash mismatch");
	}
}

function imageFromMessage(message: NonNullable<TelegramUpdate["message"]>): TelegramImageRef | undefined {
	const photo = message.photo?.at(-1);
	if (photo && (!photo.file_size || photo.file_size <= MAX_IMAGE_BYTES)) {
		return { fileId: photo.file_id, mimeType: "image/jpeg", fileSize: photo.file_size };
	}
	const document = message.document;
	if (
		document &&
		(document.mime_type === "image/jpeg" || document.mime_type === "image/png" || document.mime_type === "image/webp") &&
		(!document.file_size || document.file_size <= MAX_IMAGE_BYTES)
	) {
		return { fileId: document.file_id, mimeType: document.mime_type, fileSize: document.file_size };
	}
	return undefined;
}

export class JsonlJournal implements Journal {
	readonly path: string;
	constructor(path: string) {
		this.path = path;
	}

	async load(): Promise<JournalRecord[]> {
		let bytes: Buffer;
		try {
			bytes = await readFile(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const lastNewline = bytes.lastIndexOf(0x0a);
		if (lastNewline !== bytes.length - 1) {
			await truncate(this.path, Math.max(0, lastNewline + 1));
			bytes = bytes.subarray(0, Math.max(0, lastNewline + 1));
		}
		const lines = bytes.toString("utf8").split("\n");
		lines.pop();
		return lines.map((line, index) => {
			try {
				return JSON.parse(line) as JournalRecord;
			} catch (error) {
				throw new StateCorruptionError(`Malformed state record at line ${index + 1}: ${String(error)}`);
			}
		});
	}

	async append(record: JournalRecord): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const file = await open(this.path, "a", 0o600);
		try {
			await file.write(`${JSON.stringify(record)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
	}
}

export class MemoryJournal implements Journal {
	records: JournalRecord[];
	constructor(records: JournalRecord[] = []) {
		this.records = records;
	}
	async load(): Promise<JournalRecord[]> {
		return [...this.records];
	}
	async append(record: JournalRecord): Promise<void> {
		this.records.push(record);
	}
}

function validateBatch(record: Extract<JournalRecord, { type: "inbound_batch" }>): void {
	const count = record.memberJobIds.length;
	const openedAt = new Date(record.openedAt).valueOf(); const readyAt = new Date(record.readyAt).valueOf();
	if (record.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(record.batchId) || !Number.isSafeInteger(record.revision) || record.revision < 1 || !["open", "sealed", "dispatching"].includes(record.state) || count < 1 || count > 100 || new Set(record.memberJobIds).size !== count || record.memberJobIds.some((id) => typeof id !== "string" || !id) || record.messageIds.length !== count || new Set(record.messageIds).size !== count || record.messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || record.segmentSha256.length !== count || record.boundaries.length !== count || !record.text || !Number.isFinite(openedAt) || !Number.isFinite(readyAt) || readyAt < openedAt || record.finalMessageId !== record.messageIds.at(-1)) throw new StateCorruptionError("Inbound batch record is invalid");
	let cursor = 0;
	for (let index = 0; index < count; index++) {
		const boundary = record.boundaries[index];
		if (!boundary || boundary.start !== cursor || boundary.end < boundary.start || boundary.end > record.text.length || !/^[0-9a-f]{64}$/.test(record.segmentSha256[index]!) || sha256(record.text.slice(boundary.start, boundary.end)) !== record.segmentSha256[index]) throw new StateCorruptionError("Inbound batch segment provenance is invalid");
		if (index + 1 < count && record.text.slice(boundary.end, boundary.end + 2) !== "\n\n") throw new StateCorruptionError("Inbound batch separator is invalid");
		cursor = boundary.end + (index + 1 < count ? 2 : 0);
	}
	if (cursor !== record.text.length) throw new StateCorruptionError("Inbound batch boundaries are invalid");
}

export function recover(records: JournalRecord[], now = Date.now()): Recovery {
	const updates: Job[] = [];
	const capturedInboundJobs = new Set(records.filter((record): record is Extract<JournalRecord, { type: "media_captured" }> => record.type === "media_captured" && record.direction === "in").map((record) => record.jobId));
	const requested = new Set<string>();
	const dispatched = new Set<string>();
	const commandsStarted = new Set<string>();
	const interrupted = new Set<string>();
	const sent = new Set<string>();
	const ready = new Map<string, string>();
	const activities = new Map<string, { jobId: string; messageId: string }>();
	const batches = new Map<string, Extract<JournalRecord, { type: "inbound_batch" }>>();
	let cursor: number | undefined;
	for (const record of records) {
		if (record.type === "update") {
			cursor = record.updateId;
			if (
				record.disposition === "accepted" &&
				record.jobId &&
				record.messageId !== undefined &&
				record.text !== undefined
			) {
				updates.push({
					jobId: record.jobId,
					updateId: record.updateId,
					messageId: record.messageId,
					text: record.text,
					telegramDate: record.telegramDate,
					images: record.images ?? [],
					captureRequired: record.schemaVersion === 3 && Boolean(record.images?.length),
					command: record.command,
				});
			}
		} else if (record.type === "inbound_batch") {
			validateBatch(record);
			const previous = batches.get(record.batchId);
			if (previous) {
				const priorMembers = record.memberJobIds.slice(0, previous.memberJobIds.length);
				const transition = `${previous.state}->${record.state}`;
				if (record.revision !== previous.revision + 1 || record.openedAt !== previous.openedAt || !["open->open", "open->sealed", "open->dispatching", "sealed->dispatching"].includes(transition) || JSON.stringify(priorMembers) !== JSON.stringify(previous.memberJobIds) || JSON.stringify(record.messageIds.slice(0, previous.messageIds.length)) !== JSON.stringify(previous.messageIds) || JSON.stringify(record.segmentSha256.slice(0, previous.segmentSha256.length)) !== JSON.stringify(previous.segmentSha256) || JSON.stringify(record.boundaries.slice(0, previous.boundaries.length)) !== JSON.stringify(previous.boundaries) || !record.text.startsWith(previous.text) || (record.state !== "open" && record.memberJobIds.length !== previous.memberJobIds.length)) throw new StateCorruptionError("Inbound batch revision transition is invalid");
			}
			batches.set(record.batchId, record);
		} else if (record.type === "dispatch_requested") requested.add(record.jobId);
		else if (record.type === "dispatched") dispatched.add(record.jobId);
		else if (record.type === "command_started") commandsStarted.add(record.jobId);
		else if (record.type === "reply_ready") ready.set(record.jobId, record.text);
		else if (record.type === "reply_sent") sent.add(record.jobId);
		else if (record.type === "activity_started") activities.set(`${record.jobId}:${record.messageId}`, record);
		else if (record.type === "activity_cleared") activities.delete(`${record.jobId}:${record.messageId}`);
		else if (record.type === "interrupted") interrupted.add(record.jobId);
	}
	const memberJobIds = new Set([...batches.values()].flatMap((batch) => batch.memberJobIds));
	const updateByJobId = new Map(updates.map((job) => [job.jobId, job]));
	const recoverableBatches = [...batches.values()].filter((batch) => {
		if (sent.has(batch.batchId)) return true;
		const sentMembers = batch.memberJobIds.filter((jobId) => sent.has(jobId)).length;
		if (sentMembers === 0) return true;
		if (sentMembers === batch.memberJobIds.length) return false;
		throw new StateCorruptionError("Inbound batch has partially terminal legacy members");
	});
	const batchJobs: Job[] = recoverableBatches.filter((batch) => batch.state !== "open" || new Date(batch.readyAt).valueOf() <= now).map((batch) => ({ jobId: batch.batchId, batchId: batch.batchId, updateId: updateByJobId.get(batch.memberJobIds[0]!)?.updateId ?? 0, messageId: batch.finalMessageId, text: batch.text, images: [], memberJobIds: batch.memberJobIds, messageIds: batch.messageIds, segmentSha256: batch.segmentSha256, boundaries: batch.boundaries }));
	const unsent = [...updates.filter((job) => !memberJobIds.has(job.jobId)), ...batchJobs].filter((job) => !sent.has(job.jobId) && (job.images.length === 0 || job.captureRequired || capturedInboundJobs.has(job.jobId))).sort((a, b) => a.updateId - b.updateId);
	const actionable = unsent.filter((job) => !interrupted.has(job.jobId));
	const prompts = actionable.filter((job) => !job.command);
	const commands = actionable.filter((job) => job.command);
	return {
		cursor,
		queued: prompts.filter(
			(job) => !requested.has(job.jobId) && !dispatched.has(job.jobId) && !ready.has(job.jobId),
		),
		uncertain: prompts.filter(
			(job) => (requested.has(job.jobId) || dispatched.has(job.jobId)) && !ready.has(job.jobId),
		),
		pendingCommands: commands.filter((job) => !commandsStarted.has(job.jobId) && !ready.has(job.jobId)),
		uncertainCommands: commands.filter((job) => commandsStarted.has(job.jobId) && !ready.has(job.jobId)),
		repliesToRetry: unsent
			.filter((job) => ready.has(job.jobId))
			.map((job) => ({ ...job, reply: ready.get(job.jobId) as string })),
		orphanedActivities: [...activities.values()],
	};
}

export function splitPlainText(text: string, limit = 4_000): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const window = remaining.slice(0, limit + 1);
		let split = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
		if (split < Math.floor(limit * 0.6)) split = limit;
		chunks.push(remaining.slice(0, split));
		remaining = remaining.slice(split).trimStart();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export class TelegramOwnerBridge {
	private records: JournalRecord[] = [];
	private active?: Job;
	private dispatchConfirmed = false;
	private sawOwnInput = false;
	private assistantText?: string;
	private stopped = false;
	private appendTail: Promise<void> = Promise.resolve();

	private readonly journal: Journal;
	private readonly ownerUserId: number;
	private readonly privateChatId: number;
	private readonly formattedDelivery: boolean;
	private readonly inboundQuietWindowMs: number;
	private readonly now: () => number;

	constructor(journal: Journal, ownerUserId: number, privateChatId: number, options: TelegramBridgeOptions = {}) {
		this.journal = journal;
		this.ownerUserId = ownerUserId;
		this.privateChatId = privateChatId;
		this.formattedDelivery = options.formattedDelivery === true;
		this.inboundQuietWindowMs = options.inboundQuietWindowMs ?? DEFAULT_INBOUND_QUIET_WINDOW_MS;
		if (!Number.isSafeInteger(this.inboundQuietWindowMs) || (this.inboundQuietWindowMs !== 0 && this.inboundQuietWindowMs < MIN_INBOUND_QUIET_WINDOW_MS) || this.inboundQuietWindowMs > MAX_INBOUND_QUIET_WINDOW_MS) throw new StateCorruptionError("Inbound quiet window is out of bounds");
		this.now = options.now ?? Date.now;
	}

	async initialize(): Promise<Recovery> {
		this.records = await this.journal.load();
		validateMediaLifecycle(this.records);
		return recover(this.records, this.now());
	}

	get activeJob(): Job | undefined {
		return this.active;
	}

	get marker(): string | undefined {
		return this.active ? this.active.batchId ? `[telegram-batch:${this.active.batchId}]` : `[telegram-job:${this.active.jobId}]` : undefined;
	}

	get nextBatchReadyDelayMs(): number | undefined {
		const open = [...this.latestBatchRecords().values()].filter((batch) => batch.state === "open").sort((a, b) => new Date(a.readyAt).valueOf() - new Date(b.readyAt).valueOf())[0];
		return open ? Math.max(0, new Date(open.readyAt).valueOf() - this.now()) : undefined;
	}

	get queueDepth(): number {
		return recover(this.records, this.now()).queued.length;
	}

	get pendingReplyCount(): number {
		return recover(this.records, this.now()).repliesToRetry.length;
	}

	get pendingCommands(): Job[] {
		return recover(this.records, this.now()).pendingCommands;
	}

	get uncertainCommands(): Job[] {
		return recover(this.records, this.now()).uncertainCommands;
	}

	get cursor(): number | undefined {
		return recover(this.records, this.now()).cursor;
	}

	get orphanedActivities(): Array<{ jobId: string; messageId: string }> {
		return recover(this.records, this.now()).orphanedActivities;
	}

	get status(): "idle" | "dispatch-unconfirmed" | "running" | "stopped" {
		if (this.stopped) return "stopped";
		if (!this.active) return "idle";
		return this.dispatchConfirmed ? "running" : "dispatch-unconfirmed";
	}

	get journalRecords(): readonly JournalRecord[] {
		return this.records;
	}

	appendArchiveRecord(record: Extract<JournalRecord, { type: "projection_needed" | "projection_committed" | "projection_deferred" }>): Promise<void> {
		return this.append(record);
	}

	private append(record: JournalRecord): Promise<void> {
		const result = this.appendTail.then(async () => {
			await this.journal.append(record);
			this.records.push(record);
		});
		this.appendTail = result.catch(() => undefined);
		return result;
	}

	private latestBatchRecords(): Map<string, Extract<JournalRecord, { type: "inbound_batch" }>> {
		const latest = new Map<string, Extract<JournalRecord, { type: "inbound_batch" }>>();
		for (const record of this.records) if (record.type === "inbound_batch") latest.set(record.batchId, record);
		return latest;
	}

	private latestBatch(batchId: string): Extract<JournalRecord, { type: "inbound_batch" }> | undefined {
		return this.latestBatchRecords().get(batchId);
	}

	private latestOpenBatch(): Extract<JournalRecord, { type: "inbound_batch" }> | undefined {
		return [...this.latestBatchRecords().values()].reverse().find((batch) => batch.state === "open");
	}

	private async sealOpenBatch(): Promise<void> {
		const open = this.latestOpenBatch();
		if (open) await this.append({ ...open, revision: open.revision + 1, state: "sealed" });
	}

	async sealReadyBatches(): Promise<number> {
		const ready = [...this.latestBatchRecords().values()].filter((batch) => batch.state === "open" && new Date(batch.readyAt).valueOf() <= this.now()).sort((a, b) => new Date(a.readyAt).valueOf() - new Date(b.readyAt).valueOf());
		for (const batch of ready) await this.append({ ...batch, revision: batch.revision + 1, state: "sealed" });
		return ready.length;
	}

	private updateForJob(jobId: string): Extract<JournalRecord, { type: "update" }> | undefined {
		return [...this.records].reverse().find((record): record is Extract<JournalRecord, { type: "update" }> => record.type === "update" && record.jobId === jobId);
	}

	private async addTextToBatch(job: Job): Promise<void> {
		const now = this.now();
		let open = this.latestOpenBatch();
		if (open) {
			const previousJobId = open.memberJobIds.at(-1);
			const previousUpdate = previousJobId ? this.updateForJob(previousJobId) : undefined;
			const sameTelegramDate = previousUpdate?.telegramDate !== undefined
				&& job.telegramDate !== undefined
				&& previousUpdate.telegramDate === job.telegramDate;
			if (!sameTelegramDate || now >= new Date(open.readyAt).valueOf()) {
				await this.sealOpenBatch();
				open = undefined;
			}
		}
		const readyAt = new Date(now + this.inboundQuietWindowMs).toISOString();
		if (!open) {
			await this.append({ type: "inbound_batch", schemaVersion: 1, batchId: randomUUID(), revision: 1, state: "open", openedAt: new Date(now).toISOString(), readyAt, memberJobIds: [job.jobId], messageIds: [job.messageId], segmentSha256: [sha256(job.text)], boundaries: [{ start: 0, end: job.text.length }], text: job.text, finalMessageId: job.messageId });
			return;
		}
		const start = open.text.length + 2;
		await this.append({ ...open, revision: open.revision + 1, readyAt, memberJobIds: [...open.memberJobIds, job.jobId], messageIds: [...open.messageIds, job.messageId], segmentSha256: [...open.segmentSha256, sha256(job.text)], boundaries: [...open.boundaries, { start, end: start + job.text.length }], text: `${open.text}\n\n${job.text}`, finalMessageId: job.messageId });
	}

	async ingestBatch(updates: TelegramUpdate[]): Promise<Recovery & { acceptedModelInput: boolean; acceptedModelInputCount: number }> {
		const seen = new Set(this.records.filter((r) => r.type === "update").map((r) => r.updateId));
		let acceptedModelInputCount = 0;
		for (const update of updates) {
			if (seen.has(update.update_id)) continue;
			const message = update.message;
			let disposition: UpdateDisposition;
			let image: TelegramImageRef | undefined;
			if (
				message &&
				message.chat.type === "private" &&
				message.chat.id === this.privateChatId &&
				message.from?.id === this.ownerUserId
			) {
				image = imageFromMessage(message);
				const hasText = Boolean(message.text?.trim());
				disposition = hasText || image ? "accepted" : "unsupported";
			} else {
				disposition = message ? "unauthorized" : "unsupported";
			}
			const accepted = disposition === "accepted";
			const text = message?.text?.trim() || message?.caption?.trim() || "Please analyze this image.";
			const parsedCommand = accepted ? parseTelegramOwnerCommand(text) : undefined;
			const jobId = accepted ? randomUUID() : undefined;
			const command = parsedCommand?.kind === "known" ? parsedCommand.name : parsedCommand ? "unknown" as const : undefined;
			await this.append({ type: "update", schemaVersion: accepted && image ? 3 : 2, updateId: update.update_id, disposition, timestamp: new Date(this.now()).toISOString(), ...(accepted ? { jobId, messageId: message!.message_id, chatId: message!.chat.id, userId: message!.from!.id, text, rawText: message?.text ?? message?.caption ?? "", telegramDate: message?.date, telegramEditDate: message?.edit_date, entities: message?.entities ?? message?.caption_entities, images: image ? [image] : [], command } : {}) });
			if (accepted) {
				const job: Job = { jobId: jobId!, updateId: update.update_id, messageId: message!.message_id, text, telegramDate: message!.date, images: image ? [image] : [], command };
				if (!command) acceptedModelInputCount += 1;
				if (!command && !image && Boolean(message?.text?.trim()) && this.inboundQuietWindowMs > 0) await this.addTextToBatch(job);
				else await this.sealOpenBatch();
			}
			seen.add(update.update_id);
		}
		return { ...recover(this.records, this.now()), acceptedModelInput: acceptedModelInputCount > 0, acceptedModelInputCount };
	}

	pendingInboundMediaJobs(): Job[] {
		const captures = new Map(this.records.filter((record): record is Extract<JournalRecord, { type: "media_captured" }> => record.type === "media_captured" && record.direction === "in").map((record) => [record.jobId, record]));
		return this.records.filter((record): record is Extract<JournalRecord, { type: "update" }> => record.type === "update" && record.schemaVersion === 3 && record.disposition === "accepted" && Boolean(record.jobId && record.messageId && record.text && record.images?.length) && !captures.has(record.jobId!)).map((record) => ({ jobId: record.jobId!, updateId: record.updateId, messageId: record.messageId!, text: record.text!, telegramDate: record.telegramDate, images: record.images!, command: record.command }));
	}

	private capturedMedia(jobId: string, direction: "in" | "out"): Extract<JournalRecord, { type: "media_captured" }>[] {
		return this.records.filter((record): record is Extract<JournalRecord, { type: "media_captured" }> => record.type === "media_captured" && record.jobId === jobId && record.direction === direction);
	}

	async recordInboundMedia(job: Job, captured: readonly ResolvedArchivedImage[]): Promise<void> {
		const existing = new Set(this.capturedMedia(job.jobId, "in").map((record) => record.mediaId));
		for (let index = 0; index < captured.length; index++) {
			const item = captured[index]!;
			const source = job.images[index];
			const mediaId = `in:${job.jobId}:${index}:${item.attachment.sha256}`;
			if (existing.has(mediaId)) continue;
			await this.append({ type: "media_captured", schemaVersion: 1, mediaId, jobId: job.jobId, direction: "in", attachment: item.attachment, telegram: { updateId: job.updateId, messageId: job.messageId, ...(source ? { fileId: source.fileId } : {}) }, timestamp: new Date(this.now()).toISOString() });
		}
	}

	equivalentOutboundPhoto(attachment: ArchivedTelegramAttachment, caption: string | undefined, replyToMessageId: number): { plan: Extract<JournalRecord, { type: "photo_send_planned" }>; receipt?: Extract<JournalRecord, { type: "photo_sent" }> } | undefined {
		const deliveryKey = outboundPhotoDeliveryKey(attachment, caption, replyToMessageId);
		const plan = this.records.find((record): record is Extract<JournalRecord, { type: "photo_send_planned" }> => record.type === "photo_send_planned" && record.deliveryKey === deliveryKey);
		return plan ? { plan, receipt: this.outboundPhotoReceipt(plan.photoId) } : undefined;
	}

	async planOutboundPhoto(photoId: string, job: Job, caption: string | undefined, attachment: ArchivedTelegramAttachment): Promise<Extract<JournalRecord, { type: "photo_send_planned" }>> {
		const plans = this.records.filter((record): record is Extract<JournalRecord, { type: "photo_send_planned" }> => record.type === "photo_send_planned" && record.photoId === photoId);
		if (plans.length > 1) throw new StateCorruptionError("Outbound photo has duplicate plans");
		const planned: Extract<JournalRecord, { type: "photo_send_planned" }> = { type: "photo_send_planned", schemaVersion: 1, photoId, deliveryKey: outboundPhotoDeliveryKey(attachment, caption, job.messageId), jobId: job.jobId, caption: caption ?? "", replyToMessageId: job.messageId, attachment, timestamp: new Date(this.now()).toISOString() };
		if (plans[0]) {
			const { timestamp: _existingTimestamp, ...existingIdentity } = plans[0];
			const { timestamp: _plannedTimestamp, ...plannedIdentity } = planned;
			if (JSON.stringify(existingIdentity) !== JSON.stringify(plannedIdentity)) throw new StateCorruptionError("Outbound photo plan identity changed");
			return plans[0];
		}
		const mediaId = `out:${photoId}:${attachment.sha256}`;
		const capture = this.records.find((record): record is Extract<JournalRecord, { type: "media_captured" }> => record.type === "media_captured" && record.mediaId === mediaId);
		if (capture && (capture.jobId !== job.jobId || JSON.stringify(capture.attachment) !== JSON.stringify(attachment))) throw new StateCorruptionError("Outbound photo media capture identity changed");
		if (!capture) await this.append({ type: "media_captured", schemaVersion: 1, mediaId, jobId: job.jobId, direction: "out", attachment, telegram: {}, timestamp: planned.timestamp });
		await this.append(planned);
		return planned;
	}

	outboundPhotoPlan(photoId: string): Extract<JournalRecord, { type: "photo_send_planned" }> | undefined {
		const plans = this.records.filter((record): record is Extract<JournalRecord, { type: "photo_send_planned" }> => record.type === "photo_send_planned" && record.photoId === photoId);
		if (plans.length > 1) throw new StateCorruptionError("Outbound photo has duplicate plans");
		return plans[0];
	}

	outboundPhotoReceipt(photoId: string): Extract<JournalRecord, { type: "photo_sent" }> | undefined {
		const receipts = this.records.filter((record): record is Extract<JournalRecord, { type: "photo_sent" }> => record.type === "photo_sent" && record.photoId === photoId);
		if (receipts.length > 1) throw new StateCorruptionError("Outbound photo has duplicate receipts");
		return receipts[0];
	}

	async recordOutboundPhotoSent(photoId: string, jobId: string, messageId: string): Promise<void> {
		if (!/^[1-9][0-9]*$/.test(messageId)) throw new StateCorruptionError("Telegram returned an invalid photo message ID");
		const existing = this.outboundPhotoReceipt(photoId);
		if (existing) {
			if (existing.jobId !== jobId || existing.messageId !== messageId) throw new StateCorruptionError("Outbound photo receipt identity changed");
			return;
		}
		await this.append({ type: "photo_sent", schemaVersion: 1, photoId, jobId, messageId, timestamp: new Date(this.now()).toISOString() });
	}

	async startCommand(job: Job): Promise<void> {
		if (!job.command) throw new Error("Cannot start a non-command Telegram job");
		await this.append({ type: "command_started", jobId: job.jobId, command: job.command });
	}

	async completeCommand(job: Job, text: string): Promise<void> {
		if (!job.command) throw new Error("Cannot complete a non-command Telegram job");
		await this.append({ type: "reply_ready", jobId: job.jobId, text });
	}

	async interruptCommand(job: Job, reason: string, notice: string): Promise<void> {
		if (!job.command) throw new Error("Cannot interrupt a non-command Telegram job");
		await this.append({ type: "interrupted", jobId: job.jobId, reason });
		await this.append({ type: "reply_ready", jobId: job.jobId, text: notice });
	}

	async interruptActive(reason: string, notice: string): Promise<Job | undefined> {
		if (!this.active) return undefined;
		const job = this.active;
		await this.append({ type: "interrupted", jobId: job.jobId, reason });
		await this.append({ type: "reply_ready", jobId: job.jobId, text: notice });
		this.active = undefined;
		this.dispatchConfirmed = false;
		this.sawOwnInput = false;
		this.assistantText = undefined;
		return job;
	}

	async recordActivityStarted(jobId: string, messageId: string): Promise<void> {
		await this.append({ type: "activity_started", jobId, messageId });
	}

	async recordActivityCleared(jobId: string, messageId: string): Promise<void> {
		await this.append({ type: "activity_cleared", jobId, messageId });
	}

	private openActivities(): Array<{ jobId: string; messageId: string }> {
		const open = new Map<string, { jobId: string; messageId: string }>();
		for (const record of this.records) {
			if (record.type === "activity_started") open.set(`${record.jobId}:${record.messageId}`, { jobId: record.jobId, messageId: record.messageId });
			else if (record.type === "activity_cleared") open.delete(`${record.jobId}:${record.messageId}`);
		}
		return [...open.values()];
	}

	/** The open activity or queued-notice message for a job, if any. */
	openActivity(jobId: string): string | undefined {
		return this.openActivities().find((activity) => activity.jobId === jobId)?.messageId;
	}

	/** Open activities whose job no longer needs them: its reply was sent, or it ended without one. */
	finishedActivities(): Array<{ jobId: string; messageId: string }> {
		const sent = new Set<string>();
		const ready = new Set<string>();
		const interrupted = new Set<string>();
		for (const record of this.records) {
			if (record.type === "reply_sent") sent.add(record.jobId);
			else if (record.type === "reply_ready") ready.add(record.jobId);
			else if (record.type === "interrupted") interrupted.add(record.jobId);
		}
		return this.openActivities().filter((activity) => sent.has(activity.jobId) || (interrupted.has(activity.jobId) && !ready.has(activity.jobId)));
	}

	/** Queued jobs waiting behind other work that have no queued notice yet, with their queue position. */
	jobsAwaitingQueuedNotice(): Array<{ job: Job; position: number }> {
		const noticed = new Set(this.openActivities().map((activity) => activity.jobId));
		return recover(this.records, this.now()).queued
			.map((job, position) => ({ job, position }))
			.filter(({ job }) => job.jobId !== this.active?.jobId && !noticed.has(job.jobId));
	}

	async interruptUncertain(reason: string, notice?: string): Promise<Job[]> {
		const uncertain = recover(this.records, this.now()).uncertain;
		for (const job of uncertain) {
			await this.append({ type: "interrupted", jobId: job.jobId, reason });
			if (notice) await this.append({ type: "reply_ready", jobId: job.jobId, text: notice });
		}
		return uncertain;
	}

	private replyAnchorRejected(jobId: string): boolean {
		const records = this.records.filter((record): record is Extract<JournalRecord, { type: "reply_anchor_rejected" }> => record.type === "reply_anchor_rejected" && record.jobId === jobId);
		if (records.length > 1 || records.some((record) => record.index !== 0 || record.code !== "REPLY_TARGET_MISSING")) throw new StateCorruptionError("Reply anchor rejection receipt is invalid");
		return records.length === 1;
	}

	private async sendWithAnchorRecovery(job: Job, text: string, format: "HTML" | "plain" | undefined, send: SendReply): Promise<string> {
		if (this.replyAnchorRejected(job.jobId)) return send(text, undefined, format);
		try {
			return await send(text, job.messageId, format);
		} catch (error) {
			if (!isReplyAnchorRejection(error)) throw error;
			await this.append({ type: "reply_anchor_rejected", jobId: job.jobId, index: 0, code: "REPLY_TARGET_MISSING", timestamp: new Date().toISOString() });
			return send(text, undefined, format);
		}
	}

	private async deliverLegacy(job: Job, text: string, send: SendReply): Promise<void> {
		let firstId = "";
		for (const [index, chunk] of splitPlainText(text).entries()) {
			const id = index === 0 ? await this.sendWithAnchorRecovery(job, chunk, undefined, send) : await send(chunk);
			if (!firstId) firstId = id;
		}
		await this.append({ type: "reply_sent", jobId: job.jobId, messageId: firstId });
	}

	private async deliverPlan(job: Job, text: string, send: SendReply): Promise<void> {
		const plans = this.records.filter((record): record is Extract<JournalRecord, { type: "reply_plan" }> => record.type === "reply_plan" && record.jobId === job.jobId);
		if (plans.length > 1) throw new StateCorruptionError("Reply job has duplicate durable plans");
		let planRecord = plans[0];
		if (!planRecord) {
			if (!this.formattedDelivery) return this.deliverLegacy(job, text, send);
			planRecord = journalPlan(job.jobId, text, createTelegramTransportPlan(text));
			validateJournalPlan(planRecord, text);
			await this.append(planRecord);
		} else validateJournalPlan(planRecord, text);
		const receipts = new Map<number, Extract<JournalRecord, { type: "reply_chunk_sent" }>>();
		for (const record of this.records.filter((candidate): candidate is Extract<JournalRecord, { type: "reply_chunk_sent" }> => candidate.type === "reply_chunk_sent" && candidate.jobId === job.jobId)) {
			if (!Number.isSafeInteger(record.index) || record.index < 0 || record.index >= planRecord.chunks.length || receipts.has(record.index) || !/^[1-9][0-9]*$/.test(record.messageId) || (record.format !== "HTML" && record.format !== "plain")) throw new StateCorruptionError("Reply chunk receipt is invalid");
			receipts.set(record.index, record);
		}
		const rejected = new Set<number>();
		for (const record of this.records.filter((candidate): candidate is Extract<JournalRecord, { type: "reply_chunk_rejected" }> => candidate.type === "reply_chunk_rejected" && candidate.jobId === job.jobId)) {
			if (!Number.isSafeInteger(record.index) || record.index < 0 || record.index >= planRecord.chunks.length || planRecord.chunks[record.index]?.format !== "HTML" || rejected.has(record.index)) throw new StateCorruptionError("Reply rejection receipt is invalid");
			rejected.add(record.index);
		}
		for (const chunk of planRecord.chunks) {
			if (receipts.has(chunk.index)) continue;
			let format = rejected.has(chunk.index) ? "plain" as const : chunk.format;
			let id: string;
			try {
				id = chunk.index === 0
					? await this.sendWithAnchorRecovery(job, format === "HTML" ? chunk.payload : chunk.plainFallback, format, send)
					: await send(format === "HTML" ? chunk.payload : chunk.plainFallback, undefined, format);
			} catch (error) {
				if (format !== "HTML" || !isHtmlRejection(error)) throw error;
				await this.append({ type: "reply_chunk_rejected", jobId: job.jobId, index: chunk.index, code: "HTML_REJECTED", timestamp: new Date().toISOString() });
				rejected.add(chunk.index);
				format = "plain";
				id = chunk.index === 0
					? await this.sendWithAnchorRecovery(job, chunk.plainFallback, format, send)
					: await send(chunk.plainFallback, undefined, format);
			}
			if (!/^[1-9][0-9]*$/.test(id)) throw new StateCorruptionError("Telegram returned an invalid message ID");
			const receipt = { type: "reply_chunk_sent" as const, jobId: job.jobId, index: chunk.index, messageId: id, format, timestamp: new Date().toISOString() };
			await this.append(receipt);
			receipts.set(chunk.index, receipt);
		}
		const messageIds = planRecord.chunks.map((chunk) => receipts.get(chunk.index)?.messageId);
		if (messageIds.some((id) => id === undefined)) throw new StateCorruptionError("Reply plan is missing a durable chunk receipt");
		await this.append({ type: "reply_sent", jobId: job.jobId, messageIds: messageIds as string[], timestamp: new Date().toISOString() });
	}

	async retryReadyReplies(send: SendReply): Promise<number> {
		const retries = recover(this.records, this.now()).repliesToRetry;
		for (const job of retries) await this.deliverPlan(job, job.reply, send);
		return retries.length;
	}

	async dispatchNext(
		sessionId: string,
		sendUserMessage: (text: string, images?: ResolvedImage[]) => void,
		resolveImages?: (images: TelegramImageRef[], archived: readonly ArchivedTelegramAttachment[]) => Promise<ResolvedArchivedImage[]>,
	): Promise<Job | undefined> {
		if (this.active || this.stopped) return undefined;
		await this.sealReadyBatches();
		const job = recover(this.records, this.now()).queued[0];
		if (!job) return undefined;
		const archived = this.capturedMedia(job.jobId, "in").map((record) => record.attachment);
		const captured = job.images.length ? await resolveImages?.(job.images, archived) : undefined;
		if (job.images.length && !captured) throw new Error("No Telegram image resolver configured");
		if (captured) await this.recordInboundMedia(job, captured);
		const images = captured?.map((item) => item.image);
		this.active = job;
		this.dispatchConfirmed = false;
		this.sawOwnInput = false;
		this.assistantText = undefined;
		if (job.batchId) {
			const batch = this.latestBatch(job.batchId);
			if (!batch) throw new StateCorruptionError("Dispatch batch is missing");
			if (batch.state !== "dispatching") await this.append({ ...batch, revision: batch.revision + 1, state: "dispatching" });
		}
		await this.append({ type: "dispatch_requested", jobId: job.jobId, sessionId });
		sendUserMessage(`${this.marker}\n${job.text}`, images);
		return job;
	}

	observeInput(source: string, text: string): "continue" | "handled" {
		if (!this.active) return "continue";
		if (source === "extension" && text.startsWith(`${this.marker}\n`)) this.sawOwnInput = true;
		if (source === "interactive") return "handled";
		return "continue";
	}

	async beforeAgentStart(prompt: string, sessionId: string): Promise<boolean> {
		if (this.dispatchConfirmed || !this.active || !this.sawOwnInput || !prompt.startsWith(`${this.marker}\n`)) return false;
		await this.append({ type: "dispatched", jobId: this.active.jobId, sessionId });
		this.dispatchConfirmed = true;
		return true;
	}

	captureAgentEnd(text: string | undefined): void {
		if (this.dispatchConfirmed && text) this.assistantText = text;
	}

	async settle(send: SendReply): Promise<boolean> {
		if (!this.active || !this.dispatchConfirmed || this.assistantText === undefined) return false;
		const job = this.active;
		const text = this.assistantText;
		await this.append({ type: "reply_ready", jobId: job.jobId, text, timestamp: new Date().toISOString() });
		// The durable ready reply is retried by retryReadyReplies if delivery
		// fails, so the job no longer holds the queue.
		this.active = undefined;
		this.dispatchConfirmed = false;
		this.assistantText = undefined;
		await this.deliverPlan(job, text, send);
		return true;
	}

	async shutdown(reason: string): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.active) {
			const hasReadyReply = this.records.some(
				(record) => record.type === "reply_ready" && record.jobId === this.active?.jobId,
			);
			if (!hasReadyReply) await this.append({ type: "interrupted", jobId: this.active.jobId, reason });
		}
		this.active = undefined;
	}
}

export function extractAssistantText(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const text = message.content
				.filter((part): part is { type: "text"; text: string } =>
					Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"),
				)
				.map((part) => part.text)
				.join("");
			if (text) return text;
		}
	}
	return undefined;
}
