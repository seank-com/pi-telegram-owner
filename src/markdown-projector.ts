import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { PollerLock, systemBootIdentity, systemPidState, type BootIdentity, type PidState } from "./runtime.ts";

import { MAX_IMAGE_BYTES, renderWorkItemPrompt, validateMediaLifecycle, WORK_ITEM_MARKER_PREFIX, type ArchivedTelegramAttachment, type JournalRecord, type ResolvedImage, type WorkItem } from "./core.ts";

export interface TelegramMarkdownProjectorConfig {
	enabled: true;
	root: string;
	sessionRoot?: string;
	rootId: string;
	roleSlugs?: { user: string; assistant: string; command: string };
}

export interface ProjectionResult {
	projected: number;
	unchanged: number;
	deferred: number;
}

export interface MarkdownImportItem {
	recordId?: string;
	messageId: string | null;
	identityKind: "telegram-export-history" | "pi-session-entry" | "telegram-export-gap";
	direction: "in" | "out";
	markdown: string;
	occurredAt: string;
	confidence: "historical-html-sequence" | "exact-pi" | "unresolved-html";
	exportStatus?: "historical-authority" | "present" | "missing" | "unresolved";
	html?: { page: string; globalMessageOrdinal: number; pageSha256: string; sourceRange?: Record<string, number>; sourceTextSha256?: string };
	htmlSegments?: Array<{ page: string; globalMessageOrdinal: number; pageSha256: string; sourceRange: Record<string, number>; sourceTextSha256: string }>;
	gap?: { kind: "html-unresolved" | "html-ambiguous"; startHtmlOrdinal: number; endHtmlOrdinal: number; sources: Array<{ page: string; pageSha256: string; globalMessageOrdinal: number; compatibilityKeySha256: string; sourceRange: Record<string, number>; attachmentSha256: string[] }> };
	pi?: { sessionId: string; entryId: string; sourceRootId: string; sourcePath: string; entryLine: number; entryByteOffset: number; entryByteLength: number; entrySha256: string };
	attachments: Array<{ sourcePath: string; sha256: string; mimeType: string; size: number }>;
}

export interface MarkdownImportBinding {
	sourceSetId: string;
	sourceSetManifestSha256: string;
	speakerMapRevision: number;
	boundaryManifestSha256: string;
}

export interface PublicationResult { published: number; unchanged: number; attachments: number; mediaEvents: number; }

export type TelegramMediaEvent = {
	schema: "pi-telegram-owner/media-event/v1";
	eventId: string;
	direction: "in" | "out";
	source: "live" | "telegram-desktop-import";
	attachment: ArchivedTelegramAttachment;
	occurredAt: string;
	provenance:
		| { kind: "live-inbound"; jobId: string; updateId: number; messageId: number; fileId: string; imageIndex: number }
		| { kind: "live-outbound"; photoId: string; jobId: string; deliveryKey: string; replyToMessageId: number; telegramMessageId: string }
		| { kind: "desktop-import"; sourceSetId: string; sourceSetManifestSha256: string; boundaryManifestSha256: string; speakerMapRevision: number; recordId: string; messageId: string | null; attachmentIndex: number; page: string | null; globalMessageOrdinal: number | null; pageSha256: string | null };
};

export interface TelegramTimelineInput {
	operation: "recent" | "range" | "count";
	start?: string;
	end?: string;
	direction?: "in" | "out" | "both";
	unit?: "messages" | "exchanges";
	order?: "asc" | "desc";
	limit?: number;
}

export interface TelegramTimelineMessage {
	messageId: string;
	occurredAt: string;
	direction: "in" | "out";
	role: "user" | "assistant" | "telegram-command" | "gap";
	path: string;
	content: string;
	truncated: boolean;
}

export interface TelegramTimelineExchange { request: TelegramTimelineMessage; responses: TelegramTimelineMessage[]; }
export interface TelegramTimelineResult {
	operation: "recent" | "range" | "count";
	unit: "messages" | "exchanges";
	direction: "in" | "out" | "both";
	order: "asc" | "desc";
	timezone: "UTC";
	range: { start: string | null; end: string };
	count: number;
	messages?: TelegramTimelineMessage[];
	exchanges?: TelegramTimelineExchange[];
}

interface ImportProvenance {
	source: "telegram-desktop-historical-export" | "telegram-desktop-html-pi" | "pi-session-export-missing" | "telegram-desktop-gap";
	sourceSetId: string;
	sourceSetManifestSha256: string;
	page: string | null;
	globalMessageOrdinal: number | null;
	pageSha256: string | null;
	speakerMapRevision: number;
	boundaryManifestSha256: string;
	confidence: "historical-html-sequence" | "exact-pi" | "unresolved-html";
	sourceRange?: Record<string, number>;
	sourceTextSha256?: string;
	segments?: Array<{ page: string; globalMessageOrdinal: number; pageSha256: string; sourceRange: Record<string, number>; sourceTextSha256: string }>;
}

interface ManifestEntry {
	path: string;
	predecessor: string | null;
	contentRevision: number;
	contentSha256: string;
	metadataRevision: number;
	metadataSha256: string;
	import?: ImportProvenance;
}

interface ArchiveManifest {
	schema: "pi-telegram-owner/archive-manifest/v1";
	generation: number;
	lastMessageId: string | null;
	messages: Record<string, ManifestEntry>;
}

interface Candidate {
	jobId: string;
	direction: "in" | "out";
	identityKind: "pi-session-entry" | "telegram-job-local-response" | "telegram-live-photo" | "telegram-export-history" | "telegram-export-gap";
	messageId: string;
	canonicalMessageId?: string | null;
	body: string;
	role: "user" | "assistant" | "telegram-command" | "gap";
	occurredAt: string;
	observedAt: string;
	updateId: number | null;
	telegramMessageIds: string[];
	sessionId: string | null;
	sessionEntryId: string | null;
	sessionPath: string | null;
	sessionEntrySha256: string | null;
	sessionEntryLine: number | null;
	sessionEntryByteOffset: number | null;
	sessionEntryByteLength: number | null;
	transportCount: number;
	transportCompleteness: "pending" | "complete" | "legacy-first-only";
	import?: ImportProvenance;
	batch?: { schemaVersion: 1; batchId: string; memberJobIds: string[]; messageIds: number[]; segmentSha256: string[]; boundaries: Array<{ start: number; end: number }> };
	attachments?: ArchivedTelegramAttachment[];
	exportStatus?: "historical-authority" | "present" | "missing" | "unresolved";
	gap?: MarkdownImportItem["gap"];
}

export class ArchiveSafetyError extends Error {}
export class ArchiveLockedError extends Error {}
export class ArchiveCorruptionError extends Error {}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function messageText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

function safeTimestamp(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.valueOf())) throw new ArchiveCorruptionError("Authoritative timestamp is invalid");
	return date.toISOString();
}

function timelineTimestamp(path: string): string {
	const match = /^messages\/(\d{4})\/(\d{2})\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})-[a-z][a-z0-9-]*(?:-[0-9a-f]{8})?\.md$/.exec(path);
	if (!match || match[1] !== match[3] || match[2] !== match[4]) throw new ArchiveCorruptionError("Archive note path timestamp is invalid");
	return safeTimestamp(`${match[3]}-${match[4]}-${match[5]}T${match[6]}:${match[7]}:${match[8]}.${match[9]}Z`);
}

function boundedTimelineContent(value: string): { content: string; truncated: boolean } {
	if (Buffer.byteLength(value) <= 2_048) return { content: value, truncated: false };
	let content = "";
	for (const character of value) { if (Buffer.byteLength(content + character) > 2_045) break; content += character; }
	return { content: `${content}…`, truncated: true };
}

function strictJson(text: string, label: string): unknown {
	let value: unknown;
	try { value = JSON.parse(text); parseYaml(text, { schema: "json", uniqueKeys: true }); }
	catch { throw new ArchiveCorruptionError(`${label} contains malformed or duplicate-key JSON`); }
	return value;
}

function identityToken(messageId: string): string {
	return hash(messageId).slice(0, 24);
}

function noteRelativePath(manifest: ArchiveManifest, candidate: Candidate, roleSlug: string): string {
	const occurredAt = safeTimestamp(candidate.occurredAt);
	const stem = `${occurredAt.slice(0, 4)}${occurredAt.slice(5, 7)}${occurredAt.slice(8, 10)}-${occurredAt.slice(11, 13)}${occurredAt.slice(14, 16)}${occurredAt.slice(17, 19)}${occurredAt.slice(20, 23)}-${roleSlug}`;
	const directory = join("messages", occurredAt.slice(0, 4), occurredAt.slice(5, 7)).split(sep).join("/");
	const base = `${directory}/${stem}.md`;
	const conflict = Object.entries(manifest.messages).find(([messageId, entry]) => messageId !== candidate.messageId && entry.path === base);
	return conflict ? `${directory}/${stem}-${identityToken(candidate.messageId).slice(0, 8)}.md` : base;
}

async function ensureProtectedDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new ArchiveSafetyError("Archive path is not a safe directory");
	if ((info.mode & 0o077) !== 0) throw new ArchiveSafetyError("Archive directory permissions are not private");
	if (process.getuid && info.uid !== process.getuid()) throw new ArchiveSafetyError("Archive directory has the wrong owner");
}

async function ensureOwnedRoot(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new ArchiveSafetyError("Markdown datastore root is not owner-controlled");
}

async function ensureArchiveStateRoot(root: string): Promise<string> {
	const messagesRoot = join(root, "messages");
	await ensureProtectedDirectory(messagesRoot);
	const stateRoot = join(messagesRoot, ".telegram-archive");
	await ensureProtectedDirectory(stateRoot);
	return stateRoot;
}

async function fsyncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try { await handle.sync(); } finally { await handle.close(); }
}

async function assertSafeAncestors(root: string, targetDirectory: string, identity: { dev: number; ino: number }): Promise<void> {
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev !== identity.dev || rootInfo.ino !== identity.ino) throw new ArchiveSafetyError("Archive root identity changed");
	const rel = relative(root, targetDirectory);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ArchiveSafetyError("Archive path escaped root");
	let current = root;
	for (const component of rel.split(sep).filter(Boolean)) {
		current = join(current, component);
		const info = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
		if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new ArchiveSafetyError("Archive path contains a symlink or non-directory ancestor");
	}
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
	await ensureProtectedDirectory(dirname(path));
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
		if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new ArchiveSafetyError("Archive target is not a safe regular file");
		await rename(temporary, path);
		await fsyncDirectory(dirname(path));
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function removeStaleManifestTemps(stateRoot: string): Promise<void> {
	let removed = false;
	for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
		if (!/^\.manifest\.json\.\d+\.[0-9a-f]{16}\.tmp$/.test(entry.name)) continue;
		const path = join(stateRoot, entry.name); const info = await lstat(path);
		if (!entry.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new ArchiveSafetyError("Stale manifest temporary is unsafe");
		await unlink(path); removed = true;
	}
	if (removed) await fsyncDirectory(stateRoot);
}

function emptyManifest(): ArchiveManifest {
	return { schema: "pi-telegram-owner/archive-manifest/v1", generation: 0, lastMessageId: null, messages: {} };
}

function validRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !isAbsolute(value) && !value.includes("\\") && !value.split("/").includes("..");
}
function validSourceRange(value: unknown): value is Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const range = value as Record<string, number>;
	return Object.keys(range).sort().join(",") === "endCol,endLine,endOffset,startCol,startLine,startOffset" && Object.values(range).every((item) => Number.isSafeInteger(item) && item >= 0) && range.endOffset > range.startOffset && range.startLine >= 1 && range.endLine >= range.startLine && range.startCol >= 1 && range.endCol >= 1;
}

function validImport(value: unknown): value is ImportProvenance {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	const source = String(item.source);
	const hasHtml = source !== "pi-session-export-missing";
	const keys = Object.keys(item).sort().join(",");
	const hasAuthoritativeSource = item.sourceRange !== undefined || item.sourceTextSha256 !== undefined;
	const validAuthoritativeSource = !hasAuthoritativeSource || (validSourceRange(item.sourceRange) && /^[0-9a-f]{64}$/.test(String(item.sourceTextSha256)));
	const validSegments = item.segments === undefined || (Array.isArray(item.segments) && item.segments.length >= 2 && item.segments.length <= 100 && item.segments.every((segment: any, index: number, segments: any[]) => segment && Object.keys(segment).sort().join(",") === "globalMessageOrdinal,page,pageSha256,sourceRange,sourceTextSha256" && validRelativePath(segment.page) && Number.isSafeInteger(segment.globalMessageOrdinal) && segment.globalMessageOrdinal > 0 && (index === 0 || segment.globalMessageOrdinal > segments[index - 1].globalMessageOrdinal) && /^[0-9a-f]{64}$/.test(segment.pageSha256) && /^[0-9a-f]{64}$/.test(segment.sourceTextSha256) && validSourceRange(segment.sourceRange)));
	return keys === ["boundaryManifestSha256", "confidence", "globalMessageOrdinal", "page", "pageSha256", "source", "sourceSetId", "sourceSetManifestSha256", "speakerMapRevision", ...(hasAuthoritativeSource ? ["sourceRange", "sourceTextSha256"] : []), ...(item.segments === undefined ? [] : ["segments"])].sort().join(",")
		&& ["telegram-desktop-historical-export", "telegram-desktop-html-pi", "pi-session-export-missing", "telegram-desktop-gap"].includes(source)
		&& typeof item.sourceSetId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item.sourceSetId)
		&& (hasHtml ? validRelativePath(item.page) && Number.isSafeInteger(item.globalMessageOrdinal) && Number(item.globalMessageOrdinal) > 0 && /^[0-9a-f]{64}$/.test(String(item.pageSha256)) : item.page === null && item.globalMessageOrdinal === null && item.pageSha256 === null)
		&& Number.isSafeInteger(item.speakerMapRevision) && Number(item.speakerMapRevision) > 0
		&& [item.sourceSetManifestSha256, item.boundaryManifestSha256].every((digest) => /^[0-9a-f]{64}$/.test(String(digest)))
		&& ["historical-html-sequence", "exact-pi", "unresolved-html"].includes(String(item.confidence))
		&& validAuthoritativeSource
		&& validSegments;
}

function validateManifest(value: unknown): ArchiveManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchiveCorruptionError("Archive manifest is invalid");
	const manifest = value as ArchiveManifest;
	if (Object.keys(manifest).sort().join(",") !== "generation,lastMessageId,messages,schema" || manifest.schema !== "pi-telegram-owner/archive-manifest/v1" || !Number.isSafeInteger(manifest.generation) || manifest.generation < 0 || (manifest.lastMessageId !== null && typeof manifest.lastMessageId !== "string") || !manifest.messages || typeof manifest.messages !== "object" || Array.isArray(manifest.messages) || Object.keys(manifest.messages).length > 500_000) throw new ArchiveCorruptionError("Archive manifest is invalid");
	for (const [messageId, entry] of Object.entries(manifest.messages)) {
		const keys = ["path", "predecessor", "contentRevision", "contentSha256", "metadataRevision", "metadataSha256", ...(entry.import ? ["import"] : [])].sort().join(",");
		if (!(messageId.startsWith("tgmsg:v1:") || messageId.startsWith("tggap:v1:")) || !entry || Object.keys(entry).sort().join(",") !== keys || !validRelativePath(entry.path) || (entry.predecessor !== null && typeof entry.predecessor !== "string") || entry.contentRevision !== 1 || !/^[0-9a-f]{64}$/.test(entry.contentSha256) || !Number.isSafeInteger(entry.metadataRevision) || entry.metadataRevision < 1 || !/^[0-9a-f]{64}$/.test(entry.metadataSha256) || (entry.import !== undefined && !validImport(entry.import))) throw new ArchiveCorruptionError("Archive manifest entry is invalid");
		if (entry.predecessor !== null && !Object.hasOwn(manifest.messages, entry.predecessor)) throw new ArchiveCorruptionError("Archive predecessor is invalid");
	}
	if (manifest.lastMessageId !== null && !Object.hasOwn(manifest.messages, manifest.lastMessageId)) throw new ArchiveCorruptionError("Archive tail is invalid");
	return manifest;
}

async function readManifest(path: string): Promise<ArchiveManifest | undefined> {
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new ArchiveSafetyError("Archive manifest cannot be opened safely"); }
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new ArchiveSafetyError("Archive manifest is unsafe");
		const bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new ArchiveSafetyError("Archive manifest changed while reading");
		return validateManifest(strictJson(bytes.toString("utf8"), "Archive manifest"));
	} finally { await handle.close(); }
}

function validateArchivedAttachment(attachment: ArchivedTelegramAttachment): void {
	if (!attachment || !/^[0-9a-f]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_IMAGE_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(attachment.mimeType) || !validRelativePath(attachment.path) || attachment.path !== `messages/_attachments/${attachment.sha256}.${imageExtension(attachment.mimeType)}` || !["live", "telegram-desktop-import"].includes(attachment.source) || !["in", "out"].includes(attachment.direction)) throw new ArchiveCorruptionError("Archived attachment reference is invalid");
}

function mediaEventWithoutId(event: Omit<TelegramMediaEvent, "eventId">): Omit<TelegramMediaEvent, "eventId"> { return event; }
function mediaEventId(event: Omit<TelegramMediaEvent, "eventId">): string { return hash(canonical(mediaEventWithoutId(event))); }
function mediaProvenanceKey(event: TelegramMediaEvent): string {
	const provenance = event.provenance;
	if (provenance.kind === "live-inbound") return `live-in:${provenance.jobId}:${provenance.imageIndex}`;
	if (provenance.kind === "live-outbound") return `live-out:${provenance.photoId}`;
	return `import:${provenance.sourceSetId}:${provenance.recordId}:${provenance.attachmentIndex}`;
}
function validateMediaEvent(value: unknown): TelegramMediaEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchiveCorruptionError("Media event is invalid");
	const event = value as TelegramMediaEvent;
	if (event.schema !== "pi-telegram-owner/media-event/v1" || Object.keys(event).sort().join(",") !== "attachment,direction,eventId,occurredAt,provenance,schema,source" || !/^[0-9a-f]{64}$/.test(event.eventId) || !["in", "out"].includes(event.direction) || !["live", "telegram-desktop-import"].includes(event.source) || !Number.isFinite(new Date(event.occurredAt).valueOf())) throw new ArchiveCorruptionError("Media event is invalid");
	validateArchivedAttachment(event.attachment);
	if (event.attachment.direction !== event.direction || event.attachment.source !== event.source) throw new ArchiveCorruptionError("Media event attachment provenance is invalid");
	const provenance = event.provenance;
	if (!provenance || typeof provenance !== "object") throw new ArchiveCorruptionError("Media event provenance is invalid");
	if (provenance.kind === "live-inbound") {
		if (event.source !== "live" || event.direction !== "in" || Object.keys(provenance).sort().join(",") !== "fileId,imageIndex,jobId,kind,messageId,updateId" || !provenance.jobId || !provenance.fileId || !Number.isSafeInteger(provenance.updateId) || !Number.isSafeInteger(provenance.messageId) || !Number.isSafeInteger(provenance.imageIndex) || provenance.imageIndex < 0) throw new ArchiveCorruptionError("Media event provenance is invalid");
	} else if (provenance.kind === "live-outbound") {
		if (event.source !== "live" || event.direction !== "out" || Object.keys(provenance).sort().join(",") !== "deliveryKey,jobId,kind,photoId,replyToMessageId,telegramMessageId" || !provenance.photoId || !provenance.jobId || !/^[0-9a-f]{64}$/.test(provenance.deliveryKey) || !Number.isSafeInteger(provenance.replyToMessageId) || provenance.replyToMessageId <= 0 || !/^[1-9][0-9]*$/.test(provenance.telegramMessageId)) throw new ArchiveCorruptionError("Media event provenance is invalid");
	} else if (provenance.kind === "desktop-import") {
		if (event.source !== "telegram-desktop-import" || Object.keys(provenance).sort().join(",") !== "attachmentIndex,boundaryManifestSha256,globalMessageOrdinal,kind,messageId,page,pageSha256,recordId,sourceSetId,sourceSetManifestSha256,speakerMapRevision" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provenance.sourceSetId) || !/^[0-9a-f]{64}$/.test(provenance.sourceSetManifestSha256) || !/^[0-9a-f]{64}$/.test(provenance.boundaryManifestSha256) || !provenance.recordId || !Number.isSafeInteger(provenance.speakerMapRevision) || provenance.speakerMapRevision < 1 || !Number.isSafeInteger(provenance.attachmentIndex) || provenance.attachmentIndex < 0 || (provenance.messageId !== null && typeof provenance.messageId !== "string") || (provenance.page !== null && !validRelativePath(provenance.page)) || (provenance.globalMessageOrdinal !== null && (!Number.isSafeInteger(provenance.globalMessageOrdinal) || provenance.globalMessageOrdinal < 1)) || (provenance.pageSha256 !== null && !/^[0-9a-f]{64}$/.test(provenance.pageSha256))) throw new ArchiveCorruptionError("Media event provenance is invalid");
	} else throw new ArchiveCorruptionError("Media event provenance is invalid");
	const { eventId: _eventId, ...identity } = event;
	if (event.eventId !== mediaEventId(identity)) throw new ArchiveCorruptionError("Media event identity is invalid");
	return event;
}
async function readMediaEvents(path: string, repairIncompleteTail = false): Promise<{ events: TelegramMediaEvent[]; ids: Map<string, string>; provenance: Map<string, string> }> {
	let handle;
	try { handle = await open(path, (repairIncompleteTail ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], ids: new Map(), provenance: new Map() }; throw new ArchiveSafetyError("Media event journal cannot be opened safely"); }
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024 * 1024 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new ArchiveSafetyError("Media event journal is unsafe");
		let bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new ArchiveSafetyError("Media event journal changed while reading");
		if (bytes.length && bytes.at(-1) !== 0x0a) {
			const durableLength = Math.max(0, bytes.lastIndexOf(0x0a) + 1);
			if (repairIncompleteTail) { await handle.truncate(durableLength); await handle.sync(); }
			bytes = bytes.subarray(0, durableLength);
		}
		const events: TelegramMediaEvent[] = []; const ids = new Map<string, string>(); const provenance = new Map<string, string>();
		for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
			const event = validateMediaEvent(strictJson(line, "Media event")); const encoded = canonical(event); const key = mediaProvenanceKey(event);
			if (ids.has(event.eventId) || provenance.has(key)) throw new ArchiveCorruptionError("Media event journal contains duplicate identity");
			ids.set(event.eventId, encoded); provenance.set(key, event.eventId); events.push(event);
		}
		return { events, ids, provenance };
	} finally { await handle.close(); }
}
async function appendMediaEvent(path: string, event: TelegramMediaEvent, state: Awaited<ReturnType<typeof readMediaEvents>>): Promise<boolean> {
	validateMediaEvent(event); const encoded = canonical(event); const prior = state.ids.get(event.eventId); const provenanceId = state.provenance.get(mediaProvenanceKey(event));
	if (prior !== undefined) { if (prior !== encoded) throw new ArchiveCorruptionError("Media event identity changed"); return false; }
	if (provenanceId !== undefined) throw new ArchiveCorruptionError("Media event provenance changed");
	const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try { await handle.write(`${encoded}\n`); await handle.sync(); } finally { await handle.close(); }
	state.events.push(event); state.ids.set(event.eventId, encoded); state.provenance.set(mediaProvenanceKey(event), event.eventId); return true;
}
function makeMediaEvent(event: Omit<TelegramMediaEvent, "eventId">): TelegramMediaEvent { return { ...event, eventId: mediaEventId(event) }; }
function liveMediaEvents(records: readonly JournalRecord[]): TelegramMediaEvent[] {
	validateMediaLifecycle(records);
	const updates = new Map(records.filter((record): record is Extract<JournalRecord, { type: "update" }> => record.type === "update" && record.disposition === "accepted" && Boolean(record.jobId)).map((record) => [record.jobId!, record]));
	const events: TelegramMediaEvent[] = [];
	for (const capture of records.filter((record): record is Extract<JournalRecord, { type: "media_captured" }> => record.type === "media_captured" && record.direction === "in")) {
		const update = updates.get(capture.jobId)!; const imageIndex = update.images!.findIndex((image) => image.fileId === capture.telegram.fileId);
		events.push(makeMediaEvent({ schema: "pi-telegram-owner/media-event/v1", direction: "in", source: "live", attachment: capture.attachment, occurredAt: safeTimestamp(capture.timestamp), provenance: { kind: "live-inbound", jobId: capture.jobId, updateId: update.updateId, messageId: update.messageId!, fileId: capture.telegram.fileId!, imageIndex } }));
	}
	const receipts = new Map(records.filter((record): record is Extract<JournalRecord, { type: "photo_sent" }> => record.type === "photo_sent").map((record) => [record.photoId, record]));
	for (const plan of records.filter((record): record is Extract<JournalRecord, { type: "photo_send_planned" }> => record.type === "photo_send_planned")) {
		const receipt = receipts.get(plan.photoId); if (!receipt) continue;
		events.push(makeMediaEvent({ schema: "pi-telegram-owner/media-event/v1", direction: "out", source: "live", attachment: plan.attachment, occurredAt: safeTimestamp(receipt.timestamp), provenance: { kind: "live-outbound", photoId: plan.photoId, jobId: plan.jobId, deliveryKey: plan.deliveryKey, replyToMessageId: plan.replyToMessageId, telegramMessageId: receipt.messageId } }));
	}
	return events;
}

function transport(records: readonly JournalRecord[], jobId: string): Pick<Candidate, "telegramMessageIds" | "transportCount" | "transportCompleteness"> {
	const plan = records.find((record): record is Extract<JournalRecord, { type: "reply_plan" }> => record.type === "reply_plan" && record.jobId === jobId);
	const receipts = records.filter((record): record is Extract<JournalRecord, { type: "reply_chunk_sent" }> => record.type === "reply_chunk_sent" && record.jobId === jobId).sort((a, b) => a.index - b.index);
	const terminal = [...records].reverse().find((record): record is Extract<JournalRecord, { type: "reply_sent" }> => record.type === "reply_sent" && record.jobId === jobId);
	if (receipts.length) return { telegramMessageIds: receipts.map((record) => record.messageId), transportCount: plan?.chunks.length ?? receipts.length, transportCompleteness: terminal && "messageIds" in terminal ? "complete" : "pending" };
	if (terminal && "messageId" in terminal) return { telegramMessageIds: [terminal.messageId], transportCount: 1, transportCompleteness: "legacy-first-only" };
	return { telegramMessageIds: [], transportCount: plan?.chunks.length ?? 0, transportCompleteness: "pending" };
}

interface PersistedEntry {
	entry: SessionEntry;
	line: number;
	byteOffset: number;
	byteLength: number;
	sha256: string;
}

async function persistedEntries(session: ReadonlySessionManager, sessionRoot: string): Promise<{ path: string; entries: Map<string, PersistedEntry> } | undefined> {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) return undefined;
	const suppliedInfo = await lstat(sessionFile).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
	if (!suppliedInfo) return undefined;
	if (!suppliedInfo.isFile() || suppliedInfo.isSymbolicLink() || suppliedInfo.nlink !== 1) throw new ArchiveSafetyError("Pi session source is unsafe");
	const rootReal = await realpath(sessionRoot);
	let fileReal: string;
	try { fileReal = await realpath(sessionFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	const rel = relative(rootReal, fileReal);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ArchiveSafetyError("Pi session file is outside configured session root");
	const handle = await open(fileReal, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer;
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) throw new ArchiveSafetyError("Pi session file is unsafe");
		bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || suppliedInfo.dev !== before.dev || suppliedInfo.ino !== before.ino || !bytes.toString("utf8").endsWith("\n")) throw new ArchiveSafetyError("Pi session changed or has an incomplete tail");
	} finally { await handle.close(); }
	const lines = bytes.toString("utf8").slice(0, -1).split("\n");
	let header: any;
	header = strictJson(lines[0]!, "Pi session header");
	if (header?.type !== "session" || header.version !== 3 || header.id !== session.getSessionId()) throw new ArchiveCorruptionError("Pi session header identity is invalid");
	const entries = new Map<string, PersistedEntry>();
	let byteOffset = Buffer.byteLength(lines[0]!) + 1;
	for (let index = 1; index < lines.length; index++) {
		const raw = lines[index]!;
		let entry: SessionEntry;
		entry = strictJson(raw, "Pi session entry") as SessionEntry;
		if (!entry || typeof entry.id !== "string" || entries.has(entry.id) || typeof entry.timestamp !== "string" || !Number.isFinite(new Date(entry.timestamp).valueOf())) throw new ArchiveCorruptionError("Pi session entry identity or timestamp is invalid");
		entries.set(entry.id, { entry, line: index + 1, byteOffset, byteLength: Buffer.byteLength(raw), sha256: hash(raw) });
		byteOffset += Buffer.byteLength(raw) + 1;
	}
	return { path: rel.split(sep).join("/"), entries };
}

async function buildCandidates(records: readonly JournalRecord[], mediaEvents: readonly TelegramMediaEvent[], session: ReadonlySessionManager, sessionRoot: string): Promise<{ candidates: Candidate[]; deferred: Array<{ jobId: string; direction: "in" | "out"; code: string }> }> {
	validateMediaLifecycle(records);
	const sessionId = session.getSessionId();
	const persisted = await persistedEntries(session, sessionRoot);
	const branch = session.getBranch();
	const candidates: Candidate[] = [];
	const deferred: Array<{ jobId: string; direction: "in" | "out"; code: string }> = [];
	const updates = records.filter((record): record is Extract<JournalRecord, { type: "update" }> => record.type === "update" && record.disposition === "accepted" && Boolean(record.jobId && record.text));
	const latestBatches = new Map<string, Extract<JournalRecord, { type: "inbound_batch" }>>();
	for (const record of records) if (record.type === "inbound_batch") latestBatches.set(record.batchId, record);
	const batchMembers = new Set([...latestBatches.values()].flatMap((batch) => batch.memberJobIds));
	for (const event of mediaEvents) validateMediaEvent(event);
	const photoPlans = records.filter((record): record is Extract<JournalRecord, { type: "photo_send_planned" }> => record.type === "photo_send_planned");
	const photoReceipts = new Map(records.filter((record): record is Extract<JournalRecord, { type: "photo_sent" }> => record.type === "photo_sent").map((record) => [record.photoId, record]));
	for (const plan of photoPlans) validateArchivedAttachment(plan.attachment);
	// Journal position orders private jobs (as Telegram update order does) and work items together.
	const position = new Map<JournalRecord, number>(records.map((record, index) => [record, index]));
	const logical: Array<{ jobId: string; text: string; command?: string; timestamp: string; telegramDate?: number; updateId: number | null; messageId?: number; batch?: Extract<JournalRecord, { type: "inbound_batch" }>; item?: WorkItem; order: number }> = updates.filter((update) => update.command || !batchMembers.has(update.jobId!)).map((update) => ({ jobId: update.jobId!, text: update.text!, command: update.command, timestamp: update.timestamp, telegramDate: update.telegramDate, updateId: update.updateId, messageId: update.messageId, order: position.get(update)! }));
	for (const batch of latestBatches.values()) {
		const members = batch.memberJobIds.map((jobId) => updates.find((update) => update.jobId === jobId));
		if (members.some((member) => !member)) throw new ArchiveCorruptionError("Inbound batch member update is missing");
		const first = members[0]!; const last = members.at(-1)!;
		logical.push({ jobId: batch.batchId, text: batch.text, timestamp: last.timestamp, telegramDate: first.telegramDate, updateId: last.updateId, messageId: batch.finalMessageId, batch, order: position.get(first)! });
	}
	// Work items answered in the private chat contribute only their outbound reply; the instruction is not a Telegram message.
	for (const record of records) {
		if (record.type !== "work_item" || record.reply.kind !== "private") continue;
		const { type: _type, schemaVersion: _schemaVersion, ...item } = record;
		logical.push({ jobId: item.itemId, text: renderWorkItemPrompt(item), timestamp: item.timestamp, updateId: null, item, order: position.get(record)! });
	}
	logical.sort((a, b) => a.order - b.order || a.jobId.localeCompare(b.jobId));
	for (const update of logical) {
		const jobId = update.jobId;
		const reply = [...records].reverse().find((record): record is Extract<JournalRecord, { type: "reply_ready" }> => record.type === "reply_ready" && record.jobId === jobId);
		const addLocalResponse = () => {
			if (!reply) return;
			const sent = transport(records, jobId);
			candidates.push({ jobId, direction: "out", identityKind: "telegram-job-local-response", messageId: `tgmsg:v1:telegram-job:${jobId}:local-response`, body: reply.text, role: "telegram-command", occurredAt: safeTimestamp(reply.timestamp ?? update.timestamp), observedAt: safeTimestamp(update.timestamp), updateId: update.updateId, telegramMessageIds: sent.telegramMessageIds, sessionId: null, sessionEntryId: null, sessionPath: null, sessionEntrySha256: null, sessionEntryLine: null, sessionEntryByteOffset: null, sessionEntryByteLength: null, transportCount: sent.transportCount, transportCompleteness: sent.transportCompleteness });
		};
		if (update.command) {
			addLocalResponse();
			continue;
		}
		const dispatched = [...records].reverse().find((record): record is Extract<JournalRecord, { type: "dispatched" }> => record.type === "dispatched" && record.jobId === jobId);
		if (!dispatched) continue;
		if (dispatched.sessionId !== sessionId || !persisted) {
			if (!update.item) deferred.push({ jobId, direction: "in", code: "PI_SESSION_NOT_SUPPLIED" });
			if (reply) deferred.push({ jobId, direction: "out", code: "PI_SESSION_NOT_SUPPLIED" });
			continue;
		}
		const marker = update.item ? `${WORK_ITEM_MARKER_PREFIX}${jobId}]\n` : update.batch ? `[telegram-batch:${jobId}]\n` : `[telegram-job:${jobId}]\n`;
		const markerUsers = branch.map((entry, index) => ({ entry, index })).filter(({ entry }) => messageText(entry)?.startsWith(marker));
		const userMatches = markerUsers.filter(({ entry }) => messageText(entry)!.slice(marker.length) === update.text);
		if (userMatches.length !== 1) {
			if (markerUsers.length === 1 && userMatches.length === 0) throw new ArchiveCorruptionError("Canonical Pi user content changed under a stable job marker");
			const code = userMatches.length ? "PI_USER_ENTRY_AMBIGUOUS" : "PI_USER_ENTRY_MISSING";
			if (!update.item) deferred.push({ jobId, direction: "in", code }); if (reply) deferred.push({ jobId, direction: "out", code }); continue;
		}
		const { entry: user, index: userIndex } = userMatches[0]!;
		const storedUser = persisted!.entries.get(user.id);
		if (!storedUser || messageText(storedUser.entry) !== messageText(user)) throw new ArchiveCorruptionError("Persisted Pi user entry disagrees with branch");
		if (!update.item) {
			const body = messageText(storedUser.entry)!.slice(marker.length);
			const batchProvenance = update.batch ? { schemaVersion: 1 as const, batchId: update.batch.batchId, memberJobIds: update.batch.memberJobIds, messageIds: update.batch.messageIds, segmentSha256: update.batch.segmentSha256, boundaries: update.batch.boundaries } : undefined;
			const memberIds = update.batch?.memberJobIds ?? [jobId];
			const inboundAttachments = mediaEvents.filter((event) => event.provenance.kind === "live-inbound" && memberIds.includes(event.provenance.jobId)).map((event) => event.attachment);
			candidates.push({ jobId, direction: "in", identityKind: "pi-session-entry", messageId: `tgmsg:v1:pi:${sessionId}:${user.id}`, body, role: "user", occurredAt: update.telegramDate ? new Date(update.telegramDate * 1000).toISOString() : safeTimestamp(user.timestamp), observedAt: safeTimestamp(update.timestamp), updateId: update.updateId, telegramMessageIds: update.batch ? update.batch.messageIds.map(String) : update.messageId === undefined ? [] : [String(update.messageId)], sessionId, sessionEntryId: user.id, sessionPath: persisted.path, sessionEntrySha256: storedUser.sha256, sessionEntryLine: storedUser.line, sessionEntryByteOffset: storedUser.byteOffset, sessionEntryByteLength: storedUser.byteLength, transportCount: update.batch?.messageIds.length ?? 1, transportCompleteness: "complete", batch: batchProvenance, ...(inboundAttachments.length ? { attachments: inboundAttachments } : {}) });
			for (const plan of photoPlans.filter((item) => item.jobId === jobId)) {
				const receipt = photoReceipts.get(plan.photoId);
				if (!receipt) continue;
				const media = mediaEvents.find((event) => event.provenance.kind === "live-outbound" && event.provenance.photoId === plan.photoId);
				if (!media) throw new ArchiveCorruptionError("Outbound photo media event is missing");
				candidates.push({ jobId: plan.photoId, direction: "out", identityKind: "telegram-live-photo", messageId: `tgmsg:v1:telegram-photo:${plan.photoId}`, body: plan.caption, role: "assistant", occurredAt: safeTimestamp(receipt.timestamp), observedAt: safeTimestamp(plan.timestamp), updateId: update.updateId, telegramMessageIds: [receipt.messageId], sessionId: null, sessionEntryId: null, sessionPath: null, sessionEntrySha256: null, sessionEntryLine: null, sessionEntryByteOffset: null, sessionEntryByteLength: null, transportCount: 1, transportCompleteness: "complete", attachments: [media.attachment] });
			}
		}
		if (!reply) continue;
		// The archive records what Telegram showed; a reply that posted nothing is not a message.
		if (records.some((record) => record.type === "reply_sent" && record.jobId === jobId && "messageIds" in record && record.messageIds.length === 0)) continue;
		// The bridge records interruption notices after `interrupted`; they are not Pi assistant text.
		const beforeReply = records.slice(0, records.lastIndexOf(reply)).findLast((record) => "jobId" in record && record.jobId === jobId);
		if (beforeReply?.type === "interrupted") {
			addLocalResponse();
			continue;
		}
		const turn = branch.slice(userIndex + 1, branch.findIndex((entry, index) => index > userIndex && entry.type === "message" && entry.message.role === "user") < 0 ? branch.length : branch.findIndex((entry, index) => index > userIndex && entry.type === "message" && entry.message.role === "user"));
		const turnAssistants = turn.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const assistants = turnAssistants.filter((entry) => messageText(entry) === reply.text);
		if (assistants.length !== 1) {
			if (turnAssistants.length === 1 && assistants.length === 0) throw new ArchiveCorruptionError("Canonical Pi assistant content changed under a stable correlated turn");
			deferred.push({ jobId, direction: "out", code: assistants.length ? "PI_ASSISTANT_ENTRY_AMBIGUOUS" : "PI_ASSISTANT_ENTRY_MISSING" }); continue;
		}
		const assistant = assistants[0]!; const storedAssistant = persisted!.entries.get(assistant.id);
		if (!storedAssistant || messageText(storedAssistant.entry) !== messageText(assistant)) throw new ArchiveCorruptionError("Persisted Pi assistant entry disagrees with branch");
		const sent = transport(records, jobId);
		candidates.push({ jobId, direction: "out", identityKind: "pi-session-entry", messageId: `tgmsg:v1:pi:${sessionId}:${assistant.id}`, body: messageText(storedAssistant.entry)!, role: "assistant", occurredAt: safeTimestamp(assistant.timestamp), observedAt: safeTimestamp(reply.timestamp ?? update.timestamp), updateId: update.updateId, telegramMessageIds: sent.telegramMessageIds, sessionId, sessionEntryId: assistant.id, sessionPath: persisted.path, sessionEntrySha256: storedAssistant.sha256, sessionEntryLine: storedAssistant.line, sessionEntryByteOffset: storedAssistant.byteOffset, sessionEntryByteLength: storedAssistant.byteLength, transportCount: sent.transportCount, transportCompleteness: sent.transportCompleteness });
	}
	return { candidates, deferred };
}

function note(candidate: Candidate, rootId: string, predecessor: string | null, predecessorPath: string | null, contentRevision: number, metadataRevision: number): { text: string; contentSha256: string; metadataSha256: string } {
	const canonicalBody = candidate.body.replace(/\r\n?/g, "\n");
	const embeds = candidate.attachments?.map((attachment) => `![[${basename(attachment.path)}|512]]`).join("\n") ?? "";
	const body = embeds ? `${canonicalBody}\n\n${embeds}` : canonicalBody;
	const contentSha256 = hash(body);
	const metadata = {
		schema: "pi-telegram-owner/message/v1",
		messageId: candidate.canonicalMessageId === undefined ? candidate.messageId : candidate.canonicalMessageId,
		...(candidate.canonicalMessageId === null ? { recordId: candidate.messageId } : {}),
		identityKind: candidate.identityKind,
		direction: candidate.direction,
		turnRole: candidate.role === "gap" ? null : candidate.direction === "in" ? "request" : "response",
		conversation: "owner-private-v1",
		occurredAt: candidate.occurredAt,
		observedAt: candidate.observedAt,
		updateId: candidate.updateId,
		telegramMessageIds: candidate.telegramMessageIds,
		jobId: candidate.jobId,
		sessionId: candidate.sessionId,
		sessionEntryId: candidate.sessionEntryId,
		sessionSource: candidate.sessionId ? { format: "pi-v3", rootId, path: candidate.sessionPath, entryLine: candidate.sessionEntryLine, entryByteOffset: candidate.sessionEntryByteOffset, entryByteLength: candidate.sessionEntryByteLength, entrySha256: candidate.sessionEntrySha256 } : null,
		role: candidate.role,
		...(candidate.batch ? { inboundBatch: candidate.batch } : {}),
		...(candidate.attachments?.length ? { attachments: candidate.attachments } : {}),
		...(candidate.exportStatus ? { exportStatus: candidate.exportStatus } : {}),
		...(candidate.gap ? { gap: candidate.gap } : {}),
		chunk: { logicalIndex: 0, logicalCount: 1, transportCount: candidate.transportCount, transportCompleteness: candidate.transportCompleteness, transportRenderer: "telegram-html-v1" },
		import: candidate.import ?? { source: "live", confidence: candidate.identityKind === "telegram-live-photo" ? "exact-live-telegram" : candidate.sessionId ? "exact-pi" : "exact-local-command-html" },
		contentRevision,
		contentSha256,
		metadataRevision,
		predecessor,
		boundary: candidate.role === "gap" ? "unresolved-gap" : predecessor ? "none" : "conversation-start",
		gapBefore: candidate.role === "gap",
	};
	const metadataSha256 = hash(canonical(metadata));
	const frontmatter = stringifyYaml({ ...metadata, metadataSha256 }, { lineWidth: 0 });
	const footer = predecessor && predecessorPath ? `Previous: [[${basename(predecessorPath, ".md")}]]` : "Previous: none (conversation start)";
	return { text: `---\n${frontmatter}---\n\n${body}\n\n---\n${footer}\n`, contentSha256, metadataSha256 };
}

function imageExtension(mimeType: string): "jpg" | "png" | "webp" {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/webp") return "webp";
	throw new ArchiveSafetyError("Attachment MIME type is unsupported");
}

async function publishContentAddressedAttachment(root: string, bytes: Buffer, mimeType: string, direction: "in" | "out", source: ArchivedTelegramAttachment["source"], rootIdentity: { dev: number; ino: number }): Promise<ArchivedTelegramAttachment & { created: boolean }> {
	if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw new ArchiveSafetyError("Attachment size is invalid");
	const sha256 = hash(bytes);
	const relativePath = `messages/_attachments/${sha256}.${imageExtension(mimeType)}`;
	const target = resolve(root, relativePath);
	await assertSafeAncestors(root, dirname(target), rootIdentity);
	let existing: Buffer | undefined;
	try {
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { const info = await handle.stat(); existing = await handle.readFile(); if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new ArchiveSafetyError("Published attachment is unsafe"); }
		finally { await handle.close(); }
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (existing) {
		if (existing.length !== bytes.length || hash(existing) !== sha256) throw new ArchiveCorruptionError("Content-addressed attachment disagrees with its identity");
		return { path: relativePath, sha256, mimeType: mimeType as ArchivedTelegramAttachment["mimeType"], size: bytes.length, source, direction, created: false };
	}
	await atomicWrite(target, bytes);
	return { path: relativePath, sha256, mimeType: mimeType as ArchivedTelegramAttachment["mimeType"], size: bytes.length, source, direction, created: true };
}

async function publishAttachment(root: string, attachment: MarkdownImportItem["attachments"][number], direction: "in" | "out", rootIdentity: { dev: number; ino: number }): Promise<ArchivedTelegramAttachment & { created: boolean }> {
	if (!isAbsolute(attachment.sourcePath) || !/^[0-9a-f]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_IMAGE_BYTES) throw new ArchiveSafetyError("Import attachment identity is invalid");
	imageExtension(attachment.mimeType);
	const source = await open(attachment.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer;
	try {
		const before = await source.stat(); bytes = await source.readFile(); const after = await source.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size !== attachment.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || (process.getuid && before.uid !== process.getuid()) || hash(bytes) !== attachment.sha256) throw new ArchiveSafetyError("Import attachment changed or is unsafe");
	} finally { await source.close(); }
	return publishContentAddressedAttachment(root, bytes!, attachment.mimeType, direction, "telegram-desktop-import", rootIdentity);
}

async function verifiedLegacyAttachments(root: string, rootIdentity: { dev: number; ino: number }, noteText: string, expected: readonly MarkdownImportItem["attachments"][number][]): Promise<NonNullable<Candidate["attachments"]> | undefined> {
	const frontmatter = /^---\n([\s\S]*?)\n---\n\n/.exec(noteText); if (!frontmatter) return undefined;
	let metadata: Record<string, unknown>; try { metadata = parseYaml(frontmatter[1]!, { uniqueKeys: true }) as Record<string, unknown>; } catch { return undefined; }
	if (!Array.isArray(metadata.attachments) || metadata.attachments.length !== expected.length) return undefined;
	const attachments = [] as NonNullable<Candidate["attachments"]>;
	for (let index = 0; index < expected.length; index++) {
		const value = metadata.attachments[index]; const source = expected[index]!;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const attachment = value as Record<string, unknown>;
		if (Object.keys(attachment).sort().join(",") !== "mimeType,path,sha256,size" || !validRelativePath(attachment.path) || !String(attachment.path).startsWith("messages/_attachments/") || attachment.sha256 !== source.sha256 || attachment.mimeType !== source.mimeType || attachment.size !== source.size) return undefined;
		const target = resolve(root, String(attachment.path)); if (!target.startsWith(`${root}${sep}`)) throw new ArchiveSafetyError("Legacy attachment escaped archive root");
		await assertSafeAncestors(root, dirname(target), rootIdentity);
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { const before = await handle.stat(); const bytes = await handle.readFile(); const after = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size !== source.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid()) || hash(bytes) !== source.sha256) throw new ArchiveCorruptionError("Legacy attachment bytes disagree with immutable note"); }
		finally { await handle.close(); }
		attachments.push({ path: String(attachment.path), sha256: String(attachment.sha256), mimeType: String(attachment.mimeType) as ArchivedTelegramAttachment["mimeType"], size: Number(attachment.size) } as ArchivedTelegramAttachment);
	}
	return attachments;
}

async function verifyExistingNote(path: string, recordId: string, expectedFooter: string, expected?: ManifestEntry, canonicalMessageId: string | null = recordId): Promise<string | undefined> {
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new ArchiveSafetyError("Archive note is unsafe");
		const text = await handle.readFile("utf8");
		const frontmatter = /^---\n([\s\S]*?)\n---\n\n/.exec(text);
		const footer = text.lastIndexOf("\n\n---\nPrevious: ");
		if (!frontmatter || footer < frontmatter[0].length || text.slice(footer) !== `\n\n---\n${expectedFooter}\n`) throw new ArchiveCorruptionError("Archive note navigation is invalid");
		let metadata: Record<string, unknown>;
		try { metadata = parseYaml(frontmatter[1]!, { uniqueKeys: true }) as Record<string, unknown>; } catch { throw new ArchiveCorruptionError("Archive note YAML is invalid"); }
		const claimedMetadataHash = metadata.metadataSha256; const withoutHash = { ...metadata }; delete withoutHash.metadataSha256;
		const body = text.slice(frontmatter[0].length, footer);
		if (metadata.messageId !== canonicalMessageId || (canonicalMessageId === null && metadata.recordId !== recordId) || !/^[0-9a-f]{64}$/.test(String(claimedMetadataHash)) || hash(canonical(withoutHash)) !== claimedMetadataHash || hash(body) !== metadata.contentSha256) throw new ArchiveCorruptionError("Archive note integrity check failed");
		if (expected && (metadata.contentRevision !== expected.contentRevision || metadata.contentSha256 !== expected.contentSha256 || metadata.metadataRevision !== expected.metadataRevision || metadata.metadataSha256 !== expected.metadataSha256)) throw new ArchiveCorruptionError("Archive note and manifest disagree");
		return text;
	} finally { await handle.close(); }
}

export class TelegramMarkdownProjector {
	readonly #root: string;
	readonly #sessionRoot?: string;
	readonly #rootId: string;
	readonly #roleSlugs: { user: string; assistant: string; command: string };
	readonly #bootIdentity: () => BootIdentity | undefined;
	readonly #pidState: (pid: number) => PidState;

	constructor(config: TelegramMarkdownProjectorConfig, dependencies: { bootIdentity?: () => BootIdentity | undefined; pidState?: (pid: number) => PidState } = {}) {
		if (!config.enabled || !isAbsolute(config.root) || (config.sessionRoot !== undefined && !isAbsolute(config.sessionRoot)) || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.rootId)) throw new ArchiveSafetyError("Markdown projection root and rootId must be explicit; a supplied Pi session root must be absolute");
		this.#root = resolve(config.root);
		this.#sessionRoot = config.sessionRoot === undefined ? undefined : resolve(config.sessionRoot);
		this.#rootId = config.rootId;
		this.#roleSlugs = config.roleSlugs ?? { user: "user", assistant: "assistant", command: "command" };
		if (Object.values(this.#roleSlugs).some((slug) => !/^[a-z][a-z0-9-]{0,31}$/.test(slug))) throw new ArchiveSafetyError("Markdown projector role slugs are invalid");
		this.#bootIdentity = dependencies.bootIdentity ?? systemBootIdentity;
		this.#pidState = dependencies.pidState ?? systemPidState;
	}

	async captureLiveMedia(bytes: Buffer, mimeType: ArchivedTelegramAttachment["mimeType"], direction: "in" | "out"): Promise<ArchivedTelegramAttachment> {
		await ensureOwnedRoot(this.#root);
		await ensureArchiveStateRoot(this.#root);
		const rootInfo = await lstat(this.#root);
		const published = await publishContentAddressedAttachment(this.#root, bytes, mimeType, direction, "live", { dev: rootInfo.dev, ino: rootInfo.ino });
		const { created: _created, ...attachment } = published;
		return attachment;
	}

	async readLiveMedia(attachment: ArchivedTelegramAttachment): Promise<ResolvedImage> {
		if (attachment.source !== "live" || !validRelativePath(attachment.path) || !/^[0-9a-f]{64}$/.test(attachment.sha256) || attachment.path !== `messages/_attachments/${attachment.sha256}.${imageExtension(attachment.mimeType)}` || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_IMAGE_BYTES) throw new ArchiveSafetyError("Live attachment identity is invalid");
		const rootInfo = await lstat(this.#root);
		const target = resolve(this.#root, attachment.path);
		await assertSafeAncestors(this.#root, dirname(target), { dev: rootInfo.dev, ino: rootInfo.ino });
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat(); const bytes = await handle.readFile(); const after = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size !== attachment.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || hash(bytes) !== attachment.sha256) throw new ArchiveCorruptionError("Live attachment bytes disagree with journal identity");
			return { data: bytes.toString("base64"), mimeType: attachment.mimeType };
		} finally { await handle.close(); }
	}

	async reconcileMediaEvents(records: readonly JournalRecord[], signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted();
		await ensureOwnedRoot(this.#root);
		const stateRoot = await ensureArchiveStateRoot(this.#root);
		let lock: PollerLock;
		try { lock = await PollerLock.acquire(join(stateRoot, "lock"), process.pid, this.#pidState, this.#bootIdentity); }
		catch (error) { throw new ArchiveLockedError((error as Error).message); }
		try {
			const path = join(stateRoot, "media-events.jsonl"); const state = await readMediaEvents(path, true); let appended = 0;
			for (const event of liveMediaEvents(records)) { signal?.throwIfAborted(); if (await appendMediaEvent(path, event, state)) appended += 1; }
			return appended;
		} finally { await lock.release(); await fsyncDirectory(stateRoot).catch(() => undefined); }
	}

	async readMediaEvents(): Promise<TelegramMediaEvent[]> {
		await ensureOwnedRoot(this.#root); const stateRoot = await ensureArchiveStateRoot(this.#root);
		return (await readMediaEvents(join(stateRoot, "media-events.jsonl"))).events;
	}

	async timeline(input: TelegramTimelineInput, signal?: AbortSignal): Promise<TelegramTimelineResult> {
		if (!input || typeof input !== "object" || !["recent", "range", "count"].includes(input.operation)) throw new ArchiveSafetyError("Timeline operation is invalid");
		const unit = input.unit ?? "messages"; const direction = input.direction ?? "both"; const order = input.order ?? (input.operation === "recent" ? "desc" : "asc"); const limit = input.limit ?? 10;
		if (!["messages", "exchanges"].includes(unit) || !["in", "out", "both"].includes(direction) || !["asc", "desc"].includes(order) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (unit === "exchanges" && direction !== "both")) throw new ArchiveSafetyError("Timeline query bounds are invalid");
		if (input.operation === "count" && (input.limit !== undefined || input.order !== undefined)) throw new ArchiveSafetyError("Count queries do not accept limit or order");
		const parseBound = (value: string | undefined, required: boolean): string | undefined => { if (value === undefined) { if (required) throw new ArchiveSafetyError("Timeline range requires start and end"); return undefined; } if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ArchiveSafetyError("Timeline bounds must be ISO timestamps with an explicit offset"); return safeTimestamp(value); };
		const start = parseBound(input.start, input.operation !== "recent"); const end = parseBound(input.end, input.operation !== "recent") ?? new Date().toISOString();
		if ((start && start >= end) || (start && Date.parse(end) - Date.parse(start) > 366 * 24 * 60 * 60 * 1_000)) throw new ArchiveSafetyError("Timeline range must be positive and at most 366 days");
		if (signal?.aborted) throw signal.reason ?? new Error("Timeline query cancelled");
		const rootInfo = await lstat(this.#root).catch(() => { throw new ArchiveSafetyError("Timeline archive is unavailable"); });
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) !== 0 || (process.getuid && rootInfo.uid !== process.getuid())) throw new ArchiveSafetyError("Markdown datastore root is not owner-controlled");
		for (const directory of [join(this.#root, "messages"), join(this.#root, "messages", ".telegram-archive")]) {
			const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
			if (info && (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) throw new ArchiveSafetyError("Timeline archive directory is unsafe");
		}
		const manifest = await readManifest(join(this.#root, "messages", ".telegram-archive", "manifest.json"));
		if (!manifest) return { operation: input.operation, unit, direction, order, timezone: "UTC", range: { start: start ?? null, end }, count: 0, ...(unit === "messages" && input.operation !== "count" ? { messages: [] } : {}), ...(unit === "exchanges" && input.operation !== "count" ? { exchanges: [] } : {}) };
		const ids: string[] = []; const seen = new Set<string>(); let cursor = manifest.lastMessageId;
		while (cursor) { if (seen.has(cursor)) throw new ArchiveCorruptionError("Archive predecessor cycle detected"); seen.add(cursor); ids.push(cursor); cursor = manifest.messages[cursor]!.predecessor; }
		if (ids.length !== Object.keys(manifest.messages).length || ids.length > 50_000) throw new ArchiveCorruptionError("Timeline requires one bounded canonical predecessor chain");
		ids.reverse();
		let readBytes = 0;
		const readMessage = async (messageId: string): Promise<TelegramTimelineMessage> => {
			if (signal?.aborted) throw signal.reason ?? new Error("Timeline query cancelled");
			const entry = manifest.messages[messageId]!; const predecessorPath = entry.predecessor ? manifest.messages[entry.predecessor]!.path : undefined;
			const target = resolve(this.#root, entry.path); await assertSafeAncestors(this.#root, dirname(target), { dev: rootInfo.dev, ino: rootInfo.ino });
			const footer = entry.predecessor && predecessorPath ? `Previous: [[${basename(predecessorPath, ".md")}]]` : "Previous: none (conversation start)";
			const text = await verifyExistingNote(target, messageId, footer, entry, messageId.startsWith("tggap:v1:") ? null : messageId); if (text === undefined) throw new ArchiveCorruptionError("Archive manifest note is missing");
			readBytes += Buffer.byteLength(text); if (readBytes > 128 * 1024 * 1024) throw new ArchiveSafetyError("Timeline note-read budget exceeded");
			const frontmatter = /^---\n([\s\S]*?)\n---\n\n/.exec(text)!; const footerOffset = text.lastIndexOf("\n\n---\nPrevious: "); const metadata = parseYaml(frontmatter[1]!, { uniqueKeys: true }) as Record<string, unknown>; const occurredAt = safeTimestamp(String(metadata.occurredAt));
			if (occurredAt !== timelineTimestamp(entry.path) || !["in", "out"].includes(String(metadata.direction)) || !["user", "assistant", "telegram-command", "gap"].includes(String(metadata.role))) throw new ArchiveCorruptionError("Archive timeline metadata is invalid");
			const body = boundedTimelineContent(text.slice(frontmatter[0].length, footerOffset));
			return { messageId, occurredAt, direction: metadata.direction as "in" | "out", role: metadata.role as TelegramTimelineMessage["role"], path: entry.path, ...body };
		};
		const candidates = ids.filter((messageId) => { const timestamp = timelineTimestamp(manifest.messages[messageId]!.path); return (!start || timestamp >= start) && timestamp < end; });
		let messages: TelegramTimelineMessage[] = [];
		if (input.operation === "recent") {
			let inbound = 0;
			for (const messageId of [...candidates].reverse()) { const message = await readMessage(messageId); if (direction !== "both" && message.direction !== direction) continue; messages.push(message); if (message.direction === "in") inbound += 1; if ((unit === "messages" && messages.length >= limit) || (unit === "exchanges" && inbound >= limit)) break; }
			messages.reverse();
		} else {
			for (const messageId of candidates) { const message = await readMessage(messageId); if (direction === "both" || message.direction === direction) messages.push(message); }
		}
		const exchanges: TelegramTimelineExchange[] = [];
		if (unit === "exchanges") for (const message of messages) { if (message.direction === "in") exchanges.push({ request: message, responses: [] }); else if (exchanges.length) exchanges.at(-1)!.responses.push(message); }
		const orderedMessages = order === "desc" ? [...messages].reverse() : messages; const orderedExchanges = order === "desc" ? [...exchanges].reverse() : exchanges;
		const count = unit === "messages" ? messages.length : exchanges.length;
		return { operation: input.operation, unit, direction, order, timezone: "UTC", range: { start: start ?? null, end }, count, ...(input.operation === "count" ? {} : unit === "messages" ? { messages: orderedMessages.slice(0, limit) } : { exchanges: orderedExchanges.slice(0, limit) }) };
	}

	async publishImport(items: readonly MarkdownImportItem[], binding: MarkdownImportBinding, onProgress?: (nextIndex: number, messageId: string, manifestGeneration: number) => Promise<void>, signal?: AbortSignal): Promise<PublicationResult> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.sourceSetId) || !/^[0-9a-f]{64}$/.test(binding.sourceSetManifestSha256) || !/^[0-9a-f]{64}$/.test(binding.boundaryManifestSha256) || !Number.isSafeInteger(binding.speakerMapRevision) || binding.speakerMapRevision < 1) throw new ArchiveSafetyError("Import publication binding is invalid");
		await ensureOwnedRoot(this.#root);
		const stateRoot = await ensureArchiveStateRoot(this.#root);
		const rootInfo = await lstat(this.#root); const rootIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
		let lock: PollerLock;
		try { lock = await PollerLock.acquire(join(stateRoot, "lock"), process.pid, this.#pidState, this.#bootIdentity); }
		catch (error) { throw new ArchiveLockedError((error as Error).message); }
		const result: PublicationResult = { published: 0, unchanged: 0, attachments: 0, mediaEvents: 0 };
		try {
			await removeStaleManifestTemps(stateRoot);
			const manifestPath = join(stateRoot, "manifest.json"); let manifest = await readManifest(manifestPath) ?? emptyManifest();
			const mediaEventPath = join(stateRoot, "media-events.jsonl"); const mediaState = await readMediaEvents(mediaEventPath, true);
			if (Object.keys(manifest.messages).length > 0) {
				const existingOrder: string[] = []; let cursor = manifest.lastMessageId;
				while (cursor) { existingOrder.push(cursor); cursor = manifest.messages[cursor]?.predecessor ?? null; }
				existingOrder.reverse();
				if (existingOrder.length > items.length || existingOrder.some((messageId, index) => messageId !== (items[index]?.recordId ?? items[index]?.messageId))) throw new ArchiveCorruptionError("Import publication requires an empty root or an exact plan prefix");
				for (const messageId of existingOrder) { const provenance = manifest.messages[messageId]?.import; if (!provenance || provenance.sourceSetId !== binding.sourceSetId || provenance.sourceSetManifestSha256 !== binding.sourceSetManifestSha256 || provenance.boundaryManifestSha256 !== binding.boundaryManifestSha256 || provenance.speakerMapRevision !== binding.speakerMapRevision) throw new ArchiveCorruptionError("Existing import prefix has a different source binding"); }
			}
			for (let index = 0; index < items.length; index++) {
				signal?.throwIfAborted(); const item = items[index]!; const recordId = item.recordId ?? item.messageId;
				const isGap = item.identityKind === "telegram-export-gap";
				if (typeof recordId !== "string" || (isGap ? item.messageId !== null || !recordId.startsWith("tggap:v1:") || !item.gap || !item.html : typeof item.messageId !== "string" || !item.messageId.startsWith("tgmsg:v1:")) || !["in", "out"].includes(item.direction) || !Number.isFinite(new Date(item.occurredAt).valueOf()) || (item.html !== undefined && (item.html.globalMessageOrdinal < 1 || !/^[0-9a-f]{64}$/.test(item.html.pageSha256) || ((item.html.sourceRange !== undefined || item.html.sourceTextSha256 !== undefined) && (!validSourceRange(item.html.sourceRange) || !/^[0-9a-f]{64}$/.test(String(item.html.sourceTextSha256)))))) || (item.htmlSegments !== undefined && (item.htmlSegments.length < 2 || item.htmlSegments.some((segment) => !validRelativePath(segment.page) || !Number.isSafeInteger(segment.globalMessageOrdinal) || !/^[0-9a-f]{64}$/.test(segment.pageSha256) || !/^[0-9a-f]{64}$/.test(segment.sourceTextSha256) || !validSourceRange(segment.sourceRange))))) throw new ArchiveSafetyError("Import publication item is invalid");
				let attachments = [] as NonNullable<Candidate["attachments"]>; const pendingMediaEvents: TelegramMediaEvent[] = [];
				for (let attachmentIndex = 0; attachmentIndex < item.attachments.length; attachmentIndex++) {
					const attachment = item.attachments[attachmentIndex]!; const published = await publishAttachment(this.#root, attachment, item.direction, rootIdentity); if (published.created) result.attachments += 1; const { created: _created, ...metadata } = published; attachments.push(metadata);
					pendingMediaEvents.push(makeMediaEvent({ schema: "pi-telegram-owner/media-event/v1", direction: item.direction, source: "telegram-desktop-import", attachment: metadata, occurredAt: safeTimestamp(item.occurredAt), provenance: { kind: "desktop-import", sourceSetId: binding.sourceSetId, sourceSetManifestSha256: binding.sourceSetManifestSha256, boundaryManifestSha256: binding.boundaryManifestSha256, speakerMapRevision: binding.speakerMapRevision, recordId, messageId: item.messageId, attachmentIndex, page: item.html?.page ?? null, globalMessageOrdinal: item.html?.globalMessageOrdinal ?? null, pageSha256: item.html?.pageSha256 ?? null } }));
				}
				const source = item.identityKind === "telegram-export-history" ? "telegram-desktop-historical-export" : item.identityKind === "telegram-export-gap" ? "telegram-desktop-gap" : item.exportStatus === "missing" ? "pi-session-export-missing" : "telegram-desktop-html-pi";
				const importProvenance: ImportProvenance = { source, sourceSetId: binding.sourceSetId, sourceSetManifestSha256: binding.sourceSetManifestSha256, page: item.html?.page ?? null, globalMessageOrdinal: item.html?.globalMessageOrdinal ?? null, pageSha256: item.html?.pageSha256 ?? null, speakerMapRevision: binding.speakerMapRevision, boundaryManifestSha256: binding.boundaryManifestSha256, confidence: item.confidence, ...(item.html?.sourceRange && item.html.sourceTextSha256 ? { sourceRange: item.html.sourceRange, sourceTextSha256: item.html.sourceTextSha256 } : {}), ...(item.htmlSegments ? { segments: item.htmlSegments } : {}) };
				if (item.identityKind === "pi-session-entry" && !item.pi) throw new ArchiveSafetyError("Pi import item lacks provenance");
				const candidate: Candidate = { jobId: `import:${item.html?.globalMessageOrdinal ?? item.pi?.entryId ?? recordId}`, direction: item.direction, identityKind: item.identityKind, messageId: recordId, canonicalMessageId: item.messageId, body: item.markdown, role: isGap ? "gap" : item.direction === "in" ? "user" : "assistant", occurredAt: safeTimestamp(item.occurredAt), observedAt: safeTimestamp(item.occurredAt), updateId: null, telegramMessageIds: [], sessionId: item.pi?.sessionId ?? null, sessionEntryId: item.pi?.entryId ?? null, sessionPath: item.pi?.sourcePath ?? null, sessionEntrySha256: item.pi?.entrySha256 ?? null, sessionEntryLine: item.pi?.entryLine ?? null, sessionEntryByteOffset: item.pi?.entryByteOffset ?? null, sessionEntryByteLength: item.pi?.entryByteLength ?? null, transportCount: 0, transportCompleteness: "complete", import: importProvenance, attachments, exportStatus: item.exportStatus ?? (item.identityKind === "telegram-export-history" ? "historical-authority" : "present"), gap: item.gap };
				const previous = manifest.messages[candidate.messageId]; const predecessor = previous ? previous.predecessor : manifest.lastMessageId; const predecessorPath = predecessor ? manifest.messages[predecessor]?.path ?? null : null;
				if (predecessor && !predecessorPath) throw new ArchiveCorruptionError("Import predecessor is missing");
				const roleSlug = candidate.role === "gap" ? "gap" : candidate.role === "user" ? this.#roleSlugs.user : this.#roleSlugs.assistant;
				const relativePath = previous?.path ?? noteRelativePath(manifest, candidate, roleSlug);
				const target = resolve(this.#root, relativePath); if (!target.startsWith(`${this.#root}${sep}`)) throw new ArchiveSafetyError("Import note escaped root");
				await assertSafeAncestors(this.#root, dirname(target), rootIdentity);
				const expectedFooter = predecessor && predecessorPath ? `Previous: [[${basename(predecessorPath, ".md")}]]` : "Previous: none (conversation start)";
				const existing = await verifyExistingNote(target, candidate.messageId, expectedFooter, previous, candidate.canonicalMessageId === undefined ? candidate.messageId : candidate.canonicalMessageId);
				let rendered = note(candidate, item.pi?.sourceRootId ?? this.#rootId, predecessor, predecessorPath, 1, previous?.metadataRevision ?? 1);
				if (previous && existing !== undefined && (previous.contentSha256 !== rendered.contentSha256 || previous.metadataSha256 !== rendered.metadataSha256) && item.attachments.length) {
					const legacyAttachments = await verifiedLegacyAttachments(this.#root, rootIdentity, existing, item.attachments);
					if (legacyAttachments) { attachments = legacyAttachments; candidate.attachments = attachments; rendered = note(candidate, item.pi?.sourceRootId ?? this.#rootId, predecessor, predecessorPath, 1, previous.metadataRevision); }
				}
				if (previous && (previous.contentSha256 !== rendered.contentSha256 || previous.metadataSha256 !== rendered.metadataSha256 || existing === undefined)) throw new ArchiveCorruptionError("Published import disagrees with immutable plan");
				if (!previous && existing !== undefined && existing !== rendered.text) throw new ArchiveCorruptionError("Unmanifested import note conflicts with plan");
				for (const event of pendingMediaEvents) if (await appendMediaEvent(mediaEventPath, event, mediaState)) result.mediaEvents += 1;
				if (previous) { result.unchanged += 1; await onProgress?.(index + 1, candidate.messageId, manifest.generation); continue; }
				if (existing === undefined) await atomicWrite(target, rendered.text);
				manifest = { ...manifest, generation: manifest.generation + 1, lastMessageId: candidate.messageId, messages: { ...manifest.messages, [candidate.messageId]: { path: relativePath, predecessor, contentRevision: 1, contentSha256: rendered.contentSha256, metadataRevision: 1, metadataSha256: rendered.metadataSha256, import: importProvenance } } };
				await atomicWrite(manifestPath, `${canonical(manifest)}\n`); result.published += 1; await onProgress?.(index + 1, candidate.messageId, manifest.generation);
			}
		} finally { await lock.release(); await fsyncDirectory(stateRoot).catch(() => undefined); }
		return result;
	}

	async reconcile(records: readonly JournalRecord[], session: ReadonlySessionManager, append: (record: Extract<JournalRecord, { type: "projection_needed" | "projection_committed" | "projection_deferred" }>) => Promise<void>, signal?: AbortSignal): Promise<ProjectionResult> {
		signal?.throwIfAborted();
		await ensureOwnedRoot(this.#root);
		const stateRoot = await ensureArchiveStateRoot(this.#root);
		const rootInfo = await lstat(this.#root);
		const rootIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
		const sessionFile = session.getSessionFile();
		const sessionRoot = this.#sessionRoot ?? (sessionFile ? dirname(resolve(sessionFile)) : undefined);
		if (!sessionRoot) throw new ArchiveSafetyError("Active SessionManager has no persisted session root");
		await this.reconcileMediaEvents(records, signal);
		const mediaEvents = (await readMediaEvents(join(stateRoot, "media-events.jsonl"))).events;
		const built = await buildCandidates(records, mediaEvents, session, sessionRoot);
		for (const item of built.deferred) {
			if (!records.some((record) => record.type === "projection_deferred" && record.jobId === item.jobId && record.direction === item.direction && record.code === item.code)) await append({ type: "projection_deferred", ...item, timestamp: new Date().toISOString() });
		}
		const lockPath = join(stateRoot, "lock");
		let lock: PollerLock;
		try { lock = await PollerLock.acquire(lockPath, process.pid, this.#pidState, this.#bootIdentity); }
		catch (error) { throw new ArchiveLockedError((error as Error).message); }
		const pendingCommits: Extract<JournalRecord, { type: "projection_committed" }>[] = [];
		const result: ProjectionResult = { projected: 0, unchanged: 0, deferred: built.deferred.length };
		try {
			await removeStaleManifestTemps(stateRoot);
			const manifestPath = join(stateRoot, "manifest.json");
			let manifest = await readManifest(manifestPath) ?? emptyManifest();
			for (const candidate of built.candidates) {
				signal?.throwIfAborted();
				const previous = manifest.messages[candidate.messageId];
				candidate.import = previous?.import;
				const predecessor = previous ? previous.predecessor : manifest.lastMessageId;
				const predecessorPath = predecessor ? manifest.messages[predecessor]?.path ?? null : null;
				if (predecessor && !predecessorPath) throw new ArchiveCorruptionError("Archive predecessor is missing");
				const roleSlug = candidate.role === "user" ? this.#roleSlugs.user : candidate.role === "assistant" ? this.#roleSlugs.assistant : this.#roleSlugs.command;
				const relativePath = previous?.path ?? noteRelativePath(manifest, candidate, roleSlug);
				if (!validRelativePath(relativePath)) throw new ArchiveCorruptionError("Archive note path is invalid");
				const target = resolve(this.#root, relativePath);
				if (!target.startsWith(`${this.#root}${sep}`)) throw new ArchiveSafetyError("Archive note path escaped root");
				await assertSafeAncestors(this.#root, dirname(target), rootIdentity);
				const expectedFooter = predecessor && predecessorPath ? `Previous: [[${basename(predecessorPath, ".md")}]]` : "Previous: none (conversation start)";
				const existing = await verifyExistingNote(target, candidate.messageId, expectedFooter, previous);
				if (previous && existing === undefined) throw new ArchiveCorruptionError("Manifest note is missing");
				const initial = note(candidate, this.#rootId, predecessor, predecessorPath, previous?.contentRevision ?? 1, previous?.metadataRevision ?? 1);
				let contentRevision = previous?.contentRevision ?? 1;
				let metadataRevision = previous?.metadataRevision ?? 1;
				if (previous && previous.contentSha256 !== initial.contentSha256) throw new ArchiveCorruptionError("Canonical Pi content changed under a stable identity");
				if (previous && previous.metadataSha256 !== initial.metadataSha256) metadataRevision += 1;
				const rendered = note(candidate, this.#rootId, predecessor, predecessorPath, contentRevision, metadataRevision);
				if (previous && previous.contentSha256 === rendered.contentSha256 && previous.metadataSha256 === rendered.metadataSha256) {
					const committed = records.some((record) => record.type === "projection_committed" && record.messageId === candidate.messageId && record.contentRevision === contentRevision && record.contentSha256 === rendered.contentSha256 && record.metadataRevision === metadataRevision && record.metadataSha256 === rendered.metadataSha256);
					if (!committed) pendingCommits.push({ type: "projection_committed", jobId: candidate.jobId, direction: candidate.direction, messageId: candidate.messageId, contentRevision, contentSha256: rendered.contentSha256, metadataRevision, metadataSha256: rendered.metadataSha256, timestamp: new Date().toISOString() });
					result.unchanged += 1;
					continue;
				}
				await append({ type: "projection_needed", jobId: candidate.jobId, direction: candidate.direction, reason: previous?.contentSha256 === rendered.contentSha256 ? "metadata" : "content", canonical: candidate.sessionId ? { kind: "pi", sessionId: candidate.sessionId, entryId: candidate.sessionEntryId! } : { kind: "local-response" }, timestamp: new Date().toISOString() });
				if (!previous && existing !== undefined && existing !== rendered.text) throw new ArchiveCorruptionError("Unmanifested note conflicts with authoritative projection");
				if (previous || existing === undefined) {
					await assertSafeAncestors(this.#root, dirname(target), rootIdentity);
					await atomicWrite(target, rendered.text);
					await assertSafeAncestors(this.#root, dirname(target), rootIdentity);
				}
				manifest = { ...manifest, generation: manifest.generation + 1, lastMessageId: previous ? manifest.lastMessageId : candidate.messageId, messages: { ...manifest.messages, [candidate.messageId]: { path: relativePath, predecessor, contentRevision, contentSha256: rendered.contentSha256, metadataRevision, metadataSha256: rendered.metadataSha256, ...(candidate.import ? { import: candidate.import } : {}) } } };
				await atomicWrite(manifestPath, `${canonical(manifest)}\n`);
				pendingCommits.push({ type: "projection_committed", jobId: candidate.jobId, direction: candidate.direction, messageId: candidate.messageId, contentRevision, contentSha256: rendered.contentSha256, metadataRevision, metadataSha256: rendered.metadataSha256, timestamp: new Date().toISOString() });
				result.projected += 1;
			}
		} finally {
			await lock.release();
			await fsyncDirectory(stateRoot).catch(() => undefined);
		}
		for (const commit of pendingCommits) await append(commit);
		return result;
	}
}

