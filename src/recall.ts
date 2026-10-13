import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { MarkdownDatastoreServiceV1, SearchResult } from "./datastore.ts";

export const TELEGRAM_RECALL_STORE = "telegram";
export const TELEGRAM_RECALL_DEFAULT_LIMIT = 5;

export const TelegramRecallParameters = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: 4096,
		description: "Natural-language description, remembered phrase, decision, commitment, person, or topic to recall.",
	}),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 10,
		description: "Maximum directly validated conversation notes to return. Defaults to 5.",
	})),
}, { additionalProperties: false });

export type TelegramRecallInput = Static<typeof TelegramRecallParameters>;

function toolText(result: SearchResult): string {
	const serialized = JSON.stringify(result);
	const bounded = truncateHead(serialized, { maxBytes: 50 * 1024, maxLines: 2_000 });
	return bounded.truncated
		? `${bounded.content}\n[RESULT_LIMIT_EXCEEDED: conversation recall result exceeded the tool ceiling]`
		: bounded.content;
}

export function registerTelegramRecallTool(pi: ExtensionAPI, datastore: MarkdownDatastoreServiceV1, store: () => string = () => TELEGRAM_RECALL_STORE): void {
	pi.registerTool({
		name: "telegram_recall",
		label: "Recall Telegram discussion",
		description: "Search the canonical Telegram conversation archive for relevant prior discussion, decisions, commitments, evidence, or context. Uses hybrid lexical and semantic retrieval from the explicit configured project-local Telegram store, directly validates every returned note, and returns at most 10 bounded results with canonical paths and freshness warnings.",
		promptSnippet: "Recall relevant prior Telegram discussions, decisions, commitments, evidence, or context",
		promptGuidelines: [
			"Use telegram_recall when the current request refers to earlier discussion, prior decisions, commitments, evidence, people, or context that may not be present in the active Pi session.",
		],
		parameters: TelegramRecallParameters,
		execute: async (_id, input: TelegramRecallInput, signal) => {
			const result = await datastore.search({
				store: store(),
				query: input.query,
				mode: "hybrid",
				limit: input.limit ?? TELEGRAM_RECALL_DEFAULT_LIMIT,
				includeContent: true,
			}, signal);
			const qmd = result.provenance.sources.find((source) => source.kind === "qmd");
			return {
				content: [{ type: "text" as const, text: toolText(result) }],
				details: {
					store: store(),
					mode: "hybrid" as const,
					returned: result.data.returned,
					generation: qmd?.observationId,
					freshness: qmd?.freshness,
					warnings: result.warnings.map((warning) => warning.code),
				},
			};
		},
	});
}
