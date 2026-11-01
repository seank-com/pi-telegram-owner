import assert from "node:assert/strict";
import test from "node:test";

import {
	MemoryJournal,
	PRIVATE_OWNER_ACTIVITY_WINDOW_MS,
	TelegramOwnerBridge,
	privateOwnerActivity,
	type JournalRecord,
	type TelegramUpdate,
} from "../src/core.ts";

const OWNER = 7;
const CHAT = 70;
const NOW = 1_700_000_000_000;

function ownerText(updateId: number, text: string, telegramDate?: number): TelegramUpdate {
	return { update_id: updateId, message: { message_id: updateId, text, date: telegramDate, chat: { id: CHAT, type: "private" }, from: { id: OWNER } } };
}

test("a recent private owner message is active even when the queue is idle", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0, now: () => NOW });
	await bridge.initialize();
	assert.deepEqual(bridge.ownerActivity, { active: false, lastTurnAt: null });
	await bridge.ingestBatch([ownerText(1, "still here", NOW / 1000)]);
	assert.equal(bridge.ownerActivity.active, true);
	assert.equal(bridge.ownerActivity.lastTurnAt, new Date(NOW).toISOString());
});

test("a private turn older than 20 minutes is inactive, and group traffic does not refresh it", () => {
	const old = NOW - PRIVATE_OWNER_ACTIVITY_WINDOW_MS - 1;
	const records: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: new Date(old).toISOString(), jobId: "job-1", messageId: 1, chatId: CHAT, userId: OWNER, text: "earlier", telegramDate: old / 1000 },
		{ type: "update", schemaVersion: 2, updateId: 2, disposition: "group", timestamp: new Date(NOW).toISOString(), group: { kind: "foreign-chat", chatId: -100, chatType: "supergroup" } },
		{ type: "work_item", schemaVersion: 1, itemId: "group-job", channel: "group", authority: "peer", sender: "peer", text: "group", reply: { kind: "group", chatId: -100, messageId: 9 }, timestamp: new Date(NOW).toISOString() },
		{ type: "reply_sent", jobId: "group-job", messageIds: ["9"], timestamp: new Date(NOW).toISOString() },
		{ type: "work_item", schemaVersion: 1, itemId: "silent", channel: "endpoint", authority: "owner", sender: "clock", text: "no reply", reply: { kind: "none" }, timestamp: new Date(NOW).toISOString() },
		{ type: "reply_sent", jobId: "silent", messageIds: [], timestamp: new Date(NOW).toISOString() },
	];
	assert.deepEqual(privateOwnerActivity(records, CHAT, NOW), { active: false, lastTurnAt: new Date(old).toISOString() });
});

test("a sent batched or plain private reply refreshes activity after the inbound ages out", async () => {
	for (const options of [{ inboundQuietWindowMs: undefined, formattedDelivery: true }, { inboundQuietWindowMs: 0, formattedDelivery: false }] as const) {
		const now = Date.now();
		let clock = now - PRIVATE_OWNER_ACTIVITY_WINDOW_MS - 60_000;
		const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { now: () => clock, inboundQuietWindowMs: options.inboundQuietWindowMs, formattedDelivery: options.formattedDelivery });
		await bridge.initialize();
		await bridge.ingestBatch([ownerText(1, "Synthetic question", Math.floor(clock / 1000))]);
		clock = now;
		let prompt = "";
		const job = await bridge.dispatchNext("synthetic-session", (text) => { prompt = text; });
		assert.ok(job);
		bridge.observeInput("extension", prompt);
		assert.equal(await bridge.beforeAgentStart(prompt, "synthetic-session"), true);
		bridge.captureAgentEnd("Synthetic answer");
		assert.equal(await bridge.settle(async () => "900"), true);
		assert.equal(bridge.ownerActivity.active, true, JSON.stringify(options));
	}
});

test("a private reply within 20 minutes is active after the owner's message has aged out", () => {
	const old = NOW - PRIVATE_OWNER_ACTIVITY_WINDOW_MS - 1;
	const replied = NOW - 60_000;
	const records: JournalRecord[] = [
		{ type: "update", schemaVersion: 2, updateId: 1, disposition: "accepted", timestamp: new Date(old).toISOString(), jobId: "job-1", chatId: CHAT, telegramDate: old / 1000 },
		{ type: "reply_sent", jobId: "job-1", messageId: "4" },
		{ type: "reply_chunk_sent", jobId: "job-1", index: 0, messageId: "4", format: "plain", timestamp: new Date(replied).toISOString() },
	];
	assert.equal(privateOwnerActivity(records, CHAT, NOW).active, true);
	assert.equal(privateOwnerActivity(records, CHAT, NOW).lastTurnAt, new Date(replied).toISOString());
});
