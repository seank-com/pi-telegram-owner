import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import type { MarkdownDatastoreServiceV1, SearchResult } from "../src/datastore.ts";
import {
	registerTelegramRecallTool,
	TELEGRAM_RECALL_DEFAULT_LIMIT,
	TELEGRAM_RECALL_STORE,
} from "../src/recall.ts";

function searchResult(): SearchResult {
	return {
		contractVersion: 1,
		operation: "search",
		store: "telegram",
		data: {
			hits: [{
				note: { store: "telegram", path: "messages/2026/09/example.md" },
				uri: "md://telegram/messages/2026/09/example.md",
				path: "messages/2026/09/example.md",
				title: "Example",
				snippet: "Prior decision",
				rank: 1,
				backendRank: 1,
				backend: "qmd",
				mode: "hybrid",
				sourceRevision: "source",
				indexedRevision: "source",
				sourceMtime: "2026-09-24T00:00:00Z",
				indexFreshness: "current",
				truncated: false,
			}],
			examined: 1,
			dropped: 0,
			returned: 1,
		},
		provenance: {
			sources: [{ kind: "qmd", observationId: "gen-test", observedAt: "2026-09-24T00:00:00Z", freshness: "current" }],
			startedAt: "2026-09-24T00:00:00Z",
			completedAt: "2026-09-24T00:00:00Z",
			durationMs: 1,
		},
		bounds: { maxBytes: 4096, maxLines: 100, returnedBytes: 100, returnedLines: 1, truncated: false },
		warnings: [],
	};
}

test("telegram_recall is conspicuous, strict, and fixes the datastore retrieval policy", async () => {
	let tool: any;
	let observedInput: unknown;
	let observedSignal: AbortSignal | undefined;
	const result = searchResult();
	const datastore = {
		async search(input, signal) { observedInput = input; observedSignal = signal; return result; },
	} as MarkdownDatastoreServiceV1;
	const pi = { registerTool(value: unknown) { tool = value; } } as unknown as ExtensionAPI;
	registerTelegramRecallTool(pi, datastore);

	assert.equal(tool.name, "telegram_recall");
	assert.equal(tool.label, "Recall Telegram discussion");
	assert.match(tool.description, /canonical Telegram conversation archive/);
	assert.match(tool.promptSnippet, /Recall relevant prior Telegram discussions/);
	assert.ok(tool.promptGuidelines.some((line: string) => line.includes("Use telegram_recall")));
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(Check(tool.parameters, { query: "what did we decide?" }), true);
	assert.equal(Check(tool.parameters, { query: "" }), false);
	assert.equal(Check(tool.parameters, { query: "x", limit: 11 }), false);
	assert.equal(Check(tool.parameters, { query: "x", store: "other" }), false);

	const signal = new AbortController().signal;
	const output = await tool.execute("call", { query: "what did we decide?" }, signal);
	assert.deepEqual(observedInput, {
		store: TELEGRAM_RECALL_STORE,
		query: "what did we decide?",
		mode: "hybrid",
		limit: TELEGRAM_RECALL_DEFAULT_LIMIT,
		includeContent: true,
	});
	assert.equal(observedSignal, signal);
	assert.deepEqual(output.details, { store: "telegram", mode: "hybrid", returned: 1, generation: "gen-test", freshness: "current", warnings: [] });
	assert.deepEqual(JSON.parse(output.content[0].text), result);
});

test("telegram_recall forwards only the bounded optional limit", async () => {
	let observedInput: any;
	const datastore = { async search(input: unknown) { observedInput = input; return searchResult(); } } as MarkdownDatastoreServiceV1;
	let tool: any;
	registerTelegramRecallTool({ registerTool(value: unknown) { tool = value; } } as unknown as ExtensionAPI, datastore);
	await tool.execute("call", { query: "earlier evidence", limit: 2 }, new AbortController().signal);
	assert.equal(observedInput.limit, 2);
	assert.equal("freshness" in observedInput, false, "allow-stale is intentionally inherited so newly projected notes do not make all recall fail closed");
});
