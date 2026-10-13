import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

export const TELEGRAM_FORMAT_VERSION = "telegram-html-v1" as const;
export const TELEGRAM_FORMAT_COMPAT_VERSION = "telegram-format-compat-v1" as const;
export const TELEGRAM_HTML_LIMIT = 4_000;
export const MAX_MARKDOWN_BYTES = 256 * 1024;
export const MAX_MARKDOWN_AST_NODES = 10_000;
export const MAX_MARKDOWN_AST_DEPTH = 32;
export const MAX_RENDERED_HTML_BYTES = 512 * 1024;
export const MAX_TELEGRAM_CHUNKS = 128;

export class TelegramFormatError extends Error {}

export interface TelegramTransportChunk {
	index: number;
	format: "HTML" | "plain";
	payload: string;
	plainFallback: string;
}

export interface TelegramTransportPlan {
	renderer: typeof TELEGRAM_FORMAT_VERSION;
	compatibility: typeof TELEGRAM_FORMAT_COMPAT_VERSION;
	chunks: TelegramTransportChunk[];
	fallback: boolean;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll('"', "&quot;");
}

export function telegramSafeHref(value: string): string | undefined {
	if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	const protocol = url.protocol.toLowerCase();
	if (!new Set(["http:", "https:", "mailto:", "tel:"]).has(protocol)) return undefined;
	if ((protocol === "http:" || protocol === "https:") && (!url.hostname || url.username || url.password)) return undefined;
	if (protocol === "tel:" && !/^tel:\+?[0-9][0-9(). -]*(?:;[a-z0-9-]+=[a-z0-9+_.-]+)*$/i.test(value)) return undefined;
	if (protocol === "mailto:" && !value.slice(7).includes("@")) return undefined;
	return value;
}

function renderSpoilers(value: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < value.length) {
		const open = value.indexOf("||", cursor);
		if (open < 0) return output + escapeHtml(value.slice(cursor));
		const close = value.indexOf("||", open + 2);
		if (close < 0 || close === open + 2) return output + escapeHtml(value.slice(cursor));
		output += escapeHtml(value.slice(cursor, open));
		output += `<tg-spoiler>${escapeHtml(value.slice(open + 2, close))}</tg-spoiler>`;
		cursor = close + 2;
	}
	return output;
}

function plainSpoilers(value: string): string {
	return value.replace(/\|\|([^|\n](?:[^|]|\|(?!\|))*)\|\|/g, "$1");
}

function inlineText(node: any): string {
	if (!node) return "";
	if (node.type === "text") return plainSpoilers(String(node.value ?? ""));
	if (node.type === "inlineCode" || node.type === "code") return String(node.value ?? "");
	if (node.type === "break") return "\n";
	if (node.type === "image") return String(node.alt ?? node.url ?? "");
	if (Array.isArray(node.children)) return node.children.map(inlineText).join("");
	return typeof node.value === "string" ? node.value : "";
}

function renderInline(node: any): string {
	switch (node.type) {
		case "text": return renderSpoilers(String(node.value ?? ""));
		case "strong": return `<b>${node.children.map(renderInline).join("")}</b>`;
		case "emphasis": return `<i>${node.children.map(renderInline).join("")}</i>`;
		case "delete": return `<s>${node.children.map(renderInline).join("")}</s>`;
		case "inlineCode": return `<code>${escapeHtml(String(node.value ?? "").replaceAll("\n", " "))}</code>`;
		case "break": return "\n";
		case "link": {
			const label = node.children.map(renderInline).join("");
			const plain = node.children.map(inlineText).join("");
			const href = telegramSafeHref(String(node.url ?? ""));
			return href ? `<a href="${escapeAttribute(href)}">${label}</a>` : `${label} (${escapeHtml(String(node.url ?? ""))})`;
		}
		case "image": {
			const label = String(node.alt ?? "image");
			return escapeHtml(`${label} (${String(node.url ?? "")})`);
		}
		case "html": return escapeHtml(String(node.value ?? ""));
		default:
			return Array.isArray(node.children) ? node.children.map(renderInline).join("") : escapeHtml(String(node.value ?? ""));
	}
}

function renderBlock(node: any, orderedIndex?: number): string {
	switch (node.type) {
		case "paragraph": return node.children.map(renderInline).join("");
		case "heading": return node.children.map(renderInline).join("");
		case "code": return `<pre><code>${escapeHtml(String(node.value ?? ""))}</code></pre>`;
		case "blockquote": return `<blockquote>${node.children.map((child: any) => renderBlock(child)).join("\n\n")}</blockquote>`;
		case "list": return node.children.map((child: any, index: number) => renderBlock(child, node.ordered ? (node.start ?? 1) + index : undefined)).join("\n");
		case "listItem": {
			const marker = orderedIndex === undefined ? "- " : `${orderedIndex}. `;
			return marker + node.children.map((child: any) => renderBlock(child)).join("\n  ");
		}
		case "thematicBreak": return "---";
		case "html": return escapeHtml(String(node.value ?? ""));
		default: return Array.isArray(node.children) ? node.children.map((child: any) => renderBlock(child)).join("\n\n") : renderInline(node);
	}
}

function parse(markdown: string): any {
	if (!markdown.trim()) throw new TelegramFormatError("Telegram reply is empty");
	if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new TelegramFormatError("Markdown exceeds renderer input limit");
	const tree = fromMarkdown(markdown, {
		extensions: [gfmStrikethrough({ singleTilde: false })],
		mdastExtensions: [gfmStrikethroughFromMarkdown()],
	});
	let nodes = 0;
	const visit = (node: any, depth: number): void => {
		nodes += 1;
		if (nodes > MAX_MARKDOWN_AST_NODES) throw new TelegramFormatError("Markdown AST exceeds node limit");
		if (depth > MAX_MARKDOWN_AST_DEPTH) throw new TelegramFormatError("Markdown AST exceeds depth limit");
		if (Array.isArray(node?.children)) for (const child of node.children) visit(child, depth + 1);
	};
	visit(tree, 0);
	return tree;
}

export function markdownToTelegramHtml(markdown: string): string {
	const tree = parse(markdown);
	const rendered = tree.children.map((node: any) => renderBlock(node)).join("\n\n");
	if (!rendered || Buffer.byteLength(rendered, "utf8") > MAX_RENDERED_HTML_BYTES) throw new TelegramFormatError("Rendered Telegram HTML exceeds output limit");
	return rendered;
}

export function markdownSemanticTree(markdown: string): unknown {
	const normalize = (node: any): Record<string, unknown> => {
		const result: Record<string, unknown> = { type: String(node.type) };
		if (typeof node.value === "string") result.value = node.value;
		if (typeof node.url === "string") result.url = node.url;
		if (typeof node.alt === "string") result.alt = node.alt;
		if (node.type === "list") { result.ordered = node.ordered === true; result.start = node.start ?? null; }
		if (Array.isArray(node.children)) result.children = node.children.map(normalize);
		return result;
	};
	return normalize(parse(markdown));
}

export function markdownCompatibilityKey(markdown: string): string {
	return JSON.stringify({
		version: TELEGRAM_FORMAT_COMPAT_VERSION,
		ast: markdownSemanticTree(markdown),
		plain: markdownToPlainText(markdown).replace(/\r\n?/g, "\n"),
	});
}

function plainBlock(node: any, orderedIndex?: number): string {
	switch (node.type) {
		case "paragraph": case "heading": return node.children.map(inlineText).join("");
		case "code": return String(node.value ?? "");
		case "blockquote": return node.children.map((child: any) => plainBlock(child)).join("\n\n");
		case "list": return node.children.map((child: any, index: number) => plainBlock(child, node.ordered ? (node.start ?? 1) + index : undefined)).join("\n");
		case "listItem": {
			const marker = orderedIndex === undefined ? "- " : `${orderedIndex}. `;
			return marker + node.children.map((child: any) => plainBlock(child)).join("\n  ");
		}
		case "thematicBreak": return "---";
		default: return Array.isArray(node.children) ? node.children.map((child: any) => plainBlock(child)).join("\n\n") : inlineText(node);
	}
}

export function markdownToPlainText(markdown: string): string {
	const tree = parse(markdown);
	return tree.children.map((node: any) => plainBlock(node)).join("\n\n");
}

const TAG = /<\/?(?:b|i|s|code|pre|blockquote|tg-spoiler|a)(?:\s+href="(?:[^"&]|&(?:amp|lt|gt|quot);)*")?>/gy;
const OPEN_TAG = /^<([a-z-]+)(?:\s[^>]*)?>$/;
const CLOSE_TAG = /^<\/([a-z-]+)>$/;

function graphemes(text: string): string[] {
	const Segmenter = (Intl as typeof Intl & { Segmenter?: new (...args: any[]) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
	if (Segmenter) return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((entry) => entry.segment);
	return [...text];
}

function closeSuffix(stack: Array<{ name: string; open: string }>): string {
	return [...stack].reverse().map(({ name }) => `</${name}>`).join("");
}

function openPrefix(stack: Array<{ name: string; open: string }>): string {
	return stack.map(({ open }) => open).join("");
}

export function splitTelegramHtml(html: string, limit = TELEGRAM_HTML_LIMIT): string[] {
	if (!Number.isSafeInteger(limit) || limit < 32) throw new TelegramFormatError("Invalid Telegram chunk limit");
	const chunks: string[] = [];
	let current = "";
	let stack: Array<{ name: string; open: string }> = [];
	let plainLength = 0;
	const flush = () => {
		if (!current) return;
		const closed = current + closeSuffix(stack);
		if (closed.length > limit) throw new TelegramFormatError("Unable to satisfy Telegram HTML chunk limit");
		chunks.push(closed);
		current = openPrefix(stack);
		plainLength = 0;
	};
	const appendText = (value: string) => {
		for (const unit of graphemes(value)) {
			const escaped = escapeHtml(unit);
			if (plainLength > 0 && (current.length + escaped.length + closeSuffix(stack).length > limit || plainLength + [...unit].length > limit)) flush();
			if (current.length + escaped.length + closeSuffix(stack).length > limit) throw new TelegramFormatError("Single grapheme exceeds Telegram HTML limit");
			current += escaped;
			plainLength += [...unit].length;
		}
	};
	let cursor = 0;
	while (cursor < html.length) {
		if (html[cursor] !== "<") {
			const next = html.indexOf("<", cursor);
			appendText(html.slice(cursor, next < 0 ? html.length : next).replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
			cursor = next < 0 ? html.length : next;
			continue;
		}
		TAG.lastIndex = cursor;
		const match = TAG.exec(html);
		if (!match || match.index !== cursor) throw new TelegramFormatError("Renderer produced unsupported Telegram HTML");
		const tag = match[0];
		const close = CLOSE_TAG.exec(tag);
		if (close) {
			const expected = stack.at(-1)?.name;
			if (expected !== close[1]) throw new TelegramFormatError("Renderer produced unbalanced Telegram HTML");
			current += tag;
			stack.pop();
		} else {
			const open = OPEN_TAG.exec(tag);
			if (!open) throw new TelegramFormatError("Renderer produced malformed Telegram HTML");
			const suffix = closeSuffix([...stack, { name: open[1]!, open: tag }]);
			if (current.length > 0 && current.length + tag.length + suffix.length > limit) flush();
			current += tag;
			stack.push({ name: open[1]!, open: tag });
		}
		cursor = TAG.lastIndex;
	}
	if (stack.length) throw new TelegramFormatError("Renderer produced unterminated Telegram HTML");
	if (current) chunks.push(current);
	if (chunks.length === 0) throw new TelegramFormatError("Telegram HTML output is empty");
	if (chunks.length > MAX_TELEGRAM_CHUNKS) throw new TelegramFormatError("Telegram reply exceeds chunk count limit");
	return chunks;
}

function decodePlainHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&quot;", '"')
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&amp;", "&");
}

export function createTelegramTransportPlan(markdown: string, limit = TELEGRAM_HTML_LIMIT): TelegramTransportPlan {
	if (!markdown.trim()) throw new TelegramFormatError("Telegram reply is empty");
	try {
		const chunks = splitTelegramHtml(markdownToTelegramHtml(markdown), limit);
		return {
			renderer: TELEGRAM_FORMAT_VERSION,
			compatibility: TELEGRAM_FORMAT_COMPAT_VERSION,
			fallback: false,
			chunks: chunks.map((payload, index) => ({ index, format: "HTML", payload, plainFallback: decodePlainHtml(payload) })),
		};
	} catch {
		let plain: string;
		if (Buffer.byteLength(markdown, "utf8") <= MAX_MARKDOWN_BYTES) {
			try { plain = markdownToPlainText(markdown); } catch { plain = markdown; }
		} else {
			plain = markdown;
		}
		const chunks: string[] = [];
		let current = "";
		for (const unit of graphemes(plain)) {
			if (current && current.length + unit.length > limit) { chunks.push(current); current = ""; }
			current += unit;
		}
		if (current) chunks.push(current);
		if (chunks.length === 0 || chunks.length > MAX_TELEGRAM_CHUNKS) throw new TelegramFormatError("Plain fallback exceeds chunk bounds");
		return {
			renderer: TELEGRAM_FORMAT_VERSION,
			compatibility: TELEGRAM_FORMAT_COMPAT_VERSION,
			fallback: true,
			chunks: chunks.map((payload, index) => ({ index, format: "plain", payload, plainFallback: payload })),
		};
	}
}
