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
	extractAssistantText,
	JsonlJournal,
	type Journal,
	type Job,
	type ArchivedTelegramAttachment,
	type ResolvedArchivedImage,
	TelegramOwnerBridge,
	type TelegramImageRef,
	type TelegramUpdate,
} from "./core.ts";
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
	close?(): Promise<void>;
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
		const updateRecall = () => {
			const enabled = datastorePolicy.mode === "required" || integration.available();
			const active = pi.getActiveTools?.() ?? [];
			pi.setActiveTools?.(enabled ? [...new Set([...active, "telegram_recall"])] : active.filter(name => name !== "telegram_recall"));
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
			return details.join(" ");
		};

		const updateStatus = (): void => {
			currentContext?.ui.setStatus("telegram-owner", `telegram: ${statusText()}`);
		};

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
			if (!bridge || !runtimeDependencies?.sendActivity || !runtimeDependencies.editActivity || !runtimeDependencies.deleteActivity) return;
			lastActivityError = undefined;
			const sendActivity = runtimeDependencies.sendActivity;
			activity = new TelegramActivityMessage(job.jobId, {
				send: (text, signal) => sendActivity(text, signal, job.messageId),
				existingMessageId: bridge.openActivity(job.jobId),
				edit: runtimeDependencies.editActivity,
				delete: runtimeDependencies.deleteActivity,
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
			if (!bridge || !runtimeDependencies?.deleteActivity) return;
			for (const finished of bridge.finishedActivities()) {
				if (failedActivityDeletes.has(finished.messageId)) continue;
				try {
					await runtimeDependencies.deleteActivity(finished.messageId, new AbortController().signal);
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
			if (!bridge || !runtimeDependencies?.sendActivity || connection.phase === "stopping") return;
			for (const { job, position } of bridge.jobsAwaitingQueuedNotice()) {
				let messageId: string;
				try {
					messageId = await runtimeDependencies.sendActivity(queuedNoticeText(agentLabel, position), new AbortController().signal, job.messageId);
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
				const sent = await bridge.retryReadyReplies(runtimeDependencies.sendReply);
				if (sent > 0) lastOperationError = undefined;
			} catch (error) {
				noteError(error);
			} finally {
				await reconcileMarkdown(currentContext);
				await cleanupFinishedActivities().catch((error) => noteError(error));
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
			return [
				`State: ${state}`,
				contextText(ctx),
				`Model: ${model}, ${ctx.thinkingLevel ?? "off"}`,
				`Telegram: ${connection.phase}, queue ${bridge?.queueDepth ?? 0}${active}`,
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
				} else {
					await bridge.interruptCommand(
						job,
						"Telegram command outcome was uncertain after session restart",
						`/${job.command} was interrupted; its outcome is uncertain. Use /status to inspect the current runtime.`,
					);
				}
			}
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
			const api = config.createApiClient();
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
					{ formattedDelivery: runtimeDependencies.formattedDelivery, inboundQuietWindowMs: runtimeDependencies.inboundQuietWindowMs ?? (options.dependencies ? 0 : undefined) },
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
				await serialized(async () => {
					await retryPendingReplies();
					await processPendingCommands(ctx);
					await dispatchIfIdle(ctx);
					await postQueuedNotices();
					scheduleQuietDispatch(ctx);
				});
			} catch (error) {
				noteError(error);
				await stopReceiptTyping();
				await stopTyping();
				typing = undefined;
				const stop = stopSource;
				stopSource = undefined;
				if (stop) await stop().catch((stopError) => noteError(stopError));
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
			bridge?.captureAgentEnd(extractAssistantText(event.messages));
		});

		pi.on("agent_settled", async (_event, ctx) => {
			// The final reply is sent and recorded before the activity message is
			// deleted. A failed or uncertain final leaves the activity visible.
			const typingStopped = stopTyping();
			await serialized(async () => {
				const halted = await haltActivity();
				if (bridge && runtimeDependencies) {
					try {
						const sent = await bridge.settle(runtimeDependencies.sendReply);
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
