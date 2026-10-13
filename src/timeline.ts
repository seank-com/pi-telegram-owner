import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { TelegramMarkdownProjector } from "./markdown-projector.ts";

const Operation = Type.Union([Type.Literal("recent"), Type.Literal("range"), Type.Literal("count")]);
const Direction = Type.Union([Type.Literal("in"), Type.Literal("out"), Type.Literal("both")]);
const Unit = Type.Union([Type.Literal("messages"), Type.Literal("exchanges")]);
const Order = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);

export const TelegramTimelineParameters = Type.Object({
	operation: Operation,
	start: Type.Optional(Type.String({ description: "Inclusive ISO timestamp with an explicit Z or numeric UTC offset. Required for range and count." })),
	end: Type.Optional(Type.String({ description: "Exclusive ISO timestamp with an explicit Z or numeric UTC offset. Required for range and count; defaults to now for recent." })),
	direction: Type.Optional(Direction),
	unit: Type.Optional(Unit),
	order: Type.Optional(Order),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum returned messages or exchanges. Defaults to 10; not accepted by count." })),
}, { additionalProperties: false });

export type TelegramTimelineToolInput = Static<typeof TelegramTimelineParameters>;

export function registerTelegramTimelineTool(pi: ExtensionAPI, projector: () => TelegramMarkdownProjector | undefined): void {
	pi.registerTool({
		name: "telegram_timeline",
		label: "Read Telegram timeline",
		description: "Read or count canonical Telegram archive messages in exact chronological order. Supports recent messages, half-open ISO date ranges, and logical exchanges (one inbound request plus following outbound responses). Results are integrity-checked directly from Markdown; timezone is always reported as UTC.",
		promptSnippet: "Read recent or date-bounded Telegram messages and logical exchanges in chronological order",
		promptGuidelines: [
			"Use telegram_timeline, not telegram_recall, for the latest message, recent exchanges, exact chronological context, or date-range counts. Use explicit ISO offsets for range and count; ranges are [start, end).",
		],
		parameters: TelegramTimelineParameters,
		execute: async (_id, input: TelegramTimelineToolInput, signal) => {
			const archive = projector();
			if (!archive) throw new Error("CAPABILITY_UNAVAILABLE: Telegram Markdown projection is not active.");
			const result = await archive.timeline(input, signal);
			const serialized = JSON.stringify(result);
			const bounded = truncateHead(serialized, { maxBytes: 64 * 1024, maxLines: 2_000 });
			return {
				content: [{ type: "text" as const, text: bounded.truncated ? `${bounded.content}\n[RESULT_LIMIT_EXCEEDED: timeline result exceeded the tool ceiling]` : bounded.content }],
				details: { operation: result.operation, unit: result.unit, count: result.count, timezone: result.timezone, start: result.range.start, end: result.range.end },
			};
		},
	});
}
