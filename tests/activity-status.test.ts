import assert from "node:assert/strict";
import test from "node:test";

import {
	MemoryJournal,
	TelegramOwnerBridge,
	privateOwnerActivity,
	type JournalRecord,
	type TelegramUpdate,
} from "../src/core.ts";

const OWNER = 7;
const CHAT = 70;
const NOW = 1_700_000_000_000;
const NONE = { lastOwnerMessageAt: null, lastAgentMessageAt: null };

function ownerText(updateId: number, text: string, telegramDate?: number): TelegramUpdate {
	return { update_id: updateId, message: { message_id: updateId, text, date: telegramDate, chat: { id: CHAT, type: "private" }, from: { id: OWNER } } };
}

test("a fresh bridge has never had a private turn in either direction", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0, now: () => NOW });
	await bridge.initialize();
	assert.deepEqual(bridge.ownerActivity, NONE);
});

test("an owner message sets only the owner timestamp", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0, now: () => NOW });
	await bridge.initialize();
	await bridge.ingestBatch([ownerText(1, "still here", NOW / 1000)]);
	assert.deepEqual(bridge.ownerActivity, { lastOwnerMessageAt: new Date(NOW).toISOString(), lastAgentMessageAt: null });
});

test("group traffic and an unsent reply do not set either timestamp", () => {
	const records: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 2, disposition: "group", timestamp: new Date(NOW).toISOString(), group: { kind: "foreign-chat", chatId: -100, chatType: "supergroup" } },
		{ type: "work_item", schemaVersion: 1, itemId: "group-job", channel: "group", authority: "peer", sender: "peer", text: "group", reply: { kind: "group", chatId: -100, messageId: 9 }, timestamp: new Date(NOW).toISOString() },
		{ type: "reply_sent", jobId: "group-job", messageIds: ["9"], timestamp: new Date(NOW).toISOString() },
		{ type: "work_item", schemaVersion: 1, itemId: "silent", channel: "endpoint", authority: "owner", sender: "clock", text: "no reply", reply: { kind: "none" }, timestamp: new Date(NOW).toISOString() },
		{ type: "reply_sent", jobId: "silent", messageIds: [], timestamp: new Date(NOW).toISOString() },
	];
	assert.deepEqual(privateOwnerActivity(records, CHAT), NONE);
});

test("a private reply sets the agent timestamp and leaves an older owner timestamp", () => {
	const old = NOW - 60 * 60 * 1000;
	const replied = NOW - 60_000;
	const records: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: new Date(old).toISOString(), jobId: "job-1", chatId: CHAT, telegramDate: old / 1000 },
		{ type: "reply_chunk_sent", jobId: "job-1", index: 0, messageId: "4", format: "plain", timestamp: new Date(replied).toISOString() },
	];
	assert.deepEqual(privateOwnerActivity(records, CHAT), {
		lastOwnerMessageAt: new Date(old).toISOString(),
		lastAgentMessageAt: new Date(replied).toISOString(),
	});
});

test("an unsolicited private reply sets only the agent timestamp", () => {
	const sent = new Date(NOW).toISOString();
	const records: JournalRecord[] = [
		{ type: "work_item", schemaVersion: 1, itemId: "ping", channel: "endpoint", authority: "owner", sender: "handoff", text: "ping", reply: { kind: "private" }, timestamp: sent },
		{ type: "reply_sent", jobId: "ping", messageIds: ["8"], timestamp: sent },
	];
	assert.deepEqual(privateOwnerActivity(records, CHAT), { lastOwnerMessageAt: null, lastAgentMessageAt: sent });
});

test("a sent batched or plain private reply records the agent time without applying a window", async () => {
	for (const options of [{ inboundQuietWindowMs: undefined, formattedDelivery: true }, { inboundQuietWindowMs: 0, formattedDelivery: false }] as const) {
		const now = Date.now();
		let clock = now - 21 * 60 * 1000;
		const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { now: () => clock, inboundQuietWindowMs: options.inboundQuietWindowMs, formattedDelivery: options.formattedDelivery });
		await bridge.initialize();
		await bridge.ingestBatch([ownerText(1, "Synthetic question", Math.floor(clock / 1000))]);
		const ownerAt = new Date(Math.floor(clock / 1000) * 1000).toISOString();
		clock = now;
		let prompt = "";
		const job = await bridge.dispatchNext("synthetic-session", (text) => { prompt = text; });
		assert.ok(job);
		bridge.observeInput("extension", prompt);
		assert.equal(await bridge.beforeAgentStart(prompt, "synthetic-session"), true);
		bridge.captureAgentEnd("Synthetic answer");
		assert.equal(await bridge.settle(async () => "900"), true);
		assert.equal(bridge.ownerActivity.lastOwnerMessageAt, ownerAt, JSON.stringify(options));
		assert.ok(bridge.ownerActivity.lastAgentMessageAt, JSON.stringify(options));
		assert.ok(Date.parse(bridge.ownerActivity.lastAgentMessageAt) >= Date.parse(ownerAt), JSON.stringify(options));
	}
});
