import { resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createDatastoreIntegration, parseDatastorePolicy, type DatastorePolicy } from "./datastore.ts";
import { formatTelegramToolActivity } from "./activity.ts";
import { TelegramMarkdownProjector } from "./markdown-projector.ts";
import {
	initialThinkingText,
	queuedNoticeText,
	telegramOwnerHelpText,
	unsupportedTelegramCommandText,
} from "./commands.ts";
import {
	DEFAULT_INBOUND_QUIET_WINDOW_MS,
	extractAssistantText,
	JsonlJournal,
	type Journal,
	type Job,
	type WorkItem,
	type TurnOutcome,
	type ArchivedTelegramAttachment,
	type ResolvedArchivedImage,
	TelegramOwnerBridge,
	type TelegramImageRef,
	type TelegramUpdate,
} from "./core.ts";
import { parseQueueRequest, QUEUE_ENDPOINT_HOST, startQueueEndpoint, type QueueEndpoint, type QueueEndpointHandlers } from "./endpoint.ts";
import { GroupJournal, type GroupJournalOptions } from "./group-journal.ts";
import { GroupRuntime, type GroupRuntimeOptions, type GroupTelegramApi } from "./group-runtime.ts";
import { GROUP_RECALL_TOOL, GROUP_TIMELINE_TOOL, registerGroupRecallTool, registerGroupTimelineTool } from "./group-tools.ts";
import { registerTelegramRecallTool } from "./recall.ts";
import { registerTelegramTimelineTool } from "./timeline.ts";
import {
	type ConnectionStatus,
	loadTelegramOwnerConfig,
	LongPollSource,
	PollerLock,
	projectTelegramOwnerConfigPath,
	readSafeOutboundImage,
	sanitizeError,
	TelegramActivityMessage,
	TelegramReplyAnchorError,
	TelegramTypingActivity,
	type GroupChatConfig,
} from "./runtime.ts";

export interface PrototypeSource {
	start(
		onBatch: (updates: TelegramUpdate[]) => Promise<number | undefined>,
		cursor?: number,
	): Promise<() => Promise<void>>;
}

export interface PrototypeDependencies {
	journal: Journal;
	ownerUserId: number;
	privateChatId: number;
	/** Validated configured override; skips Telegram identity lookup when present. */
	agentLabel?: string;
	/** Resolves the validated Telegram bot first name once during startup. */
	resolveAgentLabel?(signal?: AbortSignal): Promise<string>;
	formattedDelivery?: boolean;
	inboundQuietWindowMs?: number;
	markdownProjector?: TelegramMarkdownProjector;
	/** Mandatory media-event stream writer, including when note projection is disabled. */
	mediaProjector?: TelegramMarkdownProjector;
	/** Enqueues coalesced lexical maintenance after durable Markdown publication. */
	requestLexicalRefresh?(signal?: AbortSignal): Promise<void>;
	source: PrototypeSource;
	sendReply(text: string, replyToMessageId?: number, format?: "HTML" | "plain"): Promise<string>;
	reconcileCommandMenu?(signal?: AbortSignal): Promise<void>;
	/** Sends a transient activity or queued notice, as a reply when a message is given. */
	sendActivity?(text: string, signal: AbortSignal, replyToMessageId?: number): Promise<string>;
	editActivity?(messageId: string, text: string, signal: AbortSignal): Promise<void>;
	deleteActivity?(messageId: string, signal: AbortSignal): Promise<void>;
	resolveImages?(images: TelegramImageRef[], archived: readonly ArchivedTelegramAttachment[]): Promise<ResolvedArchivedImage[]>;
	stageOutboundPhoto?(path: string, projectRoot: string): Promise<{ image: { bytes: Buffer; filename: string; mimeType: string }; attachment: ArchivedTelegramAttachment }>;
	sendPhoto?(image: { bytes: Buffer; filename: string; mimeType: string }, caption: string | undefined, replyToMessageId?: number, signal?: AbortSignal): Promise<string>;
	sendTyping?(signal: AbortSignal): Promise<void>;
	/** Group chat configuration and Telegram access, when this agent joins a group. */
	groupChat?: {
		config: GroupChatConfig;
		api: GroupTelegramApi;
		journalOptions?: GroupJournalOptions;
		wake?: GroupRuntimeOptions["wake"];
		coordinate?: GroupRuntimeOptions["coordinate"];
	};
	/** Local queue endpoint port on 127.0.0.1; 0 selects a free port. */
	queuePort?: number;
	close?(): Promise<void>;
}

/** Sends, edits and deletes messages in one chat. */
export interface ChatTransport {
	chatId: number;
	sendReply(text: string, replyToMessageId?: number, format?: "HTML" | "plain"): Promise<string>;
	sendActivity(text: string, signal: AbortSignal, replyToMessageId?: number): Promise<string>;
	editActivity(messageId: string, text: string, signal: AbortSignal): Promise<void>;
	deleteActivity(messageId: string, signal: AbortSignal): Promise<void>;
}

export interface ExtensionOptions {
	/** Immutable private assembly override, independent of live settings. */
	datastore?: Partial<DatastorePolicy>;
	datastoreTimeoutMs?: number;
	dependencies?: PrototypeDependencies;
	/** Injected project root; defaults once to the process launch directory. */
	projectRoot?: string;
	/** Test/migration injection. Normal use always derives this from projectRoot. */
	configPath?: string;
	/** Test injection. Normal use reads process.env directly. */
	environment?: NodeJS.ProcessEnv;
	/** Test injection for the bounded projection refresh coalescing window. */
	projectionRefreshDebounceMs?: number;
}

const GENERIC_AGENT_LABEL = "The agent";

/** Reads how a turn ended from its final assistant message. */
export function turnOutcome(messages: unknown[]): TurnOutcome {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as { stopReason?: string; errorMessage?: unknown } | undefined;
	const detail = typeof last?.errorMessage === "string" ? sanitizeError(last.errorMessage).slice(0, 300) : undefined;
	if (last?.stopReason === "length") return { failure: "LENGTH" };
	if (last?.stopReason === "aborted") return { failure: "ABORTED" };
	if (last?.stopReason === "error") return { failure: "MODEL_ERROR", ...(detail ? { detail } : {}) };
	const text = extractAssistantText(messages);
	return text ? { text } : { failure: "NO_REPLY" };
}
const GROUP_SEND_TOOL = "telegram_group_send";
export function createTelegramOwnerExtension(options: ExtensionOptions = {}) {
	// Capture this once, before any session can change its active cwd.
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const configPath = options.configPath ? resolve(options.configPath) : projectTelegramOwnerConfigPath(projectRoot, CONFIG_DIR_NAME);
	const environment = options.environment ?? process.env;
	const overridePolicy = options.datastore === undefined ? undefined : parseDatastorePolicy(options.datastore);
	return function telegramOwnerExtension(pi: ExtensionAPI): void {
		let datastorePolicy = overridePolicy ?? parseDatastorePolicy(undefined);
		const integration = createDatastoreIntegration(pi.events, () => datastorePolicy, options.datastoreTimeoutMs);
		const datastoreClient = integration.service;
		let groupPolicy: DatastorePolicy = { mode: "off", store: "telegram-group" };
		const groupIntegration = createDatastoreIntegration(pi.events, () => groupPolicy, options.datastoreTimeoutMs);
		let groupConfigured = false;
		const updateRecall = () => {
			const enabled = datastorePolicy.mode === "required" || integration.available();
			const groupRecall = groupConfigured && (groupPolicy.mode === "required" || groupIntegration.available());
			const toggles: Array<[string, boolean]> = [["telegram_recall", enabled], [GROUP_RECALL_TOOL, groupRecall], [GROUP_TIMELINE_TOOL, groupConfigured], [GROUP_SEND_TOOL, groupConfigured]];
			let active = pi.getActiveTools?.() ?? [];
			for (const [name, on] of toggles) active = on ? [...new Set([...active, name])] : active.filter((candidate) => candidate !== name);
			pi.setActiveTools?.(active);
		};
		const projectionRefreshDebounceMs = options.projectionRefreshDebounceMs ?? 250;
		let bridge: TelegramOwnerBridge | undefined;
		let runtimeDependencies: PrototypeDependencies | undefined;
		let stopSource: (() => Promise<void>) | undefined;
		let currentContext: ExtensionContext | undefined;
		let typing: TelegramTypingActivity | undefined;
		let receiptTypingController: AbortController | undefined;
		let receiptTypingInFlight: Promise<void> | undefined;
		let receiptTypingPending = 0;
		let activity: TelegramActivityMessage | undefined;
		let quietTimer: ReturnType<typeof setTimeout> | undefined;
		let projectionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
		let projectionRefreshPending = false;
		let projectionRefreshInFlight: Promise<void> | undefined;
		let projectionRefreshController: AbortController | undefined;
		let generation = 0;
		let operationTail: Promise<void> = Promise.resolve();
		let connection: ConnectionStatus = { phase: "disabled" };
		let lastOperationError: string | undefined;
		let lastIdentityError: string | undefined;
		let lastMenuError: string | undefined;
		let lastTypingError: string | undefined;
		let lastActivityError: string | undefined;
		let lastIndexError: string | undefined;
		let lastEndpointError: string | undefined;
		let endpoint: QueueEndpoint | undefined;
		let groupRuntime: GroupRuntime | undefined;
		let groupJournal: GroupJournal | undefined;
		let lastGroupError: string | undefined;
		let compacting = false;
		let switching = false;
		let agentLabel = GENERIC_AGENT_LABEL;
		let disabledReason = "configuration absent";

		const statusText = (): string => {
			const details: string[] = [connection.phase];
			if (datastorePolicy.mode === "required" && !integration.available()) details.push("datastore=CAPABILITY_UNAVAILABLE");
			if (connection.phase === "disabled") details.push(disabledReason);
			if (bridge) {
				details.push(`queue=${bridge.queueDepth}`);
				if (bridge.activeJob) details.push(`active=${bridge.activeJob.jobId.slice(0, 8)}`);
				if (bridge.pendingReplyCount) details.push(`pendingReplies=${bridge.pendingReplyCount}`);
			}
			if (connection.lastSuccessfulPoll) details.push(`lastPoll=${connection.lastSuccessfulPoll}`);
			if (connection.retryDelayMs) details.push(`retry=${connection.retryDelayMs}ms`);
			const lastError = lastOperationError ?? connection.lastError;
			if (lastError) details.push(`error=${lastError}`);
			if (lastIdentityError) details.push(`identityError=${lastIdentityError}`);
			if (lastMenuError) details.push(`menuError=${lastMenuError}`);
			if (lastTypingError) details.push(`typingError=${lastTypingError}`);
			if (lastActivityError) details.push(`activityError=${lastActivityError}`);
			if (lastIndexError) details.push(`indexError=${lastIndexError}`);
			if (endpoint) details.push(`endpoint=${QUEUE_ENDPOINT_HOST}:${endpoint.port}`);
			if (groupRuntime) details.push(groupRuntime.statusText());
			if (lastGroupError) details.push(`groupError=${lastGroupError}`);
			if (lastEndpointError) details.push(`endpointError=${lastEndpointError}`);
			return details.join(" ");
		};

		const updateStatus = (): void => {
			currentContext?.ui.setStatus("telegram-owner", `telegram: ${statusText()}`);
		};

		/** The chat that shows a job's activity and receives its reply, or undefined when it has none. */
		const transportFor = (item: WorkItem | undefined): ChatTransport | undefined => {
			const deps = runtimeDependencies;
			if (!deps) return undefined;
			if (item?.reply.kind === "none") return undefined;
			if (item?.reply.kind === "group") return groupRuntime?.transport;
			if (!deps.sendActivity && !deps.editActivity && !deps.deleteActivity) return undefined;
			const missing = (operation: string) => async (): Promise<never> => { throw new Error(`Telegram activity ${operation} is not configured`); };
			return {
				chatId: deps.privateChatId,
				sendReply: deps.sendReply,
				sendActivity: deps.sendActivity ?? missing("send"),
				editActivity: deps.editActivity ?? missing("edit"),
				deleteActivity: deps.deleteActivity ?? missing("delete"),
			};
		};
		const anchorOf = (job: Job): number | undefined => (job.messageId > 0 ? job.messageId : undefined);
		const routeItemReply = (item: WorkItem) => (item.reply.kind === "group" ? groupRuntime?.transport.sendReply : undefined);

		const serialized = <T>(work: () => Promise<T>): Promise<T> => {
			const result = operationTail.then(work);
			operationTail = result.then(() => undefined, () => undefined);
			return result;
		};

		const noteError = (error: unknown, token?: string): void => {
			lastOperationError = sanitizeError(error, token);
			updateStatus();
		};

		const startReceiptTyping = (): void => {
			if (connection.phase === "stopping" || !runtimeDependencies?.sendTyping) return;
			if (receiptTypingInFlight) { receiptTypingPending += 1; return; }
			lastTypingError = undefined;
			const controller = new AbortController();
			receiptTypingController = controller;
			const request = (async () => {
				try {
					await runtimeDependencies!.sendTyping!(controller.signal);
				} catch (error) {
					if (!controller.signal.aborted) {
						lastTypingError = sanitizeError(error);
						updateStatus();
					}
				} finally {
					if (receiptTypingController === controller) {
						receiptTypingController = undefined;
						receiptTypingInFlight = undefined;
						if (receiptTypingPending > 0) { receiptTypingPending -= 1; startReceiptTyping(); }
					}
				}
			})();
			receiptTypingInFlight = request;
		};

		const stopReceiptTyping = async (): Promise<void> => {
			receiptTypingController?.abort(new Error("Telegram receipt typing stopped"));
			await receiptTypingInFlight;
			receiptTypingController = undefined;
			receiptTypingInFlight = undefined;
			receiptTypingPending = 0;
		};

		const startTyping = (): void => {
			if (connection.phase === "stopping") return;
			lastTypingError = undefined;
			typing?.start();
		};

		const stopTyping = (): Promise<void> => typing?.stop() ?? Promise.resolve();

		const startActivity = (job: Job, ctx: ExtensionContext): void => {
			const transport = transportFor(job.item);
			if (!bridge || !transport) return;
			lastActivityError = undefined;
			activity = new TelegramActivityMessage(job.jobId, {
				send: (text, signal) => transport.sendActivity(text, signal, anchorOf(job)),
				existingMessageId: bridge.openActivity(job.jobId),
				edit: (messageId, text, signal) => transport.editActivity(messageId, text, signal),
				delete: (messageId, signal) => transport.deleteActivity(messageId, signal),
				onStarted: (startedJobId, messageId) => bridge!.recordActivityStarted(startedJobId, messageId),
				onCleared: (clearedJobId, messageId) => bridge!.recordActivityCleared(clearedJobId, messageId),
				onFailure: (operation, error) => {
					lastActivityError = `${operation}: ${sanitizeError(error)}`;
					updateStatus();
				},
			}, initialThinkingText(ctx.getContextUsage?.()?.percent));
			activity.start();
		};

		/** Stops activity updates; the message stays until its job's reply is sent. */
		const haltActivity = async (): Promise<TelegramActivityMessage | undefined> => {
			const current = activity;
			activity = undefined;
			await current?.halt();
			return current;
		};

		const failedActivityDeletes = new Set<string>();
		/** Deletes activity and queued-notice messages whose job has finished. */
		const cleanupFinishedActivities = async (): Promise<void> => {
			if (!bridge) return;
			for (const finished of bridge.finishedActivities()) {
				const transport = transportFor(bridge.itemFor(finished.jobId));
				if (!transport || failedActivityDeletes.has(finished.messageId)) continue;
				try {
					await transport.deleteActivity(finished.messageId, new AbortController().signal);
				} catch (error) {
					failedActivityDeletes.add(finished.messageId);
					lastActivityError = `delete: ${sanitizeError(error)}`;
					updateStatus();
					continue;
				}
				await bridge.recordActivityCleared(finished.jobId, finished.messageId);
			}
		};

		/** Tells the owner which accepted requests are waiting behind other work. */
		const postQueuedNotices = async (): Promise<void> => {
			if (!bridge || connection.phase === "stopping") return;
			for (const { job, position } of bridge.jobsAwaitingQueuedNotice()) {
				const transport = transportFor(job.item);
				if (!transport) continue;
				let messageId: string;
				try {
					messageId = await transport.sendActivity(queuedNoticeText(agentLabel, position), new AbortController().signal, anchorOf(job));
				} catch (error) {
					lastActivityError = `queued: ${sanitizeError(error)}`;
					updateStatus();
					return;
				}
				await bridge.recordActivityStarted(job.jobId, messageId);
			}
		};

		const syncMediaEvents = async (): Promise<void> => {
			if (bridge && runtimeDependencies?.mediaProjector) await runtimeDependencies.mediaProjector.reconcileMediaEvents(bridge.journalRecords);
		};

		const capturePendingInboundMedia = async (): Promise<void> => {
			if (!bridge) return;
			for (const job of bridge.pendingInboundMediaJobs()) {
				if (!runtimeDependencies?.resolveImages) throw new Error("No durable Telegram image resolver configured");
				const captured = await runtimeDependencies.resolveImages(job.images, []);
				await bridge.recordInboundMedia(job, captured);
			}
			await syncMediaEvents();
		};

		const dispatchIfIdle = async (ctx: ExtensionContext): Promise<void> => {
			if (!bridge || bridge.pendingReplyCount > 0 || compacting || switching || !ctx.isIdle()) return;
			await bridge.dispatchNext(
				ctx.sessionManager.getSessionId(),
				(text, images) => {
					const content = images?.length
						? [{ type: "text" as const, text }, ...images.map((image) => ({ type: "image" as const, ...image }))]
						: text;
					void pi.sendUserMessage(content, { expandPromptTemplates: false });
				},
				runtimeDependencies?.resolveImages,
				async (item) => {
					if (!groupJournal) throw new Error("Group images are unavailable without the group chat");
					const journal = groupJournal;
					return Promise.all((item.images ?? []).map(async (image) => ({ data: (await journal.readAttachment(image.path)).toString("base64"), mimeType: image.mimeType })));
				},
			);
			updateStatus();
		};

		const scheduleQuietDispatch = (ctx: ExtensionContext): void => {
			if (quietTimer) clearTimeout(quietTimer);
			quietTimer = undefined;
			const delay = bridge?.nextBatchReadyDelayMs;
			if (delay === undefined || (delay === 0 && !ctx.isIdle())) return;
			quietTimer = setTimeout(() => { quietTimer = undefined; void serialized(async () => { await bridge?.sealReadyBatches(); await dispatchIfIdle(ctx); await postQueuedNotices(); scheduleQuietDispatch(ctx); }); }, delay);
			quietTimer.unref?.();
		};

		const scheduleProjectionRefresh = (ownGeneration: number): void => {
			if (datastorePolicy.mode === "off" || (!integration.available() && !options.dependencies?.requestLexicalRefresh)) return;
			projectionRefreshPending = true;
			if (projectionRefreshTimer || projectionRefreshInFlight || !runtimeDependencies?.requestLexicalRefresh) return;
			projectionRefreshTimer = setTimeout(() => {
				projectionRefreshTimer = undefined;
				if (generation !== ownGeneration || !runtimeDependencies?.requestLexicalRefresh || projectionRefreshController?.signal.aborted) return;
				projectionRefreshPending = false;
				const request = runtimeDependencies.requestLexicalRefresh;
				const signal = projectionRefreshController?.signal;
				projectionRefreshInFlight = request(signal).then(() => {
					lastIndexError = undefined;
				}, (error) => {
					if (!signal?.aborted) lastIndexError = sanitizeError(error);
				}).finally(() => {
					projectionRefreshInFlight = undefined;
					updateStatus();
					if (projectionRefreshPending && generation === ownGeneration) scheduleProjectionRefresh(ownGeneration);
				});
			}, projectionRefreshDebounceMs);
			projectionRefreshTimer.unref?.();
		};

		const reconcileMarkdown = async (ctx?: ExtensionContext): Promise<void> => {
			if (!bridge || !runtimeDependencies?.markdownProjector || !ctx) return;
			try {
				const result = await runtimeDependencies.markdownProjector.reconcile(
					bridge.journalRecords,
					ctx.sessionManager,
					(record) => bridge!.appendArchiveRecord(record),
					ctx.signal,
				);
				if (result.projected > 0) scheduleProjectionRefresh(generation);
			} catch (error) {
				noteError(error);
			}
		};

		const retryPendingReplies = async (): Promise<void> => {
			if (!bridge || !runtimeDependencies) return;
			try {
				const sent = await bridge.retryReadyReplies(runtimeDependencies.sendReply, routeItemReply);
				if (sent > 0) lastOperationError = undefined;
			} catch (error) {
				noteError(error);
			} finally {
				await reconcileMarkdown(currentContext);
				await cleanupFinishedActivities().catch((error) => noteError(error));
				groupRuntime?.notifyReplies();
			}
		};

		const contextText = (ctx: ExtensionContext): string => {
			const usage = ctx.getContextUsage?.();
			if (!usage || usage.percent === null || usage.tokens === null) {
				return "Context: recalculating";
			}
			return `Context: ${Math.round(usage.percent)}% of ${Math.round(usage.contextWindow / 1_000)}k`;
		};

		const ownerStatusText = (ctx: ExtensionContext): string => {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
			const state = switching ? "switching" : compacting ? "compacting" : ctx.isIdle() ? "idle" : "working";
			const active = bridge?.activeJob ? `, active ${bridge.activeJob.jobId.slice(0, 8)}` : "";
			const queued = bridge?.queueDepthByTier;
			const group = groupRuntime?.state;
			const failure = bridge?.lastTurnFailure;
			return [
				`State: ${state}`,
				contextText(ctx),
				`Model: ${model}, ${ctx.thinkingLevel ?? "off"}`,
				`Telegram: ${connection.phase}, queue ${queued ? `${queued.owner} owner, ${queued.peer} peer` : "0"}${active}`,
				...(group ? [`Group: ${group.state === "unverified" ? `paused, ${group.reason}` : group.state}${lastGroupError ? ` (last error: ${lastGroupError})` : ""}`] : []),
				...(runtimeDependencies?.queuePort !== undefined ? [`Queue endpoint: ${endpoint ? `${QUEUE_ENDPOINT_HOST}:${endpoint.port}` : `unavailable${lastEndpointError ? `, ${lastEndpointError}` : ""}`}`] : []),
				...(failure ? [`Last failed turn: ${failure.code} at ${failure.timestamp}${failure.detail ? ` (${failure.detail})` : ""}`] : []),
			].join("\n");
		};

		const completeCommand = async (job: Job, text: string): Promise<void> => {
			if (!bridge) return;
			await bridge.completeCommand(job, text);
			await retryPendingReplies();
			updateStatus();
		};

		const processCommand = async (job: Job, ctx: ExtensionContext): Promise<"continue" | "switching"> => {
			if (!bridge || !job.command) return "continue";
			await bridge.startCommand(job);
			switch (job.command) {
				case "help":
					await completeCommand(job, telegramOwnerHelpText());
					return "continue";
				case "status":
					await completeCommand(job, ownerStatusText(ctx));
					return "continue";
				case "unknown":
					await completeCommand(job, unsupportedTelegramCommandText());
					return "continue";
				case "stop": {
					if (switching) {
						await completeCommand(job, "Session replacement is already in progress; /stop cannot cancel it.");
						return "continue";
					}
					if (ctx.isIdle() && !compacting && !bridge.activeJob) {
						await completeCommand(job, `${agentLabel} is idle; nothing to stop.`);
						return "continue";
					}
					ctx.abort();
					await stopTyping();
					await haltActivity();
					await bridge.interruptActive("Stopped by Telegram owner command", "Stopped by /stop.");
					await completeCommand(job, "Stop requested.");
					return "continue";
				}
				case "compact": {
					if (!ctx.isIdle() || compacting) {
						await completeCommand(job, `${agentLabel} is busy; /compact was not started.`);
						return "continue";
					}
					compacting = true;
					updateStatus();
					ctx.compact({
						onComplete: () => {
							void serialized(async () => {
								compacting = false;
								await completeCommand(job, `Compaction complete.\n${contextText(ctx)}`);
								await processPendingCommands(ctx);
								await dispatchIfIdle(ctx);
							});
						},
						onError: (error) => {
							void serialized(async () => {
								compacting = false;
								await completeCommand(job, `Compaction failed: ${sanitizeError(error)}`);
								await processPendingCommands(ctx);
								await dispatchIfIdle(ctx);
							});
						},
					});
					return "continue";
				}
				case "new":
					if (!ctx.isIdle() || compacting || switching) {
						await completeCommand(job, `${agentLabel} is busy; /new was not started.`);
						return "continue";
					}
					switching = true;
					updateStatus();
					try {
						await Promise.resolve(
							pi.sendUserMessage(`/telegram-status __new-session__:${job.jobId}`, { expandPromptTemplates: true }),
						);
						return "switching";
					} catch (error) {
						switching = false;
						await bridge.interruptCommand(job, "Session replacement command dispatch failed", `/new failed: ${sanitizeError(error)}`);
						await retryPendingReplies();
						return "continue";
					}
			}
		};

		const processPendingCommands = async (ctx: ExtensionContext): Promise<void> => {
			if (!bridge) return;
			for (const job of bridge.pendingCommands) {
				if (await processCommand(job, ctx) === "switching") return;
			}
		};

		const recoverUncertainCommands = async (reason: string, ctx: ExtensionContext): Promise<void> => {
			if (!bridge) return;
			for (const job of bridge.uncertainCommands) {
				if (job.command === "new" && reason === "new") {
					await bridge.completeCommand(job, `Started a new session.\nSession: ${ctx.sessionManager.getSessionId()}\n${contextText(ctx)}`);
					// Queued group and endpoint work ends visibly; a requesting agent is woken by the notice.
					await bridge.interruptQueuedItems("Owner started a new session", `Not handled: the owner reset ${agentLabel}'s session.`);
					await bridge.appendGroupRecord({ type: "group_requests_closed", timestamp: new Date().toISOString() });
				} else {
					await bridge.interruptCommand(
						job,
						"Telegram command outcome was uncertain after session restart",
						`/${job.command} was interrupted; its outcome is uncertain. Use /status to inspect the current runtime.`,
					);
				}
			}
		};

		/** Idle for elections: nothing running, queued, being collected in the quiet window, or awaiting delivery. */
		const electionIdle = (): boolean => {
			if (!bridge || !currentContext || compacting || switching || !currentContext.isIdle()) return false;
			const queued = bridge.queueDepthByTier;
			return !bridge.activeJob && queued.owner + queued.peer === 0 && bridge.nextBatchReadyDelayMs === undefined && bridge.pendingReplyCount === 0;
		};

		const isBusy = (): boolean => Boolean(bridge?.activeJob) || compacting || switching || (currentContext ? !currentContext.isIdle() : false);

		const endpointHandlers = (ownGeneration: number): QueueEndpointHandlers => ({
			queue: async (body) => {
				const parsed = parseQueueRequest(body);
				if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
				if (generation !== ownGeneration || !bridge) return { status: 503, body: { error: "The agent's Telegram transport is not running" } };
				const request = parsed.value;
				const group = groupRuntime;
				if (!group && (request.kind === "group-message" || request.reply === "group")) return { status: 409, body: { error: "The group chat is not configured" } };
				if (request.kind === "group-message") return group!.acceptWakeUp(request.messageId);
				const reply = request.reply === "group" ? { kind: "group" as const, chatId: group!.config.chatId } : { kind: request.reply };
				const admitted = await serialized(async () => {
					if (generation !== ownGeneration || !bridge) return undefined;
					const result = await bridge.admitItem({ channel: "endpoint", authority: "owner", sender: request.source, text: request.text, reply, ...(request.id ? { idempotencyKey: request.id } : {}) });
					try {
						if (currentContext) {
							await dispatchIfIdle(currentContext);
							await postQueuedNotices();
						}
					} catch (error) {
						noteError(error);
					}
					updateStatus();
					return result;
				});
				if (!admitted) return { status: 503, body: { error: "The agent's Telegram transport is not running" } };
				return { status: 202, body: { itemId: admitted.item.itemId, duplicate: admitted.duplicate } };
			},
			coordinate: async (body) => (groupRuntime ? groupRuntime.acceptCoordination(body) : { status: 409, body: { error: "The group chat is not configured" } }),
			status: async () => ({
				status: 200,
				body: {
					state: isBusy() ? "busy" : "idle",
					queue: bridge?.queueDepthByTier ?? { owner: 0, peer: 0 },
					group: groupRuntime ? groupRuntime.state.state : "unconfigured",
				},
			}),
		});

		let groupRefreshTimer: ReturnType<typeof setTimeout> | undefined;
		/** Coalesces lexical refreshes of the group store; never queued against an absent integration. */
		const scheduleGroupRefresh = (): void => {
			if (groupRefreshTimer || groupPolicy.mode === "off" || !groupIntegration.available()) return;
			groupRefreshTimer = setTimeout(() => {
				groupRefreshTimer = undefined;
				if (!groupIntegration.available()) return;
				void groupIntegration.service.refresh({ action: "start", store: groupPolicy.store, mode: "lexical" }).catch((error) => { lastGroupError = sanitizeError(error); updateStatus(); });
			}, projectionRefreshDebounceMs);
			groupRefreshTimer.unref?.();
		};

		const stopGroup = async (): Promise<void> => {
			if (groupRefreshTimer) clearTimeout(groupRefreshTimer);
			groupRefreshTimer = undefined;
			const current = groupRuntime;
			groupRuntime = undefined;
			groupJournal = undefined;
			groupConfigured = false;
			groupIntegration.stop();
			const groupTools = new Set([GROUP_RECALL_TOOL, GROUP_TIMELINE_TOOL, GROUP_SEND_TOOL]);
			pi.setActiveTools?.((pi.getActiveTools?.() ?? []).filter((name) => !groupTools.has(name)));
			await current?.stop().catch((error) => noteError(error));
		};

		const startGroup = async (deps: PrototypeDependencies, ownGeneration: number): Promise<void> => {
			const group = deps.groupChat;
			if (!group) return;
			groupPolicy = group.config.datastore;
			groupIntegration.start();
			groupJournal = new GroupJournal(group.config.sharedRoot, group.journalOptions);
			groupRuntime = new GroupRuntime({
				config: group.config,
				ownerUserId: deps.ownerUserId,
				api: group.api,
				journal: groupJournal,
				bridge: () => (generation === ownGeneration ? bridge : undefined),
				admit: (input) => serialized(async () => {
					if (generation !== ownGeneration || !bridge) throw new Error("The agent's Telegram transport is not running");
					const result = await bridge.admitItem(input);
					try {
						if (currentContext) {
							await dispatchIfIdle(currentContext);
							await postQueuedNotices();
						}
					} catch (error) {
						noteError(error);
					}
					updateStatus();
					return result;
				}),
				// The same window the bridge applies to private messages.
				quietWindowMs: deps.inboundQuietWindowMs ?? (options.dependencies ? 0 : DEFAULT_INBOUND_QUIET_WINDOW_MS),
				wake: group.wake,
				coordinate: group.coordinate ?? (async (peer, body) => {
					try {
						const response = await fetch(`http://${QUEUE_ENDPOINT_HOST}:${peer.queuePort}/coordinate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
						return { status: response.status, body: await response.json() };
					} catch {
						return undefined;
					}
				}),
				claimWhenIdle: (claim) => serialized(async () => {
					if (generation !== ownGeneration || !bridge || !electionIdle()) return "busy" as const;
					const input = await claim();
					if (input) {
						await bridge.admitItem(input);
						try {
							if (currentContext) {
								await dispatchIfIdle(currentContext);
								await postQueuedNotices();
							}
						} catch (error) {
							noteError(error);
						}
						updateStatus();
					}
					return "done" as const;
				}),
				report: (text) => { void deps.sendReply(text).catch((error) => noteError(error)); },
				onError: (error) => { lastGroupError = sanitizeError(error); updateStatus(); },
				onStatus: updateStatus,
				onJournalChanged: scheduleGroupRefresh,
			});
			groupConfigured = true;
			updateRecall();
			lastGroupError = undefined;
			await groupRuntime.start();
		};

		const stopEndpoint = async (): Promise<void> => {
			const current = endpoint;
			endpoint = undefined;
			await current?.close();
		};

		const makeDefaultDependencies = async (): Promise<PrototypeDependencies | undefined> => {
			let loaded;
			try {
				loaded = await loadTelegramOwnerConfig(configPath, environment);
			} catch (error) {
				disabledReason = sanitizeError(error);
				connection = { phase: "disabled", lastError: disabledReason };
				return undefined;
			}
			if (loaded.kind === "absent" || !loaded.config) {
				disabledReason = `configuration absent (${loaded.configPath})`;
				connection = { phase: "disabled" };
				return undefined;
			}
			const config = loaded.config;
			datastorePolicy = overridePolicy ?? config.datastore;
			let lock: PollerLock;
			try {
				lock = await PollerLock.acquire(config.lockPath);
			} catch (error) {
				disabledReason = sanitizeError(error);
				connection = { phase: "disabled", lastError: disabledReason };
				return undefined;
			}
			const groupUpdates = ["message", "chat_member", "my_chat_member"];
			const api = config.createApiClient(config.groupChat ? { allowedUpdates: groupUpdates } : {});
			const groupApi = config.groupChat ? config.createApiClient({ chatId: config.groupChat.chatId }) : undefined;
			const requests = new AbortController();
			const mediaProjector = new TelegramMarkdownProjector(config.markdownProjection ?? { enabled: true, root: projectRoot, rootId: "pi-sessions" });
			const poller = new LongPollSource(api, (next) => {
				connection = next;
				updateStatus();
			});
			return {
				journal: new JsonlJournal(config.journalPath),
				ownerUserId: config.ownerUserId,
				privateChatId: config.privateChatId,
				agentLabel: config.agentLabel,
				formattedDelivery: config.formattedDelivery,
				inboundQuietWindowMs: config.inboundQuietWindowMs,
				queuePort: config.queuePort,
				...(config.groupChat && groupApi ? { groupChat: { config: config.groupChat, api: groupApi } } : {}),
				markdownProjector: config.markdownProjection ? mediaProjector : undefined,
				mediaProjector,
				requestLexicalRefresh: async (signal) => { if (integration.available()) await datastoreClient.refresh({ action: "start", store: datastorePolicy.store, mode: "lexical" }, signal); },
				resolveAgentLabel: config.agentLabel === undefined
					? (signal) => api.getBotFirstName(signal ?? requests.signal)
					: undefined,
				source: {
					async start(onBatch, cursor) {
						const stop = await poller.start(onBatch, cursor);
						return stop;
					},
				},
				sendReply: (text, replyTo, format) => api.sendMessage(text, replyTo, requests.signal, format),
				reconcileCommandMenu: (signal) => api.setOwnerCommandMenu(signal ?? requests.signal),
				sendActivity: async (text, signal, replyTo) => {
					try {
						return await api.sendMessage(text, replyTo, signal);
					} catch (error) {
						if (replyTo === undefined || !(error instanceof TelegramReplyAnchorError)) throw error;
						return api.sendMessage(text, undefined, signal);
					}
				},
				editActivity: (messageId, text, signal) => api.editMessageText(messageId, text, signal),
				deleteActivity: (messageId, signal) => api.deleteMessage(messageId, signal),
				resolveImages: async (images, archived) => {
					if (archived.length === images.length) return Promise.all(archived.map(async (attachment) => ({ image: await mediaProjector.readLiveMedia(attachment), attachment })));
					return Promise.all(images.map(async (image) => {
						const resolved = await api.downloadImage(image, requests.signal);
						const bytes = Buffer.from(resolved.data, "base64");
						const attachment = await mediaProjector.captureLiveMedia(bytes, image.mimeType, "in");
						return { image: resolved, attachment };
					}));
				},
				stageOutboundPhoto: async (path, projectRoot) => {
					const image = await readSafeOutboundImage(path, projectRoot);
					const attachment = await mediaProjector.captureLiveMedia(image.bytes, image.mimeType as ArchivedTelegramAttachment["mimeType"], "out");
					return { image, attachment };
				},
				sendPhoto: async (image, caption, replyTo, signal) => {
					const combinedSignal = signal ? AbortSignal.any([requests.signal, signal]) : requests.signal;
					return api.sendPhoto(image, caption, replyTo, combinedSignal);
				},
				sendTyping: (signal) => api.sendChatAction(signal),
				close: async () => {
					requests.abort(new Error("Telegram owner bridge stopped"));
					await lock.release();
				},
			};
		};

		registerTelegramRecallTool(pi, datastoreClient, () => datastorePolicy.store);
		registerGroupRecallTool(pi, groupIntegration.service, () => groupPolicy.store);
		registerGroupTimelineTool(pi, () => (groupRuntime?.verified && groupJournal ? { journal: groupJournal, chatId: groupRuntime.config.chatId } : undefined));
		pi.registerTool({
			name: GROUP_SEND_TOOL,
			label: "Send to group chat",
			description: "Post a request to the group chat shared with the owner and the other agents. Mention an agent as @username to ask it; its answer comes back to you as a new turn that replies to whatever started this one. Only the supplied text is sent.",
			promptSnippet: "Ask another agent, or the group, for help in the shared group chat",
			promptGuidelines: [
				"Use telegram_group_send to ask another agent something; mention it as @username. Your final reply is posted automatically, so do not use this tool to answer the turn you are working on.",
			],
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", minLength: 1, description: "The request, including @username mentions of the agents it is for." },
					replyToMessageId: { type: "integer", minimum: 1, description: "A group message ID to reply to, such as the owner's request being passed on." },
				},
				required: ["text"],
				additionalProperties: false,
			} as any,
			executionMode: "sequential",
			execute: async (toolCallId, params) => {
				const input = params as { text: string; replyToMessageId?: number };
				if (!groupRuntime) throw new Error("CAPABILITY_UNAVAILABLE: the group chat is not configured.");
				const messageId = await groupRuntime.sendRequest(`tool:${toolCallId}`, input.text, input.replyToMessageId, bridge?.activeJob?.jobId);
				return { content: [{ type: "text" as const, text: `Posted group message ${messageId}.` }], details: { messageId } };
			},
		});
		pi.on("resources_discover", () => { updateRecall(); updateStatus(); });
		registerTelegramTimelineTool(pi, () => runtimeDependencies?.markdownProjector);

		pi.registerTool({
			name: "telegram_send_photo",
			label: "Send Telegram photo",
			description: "Send a JPEG, PNG, or WebP file from inside the current project to the verified Telegram owner. Only available while handling a Telegram turn.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Project-relative image path" },
					caption: { type: "string", maxLength: 1024 },
				},
				required: ["path"],
				additionalProperties: false,
			} as any,
			executionMode: "sequential",
			execute: async (_id, params, signal, _onUpdate, ctx) => {
				const photo = params as { path: string; caption?: string };
				if (!bridge?.activeJob || bridge.status !== "running" || !runtimeDependencies?.stageOutboundPhoto || !runtimeDependencies.sendPhoto) {
					throw new Error("telegram_send_photo is only available during an active Telegram turn");
				}
				const activeJob = bridge.activeJob;
				const photoId = _id;
				await syncMediaEvents();
				const priorReceipt = bridge.outboundPhotoReceipt(photoId);
				if (priorReceipt) return { content: [{ type: "text", text: `Photo already sent to the verified owner (message ${priorReceipt.messageId}).` }], details: {} };
				if (bridge.outboundPhotoPlan(photoId)) throw new Error("Outbound photo delivery is uncertain after an interrupted send; it will not be resent automatically");
				const staged = await runtimeDependencies.stageOutboundPhoto(photo.path, projectRoot);
				const equivalent = bridge.equivalentOutboundPhoto(staged.attachment, photo.caption, activeJob.messageId);
				if (equivalent?.receipt) return { content: [{ type: "text", text: `An equivalent photo was already sent to the verified owner (message ${equivalent.receipt.messageId}).` }], details: {} };
				if (equivalent) throw new Error("Equivalent outbound photo delivery is uncertain after an interrupted send; it will not be resent automatically");
				await bridge.planOutboundPhoto(photoId, activeJob, photo.caption, staged.attachment);
				const messageId = await runtimeDependencies.sendPhoto(staged.image, photo.caption, activeJob.messageId, signal);
				await bridge.recordOutboundPhotoSent(photoId, activeJob.jobId, messageId);
				await syncMediaEvents();
				await reconcileMarkdown(ctx);
				return { content: [{ type: "text", text: `Photo sent to the verified owner (message ${messageId}).` }], details: {} };
			},
		});

		pi.registerCommand("telegram-status", {
			description: "Show the private-owner Telegram bridge status",
			handler: async (args, ctx: ExtensionCommandContext) => {
				const internalMatch = /^__new-session__:([0-9a-f-]+)$/i.exec(args.trim());
				if (!internalMatch) {
					ctx.ui.notify(`Telegram owner bridge: ${statusText()}`);
					return;
				}
				const job = bridge?.uncertainCommands.find(
					(candidate) => candidate.command === "new" && candidate.jobId === internalMatch[1],
				);
				if (!job || !bridge) return;
				try {
					const result = await ctx.newSession();
					if (result.cancelled) {
						await serialized(async () => {
							switching = false;
							await bridge?.interruptCommand(job, "Session replacement was cancelled", "/new was cancelled; the current session is unchanged.");
							await retryPendingReplies();
							await processPendingCommands(ctx);
							await dispatchIfIdle(ctx);
						});
					}
				} catch (error) {
					await serialized(async () => {
						switching = false;
						await bridge?.interruptCommand(job, "Session replacement failed", `/new failed: ${sanitizeError(error)}`);
						await retryPendingReplies();
						await processPendingCommands(ctx);
						await dispatchIfIdle(ctx);
					});
				}
			},
		});

		pi.on("session_start", async (event, ctx) => {
			currentContext = ctx;
			integration.start();
			updateRecall();
			generation += 1;
			await stopReceiptTyping();
			if (projectionRefreshTimer) clearTimeout(projectionRefreshTimer);
			projectionRefreshTimer = undefined;
			projectionRefreshPending = false;
			projectionRefreshController?.abort(new Error("Telegram owner session replaced"));
			await projectionRefreshInFlight;
			projectionRefreshInFlight = undefined;
			projectionRefreshController = new AbortController();
			lastIndexError = undefined;
			const ownGeneration = generation;
			runtimeDependencies = options.dependencies ?? (await makeDefaultDependencies());
			updateRecall();
			if (options.dependencies) connection = { phase: "connecting" };
			if (!runtimeDependencies) {
				updateStatus();
				return;
			}
			agentLabel = runtimeDependencies.agentLabel ?? GENERIC_AGENT_LABEL;
			lastIdentityError = undefined;
			if (!runtimeDependencies.agentLabel && runtimeDependencies.resolveAgentLabel) {
				try {
					agentLabel = await runtimeDependencies.resolveAgentLabel();
				} catch (error) {
					lastIdentityError = sanitizeError(error);
					updateStatus();
				}
			}
			try {
				bridge = new TelegramOwnerBridge(
					runtimeDependencies.journal,
					runtimeDependencies.ownerUserId,
					runtimeDependencies.privateChatId,
					{ formattedDelivery: runtimeDependencies.formattedDelivery, inboundQuietWindowMs: runtimeDependencies.inboundQuietWindowMs ?? (options.dependencies ? 0 : undefined), groupChatId: runtimeDependencies.groupChat?.config.chatId },
				);
				typing = runtimeDependencies.sendTyping
					? new TelegramTypingActivity(runtimeDependencies.sendTyping, (error) => {
						lastTypingError = sanitizeError(error);
						updateStatus();
					})
					: undefined;
				const recovered = await bridge.initialize();
				await capturePendingInboundMedia();
				await reconcileMarkdown(ctx);
				if (runtimeDependencies.reconcileCommandMenu) {
					try {
						await runtimeDependencies.reconcileCommandMenu();
						lastMenuError = undefined;
					} catch (error) {
						lastMenuError = sanitizeError(error);
						updateStatus();
					}
				}
				await cleanupFinishedActivities();
				await bridge.interruptUncertain(
					"Pi restarted before dispatch outcome was durable",
					"Previous request was interrupted by Pi restart; please resend.",
				);
				await recoverUncertainCommands(event.reason, ctx);
				stopSource = await runtimeDependencies.source.start(async (updates) =>
					serialized(async () => {
						if (generation !== ownGeneration || !bridge) return bridge?.cursor;
						const state = await bridge.ingestBatch(updates);
						groupRuntime?.notifyUpdates();
						groupRuntime?.notifyIdle();
						for (let index = 0; index < state.acceptedModelInputCount; index++) startReceiptTyping();
						await capturePendingInboundMedia();
						await retryPendingReplies();
						await processPendingCommands(ctx);
						await dispatchIfIdle(ctx);
						await postQueuedNotices();
						scheduleQuietDispatch(ctx);
						return state.cursor;
					}),
					recovered.cursor,
				);
				await startGroup(runtimeDependencies, ownGeneration);
				if (runtimeDependencies.queuePort !== undefined) {
					lastEndpointError = undefined;
					try {
						endpoint = await startQueueEndpoint(runtimeDependencies.queuePort, endpointHandlers(ownGeneration));
					} catch (error) {
						lastEndpointError = sanitizeError(error);
					}
					updateStatus();
				}
				await serialized(async () => {
					await retryPendingReplies();
					await processPendingCommands(ctx);
					await dispatchIfIdle(ctx);
					await postQueuedNotices();
					scheduleQuietDispatch(ctx);
				});
			} catch (error) {
				noteError(error);
				await stopEndpoint().catch((endpointError) => noteError(endpointError));
				await stopReceiptTyping();
				await stopTyping();
				typing = undefined;
				const stop = stopSource;
				stopSource = undefined;
				if (stop) await stop().catch((stopError) => noteError(stopError));
				await stopGroup();
				const close = runtimeDependencies.close;
				runtimeDependencies = undefined;
				bridge = undefined;
				if (close) await close().catch((closeError) => noteError(closeError));
			}
		});

		pi.on("input", (event, ctx) => {
			if (!bridge) return;
			const result = bridge.observeInput(event.source, event.text);
			if (result === "handled") {
				ctx.ui.notify("Telegram turn active; wait before entering a local prompt.", "warning");
				return { action: "handled" as const };
			}
		});

		pi.on("before_agent_start", async (event, ctx) => {
			updateRecall();
			await serialized(async () => {
				if (!bridge) return;
				const began = await bridge.beforeAgentStart(event.prompt, ctx.sessionManager.getSessionId());
				if (began && bridge.activeJob) {
					startTyping();
					startActivity(bridge.activeJob, ctx);
				}
				updateStatus();
			});
		});

		pi.on("tool_execution_start", (event, ctx) => {
			if (bridge?.status !== "running" || !activity) return;
			activity.update(formatTelegramToolActivity(
				ctx.sessionManager.getBranch(),
				event.toolCallId,
				event.toolName,
			));
		});

		pi.on("agent_end", (event) => {
			bridge?.captureAgentEnd(turnOutcome(event.messages));
		});

		pi.on("agent_settled", async (_event, ctx) => {
			// The final reply is sent and recorded before the activity message is
			// deleted. A failed or uncertain final leaves the activity visible.
			const typingStopped = stopTyping();
			await serialized(async () => {
				const halted = await haltActivity();
				if (bridge && runtimeDependencies) {
					try {
						const sent = await bridge.settle(runtimeDependencies.sendReply, routeItemReply);
						if (sent) lastOperationError = undefined;
						await reconcileMarkdown(ctx);
					} catch (error) {
						noteError(error);
						await halted?.annotate("Reply delivery failed; it will be retried.");
					}
				}
				await typingStopped;
				await retryPendingReplies();
				await dispatchIfIdle(ctx);
				await postQueuedNotices();
				updateStatus();
			});
			groupRuntime?.notifyIdle();
		});

		pi.on("session_before_switch", () => (bridge?.activeJob ? { cancel: true } : undefined));
		pi.on("session_before_fork", () => (bridge?.activeJob ? { cancel: true } : undefined));

		pi.on("session_shutdown", async (event, ctx) => {
			integration.stop();
			pi.setActiveTools?.((pi.getActiveTools?.() ?? []).filter(name => name !== "telegram_recall"));
			generation += 1;
			if (quietTimer) clearTimeout(quietTimer);
			quietTimer = undefined;
			if (projectionRefreshTimer) clearTimeout(projectionRefreshTimer);
			projectionRefreshTimer = undefined;
			projectionRefreshPending = false;
			projectionRefreshController?.abort(new Error("Telegram owner bridge stopped"));
			projectionRefreshController = undefined;
			await projectionRefreshInFlight;
			projectionRefreshInFlight = undefined;
			connection = { phase: "stopping" };
			updateStatus();
			await stopEndpoint().catch((error) => noteError(error));
			const receiptTypingStopped = stopReceiptTyping();
			const typingStopped = stopTyping();
			const stop = stopSource;
			stopSource = undefined;
			if (stop) await stop();
			await receiptTypingStopped;
			await typingStopped;
			await operationTail;
			await stopTyping();
			await haltActivity();
			await stopGroup();
			if (bridge) {
				await bridge.shutdown(event.reason);
				await cleanupFinishedActivities().catch((error) => noteError(error));
			}
			bridge = undefined;
			typing = undefined;
			activity = undefined;
			const close = runtimeDependencies?.close;
			runtimeDependencies = undefined;
			if (close) await close().catch((error) => noteError(error));
			ctx.ui.setStatus("telegram-owner", undefined);
			currentContext = undefined;
		});
	};
}

export default createTelegramOwnerExtension();
