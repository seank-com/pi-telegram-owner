import assert from "node:assert/strict";
import test from "node:test";

import {
	MemoryJournal,
	renderWorkItemPrompt,
	ReplyDestinationUnavailableError,
	StateCorruptionError,
	TelegramOwnerBridge,
	type TelegramUpdate,
	type WorkItem,
} from "../src/core.ts";

const OWNER = 7;
const CHAT = 70;
const GROUP = -1001234567890;

function ownerText(updateId: number, text: string): TelegramUpdate {
	return { update_id: updateId, message: { message_id: updateId * 10, text, chat: { id: CHAT, type: "private" }, from: { id: OWNER } } };
}

const peerRequest = (text: string, messageId: number): Omit<WorkItem, "itemId" | "timestamp"> => ({
	channel: "group", authority: "peer", sender: "Agent B (@example_agent_b_bot)", text,
	reply: { kind: "group", chatId: GROUP, messageId },
});

const automation = (text: string, reply: WorkItem["reply"], idempotencyKey?: string): Omit<WorkItem, "itemId" | "timestamp"> => ({
	channel: "endpoint", authority: "owner", sender: "nightly-calendar", text, reply, ...(idempotencyKey ? { idempotencyKey } : {}),
});

async function runTurn(bridge: TelegramOwnerBridge, answer: string): Promise<string> {
	let prompt = "";
	await bridge.dispatchNext("session", (text) => { prompt = text; });
	bridge.observeInput("extension", prompt);
	assert.equal(await bridge.beforeAgentStart(prompt, "session"), true);
	bridge.captureAgentEnd(answer);
	return prompt;
}

test("the envelope names channel, sender, authority, audience and reply destination", () => {
	const prompt = renderWorkItemPrompt({ ...peerRequest("Can you check the build?", 41), itemId: "x", timestamp: "", context: ["In reply to the owner: please coordinate."] });
	assert.equal(prompt, [
		"Channel: group chat",
		"From: Agent B (@example_agent_b_bot) (peer authority)",
		"Your final reply goes to the group chat, as a reply to message 41.",
		"The owner and every configured agent can read the group chat.",
		"In reply to the owner: please coordinate.",
		"",
		"Can you check the build?",
	].join("\n"));
	assert.match(renderWorkItemPrompt({ ...automation("Remind the owner.", { kind: "none" }), itemId: "y", timestamp: "" }), /^Channel: queue endpoint\nFrom: nightly-calendar \(owner authority\)\nYour final reply goes to nowhere; this turn sends no reply\.\n\nRemind the owner\.$/);
});

test("owner-authority work runs before peer work, first in first out within each tier", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const peerOne = await bridge.admitItem(peerRequest("peer one", 1));
	await bridge.ingestBatch([ownerText(10, "private one")]);
	const peerTwo = await bridge.admitItem(peerRequest("peer two", 2));
	const owned = await bridge.admitItem(automation("automation", { kind: "private" }));
	await bridge.ingestBatch([ownerText(11, "private two")]);
	assert.deepEqual(bridge.queueDepthByTier, { owner: 3, peer: 2 });

	const order: string[] = [];
	for (let index = 0; index < 5; index++) {
		const prompt = await runTurn(bridge, `answer ${index}`);
		order.push(prompt.split("\n").at(-1)!);
		await bridge.settle(async () => "1", () => async () => "2");
	}
	assert.deepEqual(order, ["private one", "automation", "private two", "peer one", "peer two"]);
	assert.ok(peerOne.item.itemId && peerTwo.item.itemId && owned.item.itemId);
});

test("item markers are distinct from private markers and carry the envelope", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const { item } = await bridge.admitItem(peerRequest("hello", 5));
	const prompt = await runTurn(bridge, "hi");
	assert.equal(prompt, `[telegram-item:${item.itemId}]\n${renderWorkItemPrompt(item)}`);
	assert.equal(bridge.marker, `[telegram-item:${item.itemId}]`);
});

test("repeating an idempotency key returns the original item without queuing a duplicate", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT);
	await bridge.initialize();
	const first = await bridge.admitItem(automation("set alarm", { kind: "private" }, "2026-01-01-alarm"));
	const second = await bridge.admitItem(automation("set alarm again", { kind: "group", chatId: GROUP, messageId: 1 }, "2026-01-01-alarm"));
	assert.equal(first.duplicate, false);
	assert.equal(second.duplicate, true);
	assert.equal(second.item.itemId, first.item.itemId);
	assert.equal(second.item.text, "set alarm");
	assert.equal(journal.records.filter((record) => record.type === "work_item").length, 1);

	const restarted = new TelegramOwnerBridge(journal, OWNER, CHAT);
	const recovered = await restarted.initialize();
	assert.equal(recovered.queued.length, 1, "admitted items survive restart");
	assert.equal((await restarted.admitItem(automation("x", { kind: "none" }, "2026-01-01-alarm"))).duplicate, true);
});

test("replies go to the private chat without an anchor, to the group, or nowhere", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT);
	await bridge.initialize();
	await bridge.admitItem(automation("tell the owner", { kind: "private" }));
	await bridge.admitItem(automation("log only", { kind: "none" }));
	await bridge.admitItem(peerRequest("question", 77));
	const privateSends: Array<[string, number | undefined]> = [];
	const groupSends: Array<[string, number | undefined]> = [];
	const send = async (text: string, replyTo?: number) => { privateSends.push([text, replyTo]); return "500"; };
	const route = () => async (text: string, replyTo?: number) => { groupSends.push([text, replyTo]); return "600"; };
	for (const answer of ["for owner", "for nobody", "for peer"]) {
		await runTurn(bridge, answer);
		await bridge.settle(send, route);
	}
	assert.deepEqual(privateSends, [["for owner", undefined]]);
	assert.deepEqual(groupSends, [["for peer", 77]]);
	const sent = journal.records.filter((record) => record.type === "reply_sent");
	assert.equal(sent.length, 3);
	assert.ok(sent.some((record) => "messageIds" in record && record.messageIds.length === 0), "a no-reply item settles without sending");
});

test("an unavailable group keeps the group reply pending without holding private dispatch", async () => {
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.admitItem(peerRequest("question", 9));
	await runTurn(bridge, "answer");
	await assert.rejects(bridge.settle(async () => "1"), ReplyDestinationUnavailableError);
	assert.equal(bridge.pendingReplyCount, 0, "group replies do not block private dispatch");
	assert.equal(bridge.activeJob, undefined);
	await bridge.ingestBatch([ownerText(20, "private")]);
	assert.ok(await bridge.dispatchNext("session", () => {}));
	const groupSends: string[] = [];
	await bridge.retryReadyReplies(async () => "1", () => async (text) => { groupSends.push(text); return "2"; });
	assert.deepEqual(groupSends, ["answer"]);
});

test("malformed work item records fail closed", async () => {
	const journal = new MemoryJournal([{ type: "work_item", schemaVersion: 1, itemId: "not-a-uuid", channel: "endpoint", authority: "owner", sender: "x", text: "y", reply: { kind: "private" }, timestamp: "2026-01-01T00:00:00Z" }]);
	await assert.rejects(new TelegramOwnerBridge(journal, OWNER, CHAT).initialize(), StateCorruptionError);
	const bridge = new TelegramOwnerBridge(new MemoryJournal(), OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await assert.rejects(bridge.admitItem({ ...automation("", { kind: "private" }) }), StateCorruptionError);
	await assert.rejects(bridge.admitItem({ ...peerRequest("x", 0) }), StateCorruptionError);
});
