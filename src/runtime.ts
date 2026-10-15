import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseDatastorePolicy, type DatastorePolicy } from "./datastore.ts";

// Native CLIs and archive helpers do not load the Pi runtime.
const CONFIG_DIR_NAME = ".pi";
import { telegramOwnerMenuCommands } from "./commands.ts";
import type { TelegramMarkdownProjectorConfig } from "./markdown-projector.ts";
import {
	DEFAULT_INBOUND_QUIET_WINDOW_MS,
	type FetchLike,
	fetchUpdateBatch,
	MAX_IMAGE_BYTES,
	type ResolvedImage,
	type TelegramImageRef,
	type TelegramUpdate,
} from "./core.ts";

export type ConnectionPhase = "disabled" | "connecting" | "connected" | "backoff" | "stopping";

export interface ConnectionStatus {
	phase: ConnectionPhase;
	lastSuccessfulPoll?: string;
	lastError?: string;
	retryDelayMs?: number;
}

export interface TelegramOwnerConfig {
	datastore: DatastorePolicy;
	ownerUserId: number;
	privateChatId: number;
	agentLabel?: string;
	formattedDelivery: boolean;
	inboundQuietWindowMs: number;
	markdownProjection?: TelegramMarkdownProjectorConfig;
	baseDir: string;
	journalPath: string;
	lockPath: string;
	/** Creates a client without exposing or serializing the configured token. */
	createApiClient(): TelegramApiClient;
}

export interface LoadedConfig {
	kind: "absent" | "configured";
	config?: TelegramOwnerConfig;
	configPath: string;
}

export class ConfigurationError extends Error {}
export class PollerLockError extends Error {}
export class ImageSafetyError extends Error {}
export class TelegramParseError extends Error {
	readonly code = "TELEGRAM_PARSE_REJECTED";
}
export class TelegramReplyAnchorError extends Error {
	readonly code = "TELEGRAM_REPLY_ANCHOR_REJECTED";
}

export const TELEGRAM_OWNER_PROJECT_DIRECTORY = join(CONFIG_DIR_NAME, "telegram-owner");

export function projectTelegramOwnerConfigPath(
	projectRoot: string,
	configDirName = CONFIG_DIR_NAME,
): string {
	return join(resolve(projectRoot), configDirName, "telegram-owner", "config.json");
}

const ENVIRONMENT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_AGENT_LABEL_LENGTH = 64;
const UNSAFE_AGENT_LABEL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

export function validateAgentLabel(value: unknown, source = "agentLabel"): string {
	if (typeof value !== "string") throw new ConfigurationError(`${source} must be plain text`);
	const trimmed = value.trim();
	if (!trimmed || [...trimmed].length > MAX_AGENT_LABEL_LENGTH || UNSAFE_AGENT_LABEL_CHARACTER.test(trimmed)) {
		throw new ConfigurationError(`${source} must be 1-${MAX_AGENT_LABEL_LENGTH} characters of single-line plain text`);
	}
	return trimmed;
}

function fileMode(mode: number): number {
	return mode & 0o777;
}

async function requireProtectedFile(path: string, label: string): Promise<void> {
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigurationError(`${label} not found: ${path}`);
		throw error;
	}
	if (!info.isFile()) throw new ConfigurationError(`${label} must be a regular file: ${path}`);
	if ((fileMode(info.mode) & 0o077) !== 0) {
		throw new ConfigurationError(`${label} permissions must not allow group/other access: ${path}`);
	}
	if (process.getuid && info.uid !== process.getuid()) throw new ConfigurationError(`${label} must be owned by this user: ${path}`);
}

async function requireProtectedDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) throw new ConfigurationError(`Telegram owner path must be a directory: ${path}`);
	if ((fileMode(info.mode) & 0o077) !== 0) {
		throw new ConfigurationError(`Telegram owner directory permissions must not allow group/other access: ${path}`);
	}
	if (process.getuid && info.uid !== process.getuid()) {
		throw new ConfigurationError(`Telegram owner directory must be owned by this user: ${path}`);
	}
}

/** Loads one project-local configuration. */
export async function loadTelegramOwnerConfig(
	configPath: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
	try {
		await stat(configPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent", configPath };
		throw error;
	}
	const baseDir = dirname(configPath);
	await requireProtectedDirectory(baseDir);
	await requireProtectedFile(configPath, "Telegram owner config");
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(configPath, "utf8"));
	} catch (error) {
		throw new ConfigurationError(`Telegram owner config is not valid JSON: ${String(error)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigurationError("Telegram owner config must be a JSON object");
	}
	const value = raw as {
		datastore?: unknown;
		ownerUserId?: unknown;
		privateChatId?: unknown;
		tokenEnv?: unknown;
		agentLabel?: unknown;
		formattedDelivery?: unknown;
		inboundQuietWindowMs?: unknown;
		markdownProjection?: unknown;
	};
	for (const [name, id] of [
		["ownerUserId", value.ownerUserId],
		["privateChatId", value.privateChatId],
	] as const) {
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
			throw new ConfigurationError(`${name} must be a positive integer`);
		}
	}
	if (typeof value.tokenEnv !== "string" || !ENVIRONMENT_IDENTIFIER.test(value.tokenEnv)) {
		throw new ConfigurationError("tokenEnv must be a conventional environment variable name");
	}
	const token = environment[value.tokenEnv];
	if (token === undefined || token.length === 0) {
		throw new ConfigurationError(`Telegram bot token environment variable ${value.tokenEnv} is not set or empty`);
	}
	if (/\s/.test(token)) {
		throw new ConfigurationError(`Telegram bot token environment variable ${value.tokenEnv} must contain one non-empty token`);
	}
	const datastore = parseDatastorePolicy(value.datastore);
	const ownerUserId = value.ownerUserId as number;
	const privateChatId = value.privateChatId as number;
	const agentLabel = value.agentLabel === undefined ? undefined : validateAgentLabel(value.agentLabel);
	if (value.formattedDelivery !== undefined && typeof value.formattedDelivery !== "boolean") throw new ConfigurationError("formattedDelivery must be boolean");
	const formattedDelivery = value.formattedDelivery !== false;
	const inboundQuietWindowMs = value.inboundQuietWindowMs ?? DEFAULT_INBOUND_QUIET_WINDOW_MS;
	if (!Number.isSafeInteger(inboundQuietWindowMs) || Number(inboundQuietWindowMs) < 100 || Number(inboundQuietWindowMs) > 5_000) throw new ConfigurationError("inboundQuietWindowMs must be an integer from 100 through 5000");
	let markdownProjection: TelegramMarkdownProjectorConfig | undefined;
	const projectionValue = value.markdownProjection ?? { enabled: true };
	if (projectionValue !== false) {
		if (!projectionValue || typeof projectionValue !== "object" || Array.isArray(projectionValue)) throw new ConfigurationError("markdownProjection must be false or an object");
		const item = projectionValue as { enabled?: unknown; root?: unknown; sessionRoot?: unknown; rootId?: unknown; roleSlugs?: unknown };
		if (typeof item.enabled !== "boolean") throw new ConfigurationError("markdownProjection.enabled must be boolean");
		if (item.enabled) {
			if (item.root !== undefined && (typeof item.root !== "string" || !isAbsolute(item.root))) throw new ConfigurationError("markdownProjection.root override must be absolute");
			if (item.sessionRoot !== undefined && (typeof item.sessionRoot !== "string" || !isAbsolute(item.sessionRoot))) throw new ConfigurationError("markdownProjection.sessionRoot must be absolute when supplied");
			if (item.rootId !== undefined && (typeof item.rootId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.rootId))) throw new ConfigurationError("markdownProjection.rootId must be a safe non-sensitive identifier");
			let roleSlugs: TelegramMarkdownProjectorConfig["roleSlugs"];
			if (item.roleSlugs !== undefined) {
				if (!item.roleSlugs || typeof item.roleSlugs !== "object" || Array.isArray(item.roleSlugs) || Object.keys(item.roleSlugs).sort().join(",") !== "assistant,command,user") throw new ConfigurationError("markdownProjection.roleSlugs must define user, assistant, and command");
				roleSlugs = item.roleSlugs as NonNullable<TelegramMarkdownProjectorConfig["roleSlugs"]>;
				if (Object.values(roleSlugs).some((slug) => typeof slug !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(slug))) throw new ConfigurationError("markdownProjection.roleSlugs are invalid");
			}
			markdownProjection = { enabled: true, root: typeof item.root === "string" ? resolve(item.root) : resolve(baseDir, "../.."), ...(typeof item.sessionRoot === "string" ? { sessionRoot: resolve(item.sessionRoot) } : {}), rootId: typeof item.rootId === "string" ? item.rootId : "pi-sessions", ...(roleSlugs ? { roleSlugs } : {}) };
		}
	}
	return {
		kind: "configured",
		configPath,
		config: {
			datastore,
			ownerUserId,
			privateChatId,
			agentLabel,
			formattedDelivery,
			inboundQuietWindowMs: Number(inboundQuietWindowMs),
			markdownProjection,
			baseDir,
			journalPath: join(baseDir, "state.jsonl"),
			lockPath: join(baseDir, "poller.lock"),
			createApiClient: () => new TelegramApiClient(token, privateChatId),
		},
	};
}

export function sanitizeError(error: unknown, token?: string): string {
	let message = error instanceof Error ? error.message : String(error);
	if (token) message = message.split(token).join("[redacted]");
	message = message.replace(/bot[^/\s]+\//g, "bot[redacted]/");
	message = message.replace(/\b(token|secret|password|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
	message = message.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	return message.slice(0, 500);
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; close(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Telegram request deadline exceeded")), timeoutMs);
	const abort = () => controller.abort(parent?.reason);
	if (parent?.aborted) controller.abort(parent.reason);
	else parent?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		close() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}

const IMAGE_MIME_BY_EXTENSION: Record<string, TelegramImageRef["mimeType"]> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

function hasImageSignature(bytes: Buffer, mimeType: TelegramImageRef["mimeType"]): boolean {
	if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function readSafeOutboundImage(path: string, projectRoot: string): Promise<{
	bytes: Buffer;
	filename: string;
	mimeType: TelegramImageRef["mimeType"];
}> {
	if (!path || isAbsolute(path)) throw new ImageSafetyError("Outbound image path must be project-relative");
	const root = await realpath(projectRoot);
	const candidate = await realpath(resolve(projectRoot, path));
	const rel = relative(root, candidate);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new ImageSafetyError("Outbound image must be a file inside the project directory");
	}
	const info = await stat(candidate);
	if (!info.isFile()) throw new ImageSafetyError("Outbound image must be a regular file");
	if (info.size <= 0 || info.size > MAX_IMAGE_BYTES) {
		throw new ImageSafetyError(`Outbound image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
	}
	const mimeType = IMAGE_MIME_BY_EXTENSION[extname(candidate).toLowerCase()];
	if (!mimeType) throw new ImageSafetyError("Outbound image must be JPEG, PNG, or WebP");
	const bytes = await readFile(candidate);
	if (!hasImageSignature(bytes, mimeType)) throw new ImageSafetyError("Outbound image contents do not match its extension");
	return { bytes, filename: basename(candidate), mimeType };
}

export class TelegramApiClient {
	readonly #token: string;
	private readonly chatId: number;
	private readonly fetchImpl: FetchLike;
	private readonly requestDeadlineMs: number;

	constructor(
		token: string,
		chatId: number,
		fetchImpl: FetchLike = fetch as unknown as FetchLike,
		requestDeadlineMs = 35_000,
	) {
		this.#token = token;
		this.chatId = chatId;
		this.fetchImpl = fetchImpl;
		this.requestDeadlineMs = requestDeadlineMs;
	}

	/** Resolves and validates the configured bot's Telegram display name. */
	async getBotFirstName(signal?: AbortSignal): Promise<string> {
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/getMe`, {
				method: "POST",
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean; result?: { first_name?: unknown } };
			if (!response.ok || payload.ok !== true) {
				throw new Error(`Telegram getMe failed (HTTP ${response.status ?? "unknown"})`);
			}
			return validateAgentLabel(payload.result?.first_name, "Telegram getMe first_name");
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	/** Idempotently reconciles the configured bot's server-side command menu. */
	async setOwnerCommandMenu(signal?: AbortSignal): Promise<void> {
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/setMyCommands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ commands: telegramOwnerMenuCommands() }),
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean };
			if (!response.ok || payload.ok !== true) {
				throw new Error(`Telegram setMyCommands failed (HTTP ${response.status ?? "unknown"})`);
			}
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async getUpdates(cursor?: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			return await fetchUpdateBatch(this.fetchImpl, this.#token, cursor, deadline.signal, 25);
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async sendChatAction(signal?: AbortSignal): Promise<void> {
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/sendChatAction`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: this.chatId, action: "typing" }),
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean };
			if (!response.ok || payload.ok !== true) {
				throw new Error(`Telegram sendChatAction failed (HTTP ${response.status ?? "unknown"})`);
			}
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async downloadImage(image: TelegramImageRef, signal?: AbortSignal): Promise<ResolvedImage> {
		if (image.fileSize && image.fileSize > MAX_IMAGE_BYTES) throw new ImageSafetyError("Telegram image is too large");
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const metadataResponse = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/getFile`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ file_id: image.fileId }),
				signal: deadline.signal,
			});
			const metadata = (await metadataResponse.json()) as {
				ok?: boolean;
				result?: { file_path?: unknown; file_size?: unknown };
			};
			const filePath = metadata.result?.file_path;
			const fileSize = metadata.result?.file_size;
			if (!metadataResponse.ok || metadata.ok !== true || typeof filePath !== "string") {
				throw new Error(`Telegram getFile failed (HTTP ${metadataResponse.status ?? "unknown"})`);
			}
			if (!Number.isSafeInteger(fileSize) || (fileSize as number) <= 0 || (fileSize as number) > MAX_IMAGE_BYTES) {
				throw new ImageSafetyError("Telegram image metadata has an invalid size");
			}
			if (!/^[A-Za-z0-9_.\/-]+$/.test(filePath) || filePath.split("/").includes("..") || filePath.startsWith("/")) {
				throw new ImageSafetyError("Telegram returned an unsafe file path");
			}
			const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
			const fileResponse = await this.fetchImpl(`https://api.telegram.org/file/bot${this.#token}/${encodedPath}`, {
				method: "GET",
				signal: deadline.signal,
			});
			if (!fileResponse.ok || !fileResponse.arrayBuffer) {
				throw new Error(`Telegram file download failed (HTTP ${fileResponse.status ?? "unknown"})`);
			}
			const bytes = Buffer.from(await fileResponse.arrayBuffer());
			if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageSafetyError("Telegram image has an invalid size");
			if (!hasImageSignature(bytes, image.mimeType)) throw new ImageSafetyError("Telegram image contents do not match the declared type");
			return { data: bytes.toString("base64"), mimeType: image.mimeType };
		} catch (error) {
			if (error instanceof ImageSafetyError) throw error;
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async sendPhoto(
		image: { bytes: Buffer; filename: string; mimeType: string },
		caption?: string,
		replyToMessageId?: number,
		signal?: AbortSignal,
	): Promise<string> {
		if (caption && caption.length > 1_024) throw new ImageSafetyError("Telegram photo caption must not exceed 1024 characters");
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const form = new FormData();
			form.set("chat_id", String(this.chatId));
			form.set("photo", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.filename);
			if (caption) form.set("caption", caption);
			if (replyToMessageId !== undefined) form.set("reply_to_message_id", String(replyToMessageId));
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/sendPhoto`, {
				method: "POST",
				body: form,
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean; result?: { message_id?: unknown } };
			if (!response.ok || payload.ok !== true || typeof payload.result?.message_id !== "number") {
				throw new Error(`Telegram sendPhoto failed (HTTP ${response.status ?? "unknown"})`);
			}
			return String(payload.result.message_id);
		} catch (error) {
			if (error instanceof ImageSafetyError) throw error;
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async editMessageText(messageId: string, text: string, signal?: AbortSignal): Promise<void> {
		const numericMessageId = Number(messageId);
		if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) throw new Error("Invalid Telegram message ID");
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/editMessageText`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: this.chatId, message_id: numericMessageId, text }),
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean };
			if (!response.ok || payload.ok !== true) {
				throw new Error(`Telegram editMessageText failed (HTTP ${response.status ?? "unknown"})`);
			}
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async deleteMessage(messageId: string, signal?: AbortSignal): Promise<void> {
		const numericMessageId = Number(messageId);
		if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) throw new Error("Invalid Telegram message ID");
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/deleteMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: this.chatId, message_id: numericMessageId }),
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean };
			if (!response.ok || payload.ok !== true) {
				throw new Error(`Telegram deleteMessage failed (HTTP ${response.status ?? "unknown"})`);
			}
		} catch (error) {
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}

	async sendMessage(text: string, replyToMessageId?: number, signal?: AbortSignal, format: "HTML" | "plain" = "plain"): Promise<string> {
		const deadline = deadlineSignal(signal, this.requestDeadlineMs);
		try {
			const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: this.chatId,
					text,
					reply_to_message_id: replyToMessageId,
					parse_mode: format === "HTML" ? "HTML" : undefined,
				}),
				signal: deadline.signal,
			});
			const payload = (await response.json()) as { ok?: boolean; description?: unknown; result?: { message_id?: unknown } };
			if (!response.ok || payload.ok !== true || typeof payload.result?.message_id !== "number") {
				const description = typeof payload.description === "string" ? payload.description : "";
				if (format === "HTML" && response.status === 400 && /parse|entity|tag/i.test(description)) {
					throw new TelegramParseError("Telegram rejected formatted message");
				}
				if (replyToMessageId !== undefined && response.status === 400 && description === "Bad Request: message to be replied not found") {
					throw new TelegramReplyAnchorError("Telegram rejected missing reply target");
				}
				throw new Error(`Telegram sendMessage failed (HTTP ${response.status ?? "unknown"})`);
			}
			return String(payload.result.message_id);
		} catch (error) {
			if (error instanceof TelegramParseError || error instanceof TelegramReplyAnchorError) throw error;
			throw new Error(sanitizeError(error, this.#token));
		} finally {
			deadline.close();
		}
	}
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (milliseconds, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(done, milliseconds);
		function done(): void {
			signal.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", aborted, { once: true });
	});

export interface UpdateClient {
	getUpdates(cursor?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

export class TelegramTypingActivity {
	private controller?: AbortController;
	private loop?: Promise<void>;
	private readonly sendTyping: (signal: AbortSignal) => Promise<void>;
	private readonly onFailure: (error: unknown) => void;
	private readonly sleep: Sleep;
	private readonly intervalMs: number;

	constructor(
		sendTyping: (signal: AbortSignal) => Promise<void>,
		onFailure: (error: unknown) => void,
		sleep: Sleep = abortableSleep,
		intervalMs = 4_000,
	) {
		this.sendTyping = sendTyping;
		this.onFailure = onFailure;
		this.sleep = sleep;
		this.intervalMs = intervalMs;
	}

	start(): void {
		if (this.loop) return;
		const controller = new AbortController();
		this.controller = controller;
		const loop = this.run(controller.signal);
		this.loop = loop;
		const clear = () => {
			if (this.loop === loop) {
				this.loop = undefined;
				this.controller = undefined;
			}
		};
		void loop.then(clear, clear);
	}

	async stop(): Promise<void> {
		const loop = this.loop;
		this.controller?.abort(new Error("Telegram typing activity stopped"));
		await loop;
	}

	private async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.sendTyping(signal);
			} catch (error) {
				if (signal.aborted) break;
				try {
					this.onFailure(error);
				} catch {
					// Local reporting must not terminate or leak the best-effort loop.
				}
			}
			if (signal.aborted) break;
			try {
				await this.sleep(this.intervalMs, signal);
			} catch {
				break;
			}
		}
	}
}

const MAX_ACTIVITY_TEXT = 160;

function boundedActivityText(text: string): string {
	if (text.length <= MAX_ACTIVITY_TEXT) return text;
	return `${text.slice(0, MAX_ACTIVITY_TEXT - 1)}…`;
}

export interface TelegramActivityMessageOptions {
	send(text: string, signal: AbortSignal): Promise<string>;
	edit(messageId: string, text: string, signal: AbortSignal): Promise<void>;
	delete(messageId: string, signal: AbortSignal): Promise<void>;
	onStarted(jobId: string, messageId: string): Promise<void>;
	onCleared(jobId: string, messageId: string): Promise<void>;
	onFailure(operation: "send" | "edit" | "delete" | "journal", error: unknown): void;
	sleep?: Sleep;
	now?: () => number;
	minimumEditIntervalMs?: number;
}

/** Owns the single ephemeral activity message for one confirmed Telegram job. */
export class TelegramActivityMessage {
	private readonly jobId: string;
	private readonly options: TelegramActivityMessageOptions;
	private readonly initialText: string;
	private readonly controller = new AbortController();
	private worker?: Promise<void>;
	private messageId?: string;
	private desired: string;
	private attempted = "";
	private lastChangeAt = 0;
	private acceptingUpdates = true;

	constructor(jobId: string, options: TelegramActivityMessageOptions, initialText = "Thinking…") {
		this.jobId = jobId;
		this.options = options;
		this.initialText = boundedActivityText(initialText);
		this.desired = this.initialText;
	}

	start(): void {
		this.ensureWorker();
	}

	update(text: string): void {
		if (!this.acceptingUpdates || !text || text === this.desired) return;
		this.desired = boundedActivityText(text);
		this.ensureWorker();
	}

	async stopAndDelete(): Promise<void> {
		if (!this.acceptingUpdates && !this.worker) return;
		this.acceptingUpdates = false;
		this.controller.abort(new Error("Telegram activity stopped"));
		await this.worker?.catch(() => undefined);
		this.worker = undefined;
		const messageId = this.messageId;
		if (!messageId) return;
		try {
			await this.options.delete(messageId, new AbortController().signal);
		} catch (error) {
			this.fail("delete", error);
			return;
		}
		try {
			await this.options.onCleared(this.jobId, messageId);
			this.messageId = undefined;
		} catch (error) {
			this.fail("journal", error);
		}
	}

	private ensureWorker(): void {
		if (this.worker || !this.acceptingUpdates) return;
		const worker = this.run();
		this.worker = worker;
		void worker.finally(() => {
			if (this.worker === worker) this.worker = undefined;
			if (this.acceptingUpdates && this.messageId && this.desired !== this.attempted) this.ensureWorker();
		}).catch(() => undefined);
	}

	private async run(): Promise<void> {
		if (!this.messageId) {
			this.attempted = this.initialText;
			try {
				this.messageId = await this.options.send(this.initialText, this.controller.signal);
				this.lastChangeAt = (this.options.now ?? Date.now)();
				await this.options.onStarted(this.jobId, this.messageId);
			} catch (error) {
				if (!this.controller.signal.aborted) this.fail(this.messageId ? "journal" : "send", error);
				return;
			}
		}
		while (this.acceptingUpdates && this.messageId && this.desired !== this.attempted) {
			const interval = this.options.minimumEditIntervalMs ?? 1_000;
			const wait = Math.max(0, this.lastChangeAt + interval - (this.options.now ?? Date.now)());
			if (wait) {
				try {
					await (this.options.sleep ?? abortableSleep)(wait, this.controller.signal);
				} catch {
					return;
				}
			}
			if (!this.acceptingUpdates) return;
			const text = this.desired;
			this.attempted = text;
			try {
				await this.options.edit(this.messageId, text, this.controller.signal);
				this.lastChangeAt = (this.options.now ?? Date.now)();
			} catch (error) {
				if (!this.controller.signal.aborted) this.fail("edit", error);
			}
		}
	}

	private fail(operation: "send" | "edit" | "delete" | "journal", error: unknown): void {
		try {
			this.options.onFailure(operation, error);
		} catch {
			// Reporting is best effort and must never affect the durable reply.
		}
	}
}

export function reconnectDelay(failures: number, random: () => number = Math.random): number {
	const base = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
	return Math.min(30_000, Math.round(base * (0.75 + random() * 0.5)));
}

export class LongPollSource {
	private controller?: AbortController;
	private loop?: Promise<void>;
	private readonly client: UpdateClient;
	private readonly onStatus: (status: ConnectionStatus) => void;
	private readonly sleep: Sleep;
	private readonly random: () => number;

	constructor(
		client: UpdateClient,
		onStatus: (status: ConnectionStatus) => void,
		sleep: Sleep = abortableSleep,
		random: () => number = Math.random,
	) {
		this.client = client;
		this.onStatus = onStatus;
		this.sleep = sleep;
		this.random = random;
	}

	async start(
		onBatch: (updates: TelegramUpdate[]) => Promise<number | undefined>,
		cursor?: number,
	): Promise<() => Promise<void>> {
		if (this.loop) throw new Error("Telegram poller already started");
		const controller = new AbortController();
		this.controller = controller;
		this.loop = this.run(controller.signal, onBatch, cursor);
		return async () => {
			this.onStatus({ phase: "stopping" });
			controller.abort(new Error("Telegram poller stopped"));
			await this.loop?.catch(() => undefined);
			this.loop = undefined;
			this.controller = undefined;
		};
	}

	private async run(
		signal: AbortSignal,
		onBatch: (updates: TelegramUpdate[]) => Promise<number | undefined>,
		cursor?: number,
	): Promise<void> {
		let failures = 0;
		let lastSuccessfulPoll: string | undefined;
		this.onStatus({ phase: "connecting" });
		while (!signal.aborted) {
			try {
				const updates = await this.client.getUpdates(cursor, signal);
				if (signal.aborted) break;
				// Run on every successful poll so durable outbound maintenance does
				// not depend on a new inbound Telegram message.
				const durableCursor = await onBatch(updates);
				if (durableCursor !== undefined) cursor = durableCursor;
				failures = 0;
				lastSuccessfulPoll = new Date().toISOString();
				this.onStatus({ phase: "connected", lastSuccessfulPoll });
			} catch (error) {
				if (signal.aborted) break;
				const delay = reconnectDelay(failures, this.random);
				failures += 1;
				this.onStatus({ phase: "backoff", lastSuccessfulPoll, lastError: sanitizeError(error), retryDelayMs: delay });
				try {
					await this.sleep(delay, signal);
				} catch {
					break;
				}
			}
		}
	}
}

export type PidState = "alive" | "dead" | "unknown";

export interface BootIdentity {
	/** Stable for one boot: macOS kern.boottime or Linux boot_id. */
	id: string;
	startedAtMs: number;
}

export function systemPidState(pid: number): PidState {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		return "unknown";
	}
}

let cachedBootIdentity: BootIdentity | undefined;

/** Linux kernel interfaces; no wall-clock/uptime estimate is safe for lock recovery. */
export function linuxBootIdentity(
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): BootIdentity | undefined {
	try {
		const id = read("/proc/sys/kernel/random/boot_id").trim();
		const match = /^btime (\d+)$/m.exec(read("/proc/stat"));
		if (!UUID.test(id) || !match) return undefined;
		const startedAtMs = Number(match[1]) * 1_000;
		if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return undefined;
		return { id, startedAtMs };
	} catch {
		return undefined;
	}
}

/** Returns undefined rather than guessing when the host boot cannot be identified. */
export function systemBootIdentity(): BootIdentity | undefined {
	if (cachedBootIdentity) return cachedBootIdentity;
	if (process.platform === "linux") {
		cachedBootIdentity = linuxBootIdentity();
		return cachedBootIdentity;
	}
	if (process.platform !== "darwin") return undefined;
	try {
		const output = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(output);
		if (!match) return undefined;
		const seconds = Number(match[1]);
		const microseconds = Number(match[2]);
		if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds >= 1_000_000) {
			return undefined;
		}
		cachedBootIdentity = {
			id: `${seconds}.${String(microseconds).padStart(6, "0")}`,
			startedAtMs: seconds * 1_000 + microseconds / 1_000,
		};
		return cachedBootIdentity;
	} catch {
		return undefined;
	}
}

const GUARD_MARKER = "protocol-v1";
const GUARD_OWNER_PREFIX = "owner-";
const GUARD_PROTOCOL = "telegram-poller-operation-guard";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GuardOwner = { version: 1; pid: number; nonce: string; bootId: string };

function protectedMode(mode: number): boolean {
	return (fileMode(mode) & 0o077) === 0;
}

function ownedByCurrentUser(uid: number): boolean {
	return !process.getuid || uid === process.getuid();
}

function validGuardOwner(value: unknown, nonce: string): value is GuardOwner {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const owner = value as Record<string, unknown>;
	return Object.keys(owner).sort().join(",") === "bootId,nonce,pid,version"
		&& owner.version === 1
		&& typeof owner.pid === "number"
		&& Number.isSafeInteger(owner.pid)
		&& owner.pid > 0
		&& owner.nonce === nonce
		&& UUID.test(nonce)
		&& typeof owner.bootId === "string"
		&& SAFE_ID.test(owner.bootId);
}

async function readProtectedJson(path: string): Promise<unknown> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size <= 0 || info.size > 1_024 || !protectedMode(info.mode) || !ownedByCurrentUser(info.uid)) {
			throw new Error("owner metadata is not a small protected regular file");
		}
		return JSON.parse(await file.readFile("utf8")) as unknown;
	} finally {
		await file.close();
	}
}

async function publishProtectedFile(guardPath: string, destination: string, contents: string): Promise<void> {
	const temporary = join(dirname(guardPath), `.${basename(guardPath)}.tmp-${randomUUID()}`);
	let created = false;
	try {
		const file = await open(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		created = true;
		try {
			await file.write(contents);
			await file.sync();
		} finally {
			await file.close();
		}
		await link(temporary, destination);
	} finally {
		if (created) await unlink(temporary).catch(() => undefined);
	}
}

function guardBusy(path: string): PollerLockError {
	return new PollerLockError(`Telegram poller lock operation is already in progress: ${path}`);
}

function guardUnsafe(path: string): PollerLockError {
	return new PollerLockError(`Telegram poller guard ownership cannot be proven stale; refusing unsafe recovery: ${path}`);
}

async function requireGuardDirectory(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || !protectedMode(info.mode) || !ownedByCurrentUser(info.uid)) throw guardUnsafe(path);
}

async function initializeGuardDirectory(path: string, boot: BootIdentity): Promise<void> {
	let created = false;
	try {
		await mkdir(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await requireGuardDirectory(path);
	const entries = await readdir(path);
	if (!entries.includes(GUARD_MARKER)) {
		// An old guard directory had no metadata. It is recoverable only when it
		// is empty and every mutation timestamp proves that it predates this boot.
		if (!created) {
			const info = await stat(path);
			const newestTimestamp = Math.max(info.birthtimeMs, info.ctimeMs, info.mtimeMs);
			if (entries.length !== 0 || !Number.isFinite(newestTimestamp) || newestTimestamp >= boot.startedAtMs) {
				throw guardUnsafe(path);
			}
		}
		try {
			await publishProtectedFile(
				path,
				join(path, GUARD_MARKER),
				`${JSON.stringify({ version: 1, kind: GUARD_PROTOCOL })}\n`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	let marker: unknown;
	try {
		marker = await readProtectedJson(join(path, GUARD_MARKER));
	} catch {
		throw guardUnsafe(path);
	}
	if (!marker || typeof marker !== "object"
		|| Object.keys(marker as Record<string, unknown>).sort().join(",") !== "kind,version"
		|| (marker as { version?: unknown }).version !== 1
		|| (marker as { kind?: unknown }).kind !== GUARD_PROTOCOL) {
		throw guardUnsafe(path);
	}
}

function guardOwnerState(owner: GuardOwner, boot: BootIdentity, pidState: (pid: number) => PidState): PidState {
	if (owner.bootId !== boot.id) return "dead";
	return pidState(owner.pid);
}

export class PollerLock {
	private readonly path: string;
	private readonly nonce: string;
	private readonly pid: number;
	private readonly pidState: (pid: number) => PidState;
	private readonly boot: BootIdentity;

	private constructor(
		path: string,
		nonce: string,
		pid: number,
		pidState: (pid: number) => PidState,
		boot: BootIdentity,
	) {
		this.path = path;
		this.nonce = nonce;
		this.pid = pid;
		this.pidState = pidState;
		this.boot = boot;
	}

	private static async withGuard<T>(
		path: string,
		pid: number,
		pidState: (pid: number) => PidState,
		boot: BootIdentity,
		action: () => Promise<T>,
	): Promise<T> {
		const guardPath = `${path}.guard`;
		await initializeGuardDirectory(guardPath, boot);
		const nonce = randomUUID();
		const claimName = `${GUARD_OWNER_PREFIX}${nonce}`;
		const claimPath = join(guardPath, claimName);
		const owner: GuardOwner = { version: 1, pid, nonce, bootId: boot.id };
		await publishProtectedFile(guardPath, claimPath, `${JSON.stringify(owner)}\n`);
		try {
			let blocked = false;
			for (const entry of await readdir(guardPath)) {
				if (entry === GUARD_MARKER) continue;
				if (!entry.startsWith(GUARD_OWNER_PREFIX)) throw guardUnsafe(guardPath);
				const entryNonce = entry.slice(GUARD_OWNER_PREFIX.length);
				let other: unknown;
				try {
					other = await readProtectedJson(join(guardPath, entry));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw guardUnsafe(join(guardPath, entry));
				}
				if (!validGuardOwner(other, entryNonce)) throw guardUnsafe(join(guardPath, entry));
				if (entryNonce === nonce) continue;
				const state = guardOwnerState(other, boot, pidState);
				if (state === "dead") {
					// Claim names contain a nonce and are never reused, so concurrent
					// reclaimers cannot unlink a replacement owner.
					await unlink(join(guardPath, entry)).catch((error) => {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					});
				} else {
					blocked = true;
				}
			}
			if (blocked) throw guardBusy(guardPath);
			return await action();
		} finally {
			await unlink(claimPath).catch(() => undefined);
		}
	}

	static async acquire(
		path: string,
		pid = process.pid,
		pidState: (pid: number) => PidState = systemPidState,
		bootIdentity: () => BootIdentity | undefined = systemBootIdentity,
	): Promise<PollerLock> {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const boot = bootIdentity();
		if (!boot || !SAFE_ID.test(boot.id) || !Number.isFinite(boot.startedAtMs)) {
			throw new PollerLockError("Telegram poller lock cannot establish a trustworthy system boot identity");
		}
		return PollerLock.withGuard(path, pid, pidState, boot, async () => {
			const create = async (): Promise<PollerLock> => {
				const nonce = randomUUID();
				const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
				try {
					await file.write(`${JSON.stringify({ pid, nonce, bootId: boot.id })}\n`);
					await file.sync();
				} finally {
					await file.close();
				}
				return new PollerLock(path, nonce, pid, pidState, boot);
			};
			try {
				return await create();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			let owner: { pid?: unknown; bootId?: unknown };
			try {
				owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; bootId?: unknown };
			} catch {
				throw new PollerLockError(`Telegram poller lock is unreadable; refusing unsafe removal: ${path}`);
			}
			const validPid = typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0;
			const oldFormatOwner = owner.bootId === undefined;
			const validBootId = typeof owner.bootId === "string" && SAFE_ID.test(owner.bootId);
			const ownerFromPriorBoot = validBootId && owner.bootId !== boot.id;
			const provenDead = validPid && (ownerFromPriorBoot
				|| ((oldFormatOwner || owner.bootId === boot.id) && pidState(owner.pid as number) === "dead"));
			if (!provenDead) {
				throw new PollerLockError(`Telegram poller lock is held or owner cannot be proven dead: ${path}`);
			}
			await unlink(path);
			return create();
		});
	}

	async release(): Promise<void> {
		await PollerLock.withGuard(this.path, this.pid, this.pidState, this.boot, async () => {
			try {
				const owner = JSON.parse(await readFile(this.path, "utf8")) as { nonce?: unknown };
				if (owner.nonce === this.nonce) await unlink(this.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
	}
}
