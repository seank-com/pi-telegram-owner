import assert from "node:assert/strict";
import test from "node:test";
import { MemoryJournal, TelegramOwnerBridge } from "../src/core.ts";
import { taskResultContext, validateTaskRecords } from "../src/work.ts";

const group = -1001234567890;
async function fixture() {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, 7, 70, { inboundQuietWindowMs: 0, groupChatId: group });
	await bridge.initialize();
	const { item } = await bridge.admitItem({
		channel: "endpoint",
		authority: "owner",
		sender: "fixture",
		text: "Evaluate peer results",
		reply: { kind: "private" },
	});
	return { bridge, journal, item };
}
async function start(bridge: TelegramOwnerBridge) {
	let prompt = "";
	await bridge.dispatchNext("fixture", (p) => {
		prompt = p;
	});
	bridge.observeInput("extension", prompt);
	assert.ok(await bridge.beforeAgentStart(prompt, "fixture"));
	return prompt;
}
async function wait(bridge: TelegramOwnerBridge) {
	bridge.captureAgentEnd("");
	await bridge.settle(async () => {
		throw new Error("waiting must be silent");
	});
}
const result = (taskId: string, messageId = 100) => ({
	taskId,
	requestId: "child",
	recipientBotId: 202,
	messageId,
	text: "peer result " + messageId,
	disposition: "completed" as const,
});

test("waiting task and unpresented result survive restart and schedule one continuation", async () => {
	const { bridge, journal, item } = await fixture();
	await start(bridge);
	await bridge.addDependency(item.itemId, "child", [202]);
	await wait(bridge);
	await bridge.receiveResult(result(item.itemId));
	const restarted = new TelegramOwnerBridge(journal, 7, 70, { groupChatId: group });
	await restarted.initialize();
	assert.equal(restarted.taskState(item.itemId)?.state, "waiting");
	assert.equal(restarted.pendingResults(item.itemId).length, 1);
	const continuation = restarted.continuations()[0]!;
	await restarted.admitItem(continuation);
	await restarted.admitItem(continuation);
	assert.equal(restarted.queueDepth, 1);
	const recovered = new TelegramOwnerBridge(journal, 7, 70, { groupChatId: group });
	await recovered.initialize();
	assert.equal(recovered.pendingResults(item.itemId).length, 1);
	const prompt = await start(recovered);
	assert.match(prompt, /peer result 100/);
	assert.equal(recovered.pendingResults(item.itemId).length, 0);
	assert.ok(prompt.endsWith(taskResultContext(journal.records, continuation.itemId)));
	recovered.captureAgentEnd("Owner answer");
	const replies: string[] = [];
	await recovered.settle(async (text) => {
		replies.push(text);
		return "500";
	});
	assert.deepEqual(replies, ["Owner answer"]);
	assert.equal(recovered.taskState(item.itemId)?.state, "completed");
});

test("a second result arriving during continuation execution waits for another presentation", async () => {
	const { bridge, item } = await fixture();
	await start(bridge);
	await bridge.addDependency(item.itemId, "child", [202, 203]);
	await wait(bridge);
	await bridge.receiveResult(result(item.itemId));
	await bridge.admitItem(bridge.continuations()[0]!);
	await start(bridge);
	await bridge.receiveResult({ ...result(item.itemId, 101), recipientBotId: 203 });
	await wait(bridge);
	assert.equal(bridge.pendingResults(item.itemId).length, 1);
	await bridge.admitItem(bridge.continuations()[0]!);
	const prompt = await start(bridge);
	assert.match(prompt, /peer result 101/);
	assert.doesNotMatch(prompt, /peer result 100/);
});

test("terminal delivery retry survives restart without repeating execution", async () => {
	const { bridge, journal, item } = await fixture();
	await start(bridge);
	bridge.captureAgentEnd("Final result");
	await assert.rejects(
		bridge.settle(async () => {
			throw new Error("Synthetic delivery failure");
		}),
	);
	const restarted = new TelegramOwnerBridge(journal, 7, 70);
	await restarted.initialize();
	assert.equal(restarted.queueDepth, 0);
	const delivered: string[] = [];
	await restarted.retryReadyReplies(async (text) => {
		delivered.push(text);
		return "501";
	});
	assert.deepEqual(delivered, ["Final result"]);
	assert.equal(restarted.taskState(item.itemId)?.state, "completed");
});

test("completion retires a previously queued continuation and recovers its child evidence as information", async () => {
	const { bridge, journal } = await fixture();
	const { item } = await bridge.admitItem({
		channel: "group",
		authority: "peer",
		sender: "B",
		text: "Request",
		reply: { kind: "group", chatId: group },
		obligation: { requestId: "root", chainId: "root", requesterBotId: 201, recipientBotId: 202 },
	});
	// Finish the independent owner item before the peer request.
	await start(bridge);
	bridge.captureAgentEnd("owner done");
	await bridge.settle(async () => "502");
	await start(bridge);
	await bridge.addDependency(item.itemId, "child", [202]);
	await wait(bridge);
	await bridge.receiveResult(result(item.itemId));
	await bridge.admitItem(bridge.continuations()[0]!);
	await bridge.completeObligation("root", 202, "completed");
	assert.ok(bridge.continuations().length === 0);
	assert.equal(bridge.queueDepth, 1, "only informational work remains");
	const restarted = new TelegramOwnerBridge(journal, 7, 70, { groupChatId: group });
	await restarted.initialize();
	assert.equal(restarted.queueDepth, 1);
	const prompt = await start(restarted);
	assert.match(prompt, /Information only/);
	assert.doesNotMatch(prompt, /Continue the recorded waiting task/);
});

test("invalid or regressive lifecycle evidence fails closed and is not edited", () => {
	const at = new Date().toISOString();
	for (const records of [
		[
			{ type: "task_state", taskId: "root", state: "completed", timestamp: at },
			{ type: "task_state", taskId: "root", state: "waiting", timestamp: at },
		],
		[
			{
				type: "task_result",
				taskId: "root",
				requestId: "child",
				recipientBotId: 202,
				messageId: 100,
				text: "x",
				disposition: "unknown",
				timestamp: at,
			},
		],
	]) {
		const before = JSON.stringify(records);
		assert.throws(() => validateTaskRecords(records));
		assert.equal(JSON.stringify(records), before);
	}
	assert.throws(
		() =>
			taskResultContext(
				[{ type: "task_presented", taskId: "root", jobId: "turn", messageIds: [100], timestamp: at }],
				"turn",
			),
		/evidence is missing/,
	);
});
