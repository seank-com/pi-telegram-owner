import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parse } from "parse5";
import { parse as parseYaml } from "yaml";

import { TelegramMarkdownProjector, type PublicationResult } from "./markdown-projector.ts";
import { markdownCompatibilityKey, markdownToPlainText, TELEGRAM_FORMAT_COMPAT_VERSION, telegramSafeHref } from "./format.ts";

export const IMPORTER_VERSION = "telegram-desktop-pi-v2" as const;
export const HTML_COMPAT_VERSION = "telegram-desktop-html-compat-v1" as const;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_HTML_NODES = 200_000;
const MAX_HTML_DEPTH = 64;
const MAX_MESSAGES = 250_000;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_SESSION_BYTES = 512 * 1024 * 1024;
const MAX_SESSION_FILES = 10_000;
export const DEFAULT_CHUNK_CANDIDATE_GAP_MS = 2_000;
export const DEFAULT_CHUNK_CANDIDATE_MIN_LENGTH = 3_500;

export type Direction = "in" | "out";

export interface SourceSetManifest {
	schema: "pi-telegram-owner/source-set/v1";
	sourceSetId: string;
	pages: Array<{ path: string; size: number; sha256: string }>;
	messageCount: number;
}

export interface BoundaryManifest {
	schema: "pi-telegram-owner/first-pi-boundary/v1";
	sourceSetManifestSha256: string;
	firstPi: { sessionId: string; entryId: string; globalMessageOrdinal: number; direction: Direction; compatibility: typeof TELEGRAM_FORMAT_COMPAT_VERSION; normalizedSha256: string; matchKind: "markdown-semantic" | "raw-source-text" };
	admittedPiSessionIds: string[];
}

export interface SpeakerMap {
	schema: "pi-telegram-owner/speaker-map/v1";
	revision: number;
	speakers: Record<string, Direction>;
}

export interface HistoricalMessage {
	globalMessageOrdinal: number;
	page: string;
	pageSha256: string;
	direction: Direction;
	occurredAt: string;
	markdown: string;
	sourceText: string;
	photoPaths: string[];
	sourceRange: { startOffset: number; endOffset: number; startLine: number; startCol: number; endLine: number; endCol: number };
}

export interface PiImportMessage {
	sessionId: string;
	entryId: string;
	parentId: string | null;
	direction: Direction;
	timestamp: string;
	markdown: string;
	transportStrippedMarkdown?: string;
	transportJobId?: string;
	sourceRootId: string;
	sourcePath: string;
	entryLine: number;
	entryByteOffset: number;
	entryByteLength: number;
	entrySha256: string;
}

export interface ImportPlanItem {
	recordId?: string;
	messageId: string | null;
	identityKind: "telegram-export-history" | "pi-session-entry" | "telegram-export-gap";
	direction: Direction;
	markdown: string;
	occurredAt: string;
	confidence: "historical-html-sequence" | "exact-pi" | "unresolved-html";
	exportStatus: "historical-authority" | "present" | "missing" | "unresolved";
	html?: { page: string; globalMessageOrdinal: number; pageSha256: string; sourceRange: HistoricalMessage["sourceRange"]; sourceTextSha256: string };
	htmlSegments?: Array<{ page: string; globalMessageOrdinal: number; pageSha256: string; sourceRange: HistoricalMessage["sourceRange"]; sourceTextSha256: string }>;
	gap?: { kind: "html-unresolved" | "html-ambiguous"; startHtmlOrdinal: number; endHtmlOrdinal: number; sources: Array<{ page: string; pageSha256: string; globalMessageOrdinal: number; compatibilityKeySha256: string; sourceRange: HistoricalMessage["sourceRange"]; attachmentSha256: string[] }> };
	pi?: Omit<PiImportMessage, "markdown" | "direction" | "timestamp">;
	attachments: Array<{ sourcePath: string; sha256: string; mimeType: string; size: number }>;
}

export interface ChunkBoundaryCandidate {
	leftGlobalMessageOrdinal: number;
	rightGlobalMessageOrdinal: number;
	direction: Direction;
	gapMs: number;
	leftMarkdownLength: number;
	rightMarkdownLength: number;
	leftCompatibilityKeySha256: string;
	rightCompatibilityKeySha256: string;
	signals: Array<"adjacent-same-direction" | "gap-within-threshold" | "source-text-length-at-least-threshold">;
	exactPiReconstruction?: { sessionId: string; entryId: string; separator: "none" | "space" | "newline" | "blank-line"; reconstructedSha256: string };
}

export interface ImportReport {
	schema: "pi-telegram-owner/import-report/v1";
	importer: typeof IMPORTER_VERSION;
	sourceSetId: string;
	sourceSetManifestSha256: string;
	boundaryOrdinal: number;
	historical: number;
	piAligned: number;
	unresolvedPostBoundary: number;
	ambiguous: number;
	coverageMissing: number;
	chunkCandidates: ChunkBoundaryCandidate[];
	gaps: Array<{ kind: "html-unresolved" | "html-ambiguous" | "pi-unmatched"; startHtmlOrdinal: number | null; endHtmlOrdinal: number | null; piEntryIds: string[] }>;
	items: ImportPlanItem[];
	publication?: PublicationResult;
}

export interface ImportOptions {
	exportRoot: string;
	sourceSetManifestPath: string;
	boundaryManifestPath: string;
	speakerMapPath: string;
	piSessionRoot: string;
	piSessionRootId: string;
	piSessionPaths: string[];
	journalPath?: string;
	archiveRoot?: string;
	checkpointPath: string;
	dryRun?: boolean;
	roleSlugs?: { user: string; assistant: string; command: string };
	lookahead?: number;
	chunkCandidateGapMs?: number;
	chunkCandidateMinLength?: number;
	deadlineMs?: number;
	htmlPiTimestampOffsetsMs?: number[];
	signal?: AbortSignal;
}

export class ImportValidationError extends Error {
	readonly code: string;
	constructor(code: string, message = code) { super(message); this.code = code; }
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function normalized(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function comparisonKey(value: string): string { const current = normalized(value); return current.trim() ? markdownCompatibilityKey(current) : "telegram-empty-markdown/v1"; }
function compactRenderedText(value: string): string { return markdownToPlainText(value).replace(/\s+/g, " ").trim(); }
function fingerprint(value: string): string { return hash(value.trim()); }
function safeId(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new ImportValidationError("MANIFEST_INVALID", `${label} is invalid`);
	return value;
}
function validHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(","); }

function strictJson(text: string): unknown {
	let value: unknown;
	try { value = JSON.parse(text); parseYaml(text, { schema: "json", uniqueKeys: true }); }
	catch { throw new ImportValidationError("MANIFEST_INVALID", "JSON is malformed or contains duplicate keys"); }
	return value;
}

async function protectedJson(path: string, maxBytes = 4 * 1024 * 1024): Promise<{ value: unknown; bytes: Buffer; sha256: string }> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new ImportValidationError("SOURCE_UNSAFE", "Protected manifest is unsafe");
		const bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new ImportValidationError("SOURCE_CHANGED");
		return { value: strictJson(bytes.toString("utf8")), bytes, sha256: hash(bytes) };
	} finally { await handle.close(); }
}

async function safeSource(root: string, relativePath: string, maxBytes: number): Promise<{ path: string; bytes: Buffer; info: Awaited<ReturnType<typeof lstat>> }> {
	if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new ImportValidationError("SOURCE_UNSAFE");
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid())) throw new ImportValidationError("SOURCE_UNSAFE");
	let componentPath = resolve(root);
	for (const component of relativePath.split(/[\\/]/).slice(0, -1)) {
		componentPath = join(componentPath, component);
		const componentInfo = await lstat(componentPath);
		if (!componentInfo.isDirectory() || componentInfo.isSymbolicLink() || (process.getuid && componentInfo.uid !== process.getuid())) throw new ImportValidationError("SOURCE_UNSAFE");
	}
	const rootReal = await realpath(root);
	const candidate = resolve(root, relativePath);
	const candidateReal = await realpath(candidate);
	if (relative(rootReal, candidateReal).startsWith("..") || relative(rootReal, candidateReal) === "") throw new ImportValidationError("SOURCE_UNSAFE");
	const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (process.getuid && before.uid !== process.getuid())) throw new ImportValidationError("SOURCE_UNSAFE");
		const bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new ImportValidationError("SOURCE_CHANGED");
		return { path: candidateReal, bytes, info: before };
	} finally { await handle.close(); }
}

interface JournalCorrelation { sessionId: string; text: string; replyText?: string; }
async function readJournal(path: string | undefined): Promise<{ correlations: Map<string, JournalCorrelation>; identity: { size: number; sha256: string } | null }> {
	if (!path) return { correlations: new Map(), identity: null };
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new ImportValidationError("JOURNAL_UNSAFE");
		const bytes = await handle.readFile(); const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || !bytes.toString("utf8").endsWith("\n")) throw new ImportValidationError("JOURNAL_CHANGED");
		const updates = new Map<string, string>(); const batches = new Map<string, { revision: number; text: string }>(); const dispatches = new Map<string, string>(); const replies = new Map<string, string>();
		for (const line of bytes.toString("utf8").slice(0, -1).split("\n")) {
			const record = strictJson(line) as any;
			if (record?.type === "update" && record.disposition === "accepted" && typeof record.jobId === "string" && typeof record.text === "string") {
				if (updates.has(record.jobId) && updates.get(record.jobId) !== record.text) throw new ImportValidationError("JOURNAL_CORRUPT"); updates.set(record.jobId, record.text);
			} else if (record?.type === "inbound_batch" && record.schemaVersion === 1 && typeof record.batchId === "string" && Number.isSafeInteger(record.revision) && typeof record.text === "string") {
				const previous = batches.get(record.batchId); if (previous && record.revision !== previous.revision + 1) throw new ImportValidationError("JOURNAL_CORRUPT"); batches.set(record.batchId, { revision: record.revision, text: record.text });
			} else if (record?.type === "dispatched" && typeof record.jobId === "string" && typeof record.sessionId === "string") {
				if (dispatches.has(record.jobId) && dispatches.get(record.jobId) !== record.sessionId) throw new ImportValidationError("JOURNAL_CORRUPT"); dispatches.set(record.jobId, record.sessionId);
			} else if (record?.type === "reply_ready" && typeof record.jobId === "string" && typeof record.text === "string") {
				if (replies.has(record.jobId) && replies.get(record.jobId) !== record.text) throw new ImportValidationError("JOURNAL_CORRUPT"); replies.set(record.jobId, record.text);
			}
		}
		const correlations = new Map<string, JournalCorrelation>();
		for (const [jobId, sessionId] of dispatches) { const text = updates.get(jobId) ?? batches.get(jobId)?.text; if (text !== undefined) correlations.set(jobId, { sessionId, text, ...(replies.has(jobId) ? { replyText: replies.get(jobId)! } : {}) }); }
		return { correlations, identity: { size: bytes.length, sha256: hash(bytes) } };
	} finally { await handle.close(); }
}

function attrs(node: any): Record<string, string> { return Object.fromEntries((node.attrs ?? []).map((item: any) => [String(item.name).toLowerCase(), String(item.value)])); }
function classes(node: any): Set<string> { return new Set((attrs(node).class ?? "").split(/\s+/).filter(Boolean)); }
function element(node: any, tag?: string, className?: string): boolean {
	return node?.nodeName !== "#text" && (!tag || node.tagName === tag) && (!className || classes(node).has(className));
}
function descendants(node: any, predicate: (candidate: any) => boolean, found: any[] = [], depth = 0, count = { value: 0 }): any[] {
	count.value += 1;
	if (count.value > MAX_HTML_NODES || depth > MAX_HTML_DEPTH) throw new ImportValidationError("HTML_LIMIT_EXCEEDED");
	if (predicate(node)) found.push(node);
	for (const child of node.childNodes ?? []) descendants(child, predicate, found, depth + 1, count);
	return found;
}
function first(node: any, predicate: (candidate: any) => boolean): any | undefined { return descendants(node, predicate, []).at(0); }
function textContent(node: any): string { return node?.nodeName === "#text" ? String(node.value ?? "") : (node?.childNodes ?? []).map(textContent).join(""); }
function semanticText(node: any): string { return node?.nodeName === "#text" ? String(node.value ?? "") : node?.tagName === "br" ? "\n" : (node?.childNodes ?? []).map(semanticText).join(""); }
function requireAttributes(node: any, allowed: string[]): void {
	const keys = Object.keys(attrs(node));
	if (keys.some((key) => !allowed.includes(key))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", "Unexpected HTML attribute");
}
const REVIEWED_DIV_CLASS_SETS = new Set([
	"", "body", "body forwarded", "bot_button", "bot_button_column_separator", "date", "date details", "from_name", "clearfix media_wrap", "pull_left userpic_wrap", "date details pull_right",
	"details reply_to", "forwarded pull_left userpic_wrap", "text", "initials", "initials userpic",
]);
function classKey(node: any): string { return [...classes(node)].sort().join(" "); }
function validateMessageBlock(block: any): void {
	const nodes = descendants(block, () => true, []);
	for (const node of nodes) {
		if (node.nodeName === "#comment") throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", "Comments inside messages are unsupported");
		if (node.nodeName === "#text") continue;
		if (!node.sourceCodeLocation) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", "Message node has no source span");
		const tag = String(node.tagName ?? "");
		if (tag === "div") {
			const set = classes(node);
			if (node === block) {
				requireAttributes(node, ["class", "id"]);
				if (!set.has("message") || !set.has("default") || [...set].some((name) => !["message", "default", "joined", "clearfix"].includes(name))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
			} else {
				requireAttributes(node, ["class", "title", "style"]);
				if (!REVIEWED_DIV_CLASS_SETS.has(classKey(node)) && !/^userpic userpic\d+$/.test(classKey(node))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", `Unexpected message wrapper: ${classKey(node)}`);
			}
		} else if (["strong", "b", "em", "i", "s", "code", "pre", "blockquote", "br", "tbody", "tr"].includes(tag)) requireAttributes(node, []);
		else if (tag === "table") { requireAttributes(node, ["class"]); if (classKey(node) !== "bot_buttons_table") throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED"); }
		else if (tag === "td") { requireAttributes(node, ["class"]); if (classKey(node) !== "bot_button_row") throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED"); }
		else if (tag === "span") requireAttributes(node, ["class", "onclick", "title", "aria-hidden"]);
		else if (tag === "a") { requireAttributes(node, ["class", "href", "onclick", "style", '=\"\"']); if (classes(node).size && [...classes(node)].some((name) => !["photo_wrap", "sticker_wrap", "clearfix", "pull_left"].includes(name))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED"); }
		else if (tag === "img") { requireAttributes(node, ["class", "src", "style"]); if ([...classes(node)].some((name) => !["photo", "sticker"].includes(name))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED"); }
		else throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", `Unexpected message element: ${tag}`);
	}
}
function validateServiceBlock(block: any): void {
	requireAttributes(block, ["class", "id"]);
	if (![...classes(block)].every((name) => ["message", "service"].includes(name))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
	for (const node of descendants(block, () => true, [])) {
		if (node.nodeName === "#text") continue;
		if (node.nodeName === "#comment" || !node.sourceCodeLocation || node.tagName !== "div") throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
		if (node !== block) { requireAttributes(node, ["class", "title"]); if (!["body", "body details", "date details", "text"].includes(classKey(node))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED"); }
	}
}
function escapeMarkdown(value: string): string {
	return value.replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\$1").replace(/^ {4,}/gm, (spaces) => `&#32;${spaces.slice(1)}`);
}
function telegramExportTimestamp(value: string): string {
	const desktop = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC([+-])(\d{2}):(\d{2})$/.exec(value);
	if (desktop) {
		const day = Number(desktop[1]); const month = Number(desktop[2]); const year = Number(desktop[3]); const hour = Number(desktop[4]); const minute = Number(desktop[5]); const second = Number(desktop[6]); const offsetHour = Number(desktop[8]); const offsetMinute = Number(desktop[9]);
		const calendar = new Date(Date.UTC(year, month - 1, day));
		if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw new ImportValidationError("HTML_DATE_INVALID");
		const parsed = new Date(`${desktop[3]}-${desktop[2]}-${desktop[1]}T${desktop[4]}:${desktop[5]}:${desktop[6]}${desktop[7]}${desktop[8]}:${desktop[9]}`);
		if (!Number.isFinite(parsed.valueOf())) throw new ImportValidationError("HTML_DATE_INVALID");
		return parsed.toISOString();
	}
	const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!iso) throw new ImportValidationError("HTML_DATE_INVALID");
	const year = Number(iso[1]); const month = Number(iso[2]); const day = Number(iso[3]); const hour = Number(iso[4]); const minute = Number(iso[5]); const second = Number(iso[6]); const calendar = new Date(Date.UTC(year, month - 1, day));
	const parsed = new Date(value);
	if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(parsed.valueOf())) throw new ImportValidationError("HTML_DATE_INVALID");
	return parsed.toISOString();
}

function codeSpan(value: string): string {
	const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longest + 1);
	const padded = /^[ `]|[ `]$/.test(value) ? ` ${value} ` : value;
	return `${fence}${padded}${fence}`;
}
function codeBlock(value: string): string {
	const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${normalized(value)}${value.endsWith("\n") ? "" : "\n"}${fence}\n`;
}
function delimited(marker: string, value: string): string {
	const leading = /^\s*/.exec(value)?.[0] ?? ""; const trailing = /\s*$/.exec(value)?.[0] ?? "";
	const core = value.slice(leading.length, value.length - trailing.length);
	return core ? `${leading}${marker}${core}${marker}${trailing}` : value;
}

function serializeHtml(node: any, context: "text" | "pre" = "text"): string {
	if (node.nodeName === "#text") return context === "pre" ? String(node.value ?? "") : escapeMarkdown(String(node.value ?? ""));
	const tag = String(node.tagName ?? "").toLowerCase();
	const attributes = attrs(node);
	const children = () => (node.childNodes ?? []).map((child: any) => serializeHtml(child, context)).join("");
	if (!tag) return children();
	if (tag === "br") return "\n";
	if (tag === "strong" || tag === "b") return delimited("**", children());
	if (tag === "em" || tag === "i") return delimited("*", children());
	if (tag === "s") return delimited("~~", children());
	if (tag === "code" && context !== "pre") return codeSpan(textContent(node));
	if (tag === "pre") {
		if (Object.keys(attributes).length) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
		const child = node.childNodes ?? [];
		if (child.length === 1 && element(child[0], "code") && Object.keys(attrs(child[0])).length === 0) return codeBlock(textContent(child[0]));
		if (child.some((item: any) => item.nodeName !== "#text" && !element(item, "br"))) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
		return codeBlock(semanticText(node));
	}
	if (tag === "blockquote") return children().split("\n").map((line: string) => `> ${line}`).join("\n");
	if (tag === "a") {
		const label = children();
		const href = attributes.href ?? "";
		if ((!href && attributes.onclick) || (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//"))) return label;
		if (!telegramSafeHref(href)) {
			if (/^(?:https?|mailto|tel):/i.test(href)) return label;
			throw new ImportValidationError("HTML_LINK_UNSAFE");
		}
		return `[${label}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
	}
	if (tag === "span" && classes(node).has("spoiler") && Object.keys(attributes).every((key) => key === "class" || key === "onclick")) return `||${children()}||`;
	if (tag === "span" && attributes["aria-hidden"] === "true" && Object.keys(attributes).length === 1) return children();
	throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED", `Unsupported text tag: ${tag}`);
}

async function attachment(root: string, pagePath: string, href: string): Promise<ImportPlanItem["attachments"][number]> {
	const decoded = decodeURIComponent(href);
	if (!decoded || isAbsolute(decoded) || decoded.split(/[\\/]/).includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) throw new ImportValidationError("ATTACHMENT_UNSAFE");
	const relativePath = join(dirname(pagePath), decoded);
	const source = await safeSource(root, relativePath, 10 * 1024 * 1024);
	const bytes = source.bytes;
	let mimeType: string | undefined; let width = 0; let height = 0;
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
		mimeType = "image/png"; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
	} else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		mimeType = "image/jpeg";
		for (let offset = 2; offset + 9 < bytes.length;) {
			if (bytes[offset] !== 0xff) throw new ImportValidationError("ATTACHMENT_UNSAFE");
			const marker = bytes[offset + 1]!; if (marker === 0xd9 || marker === 0xda) break;
			const length = bytes.readUInt16BE(offset + 2); if (length < 2 || offset + 2 + length > bytes.length) throw new ImportValidationError("ATTACHMENT_UNSAFE");
			if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
			offset += 2 + length;
		}
	} else if (bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" && bytes.subarray(12, 16).toString("ascii") === "VP8X") {
		mimeType = "image/webp"; width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
	}
	if (!mimeType || width < 1 || height < 1 || width > 10_000 || height > 10_000 || width * height > 40_000_000) throw new ImportValidationError("ATTACHMENT_UNSAFE");
	return { sourcePath: relativePath.split(sep).join("/"), sha256: hash(bytes), mimeType, size: bytes.length };
}

async function parsePages(root: string, manifest: SourceSetManifest, speakers: SpeakerMap, deadline: number, signal?: AbortSignal): Promise<{ messages: HistoricalMessage[]; attachments: Map<number, ImportPlanItem["attachments"]> }> {
	const messages: HistoricalMessage[] = [];
	const attachments = new Map<number, ImportPlanItem["attachments"]>();
	for (const page of manifest.pages) {
		let inheritedSpeaker: string | undefined;
		signal?.throwIfAborted();
		if (Date.now() > deadline) throw new ImportValidationError("TIMEOUT");
		const source = await safeSource(root, page.path, MAX_PAGE_BYTES);
		if (source.info.size !== page.size || hash(source.bytes) !== page.sha256) throw new ImportValidationError("SOURCE_CHANGED");
		const htmlText = source.bytes.toString("utf8");
		if (htmlText.includes("\uFFFD")) throw new ImportValidationError("HTML_INVALID_UTF8");
		const document = parse(htmlText, { sourceCodeLocationInfo: true }) as any;
		const blocks = descendants(document, (node) => element(node, "div", "message"));
		for (const block of blocks) {
			if (classes(block).has("service")) { validateServiceBlock(block); continue; }
			if (!classes(block).has("default")) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
			validateMessageBlock(block);
			const senderNode = first(block, (node) => element(node, "div", "from_name"));
			const joined = classes(block).has("joined");
			if (senderNode) inheritedSpeaker = fingerprint(textContent(senderNode));
			else if (!joined || !inheritedSpeaker) throw new ImportValidationError("DIRECTION_UNKNOWN");
			const direction = speakers.speakers[inheritedSpeaker!];
			if (!direction) throw new ImportValidationError("DIRECTION_UNKNOWN");
			const textNode = first(block, (node) => element(node, "div", "text"));
			const textChildren = [...(textNode?.childNodes ?? [])];
			while (textChildren[0]?.nodeName === "#text" && /^\s*$/.test(String(textChildren[0].value ?? ""))) textChildren.shift();
			while (textChildren.at(-1)?.nodeName === "#text" && /^\s*$/.test(String(textChildren.at(-1).value ?? ""))) textChildren.pop();
			const markdown = textNode ? normalized(textChildren.map((child: any) => serializeHtml(child)).join("")).trim() : "";
			if (textNode) markdownToPlainText(markdown);
			const dateNode = first(block, (node) => element(node, "div", "date"));
			const date = attrs(dateNode ?? {}).title;
			if (!date) throw new ImportValidationError("HTML_DATE_INVALID");
			const occurredAt = telegramExportTimestamp(date);
			const ordinal = messages.length + 1;
			const photos: string[] = [];
			const planned: ImportPlanItem["attachments"] = [];
			for (const link of descendants(block, (node) => element(node, "a") && (classes(node).has("photo_wrap") || classes(node).has("sticker_wrap")))) {
				const href = attrs(link).href;
				if (!href) throw new ImportValidationError("ATTACHMENT_UNSAFE");
				photos.push(href);
				planned.push(await attachment(root, page.path, href));
			}
			if (planned.length) attachments.set(ordinal, planned);
			const location = block.sourceCodeLocation;
			if (![location?.startOffset, location?.endOffset, location?.startLine, location?.startCol, location?.endLine, location?.endCol].every(Number.isSafeInteger)) throw new ImportValidationError("HTML_STRUCTURE_UNSUPPORTED");
			messages.push({ globalMessageOrdinal: ordinal, page: page.path, pageSha256: page.sha256, direction, occurredAt, markdown, sourceText: textNode ? normalized(semanticText(textNode)).trim() : "", photoPaths: photos, sourceRange: { startOffset: Buffer.byteLength(htmlText.slice(0, location.startOffset)), endOffset: Buffer.byteLength(htmlText.slice(0, location.endOffset)), startLine: location.startLine, startCol: location.startCol, endLine: location.endLine, endCol: location.endCol } });
			if (messages.length > MAX_MESSAGES) throw new ImportValidationError("LIMIT_EXCEEDED");
		}
	}
	if (messages.length !== manifest.messageCount) throw new ImportValidationError("SOURCE_SET_INVALID", "Validated message count differs from manifest");
	return { messages, attachments };
}

async function selectedPiSessionPaths(root: string, requested: string[]): Promise<string[]> {
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid())) throw new ImportValidationError("SOURCE_UNSAFE", "Pi session root is unsafe");
	if (new Set(requested).size !== requested.length) throw new ImportValidationError("OPTIONS_INVALID", "Pi session paths must be unique");
	let paths = [...requested];
	if (!paths.length) {
		const entries = await readdir(root, { withFileTypes: true });
		paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name).sort();
		if (entries.some((entry) => entry.isSymbolicLink() && entry.name.endsWith(".jsonl"))) throw new ImportValidationError("SOURCE_UNSAFE", "Pi session root contains a symlinked JSONL source");
	}
	if (!paths.length) throw new ImportValidationError("PI_SESSION_COVERAGE_UNSUPPORTED", "Pi session root contains no selected JSONL files");
	if (paths.length > MAX_SESSION_FILES) throw new ImportValidationError("LIMIT_EXCEEDED", "Pi session file count exceeds the importer limit");
	return paths;
}

function linearPiSession(messages: PiImportMessage[]): PiImportMessage[] {
	if (!messages.length) return [];
	const children = new Map<string | null, PiImportMessage[]>();
	for (const message of messages) children.set(message.parentId, [...(children.get(message.parentId) ?? []), message]);
	if ((children.get(null) ?? []).length !== 1 || [...children.values()].some((items) => items.length > 1)) throw new ImportValidationError("PI_BRANCH_AMBIGUOUS");
	const ordered: PiImportMessage[] = [];
	let current = children.get(null)![0];
	while (current) {
		ordered.push(current);
		current = (children.get(current.entryId) ?? [])[0];
	}
	if (ordered.length !== messages.length) throw new ImportValidationError("PARENT_CHAIN_INVALID");
	return ordered;
}

async function readPiSessions(root: string, rootId: string, requestedPaths: string[], admittedSessionIds: string[], correlations: Map<string, JournalCorrelation>, deadline: number, signal?: AbortSignal): Promise<{ messages: PiImportMessage[]; files: Array<{ path: string; size: number; sha256: string }> }> {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(rootId)) throw new ImportValidationError("OPTIONS_INVALID", "Pi session rootId is invalid");
	const paths = await selectedPiSessionPaths(root, requestedPaths);
	const admitted = new Set(admittedSessionIds);
	const sessions: Array<{ sessionId: string; firstTimestamp: number; lastTimestamp: number; messages: PiImportMessage[] }> = [];
	const sessionIds = new Set<string>();
	const files: Array<{ path: string; size: number; sha256: string }> = [];
	let totalBytes = 0; let totalMessages = 0;
	for (const path of paths) {
		signal?.throwIfAborted();
		if (Date.now() > deadline) throw new ImportValidationError("TIMEOUT");
		const source = await safeSource(root, path, MAX_SESSION_BYTES);
		totalBytes += source.bytes.length;
		if (totalBytes > MAX_TOTAL_SESSION_BYTES) throw new ImportValidationError("LIMIT_EXCEEDED", "Combined Pi session bytes exceed the importer limit");
		const lines = source.bytes.toString("utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		const offsets: number[] = []; let offset = 0;
		for (const line of lines) { offsets.push(offset); offset += Buffer.byteLength(line) + 1; }
		if (!lines.length) throw new ImportValidationError("PI_SESSION_CORRUPT");
		let header: any;
		try { header = strictJson(lines[0]!); } catch { throw new ImportValidationError("PI_SESSION_CORRUPT"); }
		if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(header.id)) throw new ImportValidationError("PI_FORMAT_UNSUPPORTED");
		if (!admitted.has(header.id)) continue;
		if (sessionIds.has(header.id)) throw new ImportValidationError("PI_SESSION_DUPLICATE", "Pi session ID appears in more than one source file");
		sessionIds.add(header.id);
		files.push({ path, size: source.bytes.length, sha256: hash(source.bytes) });
		const ids = new Set<string>();
		const nearestMessage = new Map<string, string | null>();
		const sessionMessages: PiImportMessage[] = [];
		for (let index = 1; index < lines.length; index++) {
			if ((index & 1023) === 0) { signal?.throwIfAborted(); if (Date.now() > deadline) throw new ImportValidationError("TIMEOUT"); }
			let entry: any;
			try { entry = strictJson(lines[index]!); } catch { throw new ImportValidationError("PI_SESSION_CORRUPT"); }
			if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(entry.id) || ids.has(entry.id) || typeof entry.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(entry.timestamp)) throw new ImportValidationError("PI_SESSION_CORRUPT");
			let piTimestamp: string; try { piTimestamp = telegramExportTimestamp(entry.timestamp); } catch { throw new ImportValidationError("PI_SESSION_CORRUPT", "Pi entry timestamp is invalid"); }
			if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) throw new ImportValidationError("PARENT_CHAIN_INVALID");
			ids.add(entry.id);
			const conversationalParent = entry.parentId === null ? null : nearestMessage.get(entry.parentId) ?? null;
			if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) { nearestMessage.set(entry.id, conversationalParent); continue; }
			nearestMessage.set(entry.id, entry.id);
			const content = entry.message.content;
			let markdown = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("") : undefined;
			if (markdown === undefined) throw new ImportValidationError("PI_SESSION_CORRUPT");
			let transportStrippedMarkdown: string | undefined; let transportJobId: string | undefined;
			if (entry.message.role === "user") {
				const marker = /^\[(?:telegram-job|telegram-batch):([A-Za-z0-9._:-]{1,128})\]\n/.exec(markdown);
				if (marker) {
					const markerJobId = marker[1]!;
					const remainder = markdown.slice(marker[0].length); const correlation = correlations.get(markerJobId);
					if (correlation && correlation.sessionId === header.id && remainder === correlation.text) { markdown = correlation.text; transportJobId = markerJobId; }
					else if (correlation) throw new ImportValidationError("JOURNAL_CORRELATION_CONFLICT");
					else transportStrippedMarkdown = remainder;
				}
			}
			totalMessages++;
			if (totalMessages > MAX_MESSAGES) throw new ImportValidationError("LIMIT_EXCEEDED", "Combined Pi conversational entries exceed the importer limit");
			sessionMessages.push({ sessionId: header.id, entryId: entry.id, parentId: conversationalParent, direction: entry.message.role === "user" ? "in" : "out", timestamp: piTimestamp, markdown, ...(transportStrippedMarkdown === undefined ? {} : { transportStrippedMarkdown }), ...(transportJobId === undefined ? {} : { transportJobId }), sourceRootId: rootId, sourcePath: path, entryLine: index + 1, entryByteOffset: offsets[index]!, entryByteLength: Buffer.byteLength(lines[index]!), entrySha256: hash(lines[index]!) });
		}
		const ordered = linearPiSession(sessionMessages);
		let imported = ordered;
		if (correlations.size) {
			imported = [];
			for (let index = 0; index < ordered.length; index++) {
				const user = ordered[index]!;
				if (user.direction !== "in" || !user.transportJobId) continue;
				const correlation = correlations.get(user.transportJobId);
				if (!correlation || correlation.sessionId !== header.id) continue;
				imported.push(user);
				if (correlation.replyText === undefined) continue;
				let end = index + 1;
				while (end < ordered.length && ordered[end]!.direction !== "in") end++;
				const matches = ordered.slice(index + 1, end).filter((candidate) => candidate.direction === "out" && candidate.markdown === correlation.replyText);
				if (matches.length > 1) throw new ImportValidationError("PI_ASSISTANT_ENTRY_AMBIGUOUS", "Durable Telegram reply matches more than one assistant entry in its Pi turn");
				if (matches.length === 1) imported.push({ ...matches[0]!, transportJobId: user.transportJobId });
			}
		}
		const timestamps = imported.map((message) => new Date(message.timestamp).valueOf());
		if (timestamps.some((timestamp, index) => index > 0 && timestamp < timestamps[index - 1]!)) throw new ImportValidationError("PI_SESSION_ORDER_AMBIGUOUS", "Pi message timestamps regress along the parent chain");
		if (imported.length) sessions.push({ sessionId: header.id, firstTimestamp: timestamps[0]!, lastTimestamp: timestamps[timestamps.length - 1]!, messages: imported });
	}
	if (sessionIds.size !== admitted.size) throw new ImportValidationError("PI_SESSION_COVERAGE_UNSUPPORTED", "Not every admitted Pi session ID has one selected source file");
	sessions.sort((a, b) => a.firstTimestamp - b.firstTimestamp || a.sessionId.localeCompare(b.sessionId));
	if (sessions.some((session, index) => index > 0 && session.firstTimestamp <= sessions[index - 1]!.lastTimestamp)) throw new ImportValidationError("PI_SESSION_ORDER_AMBIGUOUS", "Pi session time ranges overlap or tie");
	return { messages: sessions.flatMap((session) => session.messages), files };
}

function validateManifests(source: unknown, boundary: unknown, speaker: unknown, sourceHash: string): { source: SourceSetManifest; boundary: BoundaryManifest; speaker: SpeakerMap } {
	const s = source as SourceSetManifest;
	if (s?.schema !== "pi-telegram-owner/source-set/v1" || !exactKeys(s as unknown as Record<string, unknown>, ["schema", "sourceSetId", "pages", "messageCount"]) || !Array.isArray(s.pages) || !Number.isSafeInteger(s.messageCount) || s.messageCount < 0) throw new ImportValidationError("SOURCE_SET_INVALID");
	safeId(s.sourceSetId, "sourceSetId");
	for (const page of s.pages) if (!page || !exactKeys(page as unknown as Record<string, unknown>, ["path", "size", "sha256"]) || typeof page.path !== "string" || !Number.isSafeInteger(page.size) || page.size < 0 || !validHash(page.sha256)) throw new ImportValidationError("SOURCE_SET_INVALID");
	const rawBoundary = boundary as BoundaryManifest;
	const boundaryKeys = ["schema", "sourceSetManifestSha256", "firstPi", "admittedPiSessionIds"];
	const firstPiKeys = ["sessionId", "entryId", "globalMessageOrdinal", "direction", "compatibility", "normalizedSha256", "matchKind"];
	if (!rawBoundary || rawBoundary.schema !== "pi-telegram-owner/first-pi-boundary/v1" || !exactKeys(rawBoundary as unknown as Record<string, unknown>, boundaryKeys) || rawBoundary.sourceSetManifestSha256 !== sourceHash || !rawBoundary.firstPi || !exactKeys(rawBoundary.firstPi as unknown as Record<string, unknown>, firstPiKeys) || rawBoundary.firstPi.compatibility !== TELEGRAM_FORMAT_COMPAT_VERSION || !["markdown-semantic", "raw-source-text"].includes(rawBoundary.firstPi.matchKind) || !Number.isSafeInteger(rawBoundary.firstPi.globalMessageOrdinal) || rawBoundary.firstPi.globalMessageOrdinal < 1 || !validHash(rawBoundary.firstPi.normalizedSha256) || !["in", "out"].includes(rawBoundary.firstPi.direction)) throw new ImportValidationError("BOUNDARY_INVALID");
	const admittedPiSessionIds = rawBoundary.admittedPiSessionIds;
	if (!Array.isArray(admittedPiSessionIds) || !admittedPiSessionIds.length || new Set(admittedPiSessionIds).size !== admittedPiSessionIds.length || admittedPiSessionIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) || !admittedPiSessionIds.includes(rawBoundary.firstPi.sessionId)) throw new ImportValidationError("BOUNDARY_INVALID");
	const b: BoundaryManifest = { ...rawBoundary, admittedPiSessionIds };
	const m = speaker as SpeakerMap;
	if (m?.schema !== "pi-telegram-owner/speaker-map/v1" || !exactKeys(m as unknown as Record<string, unknown>, ["schema", "revision", "speakers"]) || !Number.isSafeInteger(m.revision) || m.revision < 1 || !m.speakers || Object.values(m.speakers).some((value) => value !== "in" && value !== "out") || Object.keys(m.speakers).some((key) => !validHash(key))) throw new ImportValidationError("SPEAKER_MAP_INVALID");
	return { source: s, boundary: b, speaker: m };
}

async function protectedDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new ImportValidationError("ARCHIVE_UNSAFE");
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, body: string): Promise<void> {
	await protectedDirectory(dirname(path));
	const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
	const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
	try {
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
		if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new ImportValidationError("ARCHIVE_UNSAFE");
		await rename(temp, path);
		await syncDirectory(dirname(path));
	} catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

async function checkpoint(path: string, value: unknown): Promise<void> {
	await protectedDirectory(dirname(path));
	await atomicWrite(path, `${canonical(value)}\n`);
}

export class TelegramArchiveImporter {
	async run(options: ImportOptions): Promise<ImportReport> {
		const lookahead = options.lookahead ?? 12;
		const chunkCandidateGapMs = options.chunkCandidateGapMs ?? DEFAULT_CHUNK_CANDIDATE_GAP_MS;
		const chunkCandidateMinLength = options.chunkCandidateMinLength ?? DEFAULT_CHUNK_CANDIDATE_MIN_LENGTH;
		const htmlPiTimestampOffsetsMs = options.htmlPiTimestampOffsetsMs ?? [];
		if (!Number.isSafeInteger(lookahead) || lookahead < 1 || lookahead > 100 || !Number.isSafeInteger(chunkCandidateGapMs) || chunkCandidateGapMs < 1 || chunkCandidateGapMs > 60_000 || !Number.isSafeInteger(chunkCandidateMinLength) || chunkCandidateMinLength < 1 || chunkCandidateMinLength > 100_000 || htmlPiTimestampOffsetsMs.length > 8 || new Set(htmlPiTimestampOffsetsMs).size !== htmlPiTimestampOffsetsMs.length || htmlPiTimestampOffsetsMs.some((offset) => !Number.isSafeInteger(offset) || Math.abs(offset) > 24 * 60 * 60 * 1_000)) throw new ImportValidationError("OPTIONS_INVALID");
		const deadline = Date.now() + (options.deadlineMs ?? 60_000);
		options.signal?.throwIfAborted();
		const [sourceDocument, boundaryDocument, speakerDocument] = await Promise.all([protectedJson(options.sourceSetManifestPath), protectedJson(options.boundaryManifestPath), protectedJson(options.speakerMapPath)]);
		const manifests = validateManifests(sourceDocument.value, boundaryDocument.value, speakerDocument.value, sourceDocument.sha256);
		const { messages: html, attachments } = await parsePages(options.exportRoot, manifests.source, manifests.speaker, deadline, options.signal);
		const chunkCandidates: ChunkBoundaryCandidate[] = [];
		for (let index = 1; index < html.length; index++) {
			const left = html[index - 1]!; const right = html[index]!;
			const gapMs = new Date(right.occurredAt).valueOf() - new Date(left.occurredAt).valueOf();
			if (left.direction !== right.direction || gapMs < 0 || gapMs > chunkCandidateGapMs || Math.max(left.sourceText.length, right.sourceText.length) < chunkCandidateMinLength) continue;
			chunkCandidates.push({ leftGlobalMessageOrdinal: left.globalMessageOrdinal, rightGlobalMessageOrdinal: right.globalMessageOrdinal, direction: left.direction, gapMs, leftMarkdownLength: left.sourceText.length, rightMarkdownLength: right.sourceText.length, leftCompatibilityKeySha256: hash(comparisonKey(left.markdown)), rightCompatibilityKeySha256: hash(comparisonKey(right.markdown)), signals: ["adjacent-same-direction", "gap-within-threshold", "source-text-length-at-least-threshold"] });
		}
		const journal = await readJournal(options.journalPath);
		const piSource = await readPiSessions(options.piSessionRoot, options.piSessionRootId, options.piSessionPaths, manifests.boundary.admittedPiSessionIds, journal.correlations, deadline, options.signal);
		const separators = [{ name: "none", value: "" }, { name: "space", value: " " }, { name: "newline", value: "\n" }, { name: "blank-line", value: "\n\n" }] as const;
		for (const candidate of chunkCandidates) {
			const left = html[candidate.leftGlobalMessageOrdinal - 1]!; const right = html[candidate.rightGlobalMessageOrdinal - 1]!;
			const matches: Array<{ sessionId: string; entryId: string; separator: typeof separators[number]["name"]; reconstructed: string }> = [];
			for (const separator of separators) {
				const reconstructed = `${left.sourceText.trim()}${separator.value}${right.sourceText.trim()}`;
				for (const entry of piSource.messages) if (entry.direction === candidate.direction && normalized(entry.transportStrippedMarkdown ?? entry.markdown).trim() === reconstructed) matches.push({ sessionId: entry.sessionId, entryId: entry.entryId, separator: separator.name, reconstructed });
			}
			if (matches.length === 1) candidate.exactPiReconstruction = { sessionId: matches[0]!.sessionId, entryId: matches[0]!.entryId, separator: matches[0]!.separator, reconstructedSha256: hash(matches[0]!.reconstructed) };
		}
		let pi = piSource.messages;
		const anchorH = html[manifests.boundary.firstPi.globalMessageOrdinal - 1];
		const anchorIndex = pi.findIndex((item) => item.sessionId === manifests.boundary.firstPi.sessionId && item.entryId === manifests.boundary.firstPi.entryId);
		const anchorP = anchorIndex >= 0 ? pi[anchorIndex] : undefined;
		const rawAnchor = anchorH ? normalized(anchorH.sourceText).trim() : ""; const rawPiAnchor = anchorP ? normalized(anchorP.transportStrippedMarkdown ?? anchorP.markdown).trim() : "";
		const rawBoundaryMatch = manifests.boundary.firstPi.matchKind === "raw-source-text";
		if (!anchorH || !anchorP || anchorH.direction !== manifests.boundary.firstPi.direction || anchorP.direction !== anchorH.direction || (rawBoundaryMatch ? hash(rawAnchor) !== manifests.boundary.firstPi.normalizedSha256 || rawPiAnchor !== rawAnchor : hash(comparisonKey(anchorH.markdown)) !== manifests.boundary.firstPi.normalizedSha256 || comparisonKey(anchorP.transportStrippedMarkdown ?? anchorP.markdown) !== comparisonKey(anchorH.markdown))) throw new ImportValidationError("BOUNDARY_INVALID");
		pi = pi.slice(anchorIndex);
		const htmlPlan = (item: HistoricalMessage): ImportPlanItem => ({ messageId: `tgmsg:v1:telegram-export-history:${manifests.source.sourceSetId}:${item.globalMessageOrdinal}`, identityKind: "telegram-export-history", direction: item.direction, markdown: item.markdown, occurredAt: item.occurredAt, confidence: "historical-html-sequence", exportStatus: "historical-authority", html: { page: item.page, globalMessageOrdinal: item.globalMessageOrdinal, pageSha256: item.pageSha256, sourceRange: item.sourceRange, sourceTextSha256: hash(item.sourceText) }, attachments: attachments.get(item.globalMessageOrdinal) ?? [] });
		const items: ImportPlanItem[] = html.slice(0, anchorH.globalMessageOrdinal - 1).map(htmlPlan);
		const piPlan = (entry: PiImportMessage, exportStatus: "present" | "missing", htmlItem?: HistoricalMessage, segments: HistoricalMessage[] = htmlItem ? [htmlItem] : []): ImportPlanItem => ({ messageId: `tgmsg:v1:pi:${entry.sessionId}:${entry.entryId}`, identityKind: "pi-session-entry", direction: entry.direction, markdown: exportStatus === "present" ? entry.transportStrippedMarkdown ?? entry.markdown : entry.markdown, occurredAt: entry.timestamp, confidence: "exact-pi", exportStatus, ...(htmlItem ? { html: { page: htmlItem.page, globalMessageOrdinal: htmlItem.globalMessageOrdinal, pageSha256: htmlItem.pageSha256, sourceRange: htmlItem.sourceRange, sourceTextSha256: hash(htmlItem.sourceText) } } : {}), ...(segments.length > 1 ? { htmlSegments: segments.map((segment) => ({ page: segment.page, globalMessageOrdinal: segment.globalMessageOrdinal, pageSha256: segment.pageSha256, sourceRange: segment.sourceRange, sourceTextSha256: hash(segment.sourceText) })) } : {}), pi: { sessionId: entry.sessionId, entryId: entry.entryId, parentId: entry.parentId, sourceRootId: entry.sourceRootId, sourcePath: entry.sourcePath, entryLine: entry.entryLine, entryByteOffset: entry.entryByteOffset, entryByteLength: entry.entryByteLength, entrySha256: entry.entrySha256 }, attachments: segments.flatMap((segment) => attachments.get(segment.globalMessageOrdinal) ?? []) });
		const originalPiIndex = new Map(pi.map((entry, index) => [`${entry.sessionId}:${entry.entryId}`, index]));
		const remainingPi = [...pi];
		let ambiguous = 0; let unresolved = 0; let coverageMissing = 0;
		const gaps: ImportReport["gaps"] = [];
		let pendingGap: { kind: "html-unresolved" | "html-ambiguous"; messages: HistoricalMessage[] } | undefined;
		const flushGap = (): void => {
			if (!pendingGap) return; const first = pendingGap.messages[0]!; const last = pendingGap.messages.at(-1)!;
			const gap = { kind: pendingGap.kind, startHtmlOrdinal: first.globalMessageOrdinal, endHtmlOrdinal: last.globalMessageOrdinal, sources: pendingGap.messages.map((source) => ({ page: source.page, pageSha256: source.pageSha256, globalMessageOrdinal: source.globalMessageOrdinal, compatibilityKeySha256: hash(comparisonKey(source.markdown)), sourceRange: source.sourceRange, attachmentSha256: (attachments.get(source.globalMessageOrdinal) ?? []).map((attachment) => attachment.sha256) })) };
			items.push(...pendingGap.messages.map(htmlPlan));
			pendingGap = undefined;
		};
		const addHtmlGap = (kind: "html-unresolved" | "html-ambiguous", item: HistoricalMessage): void => {
			if (!pendingGap || pendingGap.kind !== kind || pendingGap.messages.at(-1)!.globalMessageOrdinal + 1 !== item.globalMessageOrdinal) { flushGap(); pendingGap = { kind, messages: [] }; }
			pendingGap.messages.push(item);
			const previous = gaps.at(-1); if (previous?.kind === kind && previous.endHtmlOrdinal === item.globalMessageOrdinal - 1) previous.endHtmlOrdinal = item.globalMessageOrdinal; else gaps.push({ kind, startHtmlOrdinal: item.globalMessageOrdinal, endHtmlOrdinal: item.globalMessageOrdinal, piEntryIds: [] });
		};
		const postBoundaryHtml = html.slice(anchorH.globalMessageOrdinal - 1);
		const exactChunks = new Map(chunkCandidates.filter((candidate) => candidate.exactPiReconstruction).map((candidate) => [candidate.leftGlobalMessageOrdinal, candidate]));
		for (let htmlIndex = 0; htmlIndex < postBoundaryHtml.length; htmlIndex++) {
			const item = postBoundaryHtml[htmlIndex]!;
			options.signal?.throwIfAborted(); if (Date.now() > deadline) throw new ImportValidationError("TIMEOUT");
			let candidates: PiImportMessage[] = [];
			for (let index = 0; index < Math.min(remainingPi.length, lookahead); index++) { const candidate = remainingPi[index]!; const candidateMarkdown = candidate.transportStrippedMarkdown ?? candidate.markdown; const rawMatch = normalized(candidateMarkdown).trim() === normalized(item.sourceText).trim(); const provenRenderedPlainMatch = Boolean(candidate.transportJobId) && Boolean(candidateMarkdown.trim()) && Boolean(item.markdown.trim()) && (markdownToPlainText(candidateMarkdown) === markdownToPlainText(item.markdown) || compactRenderedText(candidateMarkdown) === compactRenderedText(item.markdown)); if (candidate.direction === item.direction && (rawMatch || comparisonKey(candidateMarkdown) === comparisonKey(item.markdown) || provenRenderedPlainMatch)) candidates.push(candidate); }
			if (candidates.length > 1 && htmlPiTimestampOffsetsMs.length) {
				const htmlTime = new Date(item.occurredAt).valueOf();
				const scored = candidates.map((candidate) => ({ candidate, skew: Math.min(...htmlPiTimestampOffsetsMs.map((offset) => Math.abs((htmlTime - new Date(candidate.timestamp).valueOf()) - offset))) })).sort((a, b) => a.skew - b.skew || a.candidate.entryId.localeCompare(b.candidate.entryId));
				if (scored[0]!.skew <= 5 * 60 * 1_000 && scored[0]!.skew < scored[1]!.skew) candidates = [scored[0]!.candidate];
			}
			if (candidates.length === 1) {
				flushGap(); const matched = candidates[0]!; remainingPi.splice(remainingPi.indexOf(matched), 1); items.push(piPlan(matched, "present", item)); continue;
			}
			if (candidates.length > 1) { ambiguous += 1; addHtmlGap("html-ambiguous", item); continue; }
			let reviewedMultiChunk: { entry: PiImportMessage; segments: HistoricalMessage[] } | undefined;
			const multiMatches = new Map<string, { entry: PiImportMessage; segments: HistoricalMessage[] }>();
			for (let span = 2; span <= 8 && htmlIndex + span <= postBoundaryHtml.length; span++) {
				const segments = postBoundaryHtml.slice(htmlIndex, htmlIndex + span);
				if (segments.some((segment) => segment.direction !== item.direction)) break;
				if (segments.slice(1).some((segment, index) => new Date(segment.occurredAt).valueOf() - new Date(segments[index]!.occurredAt).valueOf() > chunkCandidateGapMs)) break;
				for (const candidate of remainingPi.slice(0, lookahead)) {
					if (!candidate.transportJobId || candidate.direction !== item.direction) continue;
					const target = compactRenderedText(candidate.transportStrippedMarkdown ?? candidate.markdown);
					for (const separator of ["", " ", "\n", "\n\n"]) if (compactRenderedText(segments.map((segment) => segment.markdown).join(separator)) === target) multiMatches.set(`${candidate.sessionId}:${candidate.entryId}:${span}`, { entry: candidate, segments });
				}
			}
			if (multiMatches.size === 1) reviewedMultiChunk = [...multiMatches.values()][0];
			if (reviewedMultiChunk) {
				flushGap(); const matchedIndex = remainingPi.indexOf(reviewedMultiChunk.entry); remainingPi.splice(matchedIndex, 1);
				items.push(piPlan(reviewedMultiChunk.entry, "present", item, reviewedMultiChunk.segments)); htmlIndex += reviewedMultiChunk.segments.length - 1; continue;
			}
			const chunk = exactChunks.get(item.globalMessageOrdinal); const nextHtml = postBoundaryHtml[htmlIndex + 1];
			if (chunk?.exactPiReconstruction && nextHtml?.globalMessageOrdinal === chunk.rightGlobalMessageOrdinal) {
				const matchedIndex = remainingPi.slice(0, lookahead).findIndex((entry) => entry.sessionId === chunk.exactPiReconstruction!.sessionId && entry.entryId === chunk.exactPiReconstruction!.entryId);
				if (matchedIndex >= 0) {
					flushGap();
					const [matched] = remainingPi.splice(matchedIndex, 1); items.push(piPlan(matched!, "present", item, [item, nextHtml])); htmlIndex += 1; continue;
				}
			}
			unresolved += 1; addHtmlGap("html-unresolved", item);
		}
		flushGap();
		coverageMissing = remainingPi.length;
		for (const missing of remainingPi) {
			const missingIndex = originalPiIndex.get(`${missing.sessionId}:${missing.entryId}`)!;
			let insertAt = items.findIndex((planned) => planned.pi && originalPiIndex.get(`${planned.pi.sessionId}:${planned.pi.entryId}`)! > missingIndex);
			if (insertAt < 0) insertAt = items.length;
			const nextOrdinal = items[insertAt]?.html?.globalMessageOrdinal ?? null;
			gaps.push({ kind: "pi-unmatched", startHtmlOrdinal: nextOrdinal, endHtmlOrdinal: nextOrdinal, piEntryIds: [missing.entryId] });
			items.splice(insertAt, 0, piPlan(missing, "missing"));
		}
		gaps.sort((a, b) => (a.startHtmlOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.startHtmlOrdinal ?? Number.MAX_SAFE_INTEGER) || (a.kind === "pi-unmatched" ? -1 : 1));
		const report: ImportReport = { schema: "pi-telegram-owner/import-report/v1", importer: IMPORTER_VERSION, sourceSetId: manifests.source.sourceSetId, sourceSetManifestSha256: sourceDocument.sha256, boundaryOrdinal: anchorH.globalMessageOrdinal, historical: anchorH.globalMessageOrdinal - 1, piAligned: items.filter((item) => item.identityKind === "pi-session-entry" && item.exportStatus === "present").length, unresolvedPostBoundary: unresolved, ambiguous, coverageMissing, chunkCandidates, gaps, items };
		const planned = items.map((item) => ({ recordId: item.recordId ?? item.messageId, messageId: item.messageId, identityKind: item.identityKind, exportStatus: item.exportStatus, contentSha256: hash(item.markdown), compatibilityKeySha256: hash(comparisonKey(item.markdown)), itemSha256: hash(canonical(item)), sourceRange: item.html?.sourceRange ?? null, attachmentSha256: item.attachments.map((attachment) => attachment.sha256) }));
		const immutablePlan = { importer: IMPORTER_VERSION, htmlCompatibility: HTML_COMPAT_VERSION, markdownCompatibility: TELEGRAM_FORMAT_COMPAT_VERSION, sourceSetId: manifests.source.sourceSetId, sourceSetManifestSha256: sourceDocument.sha256, boundaryManifestSha256: boundaryDocument.sha256, speakerMapSha256: speakerDocument.sha256, speakerMapRevision: manifests.speaker.revision, piSessionRootId: options.piSessionRootId, journal: journal.identity, piFiles: piSource.files, options: { lookahead, chunkCandidateGapMs, chunkCandidateMinLength, htmlPiTimestampOffsetsMs: [...htmlPiTimestampOffsetsMs].sort((a, b) => a - b) }, chunkCandidates, planned, counts: { historical: report.historical, piAligned: report.piAligned, unresolved, ambiguous, coverageMissing }, gaps };
		const planSha256 = hash(canonical(immutablePlan));
		const checkpointBase = { schema: "pi-telegram-owner/import-checkpoint/v1", ...immutablePlan, planSha256 };
		if (options.dryRun !== false) {
			await checkpoint(options.checkpointPath, { ...checkpointBase, publication: { phase: "planned", nextIndex: 0, lastMessageId: null, manifestGeneration: null } });
			return report;
		}
		if (!options.archiveRoot || !isAbsolute(options.archiveRoot)) throw new ImportValidationError("OPTIONS_INVALID", "Commit requires an absolute archiveRoot");
		let existing: any;
		try { existing = (await protectedJson(options.checkpointPath, 256 * 1024 * 1024)).value; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ImportValidationError("CHECKPOINT_REQUIRED", "Run the exact dry-run plan before commit"); throw error; }
		const { schema: existingSchema, planSha256: existingPlanSha256, publication: existingPublication, ...existingImmutablePlan } = existing ?? {};
		if (existingSchema !== "pi-telegram-owner/import-checkpoint/v1" || existingPlanSha256 !== planSha256 || hash(canonical(existingImmutablePlan)) !== planSha256 || !existingPublication || !exactKeys(existingPublication, ["phase", "nextIndex", "lastMessageId", "manifestGeneration"]) || !["planned", "publishing", "complete"].includes(existingPublication.phase) || !Number.isSafeInteger(existingPublication.nextIndex) || existingPublication.nextIndex < 0 || existingPublication.nextIndex > items.length) throw new ImportValidationError("PLAN_BINDING_MISMATCH", "Checkpoint does not bind the exact immutable plan");
		try { await lstat(join(options.archiveRoot, "images", "_attachments")); throw new ImportValidationError("ARCHIVE_MIGRATION_REQUIRED", "Importer v2 cannot resume the prototype attachment layout"); }
		catch (error) { if (error instanceof ImportValidationError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const projector = new TelegramMarkdownProjector({ enabled: true, root: resolve(options.archiveRoot), rootId: options.piSessionRootId, roleSlugs: options.roleSlugs });
		let finalGeneration: number | null = existing.publication.manifestGeneration ?? null;
		const publicationItems = items.map((item) => ({ ...item, attachments: item.attachments.map((attachment) => ({ ...attachment, sourcePath: resolve(options.exportRoot, attachment.sourcePath) })) }));
		const publication = await projector.publishImport(publicationItems, { sourceSetId: manifests.source.sourceSetId, sourceSetManifestSha256: sourceDocument.sha256, speakerMapRevision: manifests.speaker.revision, boundaryManifestSha256: boundaryDocument.sha256 }, async (nextIndex, messageId, manifestGeneration) => {
			finalGeneration = manifestGeneration;
			await checkpoint(options.checkpointPath, { ...checkpointBase, publication: { phase: "publishing", nextIndex, lastMessageId: messageId, manifestGeneration } });
		}, options.signal);
		await checkpoint(options.checkpointPath, { ...checkpointBase, publication: { phase: "complete", nextIndex: items.length, lastMessageId: items.at(-1)?.recordId ?? items.at(-1)?.messageId ?? null, manifestGeneration: finalGeneration } });
		report.publication = publication;
		return report;
	}
}
