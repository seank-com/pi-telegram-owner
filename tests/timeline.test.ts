import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import type { TelegramMarkdownProjector, TelegramTimelineResult } from "../src/markdown-projector.ts";
import { registerTelegramTimelineTool, TelegramTimelineParameters } from "../src/timeline.ts";

const result: TelegramTimelineResult = {
	operation: "recent",
	unit: "messages",
	direction: "both",
	order: "desc",
	timezone: "UTC",
	range: { start: null, end: "2026-09-24T12:00:00.000Z" },
	count: 1,
	messages: [{ messageId: "tgmsg:v1:pi:session:entry", occurredAt: "2026-09-24T11:59:00.000Z", direction: "in", role: "user", path: "messages/2026/09/example-user.md", content: "last thing", truncated: false }],
};

test("telegram_timeline is conspicuous, strict, and delegates only to the active canonical archive", async () => {
	let tool: any; let observedInput: unknown; let observedSignal: AbortSignal | undefined;
	const projector = { async timeline(input: unknown, signal?: AbortSignal) { observedInput = input; observedSignal = signal; return result; } } as unknown as TelegramMarkdownProjector;
	registerTelegramTimelineTool({ registerTool(value: unknown) { tool = value; } } as unknown as ExtensionAPI, () => projector);
	assert.equal(tool.name, "telegram_timeline");
	assert.match(tool.description, /exact chronological order/);
	assert.ok(tool.promptGuidelines.some((line: string) => line.includes("not telegram_recall")));
	assert.equal(Check(TelegramTimelineParameters, { operation: "recent" }), true);
	assert.equal(Check(TelegramTimelineParameters, { operation: "range", start: "x", end: "y" }), true, "cross-field timestamp validation belongs to the projector");
	assert.equal(Check(TelegramTimelineParameters, { operation: "recent", limit: 51 }), false);
	assert.equal(Check(TelegramTimelineParameters, { operation: "latest" }), false);
	assert.equal(Check(TelegramTimelineParameters, { operation: "recent", query: "topic" }), false);
	const signal = new AbortController().signal;
	const output = await tool.execute("call", { operation: "recent" }, signal);
	assert.deepEqual(observedInput, { operation: "recent" });
	assert.equal(observedSignal, signal);
	assert.deepEqual(JSON.parse(output.content[0].text), result);
	assert.deepEqual(output.details, { operation: "recent", unit: "messages", count: 1, timezone: "UTC", start: null, end: "2026-09-24T12:00:00.000Z" });
});

test("telegram_timeline fails explicitly when Markdown projection is inactive", async () => {
	let tool: any;
	registerTelegramTimelineTool({ registerTool(value: unknown) { tool = value; } } as unknown as ExtensionAPI, () => undefined);
	await assert.rejects(() => tool.execute("call", { operation: "recent" }, new AbortController().signal), /CAPABILITY_UNAVAILABLE/);
});
