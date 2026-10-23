import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stringify as stringifyYaml } from "yaml";
import { validWork, type GroupWork } from "./work.ts";

import { PollerLock, PollerLockError, systemBootIdentity, systemPidState, type BootIdentity, type PidState } from "./runtime.ts";

export const GROUP_EVENT_SCHEMA = "pi-telegram-owner/group-event/v1";
export const GROUP_MESSAGE_NOTE_SCHEMA = "pi-telegram-owner/group-message/v1";
export const GROUP_STATE_DIRECTORY = ".telegram-archive";
export const GROUP_ATTACHMENTS_DIRECTORY = "_attachments";
/** How the owner appears as a sender in the group journal. */
export const GROUP_OWNER_SENDER = "Owner";

export interface TelegramEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: { id: number };
}

export interface GroupMessage {
	chatId: number;
	/** The first Telegram message ID; a split agent post lists every part in partIds. */
	messageId: number;
	partIds?: number[];
	senderId: number;
	/** Display name: the owner, a configured agent's name, or the sender's Telegram name. */
	sender: string;
	senderKind: "owner" | "agent" | "other";
	/** Telegram Unix time in seconds. */
	date: number;
	/** Untrimmed message text or caption; empty when there is neither. */
	text: string;
	entities: TelegramEntity[];
	replyToMessageId?: number;
	/** Agent posts: a request sent with telegram_group_send, or an answer. */
	posting?: { kind: "request" | "answer" | "notify"; originItemId?: string };
	work?: GroupWork;
	/** Recorded from Telegram's copy inside a reply; the sender's own record supersedes it. */
	source?: "reply-copy";
	media?: { kind: "photo" | "document" | "other"; fileName?: string; mimeType?: string; size?: number; attachment?: string };
}

interface EventBase {
	schema: typeof GROUP_EVENT_SCHEMA;
	seq: number;
	recordedAt: string;
}

export type GroupEvent =
	| (EventBase & { kind: "message"; message: GroupMessage; recordedBy: string })
	| (EventBase & { kind: "conflict"; chatId: number; messageId: number; observed: GroupMessage; recordedBy: string })
	| (EventBase & { kind: "claim"; chatId: number; messageId: number; agent: string })
	| (EventBase & { kind: "election_notice"; chatId: number; messageId: number; noticeMessageId: number; agent: string })
	| (EventBase & { kind: "roster_check"; agent: string; peer: string; result: "match" | "mismatch" });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GroupEventInput = DistributiveOmit<GroupEvent, "schema" | "seq" | "recordedAt">;

export interface GroupJournalOptions {
	pidState?: (pid: number) => PidState;
	bootIdentity?: () => BootIdentity | undefined;
	now?: () => number;
	/** Backoff while another agent holds the lock. */
	sleep?: (milliseconds: number) => Promise<void>;
}

export interface RecordResult {
	outcome: "recorded" | "duplicate" | "conflict";
	event: GroupEvent;
}

/** Identity used to decide whether two observations describe the same message. */
function fingerprint(message: GroupMessage): string {
	return JSON.stringify([message.chatId, message.messageId, message.senderId, message.text, message.work]);
}

/** The latest recorded version of each message; an agent's own post supersedes a reply copy. */
function latestMessages(events: readonly GroupEvent[], chatId?: number): Map<string, GroupMessage> {
	const messages = new Map<string, GroupMessage>();
	for (const event of events) {
		if (event.kind === "message" && (chatId === undefined || event.message.chatId === chatId)) messages.set(key(event.message.chatId, event.message.messageId), event.message);
	}
	return messages;
}

function findClaim(events: readonly GroupEvent[], chatId: number, messageIds: readonly number[]): string | undefined {
	return events.find((event): event is Extract<GroupEvent, { kind: "claim" }> => event.kind === "claim" && event.chatId === chatId && messageIds.includes(event.messageId))?.agent;
}

/** Contention that resolves when another agent finishes; anything else is a broken lock. */
function lockBusy(error: PollerLockError): boolean {
	return /already in progress|is held or owner cannot be proven dead/.test(error.message);
}

export class GroupJournalClosedError extends Error {}

function key(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
	const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		await file.writeFile(content);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Relative note path: notes sit directly under the shared root by month. */
export function groupNotePath(message: GroupMessage): string {
	const date = new Date(message.date * 1000);
	const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
	return join(String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), `${day}T${time}Z-${message.messageId}.md`);
}

function mediaLabel(media: NonNullable<GroupMessage["media"]>): string {
	return media.kind === "photo" ? "[photo]" : media.fileName ? `[${media.kind}: ${media.fileName}]` : `[${media.kind}]`;
}

export function renderGroupNote(message: GroupMessage): string {
	const metadata = {
		schema: GROUP_MESSAGE_NOTE_SCHEMA,
		chatId: message.chatId,
		messageId: message.messageId,
		telegramMessageIds: message.partIds ?? [message.messageId],
		sender: message.sender,
		senderKind: message.senderKind,
		occurredAt: new Date(message.date * 1000).toISOString(),
		...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
		...(message.posting ? { posting: message.posting.kind } : {}),
		...(message.work ? { work: message.work } : {}),
		...(message.media ? { media: message.media } : {}),
	};
	const parts = [message.text, message.media?.attachment ? `![[${message.media.attachment}|512]]` : message.media ? mediaLabel(message.media) : ""].filter(Boolean);
	return `---\n${stringifyYaml(metadata, { lineWidth: 0 })}---\n\n${parts.join("\n\n")}\n`;
}

/**
 * The shared group journal: one forward-only event log contributed to by
 * every agent, with Markdown notes as its projection.
 */
export class GroupJournal {
	readonly root: string;
	readonly eventsPath: string;
	private readonly lockPath: string;
	private readonly options: GroupJournalOptions;
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(root: string, options: GroupJournalOptions = {}) {
		this.root = root;
		this.eventsPath = join(root, GROUP_STATE_DIRECTORY, "events.jsonl");
		this.lockPath = join(root, GROUP_STATE_DIRECTORY, "lock");
		this.options = options;
	}

	private now(): string {
		return new Date((this.options.now ?? Date.now)()).toISOString();
	}

	/** Stops waiting for the lock; pending and later writes fail. */
	close(): void {
		this.closed = true;
	}

	/** The shared root must be a directory owned by this account with no group or other access. */
	async checkRoot(): Promise<void> {
		const info = await lstat(this.root).catch(() => undefined);
		if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`the shared root ${this.root} is not a directory`);
		if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error(`the shared root ${this.root} must be owned by this account with mode 0700`);
	}

	/** Reads every complete event. A fragment left by a crashed writer is skipped. */
	async events(): Promise<GroupEvent[]> {
		let text: string;
		try {
			text = await readFile(this.eventsPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const events: GroupEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const event = JSON.parse(line) as GroupEvent;
				if (event.schema === GROUP_EVENT_SCHEMA && Number.isSafeInteger(event.seq)) events.push(event);
			} catch {
				// Incomplete fragment from a writer whose lock was recovered.
			}
		}
		for(const event of events) if(event.kind==='message'&&event.message.work&&!validWork(event.message.work)) throw new Error('Invalid group lifecycle metadata');
		return events;
	}

	/** A message by its ID, or by any part ID of a split agent post. */
	async message(chatId: number, messageId: number): Promise<GroupMessage | undefined> {
		const messages = latestMessages(await this.events(), chatId);
		return messages.get(key(chatId, messageId)) ?? [...messages.values()].find((message) => message.partIds?.includes(messageId));
	}

	/** Every journaled message ID in a chat, including split-post parts. */
	async messageIds(chatId: number): Promise<Set<number>> {
		const ids = new Set<number>();
		for (const message of latestMessages(await this.events(), chatId).values()) {
			ids.add(message.messageId);
			for (const part of message.partIds ?? []) ids.add(part);
		}
		return ids;
	}

	/** The agent that claimed any of these messages, if one has. */
	async claimFor(chatId: number, messageIds: number | readonly number[]): Promise<string | undefined> {
		return findClaim(await this.events(), chatId, typeof messageIds === "number" ? [messageIds] : messageIds);
	}

	/** Messages in Telegram order, optionally before or after a message ID. */
	async timeline(input: { chatId: number; before?: number; after?: number; limit: number }): Promise<GroupMessage[]> {
		const messages = [...latestMessages(await this.events(), input.chatId).values()]
			.filter((message) => (input.before === undefined || message.messageId < input.before) && (input.after === undefined || message.messageId > input.after))
			.sort((a, b) => a.messageId - b.messageId);
		return input.after !== undefined ? messages.slice(0, input.limit) : messages.slice(-input.limit);
	}

	/**
	 * Records a message once. Identical observations are no-ops and a different
	 * one is recorded as a conflict, except that the sender's own record of a
	 * message supersedes Telegram's reply copy of it.
	 */
	recordMessage(message: GroupMessage, recordedBy: string): Promise<RecordResult> {
		if(message.work&&!validWork(message.work)) return Promise.reject(new Error('Invalid group lifecycle metadata'));
		return this.withLock(async (events, append) => {
			const existing = latestMessages(events, message.chatId).get(key(message.chatId, message.messageId));
			if (!existing || (existing.source === "reply-copy" && message.source !== "reply-copy")) {
				const event = await append({ kind: "message", message, recordedBy });
				await this.project(message);
				return { outcome: "recorded", event };
			}
			const recorded = events.findLast((event) => event.kind === "message" && event.message.chatId === message.chatId && event.message.messageId === message.messageId)!;
			if (fingerprint(existing) === fingerprint(message) || message.source === "reply-copy") return { outcome: "duplicate", event: recorded };
			const event = await append({ kind: "conflict", chatId: message.chatId, messageId: message.messageId, observed: message, recordedBy });
			return { outcome: "conflict", event };
		});
	}

	/**
	 * Atomically claims messages for one agent. Without force, a claim by
	 * another agent on any of them wins; with force, the unclaimed ones are
	 * claimed regardless.
	 */
	claim(chatId: number, messageIds: number | readonly number[], agent: string, options: { force?: boolean } = {}): Promise<{ agent: string; won: boolean }> {
		const ids = typeof messageIds === "number" ? [messageIds] : [...messageIds];
		return this.withLock(async (events, append) => {
			const other = events.find((event): event is Extract<GroupEvent, { kind: "claim" }> => event.kind === "claim" && event.chatId === chatId && ids.includes(event.messageId) && event.agent !== agent);
			if (other && !options.force) return { agent: other.agent, won: false };
			for (const messageId of ids) {
				if (!events.some((event) => event.kind === "claim" && event.chatId === chatId && event.messageId === messageId)) await append({ kind: "claim", chatId, messageId, agent });
			}
			return { agent, won: true };
		});
	}

	/** Stores an image once by content hash; returns its path relative to the shared root. */
	async storeAttachment(bytes: Buffer, mimeType: "image/jpeg" | "image/png" | "image/webp"): Promise<string> {
		const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
		const relativePath = `${GROUP_ATTACHMENTS_DIRECTORY}/${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
		const path = join(this.root, relativePath);
		if (!(await lstat(path).catch(() => undefined))) await atomicWrite(path, bytes);
		return relativePath;
	}

	async readAttachment(relativePath: string): Promise<Buffer> {
		if (!/^_attachments\/[0-9a-f]{64}\.(jpg|png|webp)$/.test(relativePath)) throw new Error("Group attachment path is invalid");
		return readFile(join(this.root, relativePath));
	}

	/**
	 * Posts and records at most one election notice per item, and none once any
	 * of its messages is claimed. Returns the notice's message ID, if one exists.
	 */
	reserveNotice(chatId: number, messageIds: readonly number[], agent: string, send: () => Promise<number>): Promise<number | undefined> {
		return this.withLock(async (events, append) => {
			const existing = events.find((event): event is Extract<GroupEvent, { kind: "election_notice" }> => event.kind === "election_notice" && event.chatId === chatId && messageIds.includes(event.messageId));
			if (existing) return existing.noticeMessageId;
			if (findClaim(events, chatId, messageIds)) return undefined;
			const noticeMessageId = await send();
			await append({ kind: "election_notice", chatId, messageId: messageIds[0]!, noticeMessageId, agent });
			return noticeMessageId;
		});
	}

	async noticeFor(chatId: number, messageIds: number | readonly number[]): Promise<number | undefined> {
		const ids = typeof messageIds === "number" ? [messageIds] : messageIds;
		return (await this.events()).find((event): event is Extract<GroupEvent, { kind: "election_notice" }> => event.kind === "election_notice" && event.chatId === chatId && ids.includes(event.messageId))?.noticeMessageId;
	}

	async appendEvent(input: GroupEventInput): Promise<GroupEvent> {
		return this.withLock((_events, append) => append(input));
	}

	/** Rewrites any missing or outdated note from the event log. */
	async rebuildProjection(): Promise<number> {
		let written = 0;
		for (const message of latestMessages(await this.events()).values()) {
			if (await this.project(message)) written += 1;
		}
		return written;
	}

	private async project(message: GroupMessage): Promise<boolean> {
		const path = join(this.root, groupNotePath(message));
		const content = renderGroupNote(message);
		const current = await readFile(path, "utf8").catch(() => undefined);
		if (current === content) return false;
		await atomicWrite(path, content);
		return true;
	}

	private withLock<T>(work: (events: GroupEvent[], append: (input: GroupEventInput) => Promise<GroupEvent>) => Promise<T>): Promise<T> {
		const run = this.tail.then(async () => {
			const lock = await this.acquire();
			try {
				await this.terminateFragment();
				const events = await this.events();
				let seq = events.reduce((highest, event) => Math.max(highest, event.seq), 0);
				const append = async (input: GroupEventInput): Promise<GroupEvent> => {
					seq += 1;
					const event = { schema: GROUP_EVENT_SCHEMA, seq, recordedAt: this.now(), ...input } as GroupEvent;
					const file = await open(this.eventsPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
					try {
						await file.write(`${JSON.stringify(event)}\n`);
						await file.sync();
					} finally {
						await file.close();
					}
					events.push(event);
					return event;
				};
				return await work(events, append);
			} finally {
				await this.release(lock);
			}
		});
		this.tail = run.catch(() => undefined);
		return run;
	}

	/** A writer that crashed mid-append leaves an unterminated line; end it so later appends stay intact. */
	private async terminateFragment(): Promise<void> {
		const info = await lstat(this.eventsPath).catch(() => undefined);
		if (!info || info.size === 0) return;
		const file = await open(this.eventsPath, "r");
		let last: Buffer;
		try {
			last = Buffer.alloc(1);
			await file.read(last, 0, 1, info.size - 1);
		} finally {
			await file.close();
		}
		if (last[0] === 0x0a) return;
		const appendFile = await open(this.eventsPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
		try {
			await appendFile.write("\n");
			await appendFile.sync();
		} finally {
			await appendFile.close();
		}
	}

	private async acquire(): Promise<PollerLock> {
		return this.retryWhileBusy(() => PollerLock.acquire(this.lockPath, process.pid, this.options.pidState ?? systemPidState, this.options.bootIdentity ?? systemBootIdentity));
	}

	private release(lock: PollerLock): Promise<void> {
		return this.retryWhileBusy(() => lock.release());
	}

	/**
	 * Waits while another agent holds the lock or its guard; a dead holder is
	 * reclaimed by PollerLock. A lock that stays unreadable or unsafe is
	 * reported instead of waited on, so an operator can inspect it.
	 */
	private async retryWhileBusy<T>(operation: () => Promise<T>): Promise<T> {
		const sleep = this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		let unsafeAttempts = 0;
		for (let attempt = 0; ; attempt++) {
			if (this.closed) throw new GroupJournalClosedError("The group journal is closed");
			try {
				return await operation();
			} catch (error) {
				if (!(error instanceof PollerLockError) || /boot identity/.test(error.message)) throw error;
				// A lock being created is briefly unreadable; one that stays that way is broken.
				if (!lockBusy(error) && ++unsafeAttempts > 50) throw new Error(`The shared journal lock ${this.lockPath} is unreadable or unsafe; check that no agent is writing, then remove it (${error.message})`);
				await sleep(Math.min(1_000, 10 * 2 ** Math.min(attempt, 7)) * (0.5 + Math.random() / 2));
			}
		}
	}
}
