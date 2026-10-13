import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	createTelegramTransportPlan,
	markdownCompatibilityKey,
	markdownToPlainText,
	markdownToTelegramHtml,
	splitTelegramHtml,
	TELEGRAM_FORMAT_COMPAT_VERSION,
	TELEGRAM_FORMAT_VERSION,
} from "../src/format.ts";

test("shared Markdown renderer emits only allowlisted Telegram HTML", () => {
	const markdown = [
		"**bold** *italic* ~~gone~~ ||quiet||",
		"",
		"`a < b` and [site](https://example.test/a?x=1&y=2)",
		"",
		"> quoted",
		"",
		"```",
		"<tag> & data",
		"```",
	].join("\n");
	assert.equal(
		markdownToTelegramHtml(markdown),
		'<b>bold</b> <i>italic</i> <s>gone</s> <tg-spoiler>quiet</tg-spoiler>\n\n<code>a &lt; b</code> and <a href="https://example.test/a?x=1&amp;y=2">site</a>\n\n<blockquote>quoted</blockquote>\n\n<pre><code>&lt;tag&gt; &amp; data</code></pre>',
	);
});

test("representative assistant Markdown has an exact Telegram rendering contract", () => {
	const markdown = [
		"# Status",
		"",
		"**bold** *italic* ~~gone~~ ||hidden||",
		"",
		"- first",
		"- second with `a < b`",
		"",
		"1. one",
		"2. two",
		"",
		"> literal <tag> & [site](https://example.test/a?x=1&y=2)",
	].join("\n");
	const expected = 'Status\n\n<b>bold</b> <i>italic</i> <s>gone</s> <tg-spoiler>hidden</tg-spoiler>\n\n- first\n- second with <code>a &lt; b</code>\n\n1. one\n2. two\n\n<blockquote>literal &lt;tag&gt; &amp; <a href="https://example.test/a?x=1&amp;y=2">site</a></blockquote>';
	assert.equal(markdownToTelegramHtml(markdown), expected);
	const plan = createTelegramTransportPlan(markdown);
	assert.equal(plan.fallback, false);
	assert.deepEqual(plan.chunks.map(({ format, payload }) => ({ format, payload })), [{ format: "HTML", payload: expected }]);
});

test("semantic compatibility keys ignore source spelling but retain structure and destinations", () => {
	assert.equal(markdownCompatibilityKey("hello."), markdownCompatibilityKey("hello\\."));
	assert.equal(markdownCompatibilityKey("**same**"), markdownCompatibilityKey("__same__"));
	assert.equal(markdownCompatibilityKey("```\ncode\n```"), markdownCompatibilityKey("````\ncode\n````"));
	assert.notEqual(markdownCompatibilityKey("**same**"), markdownCompatibilityKey("same"));
	assert.notEqual(markdownCompatibilityKey("[same](https://one.test)"), markdownCompatibilityKey("[same](https://two.test)"));
});

test("current and legacy Markdown fixtures preserve semantic and plain-text roundtrips", async () => {
	const fixtures = JSON.parse(await readFile(new URL("./fixtures/markdown-roundtrip.json", import.meta.url), "utf8")) as Array<{ name: string; current: string; legacy: string; plain: string }>;
	for (const fixture of fixtures) {
		assert.equal(markdownCompatibilityKey(fixture.current), markdownCompatibilityKey(fixture.legacy), fixture.name);
		assert.equal(markdownToPlainText(fixture.current), fixture.plain, fixture.name);
		assert.equal(markdownToPlainText(fixture.legacy), fixture.plain, fixture.name);
	}
});

test("plain projection preserves nested list markers emitted by the Telegram renderer", () => {
	assert.equal(markdownToPlainText("- Paths:\n  - `one.md`\n  - `two.md`"), "- Paths:\n  - one.md\n- two.md");
	assert.equal(markdownToPlainText("1. Parent\n   1. Child"), "1. Parent\n  1. Child");
});

test("tel links share bidirectional renderer semantics and malformed links degrade readably", () => {
	assert.equal(
		markdownToTelegramHtml("[Call](tel:+15550100)"),
		'<a href="tel:+15550100">Call</a>',
	);
	assert.equal(markdownToPlainText("[Call](tel:+15550100)"), "Call");
	assert.equal(
		markdownToTelegramHtml("[Unsafe](tel:javascript)"),
		"Unsafe (tel:javascript)",
	);
});

test("raw HTML and unsafe URL schemes never pass through", () => {
	assert.equal(markdownToTelegramHtml("<b>raw</b> [x](javascript:alert(1))"), "&lt;b&gt;raw&lt;/b&gt; x (javascript:alert(1))");
});

test("HTML chunking closes and reopens formatting without exceeding limit", () => {
	const chunks = splitTelegramHtml(`<b>${"alpha ".repeat(30)}</b>`, 64);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 64);
		assert.match(chunk, /^<b>.*<\/b>$/);
	}
	assert.equal(chunks.map((chunk) => chunk.slice(3, -4)).join(""), "alpha ".repeat(30));
});

test("nested formatted chunks are balanced, bounded, and preserve visible text", () => {
	const visible = "alpha & beta ".repeat(30).trimEnd();
	const plan = createTelegramTransportPlan(`> **${visible}**`, 96);
	assert.equal(plan.fallback, false);
	assert.ok(plan.chunks.length > 1);
	for (const chunk of plan.chunks) {
		assert.equal(chunk.format, "HTML");
		assert.ok(chunk.payload.length <= 96);
		assert.match(chunk.payload, /^<blockquote><b>.*<\/b><\/blockquote>$/);
		assert.equal(/<(?!\/?(?:blockquote|b)>)/.test(chunk.payload), false);
	}
	assert.equal(plan.chunks.map((chunk) => chunk.plainFallback).join(""), visible);
});

test("transport plans are deterministic and carry per-chunk plain fallback", () => {
	const first = createTelegramTransportPlan(`**${"word ".repeat(40)}**`, 80);
	const second = createTelegramTransportPlan(`**${"word ".repeat(40)}**`, 80);
	assert.deepEqual(first, second);
	assert.equal(first.renderer, TELEGRAM_FORMAT_VERSION);
	assert.equal(first.compatibility, TELEGRAM_FORMAT_COMPAT_VERSION);
	assert.equal(first.fallback, false);
	assert.ok(first.chunks.length > 1);
	assert.ok(first.chunks.every((chunk, index) => chunk.index === index && chunk.format === "HTML" && chunk.plainFallback.length > 0));
});

test("oversized renderer input uses a complete bounded fallback without truncation", () => {
	const raw = "x".repeat(300_000);
	const plan = createTelegramTransportPlan(raw, 4_000);
	assert.equal(plan.fallback, true);
	assert.ok(plan.chunks.length <= 128);
	assert.ok(plan.chunks.every((chunk) => chunk.format === "plain" && chunk.payload.length <= 4_000));
	assert.equal(plan.chunks.map((chunk) => chunk.payload).join(""), raw);

	const emoji = "😀".repeat(70_000);
	const emojiPlan = createTelegramTransportPlan(emoji, 4_000);
	assert.equal(Buffer.byteLength(emoji, "utf8") > emoji.length, true);
	assert.ok(emojiPlan.chunks.every((chunk) => chunk.payload.length <= 4_000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.payload)));
	assert.equal(emojiPlan.chunks.map((chunk) => chunk.payload).join(""), emoji);
});

test("representative safe and hostile replies always produce bounded deterministic plans", async () => {
	const fixtures = JSON.parse(await readFile(new URL("./fixtures/markdown-roundtrip.json", import.meta.url), "utf8")) as Array<{ name: string; current: string; legacy: string }>;
	const corpus = [
		...fixtures.flatMap((fixture) => [fixture.current, fixture.legacy]),
		"<script>alert('x')</script>",
		"[credentials](https://user:password@example.test/private)",
		"[unsafe](javascript:alert(1))",
		"`<b>& raw</b>`",
		"||spoiler with <angle> & ampersand||",
	];
	for (const markdown of corpus) {
		const first = createTelegramTransportPlan(markdown, 128);
		const second = createTelegramTransportPlan(markdown, 128);
		assert.deepEqual(first, second);
		assert.ok(first.chunks.length >= 1 && first.chunks.length <= 128);
		assert.ok(first.chunks.every((chunk, index) => chunk.index === index && chunk.payload.length <= 128 && chunk.plainFallback.length > 0));
	}
});

test("empty and over-chunked output fail closed", () => {
	assert.throws(() => createTelegramTransportPlan("   \n"), /empty/);
	assert.throws(() => createTelegramTransportPlan("x".repeat(300_000), 1_000), /chunk bounds/);
});
