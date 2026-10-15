import {
	ReplyDestinationUnavailableError,
	workItemIdForKey,
	type GroupProgressRecord,
	type GroupUpdatePayload,
	type JournalRecord,
	type TelegramChatMemberUpdate,
	type TelegramMessage,
	type TelegramOwnerBridge,
	type WorkItem,
} from "./core.ts";
import type { EndpointResponse } from "./endpoint.ts";
import type { GroupJournal, GroupMessage, TelegramEntity } from "./group-journal.ts";
import { TelegramReplyAnchorError, type GroupAgentConfig, type GroupChatConfig } from "./runtime.ts";

/** The Telegram calls the group runtime makes against the configured group. */
export interface GroupTelegramApi {
	getMe(signal?: AbortSignal): Promise<{ id: number; username: string; firstName: string }>;
	getChat(signal?: AbortSignal): Promise<{ id: number; type: string }>;
	getChatMember(userId: number, signal?: AbortSignal): Promise<{ status: string; canRestrictMembers?: boolean; canDeleteMessages?: boolean }>;
	getChatMemberCount(signal?: AbortSignal): Promise<number>;
	removeChatMember(userId: number, signal?: AbortSignal): Promise<void>;
	leaveChat(chatId: number, signal?: AbortSignal): Promise<void>;
	sendMessage(text: string, replyToMessageId?: number, signal?: AbortSignal, format?: "HTML" | "plain"): Promise<string>;
	editMessageText(messageId: string, text: string, signal?: AbortSignal): Promise<void>;
	deleteMessage(messageId: string, signal?: AbortSignal): Promise<void>;
}

export type WakeResult = "accepted" | "rejected" | "retry";

export interface GroupRuntimeOptions {
	config: GroupChatConfig;
	ownerUserId: number;
	api: GroupTelegramApi;
	journal: GroupJournal;
	bridge: () => TelegramOwnerBridge | undefined;
	/** Admits a work item to this agent's queue and dispatches it when idle. */
	admit(input: Omit<WorkItem, "itemId" | "timestamp"> & { itemId: string }): Promise<unknown>;
	/** The owner's consecutive group messages within this window are one item. */
	quietWindowMs: number;
	/** Posts a wake-up to a peer's queue endpoint. */
	wake?(peer: GroupAgentConfig, messageId: number): Promise<WakeResult>;
	/** A short notice for the owner's private chat. */
	report(text: string): void;
	onError(error: unknown): void;
	onStatus?(): void;
	/** The shared journal gained entries; group search indexes may need a refresh. */
	onJournalChanged?(): void;
	/**
	 * Runs claim inside the agent's queue reservation when the agent is idle, then
	 * admits the item it returns. Resolves "busy" without calling claim otherwise.
	 */
	claimWhenIdle?(claim: () => Promise<(Omit<WorkItem, "itemId" | "timestamp"> & { itemId: string }) | undefined>): Promise<"busy" | "done">;
	/** Posts a coordination message to a peer; undefined when it cannot be reached. */
	coordinate?(peer: GroupAgentConfig, body: unknown): Promise<{ status: number; body: unknown } | undefined>;
	now?: () => number;
	/** Delay before retrying a failed wake-up or membership check. */
	retryDelayMs?: (attempt: number) => number;
}

export type MembershipState = { state: "verifying" } | { state: "verified" } | { state: "unverified"; reason: string };

const MEMBER_STATUSES = new Set(["creator", "administrator", "member", "restricted"]);
const OWNER_SENDER = "Owner";

async function defaultWake(peer: GroupAgentConfig, messageId: number): Promise<WakeResult> {
	try {
		const response = await fetch(`http://127.0.0.1:${peer.queuePort}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "group-message", messageId }) });
		if (response.status === 202) return "accepted";
		if (response.status === 409 || response.status === 400) return "rejected";
		return "retry";
	} catch {
		return "retry";
	}
}

/** Agent usernames mentioned as @username in text, as Telegram detects them. */
export function mentionedAccounts(text: string): string[] {
	return [...text.matchAll(/(?:^|[^\w@])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g)].map((match) => match[1]!.toLowerCase());
}

/** Group chat behavior for one agent: publication, routing, membership and peer delivery. */
export class GroupRuntime {
	private readonly options: GroupRuntimeOptions;
	private self?: { id: number; username: string };
	private membership: MembershipState = { state: "verifying" };
	private chain: Promise<void> = Promise.resolve();
	private stopped = false;
	private quietTimer?: ReturnType<typeof setTimeout>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private retryAttempt = 0;
	private lastReported?: string;

	/** Replies and transient messages in the group; sends are unavailable while membership is unverified. */
	readonly transport: {
		chatId: number;
		sendReply(text: string, replyTo?: number, format?: "HTML" | "plain"): Promise<string>;
		sendActivity(text: string, signal: AbortSignal, replyTo?: number): Promise<string>;
		editActivity(messageId: string, text: string, signal: AbortSignal): Promise<void>;
		deleteActivity(messageId: string, signal: AbortSignal): Promise<void>;
	};

	constructor(options: GroupRuntimeOptions) {
		this.options = options;
		this.transport = {
			chatId: options.config.chatId,
			sendReply: (text, replyTo, format) => {
				if (!this.verified) return Promise.reject(new ReplyDestinationUnavailableError(`The group chat is not available: ${this.statusText()}`));
				return options.api.sendMessage(text, replyTo, undefined, format);
			},
			sendActivity: (text, signal, replyTo) => {
				if (!this.verified) return Promise.reject(new ReplyDestinationUnavailableError("The group chat is not available"));
				return this.sendWithAnchor(text, replyTo, undefined, signal);
			},
			editActivity: (messageId, text, signal) => options.api.editMessageText(messageId, text, signal),
			deleteActivity: (messageId, signal) => options.api.deleteMessage(messageId, signal),
		};
	}

	get config(): GroupChatConfig {
		return this.options.config;
	}

	get identity(): { id: number; username: string } | undefined {
		return this.self;
	}

	get state(): MembershipState {
		return this.membership;
	}

	get verified(): boolean {
		return this.membership.state === "verified";
	}

	statusText(): string {
		return this.membership.state === "unverified" ? `group=unverified(${this.membership.reason})` : `group=${this.membership.state}`;
	}

	/** Resolves this bot's identity, verifies membership and processes anything left from before a restart. */
	async start(): Promise<void> {
		try {
			this.self = await this.options.api.getMe();
		} catch (error) {
			// The private transport keeps running; group work waits for a successful retry.
			this.setMembership({ state: "unverified", reason: `bot identity lookup failed (${error instanceof Error ? error.message : String(error)})` });
			this.scheduleRetry();
			return;
		}
		await this.run(async () => {
			await this.verify();
			if (this.verified) await this.exchangeRoster();
			await this.processUpdates();
			await this.recordAgentPosts();
			await this.deliverWakes();
			await this.electionTick();
		});
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.quietTimer) clearTimeout(this.quietTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.electionTimer) clearTimeout(this.electionTimer);
		await this.chain;
	}

	/** Called after the poller records new updates. */
	notifyUpdates(): void {
		void this.run(() => this.processUpdates());
	}

	/** Called after replies are delivered, to journal the agent's group posts and wake peers. */
	notifyReplies(): void {
		void this.run(async () => {
			await this.recordAgentPosts();
			await this.deliverWakes();
		});
	}

	private run(work: () => Promise<void>): Promise<void> {
		const next = this.chain.then(async () => {
			if (this.stopped) return;
			try {
				await work();
			} catch (error) {
				this.options.onError(error);
				this.scheduleRetry();
			}
		});
		this.chain = next;
		return next;
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retryTimer) return;
		const delay = (this.options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))))(this.retryAttempt);
		this.retryAttempt += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.run(async () => {
				if (this.membership.state !== "verified") await this.verify();
				await this.processUpdates();
				await this.electionTick();
				await this.recordAgentPosts();
				await this.deliverWakes();
			});
		}, delay);
		this.retryTimer.unref?.();
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}

	private records(): readonly JournalRecord[] {
		return this.options.bridge()?.journalRecords ?? [];
	}

	private async append(record: GroupProgressRecord): Promise<void> {
		const bridge = this.options.bridge();
		if (!bridge) throw new Error("Telegram bridge is not running");
		await bridge.appendGroupRecord(record);
	}

	private agentById(id: number): GroupAgentConfig | undefined {
		return this.config.otherAgents.find((agent) => agent.botUserId === id);
	}

	private agentByAccount(account: string): GroupAgentConfig | undefined {
		return this.config.otherAgents.find((agent) => agent.telegramAccount.toLowerCase() === account.toLowerCase());
	}

	private allowedMember(id: number): boolean {
		return id === this.options.ownerUserId || id === this.self?.id || Boolean(this.agentById(id));
	}

	private setMembership(next: MembershipState): void {
		const before = this.membership;
		this.membership = next;
		this.options.onStatus?.();
		if (next.state === "unverified") {
			const text = `Group chat paused: ${next.reason}. Nothing will be sent to the group until this is fixed.`;
			if (this.lastReported !== text) {
				this.lastReported = text;
				this.options.report(text);
			}
		} else if (next.state === "verified" && before.state === "unverified") {
			this.lastReported = undefined;
			this.options.report("Group chat membership verified; group work resumes.");
		}
		if (next.state === "verified") this.retryAttempt = 0;
	}

	/** Checks the chat type, this bot's admin rights, every configured member and the member count. */
	async verify(): Promise<void> {
		const { api, config, ownerUserId } = this.options;
		try {
			if (!this.self) this.self = await api.getMe();
			const chat = await api.getChat();
			if (chat.type !== "supergroup") return this.setMembership({ state: "unverified", reason: `the configured chat is a ${chat.type}, not a supergroup` });
			const me = await api.getChatMember(this.self.id);
			if (me.status !== "creator" && me.status !== "administrator") return this.setMembership({ state: "unverified", reason: "this bot is not a group administrator" });
			if (me.status === "administrator" && (!me.canRestrictMembers || !me.canDeleteMessages)) return this.setMembership({ state: "unverified", reason: "this bot needs permission to ban users and delete messages" });
			for (const [id, name] of [[ownerUserId, "the owner"] as const, ...config.otherAgents.map((agent) => [agent.botUserId, `@${agent.telegramAccount}`] as const)]) {
				const member = await api.getChatMember(id);
				if (!MEMBER_STATUSES.has(member.status)) return this.setMembership({ state: "unverified", reason: `${name} is not a member` });
			}
			const count = await api.getChatMemberCount();
			const expected = 2 + config.otherAgents.length;
			if (count !== expected) return this.setMembership({ state: "unverified", reason: `the group has ${count} members; expected ${expected}` });
			if (this.rosterMismatched) return;
			this.setMembership({ state: "verified" });
		} catch (error) {
			this.setMembership({ state: "unverified", reason: `membership check failed (${error instanceof Error ? error.message : String(error)})` });
			this.scheduleRetry();
		}
	}

	private handledStages(): Map<number, Set<"published" | "routed">> {
		const stages = new Map<number, Set<"published" | "routed">>();
		for (const record of this.records()) {
			if (record.type !== "group_handled") continue;
			const set = stages.get(record.updateId) ?? new Set();
			set.add(record.stage);
			stages.set(record.updateId, set);
		}
		return stages;
	}

	private toGroupMessage(message: Omit<TelegramMessage, "reply_to_message">): GroupMessage {
		const fromId = message.from?.id ?? 0;
		const anonymous = Boolean(message.sender_chat);
		const agent = this.agentById(fromId);
		const senderKind = !anonymous && fromId === this.options.ownerUserId ? "owner" : agent || fromId === this.self?.id ? "agent" : "other";
		const sender = senderKind === "owner" ? OWNER_SENDER : agent ? agent.telegramName : fromId === this.self?.id ? (this.self?.username ?? "this agent") : message.from?.first_name ?? message.from?.username ?? "unknown";
		const text = message.text ?? message.caption ?? "";
		const entities = ((message.text !== undefined ? message.entities : message.caption_entities) ?? []).map((entity): TelegramEntity => ({ type: entity.type, offset: entity.offset, length: entity.length, ...(entity.url ? { url: entity.url } : {}), ...(entity.user ? { user: { id: entity.user.id } } : {}) }));
		const media = message.photo ? { kind: "photo" as const } : message.document ? { kind: "document" as const, ...(message.document.file_name ? { fileName: message.document.file_name } : {}), ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}), ...(message.document.file_size ? { size: message.document.file_size } : {}) } : !text ? { kind: "other" as const } : undefined;
		const reply = (message as TelegramMessage).reply_to_message;
		return {
			chatId: this.config.chatId,
			messageId: message.message_id,
			senderId: anonymous ? message.sender_chat!.id : fromId,
			sender,
			senderKind,
			date: message.date ?? Math.floor(this.now() / 1000),
			text,
			entities,
			...(reply ? { replyToMessageId: reply.message_id } : {}),
			...(media ? { media } : {}),
		};
	}

	/** Bot user IDs a message addresses through Telegram mention entities and text mentions. */
	mentionedIds(message: GroupMessage): Set<number> {
		const ids = new Set<number>();
		for (const entity of message.entities) {
			if (entity.type === "text_mention" && entity.user) ids.add(entity.user.id);
			if (entity.type !== "mention") continue;
			// Telegram offsets count UTF-16 code units, as JavaScript strings do.
			const account = message.text.slice(entity.offset + 1, entity.offset + entity.length).toLowerCase();
			if (this.self && account === this.self.username.toLowerCase()) ids.add(this.self.id);
			const agent = this.agentByAccount(account);
			if (agent) ids.add(agent.botUserId);
		}
		return ids;
	}

	private async processUpdates(): Promise<void> {
		if (!this.self) return;
		const stages = this.handledStages();
		let ownerPending = false;
		for (const { updateId, payload } of this.options.bridge()?.groupUpdates() ?? []) {
			const handled = stages.get(updateId);
			if (handled?.has("routed")) continue;
			if (payload.kind === "foreign-chat") {
				await this.options.api.leaveChat(payload.chatId).catch((error) => this.options.onError(error));
				await this.append({ type: "group_handled", updateId, stage: "routed", timestamp: this.timestamp() });
				continue;
			}
			if (payload.kind === "member") {
				await this.handleMember(payload.member, payload.self);
				await this.append({ type: "group_handled", updateId, stage: "routed", timestamp: this.timestamp() });
				continue;
			}
			if (!handled?.has("published")) {
				await this.publish(payload.message);
				await this.append({ type: "group_handled", updateId, stage: "published", timestamp: this.timestamp() });
			}
			const message = payload.message;
			if (!message.sender_chat && message.from?.id === this.options.ownerUserId) ownerPending = true;
			else await this.append({ type: "group_handled", updateId, stage: "routed", timestamp: this.timestamp() });
		}
		if (ownerPending) this.scheduleOwnerRouting();
	}

	private async publish(message: TelegramMessage): Promise<void> {
		const reply = message.reply_to_message;
		if (reply && !(await this.options.journal.message(this.config.chatId, reply.message_id))) {
			// Telegram's copy of the replied-to message repairs an entry missing from the shared journal.
			await this.options.journal.recordMessage(this.toGroupMessage({ ...reply, chat: message.chat }), this.self!.username);
		}
		const result = await this.options.journal.recordMessage(this.toGroupMessage(message), this.self!.username);
		if (result.outcome !== "conflict") this.options.onJournalChanged?.();
	}

	private async handleMember(update: TelegramChatMemberUpdate, self: boolean): Promise<void> {
		const user = update.new_chat_member.user;
		if (!self && MEMBER_STATUSES.has(update.new_chat_member.status) && !this.allowedMember(user.id)) {
			await this.options.api.removeChatMember(user.id).catch((error) => this.options.onError(error));
		}
		await this.verify();
	}

	private scheduleOwnerRouting(): void {
		if (this.quietTimer) clearTimeout(this.quietTimer);
		this.quietTimer = setTimeout(() => {
			this.quietTimer = undefined;
			void this.run(() => this.routeOwnerMessages());
		}, this.options.quietWindowMs);
		this.quietTimer.unref?.();
	}

	/** Routes the owner's published, unrouted group messages as one item. */
	async routeOwnerMessages(): Promise<void> {
		const stages = this.handledStages();
		const pending = (this.options.bridge()?.groupUpdates() ?? []).filter(({ updateId, payload }) => payload.kind === "message" && stages.get(updateId)?.has("published") && !stages.get(updateId)?.has("routed"));
		if (!pending.length) return;
		const messages: GroupMessage[] = [];
		for (const { payload } of pending) {
			if (payload.kind !== "message") continue;
			const recorded = await this.options.journal.message(this.config.chatId, payload.message.message_id);
			if (recorded) messages.push(recorded);
		}
		messages.sort((a, b) => a.messageId - b.messageId);
		const addressed = new Set<number>();
		for (const message of messages) {
			for (const id of this.mentionedIds(message)) addressed.add(id);
			if (message.replyToMessageId) {
				const target = await this.options.journal.message(this.config.chatId, message.replyToMessageId);
				if (target && target.senderKind === "agent") addressed.add(target.senderId);
			}
		}
		if (messages.length && addressed.has(this.self!.id)) await this.admitOwnerItem(messages);
		else if (messages.length && addressed.size === 0) await this.startElection(messages);
		for (const { updateId } of pending) await this.append({ type: "group_handled", updateId, stage: "routed", timestamp: this.timestamp() });
	}

	private async contextFor(message: GroupMessage): Promise<string[]> {
		const lines: string[] = [];
		if (message.replyToMessageId) {
			const target = await this.options.journal.message(this.config.chatId, message.replyToMessageId);
			if (target) lines.push(`This replies to ${target.senderKind === "owner" ? "the owner's" : `${target.sender}'s`} message ${target.messageId}: ${target.text}`);
		}
		return lines;
	}

	private async admitOwnerItem(messages: GroupMessage[]): Promise<void> {
		await this.options.admit(await this.ownerItem(messages));
	}

	private async ownerItem(messages: GroupMessage[]): Promise<Omit<WorkItem, "itemId" | "timestamp"> & { itemId: string }> {
		const first = messages[0]!;
		const last = messages.at(-1)!;
		const text = messages.map((message) => message.text || (message.media ? `[${message.media.kind}]` : "")).filter(Boolean).join("\n\n");
		return ({
			itemId: groupItemId(this.config.chatId, first.messageId),
			channel: "group",
			authority: "owner",
			sender: "the owner",
			text: text || "[empty message]",
			reply: { kind: "group", chatId: this.config.chatId, messageId: last.messageId },
			context: await this.contextFor(first),
		});
	}

	/** Every agent's position for an item: the roster by bot ID, rotated by the item's first message ID. */
	electionRank(firstMessageId: number): number {
		const ids = [this.self!.id, ...this.config.otherAgents.map((agent) => agent.botUserId)].sort((a, b) => a - b);
		const offset = ((firstMessageId % ids.length) + ids.length) % ids.length;
		const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
		return rotated.indexOf(this.self!.id);
	}

	private electionTimer?: ReturnType<typeof setTimeout>;

	private async startElection(messages: GroupMessage[]): Promise<void> {
		await this.append({ type: "group_candidate", firstMessageId: messages[0]!.messageId, messageIds: messages.map((message) => message.messageId), timestamp: this.timestamp() });
		await this.electionTick();
	}

	/** Called when this agent becomes idle, so it can claim waiting items. */
	notifyIdle(): void {
		void this.run(() => this.electionTick());
	}

	private openCandidates(): Array<Extract<GroupProgressRecord, { type: "group_candidate" }>> {
		const records = this.records();
		const done = new Set(records.filter((record) => record.type === "group_candidate_done").map((record) => (record as Extract<GroupProgressRecord, { type: "group_candidate_done" }>).firstMessageId));
		return records.filter((record): record is Extract<GroupProgressRecord, { type: "group_candidate" }> => record.type === "group_candidate" && !done.has(record.firstMessageId));
	}

	private async electionTick(): Promise<void> {
		if (!this.self || !this.verified) return;
		const step = this.config.electionStepMs;
		const rosterSize = this.config.otherAgents.length + 1;
		let nextCheck: number | undefined;
		for (const candidate of this.openCandidates()) {
			const first = candidate.firstMessageId;
			const owner = await this.options.journal.claimFor(this.config.chatId, first);
			if (owner && owner !== this.self.username) {
				await this.append({ type: "group_candidate_done", firstMessageId: first, outcome: "lost", timestamp: this.timestamp() });
				continue;
			}
			const elapsed = this.now() - new Date(candidate.timestamp).valueOf();
			const myWait = this.electionRank(first) * step;
			const allWaited = rosterSize * step;
			if (owner === this.self.username || elapsed >= myWait) {
				const outcome = await this.tryClaim(candidate, owner === this.self.username);
				if (outcome === "claimed" || outcome === "lost") continue;
			} else {
				nextCheck = Math.min(nextCheck ?? Infinity, myWait - elapsed);
				continue;
			}
			// Busy: nobody may have claimed it yet. Once every rank's wait has passed, make sure the owner sees a notice.
			if (elapsed >= allWaited) {
				await this.options.journal.reserveNotice(this.config.chatId, first, this.self.username, async () => Number(await this.sendWithAnchor("Everyone is busy right now; the first agent to finish will pick this up.", candidate.messageIds.at(-1))));
			} else {
				nextCheck = Math.min(nextCheck ?? Infinity, allWaited - elapsed);
			}
		}
		this.scheduleElection(nextCheck);
	}

	private scheduleElection(delay: number | undefined): void {
		if (this.electionTimer) clearTimeout(this.electionTimer);
		this.electionTimer = undefined;
		if (delay === undefined || this.stopped) return;
		this.electionTimer = setTimeout(() => {
			this.electionTimer = undefined;
			void this.run(() => this.electionTick());
		}, Math.max(0, delay));
		this.electionTimer.unref?.();
	}

	/** Claims the item in the shared journal while this agent is idle, and starts it. */
	private async tryClaim(candidate: Extract<GroupProgressRecord, { type: "group_candidate" }>, alreadyClaimed: boolean): Promise<"claimed" | "lost" | "busy"> {
		const first = candidate.firstMessageId;
		const messages: GroupMessage[] = [];
		for (const id of candidate.messageIds) {
			const message = await this.options.journal.message(this.config.chatId, id);
			if (message) messages.push(message);
		}
		if (!messages.length || !this.options.claimWhenIdle) return "busy";
		let won = alreadyClaimed;
		const result = await this.options.claimWhenIdle(async () => {
			if (!won) won = (await this.options.journal.claim(this.config.chatId, first, this.self!.username)).won;
			return won ? this.ownerItem(messages) : undefined;
		});
		if (result === "busy") return "busy";
		await this.append({ type: "group_candidate_done", firstMessageId: first, outcome: won ? "claimed" : "lost", timestamp: this.timestamp() });
		if (!won) return "lost";
		const notice = await this.options.journal.noticeFor(this.config.chatId, first);
		if (notice) await this.options.api.deleteMessage(String(notice)).catch((error) => this.options.onError(error));
		for (const peer of this.config.otherAgents) void this.options.coordinate?.(peer, { kind: "claimed", messageId: first, agent: this.self!.username });
		return "claimed";
	}

	/** Handles POST /coordinate from a peer. */
	async acceptCoordination(body: unknown): Promise<EndpointResponse> {
		if (!this.self) return { status: 503, body: { error: "The group runtime has not started" } };
		const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
		if (value.kind === "claimed") {
			if (!Number.isSafeInteger(value.messageId)) return { status: 400, body: { error: "messageId must be an integer" } };
			// The shared journal, not the notification, decides the winner.
			void this.run(() => this.electionTick());
			return { status: 200, body: { agent: await this.options.journal.claimFor(this.config.chatId, value.messageId as number) ?? null } };
		}
		if (value.kind === "roster") {
			const mine = this.rosterFingerprint();
			const match = value.roster === mine;
			if (!match) await this.rosterMismatch(String(value.agent ?? "a peer"));
			return { status: 200, body: { roster: mine, match } };
		}
		return { status: 400, body: { error: "kind must be \"claimed\" or \"roster\"" } };
	}

	/** Every agent must agree on the group, owner, roster and election step for ranks to agree. */
	rosterFingerprint(): string {
		const ids = [this.self!.id, ...this.config.otherAgents.map((agent) => agent.botUserId)].sort((a, b) => a - b);
		return `${this.config.chatId}:${this.options.ownerUserId}:${ids.join(",")}:${this.config.electionStepMs}`;
	}

	private rosterMismatched = false;

	private async rosterMismatch(peer: string): Promise<void> {
		await this.options.journal.appendEvent(() => ({ kind: "roster_check", agent: this.self!.username, peer, result: "mismatch" }), () => undefined).catch((error) => this.options.onError(error));
		this.rosterMismatched = true;
		this.setMembership({ state: "unverified", reason: `the group configuration differs from ${peer}'s (roster, owner or election step)` });
	}

	/** Compares configuration with every reachable peer. */
	private async exchangeRoster(): Promise<void> {
		const roster = this.rosterFingerprint();
		for (const peer of this.config.otherAgents) {
			const response = await this.options.coordinate?.(peer, { kind: "roster", agent: this.self!.username, roster });
			const reply = response?.body as { roster?: unknown; match?: unknown } | undefined;
			if (response?.status === 200 && reply?.roster !== roster) return this.rosterMismatch(`@${peer.telegramAccount}`);
		}
	}

	/** Verifies and queues a peer's wake-up for a journaled group message. */
	async acceptWakeUp(messageId: number): Promise<EndpointResponse> {
		if (!this.self) return { status: 503, body: { error: "The group runtime has not started" } };
		const message = await this.options.journal.message(this.config.chatId, messageId);
		if (!message) return { status: 404, body: { error: `Group message ${messageId} is not in the shared journal` } };
		const peer = this.agentById(message.senderId);
		if (message.senderKind !== "agent" || !peer) return { status: 400, body: { error: "Only messages from configured agents can be delivered" } };
		const target = message.replyToMessageId ? await this.options.journal.message(this.config.chatId, message.replyToMessageId) : undefined;
		const repliesToOwnRequest = Boolean(target && target.senderId === this.self.id && target.posting?.kind === "request");
		const mentioned = this.mentionedIds(message).has(this.self.id) || mentionedAccounts(message.text).includes(this.self.username.toLowerCase());
		if (message.posting?.kind === "answer" && !repliesToOwnRequest) return { status: 400, body: { error: "An answer wakes only the agent whose request it answers" } };
		if (!mentioned && !repliesToOwnRequest) return { status: 400, body: { error: "The message does not address this agent" } };
		// An answer to this agent's request returns to the work that asked; a new request is answered in the group.
		if (repliesToOwnRequest && message.posting?.kind === "answer") return this.admitAnswer(message, peer, target!);
		const result = await this.options.admit({
			itemId: groupItemId(this.config.chatId, message.messageId),
			channel: "group",
			authority: "peer",
			sender: `${peer.telegramName} (@${peer.telegramAccount})`,
			text: message.text || "[empty message]",
			reply: { kind: "group", chatId: this.config.chatId, messageId: message.messageId },
			context: await this.contextFor(message),
		}) as { item: WorkItem; duplicate: boolean } | undefined;
		return { status: 202, body: { itemId: result?.item.itemId, duplicate: result?.duplicate ?? false } };
	}

	private async admitAnswer(message: GroupMessage, peer: GroupAgentConfig, request: GroupMessage): Promise<EndpointResponse> {
		const records = this.records();
		const closed = records.findLast((record): record is Extract<GroupProgressRecord, { type: "group_requests_closed" }> => record.type === "group_requests_closed");
		if (closed && request.date <= Math.floor(new Date(closed.timestamp).valueOf() / 1000)) {
			// The owner reset this agent's session after the request; the answer stays in the journal as context.
			return { status: 202, body: { context: true } };
		}
		const bridge = this.options.bridge();
		const originId = request.posting?.originItemId;
		const originItem = originId ? bridge?.itemFor(originId) : undefined;
		const originPrivate = originId && !originItem ? bridge?.privateJobFor(originId) : undefined;
		const context = [`This answers your request ${request.messageId} in the group chat: ${request.text}`];
		let reply: WorkItem["reply"];
		if (originItem) {
			reply = originItem.reply;
			const where = originItem.reply.kind === "group" && originItem.reply.messageId ? `group message ${originItem.reply.messageId}` : originItem.channel === "endpoint" ? "a queue endpoint instruction" : "the group chat";
			context.push(`You sent that request while working on ${where} from ${originItem.sender}: ${originItem.text}`);
		} else if (originPrivate) {
			reply = { kind: "private", messageId: originPrivate.messageId };
			context.push(`You sent that request while working on the owner's private message ${originPrivate.messageId}: ${originPrivate.text}`);
		} else {
			reply = { kind: "group", chatId: this.config.chatId, messageId: message.messageId };
		}
		context.push("Use telegram_group_timeline or telegram_timeline if you need more of that conversation.");
		const result = await this.options.admit({
			itemId: groupItemId(this.config.chatId, message.messageId),
			channel: "group",
			authority: "peer",
			sender: `${peer.telegramName} (@${peer.telegramAccount})`,
			text: message.text || "[empty message]",
			reply,
			context,
		}) as { item: WorkItem; duplicate: boolean } | undefined;
		return { status: 202, body: { itemId: result?.item.itemId, duplicate: result?.duplicate ?? false } };
	}

	/** After /new, answers to requests sent before now no longer start work. */
	async closeRequests(): Promise<void> {
		await this.append({ type: "group_requests_closed", timestamp: this.timestamp() });
	}

	/** Journals group replies Telegram accepted for this agent, then queues wake-ups for the agents they address. */
	private async recordAgentPosts(): Promise<void> {
		if (!this.self) return;
		const records = this.records();
		const recorded = new Set(records.filter((record) => record.type === "group_post_recorded").map((record) => (record as Extract<GroupProgressRecord, { type: "group_post_recorded" }>).postId));
		for (const record of records) {
			if (record.type === "work_item" && record.reply.kind === "group" && !recorded.has(record.itemId)) {
				const sent = records.findLast((candidate): candidate is Extract<JournalRecord, { type: "reply_sent" }> => candidate.type === "reply_sent" && candidate.jobId === record.itemId);
				const ready = records.findLast((candidate): candidate is Extract<JournalRecord, { type: "reply_ready" }> => candidate.type === "reply_ready" && candidate.jobId === record.itemId);
				const partIds = !sent ? [] : "messageIds" in sent ? sent.messageIds.map(Number) : [Number(sent.messageId)];
				if (!sent || !ready || !partIds.length) continue;
				const anchorRejected = records.some((candidate) => candidate.type === "reply_anchor_rejected" && candidate.jobId === record.itemId);
				await this.recordPost(record.itemId, {
					partIds, text: ready.text, posting: { kind: "answer" },
					date: Math.floor(new Date(sent.timestamp ?? this.timestamp()).valueOf() / 1000),
					replyToMessageId: anchorRejected ? undefined : record.reply.messageId,
				});
			} else if (record.type === "group_send_accepted" && !recorded.has(record.sendId)) {
				const plan = records.find((candidate): candidate is Extract<GroupProgressRecord, { type: "group_send_planned" }> => candidate.type === "group_send_planned" && candidate.sendId === record.sendId);
				if (!plan) continue;
				await this.recordPost(record.sendId, {
					partIds: record.messageIds, text: plan.text, date: record.date, replyToMessageId: plan.replyToMessageId,
					posting: { kind: "request", ...(plan.originJobId ? { originItemId: plan.originJobId } : {}) },
				});
			}
		}
	}

	private async recordPost(postId: string, post: { partIds: number[]; text: string; date: number; replyToMessageId?: number; posting: NonNullable<GroupMessage["posting"]> }): Promise<void> {
		const message: GroupMessage = {
			chatId: this.config.chatId,
			messageId: post.partIds[0]!,
			...(post.partIds.length > 1 ? { partIds: post.partIds } : {}),
			senderId: this.self!.id,
			sender: this.self!.username,
			senderKind: "agent",
			date: post.date,
			text: post.text,
			entities: [],
			...(post.replyToMessageId ? { replyToMessageId: post.replyToMessageId } : {}),
			posting: post.posting,
		};
		await this.options.journal.recordMessage(message, this.self!.username);
		this.options.onJournalChanged?.();
		const peers = new Set<GroupAgentConfig>();
		// A request wakes the agents it mentions; an answer never starts new work.
		if (post.posting.kind === "request") {
			for (const account of mentionedAccounts(post.text)) {
				const agent = this.agentByAccount(account);
				if (agent) peers.add(agent);
			}
		}
		if (post.replyToMessageId) {
			const target = await this.options.journal.message(this.config.chatId, post.replyToMessageId);
			const author = target ? this.agentById(target.senderId) : undefined;
			if (author && target?.posting?.kind === "request") peers.add(author);
		}
		for (const peer of peers) await this.append({ type: "group_wake", messageId: message.messageId, peer: peer.telegramAccount, timestamp: this.timestamp() });
		await this.append({ type: "group_post_recorded", postId, messageId: message.messageId, timestamp: this.timestamp() });
	}

	private async deliverWakes(): Promise<void> {
		const records = this.records();
		const done = new Set(records.filter((record) => record.type === "group_wake_done").map((record) => {
			const item = record as Extract<GroupProgressRecord, { type: "group_wake_done" }>;
			return `${item.messageId}:${item.peer}`;
		}));
		let retry = false;
		for (const record of records) {
			if (record.type !== "group_wake" || done.has(`${record.messageId}:${record.peer}`)) continue;
			const peer = this.agentByAccount(record.peer);
			if (!peer) continue;
			const result = await (this.options.wake ?? defaultWake)(peer, record.messageId);
			if (result === "retry") {
				retry = true;
				continue;
			}
			done.add(`${record.messageId}:${record.peer}`);
			await this.append({ type: "group_wake_done", messageId: record.messageId, peer: record.peer, outcome: result, timestamp: this.timestamp() });
			if (result === "rejected") this.options.report(`@${peer.telegramAccount} refused group message ${record.messageId}; check that its group chat is configured.`);
		}
		if (retry) this.scheduleRetry();
	}

	/** Posts a request to the group for telegram_group_send. Never resends an uncertain attempt. */
	async sendRequest(sendId: string, text: string, replyToMessageId: number | undefined, originJobId: string | undefined): Promise<number> {
		if (!this.verified) throw new ReplyDestinationUnavailableError(`The group chat is not available: ${this.statusText()}`);
		const bridge = this.options.bridge();
		if (!bridge) throw new Error("Telegram bridge is not running");
		const accepted = bridge.journalRecords.find((record): record is Extract<GroupProgressRecord, { type: "group_send_accepted" }> => record.type === "group_send_accepted" && record.sendId === sendId);
		if (accepted) return accepted.messageIds[0]!;
		if (bridge.journalRecords.some((record) => record.type === "group_send_planned" && record.sendId === sendId)) throw new Error("This group message's delivery is uncertain after an interruption; it was not resent");
		await this.append({ type: "group_send_planned", sendId, text, ...(replyToMessageId ? { replyToMessageId } : {}), ...(originJobId ? { originJobId } : {}), timestamp: this.timestamp() });
		const parts = splitForGroup(text);
		const messageIds: number[] = [];
		for (const [index, part] of parts.entries()) messageIds.push(Number(await this.sendWithAnchor(part, index === 0 ? replyToMessageId : undefined)));
		await this.append({ type: "group_send_accepted", sendId, messageIds, date: Math.floor(this.now() / 1000), timestamp: this.timestamp() });
		await this.run(async () => {
			await this.recordAgentPosts();
			await this.deliverWakes();
		});
		return messageIds[0]!;
	}

	private async sendWithAnchor(text: string, replyTo: number | undefined, format?: "HTML" | "plain", signal?: AbortSignal): Promise<string> {
		try {
			return await this.options.api.sendMessage(text, replyTo, signal, format);
		} catch (error) {
			if (replyTo === undefined || !(error instanceof TelegramReplyAnchorError)) throw error;
			return this.options.api.sendMessage(text, undefined, signal, format);
		}
	}
}

/** A group message becomes at most one work item per agent. */
export function groupItemId(chatId: number, messageId: number): string {
	return workItemIdForKey("group", `${chatId}:${messageId}`);
}

function splitForGroup(text: string, limit = 4_000): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const window = remaining.slice(0, limit + 1);
		let split = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
		if (split < Math.floor(limit * 0.6)) split = limit;
		parts.push(remaining.slice(0, split));
		remaining = remaining.slice(split).trimStart();
	}
	if (remaining) parts.push(remaining);
	return parts;
}

export type { GroupUpdatePayload };
