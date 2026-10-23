import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { MarkdownDatastoreServiceV1 } from "./datastore.ts";
import type { GroupJournal, GroupMessage } from "./group-journal.ts";

export const GROUP_TIMELINE_TOOL = "telegram_group_timeline";
export const GROUP_RECALL_TOOL = "telegram_group_recall";
export const GROUP_RECALL_DEFAULT_LIMIT = 5;

export const GroupTimelineParameters = Type.Object({
	before: Type.Optional(Type.Integer({ minimum: 1, description: "Return messages before this group message ID." })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "Return messages after this group message ID." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum messages. Defaults to 20." })),
}, { additionalProperties: false });

export type GroupTimelineInput = Static<typeof GroupTimelineParameters>;

export const GroupRecallParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 4096, description: "Topic, decision, phrase or person to find in group chat history." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum notes to return. Defaults to 5." })),
}, { additionalProperties: false });

export type GroupRecallInput = Static<typeof GroupRecallParameters>;

export interface GroupHistory {
	journal: GroupJournal;
	chatId: number;
}

function bounded(value: unknown, label: string): string {
	const result = truncateHead(JSON.stringify(value), { maxBytes: 64 * 1024, maxLines: 2_000 });
	return result.truncated ? `${result.content}\n[RESULT_LIMIT_EXCEEDED: ${label} exceeded the tool ceiling]` : result.content;
}

/** The model-facing shape of one group message. */
export function timelineEntry(message: GroupMessage): Record<string, unknown> {
	return {
		messageId: message.messageId,
		...(message.partIds && message.partIds.length > 1 ? { telegramMessageIds: message.partIds } : {}),
		sender: message.sender,
		senderKind: message.senderKind,
		occurredAt: new Date(message.date * 1000).toISOString(),
		...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
		...(message.posting ? { posting: message.posting.kind } : {}),
		...(message.work ? { work: message.work } : {}),
		text: message.text,
		...(message.media ? { media: message.media } : {}),
	};
}

export function registerGroupTimelineTool(pi: ExtensionAPI, history: () => GroupHistory | undefined): void {
	pi.registerTool({
		name: GROUP_TIMELINE_TOOL,
		label: "Read group chat timeline",
		description: "Read the shared group chat journal in Telegram order: the owner's and every agent's messages, including ones this agent was not sent. Use before or after a message ID to page.",
		promptSnippet: "Read recent group chat messages, including ones that were not addressed to you",
		promptGuidelines: [
			"Use telegram_group_timeline when a group turn depends on earlier group messages you have not seen, such as the conversation around a request.",
		],
		parameters: GroupTimelineParameters,
		execute: async (_id, input: GroupTimelineInput) => {
			const group = history();
			if (!group) throw new Error("CAPABILITY_UNAVAILABLE: the group chat is not configured or not verified.");
			const messages = await group.journal.timeline({ chatId: group.chatId, before: input.before, after: input.after, limit: input.limit ?? 20 });
			return {
				content: [{ type: "text" as const, text: bounded({ count: messages.length, messages: messages.map(timelineEntry) }, "group timeline") }],
				details: { count: messages.length, first: messages[0]?.messageId, last: messages.at(-1)?.messageId },
			};
		},
	});
}

export function registerGroupRecallTool(pi: ExtensionAPI, datastore: MarkdownDatastoreServiceV1, store: () => string): void {
	pi.registerTool({
		name: GROUP_RECALL_TOOL,
		label: "Recall group discussion",
		description: "Search the shared group chat history for earlier requests, decisions, results or context, using the configured group datastore store. Returns at most 10 bounded results.",
		promptSnippet: "Search earlier group chat discussion by topic",
		promptGuidelines: [
			"Use telegram_group_recall to find older group discussion by topic; use telegram_group_timeline for recent or adjacent messages.",
		],
		parameters: GroupRecallParameters,
		execute: async (_id, input: GroupRecallInput, signal) => {
			const result = await datastore.search({ store: store(), query: input.query, mode: "hybrid", limit: input.limit ?? GROUP_RECALL_DEFAULT_LIMIT, includeContent: true }, signal);
			const qmd = result.provenance.sources.find((source) => source.kind === "qmd");
			return {
				content: [{ type: "text" as const, text: bounded(result, "group recall result") }],
				details: { store: store(), mode: "hybrid" as const, returned: result.data.returned, generation: qmd?.observationId, freshness: qmd?.freshness, warnings: result.warnings.map((warning) => warning.code) },
			};
		},
	});
}
