import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fetchUpdateBatch,
	JsonlJournal,
	MAX_IMAGE_BYTES,
	MemoryJournal,
	outboundPhotoDeliveryKey,
	recover,
	splitPlainText,
	StateCorruptionError,
	TelegramOwnerBridge,
	validateMediaLifecycle,
	type JournalRecord,
	type ResolvedImage,
	type TelegramUpdate,
} from "../src/core.ts";
import { createTelegramOwnerExtension } from "../src/index.ts";

const OWNER = 7;
const CHAT = 70;

function textUpdate(updateId: number, text: string, userId = OWNER, chatId = CHAT, telegramDate?: number): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: updateId * 10,
			text,
			date: telegramDate,
			chat: { id: chatId, type: "private" },
			from: { id: userId },
		},
	};
}

function updateRecord(jobId: string, updateId: number): JournalRecord {
	return {
		type: "update",
		updateId,
		disposition: "accepted",
		timestamp: "2026-09-15T00:00:00Z",
		jobId,
		messageId: updateId * 10,
		chatId: CHAT,
		userId: OWNER,
		text: `message ${jobId}`,
	};
}

test("mock HTTP catch-up durably classifies authorized, unauthorized, and unsupported updates", async () => {
	const returned = [
		textUpdate(10, "first"),
		textUpdate(13, "intruder", 8),
		{ update_id: 99, message: { message_id: 990, chat: { id: CHAT, type: "private" }, from: { id: OWNER } } },
	];
	let requestBody: Record<string, unknown> | undefined;
	const batch = await fetchUpdateBatch(
		async (url, init) => {
			assert.equal(url.endsWith("/botmock-token/getUpdates"), true);
			requestBody = JSON.parse(init.body) as Record<string, unknown>;
			return { ok: true, async json() { return { ok: true, result: returned }; } };
		},
		"mock-token",
	);
	assert.deepEqual(requestBody, { timeout: 0, allowed_updates: ["message"] });
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const result = await bridge.ingestBatch(batch);
	assert.equal(result.cursor, 99);
	assert.deepEqual(
		journal.records.filter((record) => record.type === "update").map((record) => [record.updateId, record.disposition]),
		[
			[10, "accepted"],
			[13, "unauthorized"],
			[99, "unsupported"],
		],
	);
	assert.equal(result.queued.length, 1);

	await bridge.ingestBatch([textUpdate(10, "duplicate"), textUpdate(150, "later")]);
	assert.deepEqual(
		journal.records.filter((record) => record.type === "update").map((record) => record.updateId),
		[10, 13, 99, 150],
	);
});

test("ingest reports only newly durable model-bound owner input", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const localOnly = await bridge.ingestBatch([
		textUpdate(1, "/status"),
		textUpdate(2, "intruder", OWNER + 1),
	]);
	assert.equal(localOnly.acceptedModelInput, false);
	const modelInput = await bridge.ingestBatch([textUpdate(3, "ordinary")]);
	assert.equal(modelInput.acceptedModelInput, true);
	assert.equal(modelInput.acceptedModelInputCount, 1);
	const twoSegments = await bridge.ingestBatch([textUpdate(4, "one", OWNER, CHAT, 100), textUpdate(5, "two", OWNER, CHAT, 100)]);
	assert.equal(twoSegments.acceptedModelInputCount, 2);
	const duplicate = await bridge.ingestBatch([textUpdate(3, "ordinary")]);
	assert.equal(duplicate.acceptedModelInput, false);
	assert.equal(duplicate.acceptedModelInputCount, 0);
});

test("owner photos are durably recovered and resolved only immediately before dispatch", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.ingestBatch([
		{
			update_id: 20,
			message: {
				message_id: 200,
				caption: "inspect this",
				photo: [
					{ file_id: "small", file_size: 100, width: 10, height: 10 },
					{ file_id: "large", file_size: 200, width: 20, height: 20 },
				],
				chat: { id: CHAT, type: "private" },
				from: { id: OWNER },
			},
		},
		{
			update_id: 21,
			message: {
				message_id: 210,
				document: { file_id: "too-large", file_size: MAX_IMAGE_BYTES + 1, mime_type: "image/png" },
				chat: { id: CHAT, type: "private" },
				from: { id: OWNER },
			},
		},
	]);
	const recovered = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	const state = await recovered.initialize();
	assert.equal(state.queued.length, 1);
	assert.deepEqual(state.queued[0]?.images, [{ fileId: "large", mimeType: "image/jpeg", fileSize: 200 }]);
	assert.equal(journal.records.find((record) => record.type === "update" && record.updateId === 21)?.disposition, "unsupported");

	let sent: unknown;
	await recovered.dispatchNext(
		"image-session",
		(text, images) => { sent = { text, images }; },
		async (images, archived) => {
			assert.deepEqual(images, [{ fileId: "large", mimeType: "image/jpeg", fileSize: 200 }]);
			assert.deepEqual(archived, []);
			return [{ image: { data: "base64-image", mimeType: "image/jpeg" }, attachment: { sha256: "a".repeat(64), size: 200, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"a".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const } }];
		},
	);
	assert.deepEqual(sent, {
		text: `${recovered.marker}\ninspect this`,
		images: [{ data: "base64-image", mimeType: "image/jpeg" }],
	});
	const admitted = journal.records.find((record) => record.type === "update" && record.updateId === 20);
	assert.equal(admitted?.schemaVersion, 3, "new accepted images must cross the forward capture boundary");
	const capture = journal.records.find((record) => record.type === "media_captured");
	assert.equal(capture?.attachment.sha256, "a".repeat(64));
	assert.deepEqual(capture?.telegram, { updateId: 20, messageId: 200, fileId: "large" });
});

test("restart dispatch can reuse durable inbound media without another capture", async () => {
	const attachment = { sha256: "c".repeat(64), size: 20, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"c".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const };
	const journal = new MemoryJournal([
		{ type: "update", schemaVersion: 2, updateId: 20, disposition: "accepted", timestamp: "2026-10-01T00:00:00.000Z", jobId: "image-job", messageId: 200, text: "inspect", images: [{ fileId: "telegram-file", mimeType: "image/jpeg", fileSize: 20 }] },
		{ type: "media_captured", schemaVersion: 1, mediaId: `in:image-job:0:${attachment.sha256}`, jobId: "image-job", direction: "in", attachment, telegram: { updateId: 20, messageId: 200, fileId: "telegram-file" }, timestamp: "2026-10-01T00:00:00.500Z" },
	]);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	let sent: ResolvedImage[] | undefined;
	await bridge.dispatchNext("session", (_text, images) => { sent = images; }, async (_images, archived) => {
		assert.deepEqual(archived, [attachment]);
		return [{ image: { data: "from-archive", mimeType: "image/jpeg" }, attachment: archived[0]! }];
	});
	assert.deepEqual(sent, [{ data: "from-archive", mimeType: "image/jpeg" }]);
	assert.equal(journal.records.filter((record) => record.type === "media_captured").length, 1);
});

test("mandatory inbound capture ignores legacy images and retains post-feature crash work", async () => {
	const image = { fileId: "telegram-file", mimeType: "image/jpeg" as const, fileSize: 20 };
	const journal = new MemoryJournal([
		{ type: "update", schemaVersion: 2, updateId: 19, disposition: "accepted", timestamp: "2026-09-30T00:00:00.000Z", jobId: "legacy-image", messageId: 190, text: "legacy", images: [image] },
		{ type: "update", schemaVersion: 3, updateId: 20, disposition: "accepted", timestamp: "2026-10-01T00:00:00.000Z", jobId: "required-image", messageId: 200, text: "required", images: [image] },
	]);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	const recovered = await bridge.initialize();
	assert.deepEqual(bridge.pendingInboundMediaJobs().map((job) => job.jobId), ["required-image"]);
	assert.deepEqual(recovered.queued.map((job) => job.jobId), ["required-image"], "uncaptured legacy image remains historical rather than executable backfill work");
});

test("outbound photo plans preserve uncertain delivery and are idempotent across restart", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now, inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const job = { jobId: "job-photo", updateId: 1, messageId: 10, text: "send", images: [] };
	const attachment = { sha256: "b".repeat(64), size: 8, mimeType: "image/png" as const, path: `messages/_attachments/${"b".repeat(64)}.png`, source: "live" as const, direction: "out" as const };
	await bridge.planOutboundPhoto("tool-call-1", job, "caption", attachment);
	assert.equal(bridge.outboundPhotoReceipt("tool-call-1"), undefined, "a durable plan without receipt is honestly uncertain");
	assert.equal(bridge.equivalentOutboundPhoto(attachment, "caption", 10)?.plan.photoId, "tool-call-1");
	assert.equal(bridge.equivalentOutboundPhoto(attachment, "different", 10), undefined, "a distinct caption remains a legitimate send");

	now = 2_000;
	const restarted = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now, inboundQuietWindowMs: 0 });
	await restarted.initialize();
	await restarted.planOutboundPhoto("tool-call-1", job, "caption", attachment);
	assert.equal(journal.records.filter((record) => record.type === "photo_send_planned").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "media_captured" && record.direction === "out").length, 1);
	await restarted.recordOutboundPhotoSent("tool-call-1", job.jobId, "11");
	await restarted.recordOutboundPhotoSent("tool-call-1", job.jobId, "11");
	assert.equal(journal.records.filter((record) => record.type === "photo_sent").length, 1);
	assert.equal(restarted.outboundPhotoReceipt("tool-call-1")?.messageId, "11");
	assert.equal(restarted.equivalentOutboundPhoto(attachment, "caption", 10)?.receipt?.messageId, "11");
	await assert.rejects(() => restarted.planOutboundPhoto("tool-call-1", job, "changed", attachment), StateCorruptionError);
});

test("outbound media capture-first planning converges after an interrupted plan append", async () => {
	const attachment = { sha256: "d".repeat(64), size: 8, mimeType: "image/png" as const, path: `messages/_attachments/${"d".repeat(64)}.png`, source: "live" as const, direction: "out" as const };
	class FailPlanJournal extends MemoryJournal {
		fail = true;
		override async append(record: JournalRecord): Promise<void> {
			if (record.type === "photo_send_planned" && this.fail) { this.fail = false; throw new Error("plan fsync"); }
			await super.append(record);
		}
	}
	const journal = new FailPlanJournal(); const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 }); await bridge.initialize();
	const job = { jobId: "job", updateId: 1, messageId: 10, text: "send", images: [] };
	await assert.rejects(() => bridge.planOutboundPhoto("photo", job, "caption", attachment), /plan fsync/);
	assert.equal(journal.records.filter((record) => record.type === "media_captured").length, 1);
	await bridge.planOutboundPhoto("photo", job, "caption", attachment);
	validateMediaLifecycle(journal.records);
	assert.equal(journal.records.filter((record) => record.type === "media_captured").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "photo_send_planned").length, 1);
});

test("media lifecycle validation rejects missing captures, duplicate semantic plans, and orphan receipts", () => {
	const attachment = { sha256: "e".repeat(64), size: 8, mimeType: "image/png" as const, path: `messages/_attachments/${"e".repeat(64)}.png`, source: "live" as const, direction: "out" as const };
	const plan: Extract<JournalRecord, { type: "photo_send_planned" }> = { type: "photo_send_planned", schemaVersion: 1, photoId: "photo", deliveryKey: outboundPhotoDeliveryKey(attachment, "caption", 10), jobId: "job", caption: "caption", replyToMessageId: 10, attachment, timestamp: "2026-10-01T00:00:00.000Z" };
	assert.throws(() => validateMediaLifecycle([plan]), /lacks its matching media capture/);
	const capture: Extract<JournalRecord, { type: "media_captured" }> = { type: "media_captured", schemaVersion: 1, mediaId: `out:photo:${attachment.sha256}`, jobId: "job", direction: "out", attachment, telegram: {}, timestamp: plan.timestamp };
	assert.throws(() => validateMediaLifecycle([capture, plan, plan]), /plan lifecycle is invalid/);
	assert.throws(() => validateMediaLifecycle([capture, plan, { ...plan, photoId: "equivalent-photo" }]), /plan lifecycle is invalid/);
	assert.throws(() => validateMediaLifecycle([{ type: "photo_sent", schemaVersion: 1, photoId: "missing", jobId: "job", messageId: "11", timestamp: plan.timestamp }]), /orphaned or mismatched/);
	assert.throws(() => validateMediaLifecycle([capture, plan, { type: "photo_sent", schemaVersion: 1, photoId: "photo", jobId: "other", messageId: "11", timestamp: plan.timestamp }]), /orphaned or mismatched/);
});

test("media lifecycle validation rejects non-live and misbound inbound captures", () => {
	const update: Extract<JournalRecord, { type: "update" }> = { type: "update", schemaVersion: 3, updateId: 20, disposition: "accepted", timestamp: "2026-10-01T00:00:00.000Z", jobId: "image-job", messageId: 200, text: "image", images: [{ fileId: "telegram-file", mimeType: "image/jpeg", fileSize: 20 }] };
	const attachment = { sha256: "f".repeat(64), size: 20, mimeType: "image/jpeg" as const, path: `messages/_attachments/${"f".repeat(64)}.jpg`, source: "live" as const, direction: "in" as const };
	const capture: Extract<JournalRecord, { type: "media_captured" }> = { type: "media_captured", schemaVersion: 1, mediaId: `in:image-job:0:${attachment.sha256}`, jobId: "image-job", direction: "in", attachment, telegram: { updateId: 20, messageId: 200, fileId: "telegram-file" }, timestamp: "2026-10-01T00:00:00.500Z" };
	validateMediaLifecycle([update, capture]);
	assert.throws(() => validateMediaLifecycle([update, { ...capture, attachment: { ...attachment, source: "telegram-desktop-import" } }]), /capture lifecycle is invalid/);
	assert.throws(() => validateMediaLifecycle([update, { ...capture, telegram: { ...capture.telegram, updateId: 21 } }]), /capture linkage is invalid/);
	assert.throws(() => validateMediaLifecycle([update, { ...capture, telegram: { ...capture.telegram, messageId: 201 } }]), /capture linkage is invalid/);
	assert.throws(() => validateMediaLifecycle([update, { ...capture, telegram: { ...capture.telegram, fileId: "other-file" } }]), /capture linkage is invalid/);
	assert.throws(() => validateMediaLifecycle([update, { ...capture, mediaId: `in:image-job:1:${attachment.sha256}` }]), /capture linkage is invalid/);
	assert.throws(() => validateMediaLifecycle([update, capture, { ...capture, mediaId: `in:image-job:0:${"a".repeat(64)}`, attachment: { ...attachment, sha256: "a".repeat(64), path: `messages/_attachments/${"a".repeat(64)}.jpg` } }]), /capture linkage is invalid/);
});

test("cursor advances only after each earlier returned update append succeeds", async () => {
	class FailingJournal extends MemoryJournal {
		attempt = 0;
		override async append(record: JournalRecord): Promise<void> {
			this.attempt += 1;
			if (this.attempt === 2) throw new Error("mock fsync failure");
			await super.append(record);
		}
	}
	const journal = new FailingJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await assert.rejects(() => bridge.ingestBatch([textUpdate(21, "one"), textUpdate(25, "two")]), /fsync/);
	assert.equal(recover(journal.records).cursor, 21);
	assert.equal(journal.records.length, 1);
});

test("JSONL recovery truncates an incomplete tail and rejects malformed interior state", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "telegram-owner-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.jsonl");
	const valid = JSON.stringify(updateRecord("a", 1));
	await writeFile(path, `${valid}\n{"type":"update"`, { mode: 0o600 });
	const journal = new JsonlJournal(path);
	assert.equal((await journal.load()).length, 1);
	assert.equal((await readFile(path, "utf8")), `${valid}\n`);

	await writeFile(path, `${valid}\nnot-json\n${valid}\n`);
	await assert.rejects(() => journal.load(), StateCorruptionError);
});

test("idle dispatch serializes a message received while Pi is busy and splits the final reply", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(1, "first"), textUpdate(2, "second")]);
	const sentToPi: string[] = [];
	const first = await bridge.dispatchNext("session-a", (text) => sentToPi.push(text));
	assert.ok(first);
	assert.equal(await bridge.dispatchNext("session-a", (text) => sentToPi.push(text)), undefined);
	assert.equal(bridge.observeInput("extension", sentToPi[0]!), "continue");
	assert.equal(await bridge.beforeAgentStart(sentToPi[0]!, "session-a"), true);
	assert.equal(await bridge.beforeAgentStart(sentToPi[0]!, "session-a"), false);
	bridge.captureAgentEnd(`${"x".repeat(3_900)}\n\n${"y".repeat(300)}`);
	const telegram: Array<{ text: string; replyTo?: number }> = [];
	assert.equal(
		await bridge.settle(async (text, replyTo) => {
			telegram.push({ text, replyTo });
			return String(telegram.length);
		}),
		true,
	);
	assert.equal(telegram.length, 2);
	assert.equal(telegram[0]?.replyTo, first.messageId);
	assert.ok(telegram.every(({ text }) => text.length <= 4_000));
	assert.ok(await bridge.dispatchNext("session-a", (text) => sentToPi.push(text)));
	assert.equal(sentToPi.length, 2);
});

test("reload shutdown interrupts an active remote job and is idempotent", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(3, "work")]);
	let prompt = "";
	await bridge.dispatchNext("session-r", (text) => (prompt = text));
	bridge.observeInput("extension", prompt);
	await bridge.beforeAgentStart(prompt, "session-r");
	await bridge.shutdown("reload");
	await bridge.shutdown("reload");
	assert.equal(journal.records.filter((record) => record.type === "interrupted").length, 1);
	assert.equal(bridge.status, "stopped");
});

test("another extension message bypasses input isolation but cannot confirm or route the Telegram job", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(4, "remote")]);
	let ownPrompt = "";
	await bridge.dispatchNext("session-x", (text) => (ownPrompt = text));
	assert.equal(bridge.observeInput("extension", "message from another extension"), "continue");
	assert.equal(await bridge.beforeAgentStart("message from another extension", "session-x"), false);
	bridge.captureAgentEnd("must stay local");
	let replies = 0;
	assert.equal(await bridge.settle(async () => String(++replies)), false);
	assert.equal(replies, 0);
	assert.equal(bridge.observeInput("interactive", "local steer"), "handled");
	assert.ok(ownPrompt.includes("telegram-job:"));
});

test("asynchronous sendUserMessage rejection stays unconfirmed with no false completion or reply", async () => {
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(5, "reject me")]);
	const hostErrors: string[] = [];
	await bridge.dispatchNext("session-e", () => {
		void Promise.reject(new Error("mock async rejection")).catch((error: Error) => hostErrors.push(error.message));
	});
	await Promise.resolve();
	assert.deepEqual(hostErrors, ["mock async rejection"]);
	assert.equal(bridge.status, "dispatch-unconfirmed");
	bridge.captureAgentEnd("wrong response");
	let replies = 0;
	assert.equal(await bridge.settle(async () => String(++replies)), false);
	assert.equal(replies, 0);
	assert.equal(journal.records.some((record) => record.type === "reply_ready"), false);
	await bridge.shutdown("reload");
	assert.equal(recover(journal.records).queued.length, 0);
});

test("restart classification resumes only undispatched work and retries ready replies", async () => {
	const records: JournalRecord[] = [
		updateRecord("queued", 1),
		updateRecord("requested", 2),
		{ type: "dispatch_requested", jobId: "requested", sessionId: "old" },
		updateRecord("dispatched", 3),
		{ type: "dispatch_requested", jobId: "dispatched", sessionId: "old" },
		{ type: "dispatched", jobId: "dispatched", sessionId: "old" },
		updateRecord("ready", 4),
		{ type: "dispatch_requested", jobId: "ready", sessionId: "old" },
		{ type: "dispatched", jobId: "ready", sessionId: "old" },
		{ type: "reply_ready", jobId: "ready", text: "recover this" },
	];
	const state = recover(records);
	assert.deepEqual(state.queued.map((job) => job.jobId), ["queued"]);
	assert.deepEqual(state.uncertain.map((job) => job.jobId), ["requested", "dispatched"]);
	assert.deepEqual(state.repliesToRetry.map((job) => job.jobId), ["ready"]);

	const journal = new MemoryJournal(records);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const retried: string[] = [];
	assert.equal(await bridge.retryReadyReplies(async (text) => (retried.push(text), "telegram-1")), 1);
	assert.deepEqual(retried, ["recover this"]);
	assert.equal(recover(journal.records).repliesToRetry.length, 0);
});

test("stale reply anchors retry unanchored and settle both plain and formatted replies", async () => {
	for (const formattedDelivery of [false, true]) {
		const jobId = formattedDelivery ? "formatted-stale" : "plain-stale";
		const journal = new MemoryJournal([
			updateRecord(jobId, formattedDelivery ? 41 : 40),
			{ type: "reply_ready", jobId, text: "**recover this**" },
		]);
		const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery, inboundQuietWindowMs: 0 });
		await bridge.initialize();
		const calls: Array<{ replyTo?: number; format?: "HTML" | "plain" }> = [];
		await bridge.retryReadyReplies(async (_text, replyTo, format) => {
			calls.push({ replyTo, format });
			if (replyTo !== undefined) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
			return formattedDelivery ? "411" : "401";
		});
		assert.deepEqual(calls.map((call) => call.replyTo), [formattedDelivery ? 410 : 400, undefined]);
		assert.equal(calls[0]?.format, formattedDelivery ? "HTML" : undefined);
		assert.equal(calls[1]?.format, formattedDelivery ? "HTML" : undefined);
		assert.equal(journal.records.filter((record) => record.type === "reply_anchor_rejected").length, 1);
		assert.equal(journal.records.filter((record) => record.type === "reply_sent").length, 1);
		assert.equal(bridge.pendingReplyCount, 0);
	}
});

test("stale reply recovery unblocks newer queued work after restart", async () => {
	const journal = new MemoryJournal([
		updateRecord("stale", 50),
		{ type: "reply_ready", jobId: "stale", text: "old reply" },
		updateRecord("newer", 51),
	]);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const order: string[] = [];
	await bridge.retryReadyReplies(async (_text, replyTo) => {
		order.push(replyTo === undefined ? "reply-unanchored" : "reply-anchored");
		if (replyTo !== undefined) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
		return "501";
	});
	const dispatched = await bridge.dispatchNext("new-session", (text) => order.push(`dispatch:${text}`));
	assert.equal(dispatched?.jobId, "newer");
	assert.deepEqual(order, ["reply-anchored", "reply-unanchored", "dispatch:[telegram-job:newer]\nmessage newer"]);
	assert.equal(bridge.pendingReplyCount, 0);
	assert.equal(bridge.queueDepth, 0);
	assert.equal(journal.records.filter((record) => record.type === "reply_ready" && record.jobId === "stale").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent" && record.jobId === "stale").length, 1);
});

test("durable stale-anchor rejection resumes unanchored after a crash before receipt", async () => {
	const journal = new MemoryJournal([
		updateRecord("anchor-crash", 55),
		{ type: "reply_ready", jobId: "anchor-crash", text: "recover after crash" },
	]);
	const first = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await first.initialize();
	await assert.rejects(() => first.retryReadyReplies(async (_text, replyTo) => {
		if (replyTo !== undefined) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
		throw new Error("crash before unanchored receipt");
	}), /crash before unanchored receipt/);
	assert.equal(journal.records.filter((record) => record.type === "reply_anchor_rejected").length, 1);
	assert.equal(journal.records.some((record) => record.type === "reply_sent"), false);

	const resumed = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await resumed.initialize();
	const replyTargets: Array<number | undefined> = [];
	await resumed.retryReadyReplies(async (_text, replyTo) => (replyTargets.push(replyTo), "551"));
	assert.deepEqual(replyTargets, [undefined]);
	assert.equal(journal.records.filter((record) => record.type === "reply_anchor_rejected").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_sent").length, 1);
	assert.equal(resumed.pendingReplyCount, 0);
});

test("HTML parse and stale-anchor fallbacks commute without restoring the obsolete anchor", async () => {
	for (const anchorFirst of [true, false]) {
		const jobId = anchorFirst ? "anchor-first" : "parse-first";
		const journal = new MemoryJournal([
			updateRecord(jobId, anchorFirst ? 56 : 57),
			{ type: "reply_ready", jobId, text: "**formatted**" },
		]);
		const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
		await bridge.initialize();
		const calls: Array<{ replyTo?: number; format?: "HTML" | "plain" }> = [];
		await bridge.retryReadyReplies(async (_text, replyTo, format) => {
			calls.push({ replyTo, format });
			if (anchorFirst) {
				if (calls.length === 1) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
				if (calls.length === 2) throw Object.assign(new Error("bad HTML"), { code: "TELEGRAM_PARSE_REJECTED" });
			} else {
				if (calls.length === 1) throw Object.assign(new Error("bad HTML"), { code: "TELEGRAM_PARSE_REJECTED" });
				if (calls.length === 2) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
			}
			return anchorFirst ? "561" : "571";
		});
		assert.deepEqual(calls.map((call) => call.format), ["HTML", anchorFirst ? "HTML" : "plain", "plain"]);
		assert.deepEqual(calls.map((call) => call.replyTo), anchorFirst ? [560, undefined, undefined] : [570, 570, undefined]);
		assert.equal(journal.records.filter((record) => record.type === "reply_anchor_rejected").length, 1);
		assert.equal(journal.records.filter((record) => record.type === "reply_chunk_rejected").length, 1);
		assert.equal(bridge.pendingReplyCount, 0);
	}
});

test("formatted stale-anchor receipt resumes terminal settlement without resending", async () => {
	const firstJournal = new MemoryJournal([
		updateRecord("receipt", 60),
		{ type: "reply_ready", jobId: "receipt", text: "**durable**" },
	]);
	const first = new TelegramOwnerBridge(firstJournal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await first.initialize();
	await first.retryReadyReplies(async (_text, replyTo) => {
		if (replyTo !== undefined) throw Object.assign(new Error("stale anchor"), { code: "TELEGRAM_REPLY_ANCHOR_REJECTED" });
		return "601";
	});
	const crashBoundary = firstJournal.records.filter((record) => record.type !== "reply_sent");
	const resumedJournal = new MemoryJournal(crashBoundary);
	const resumed = new TelegramOwnerBridge(resumedJournal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await resumed.initialize();
	let sends = 0;
	await resumed.retryReadyReplies(async () => (sends += 1, "duplicate"));
	assert.equal(sends, 0);
	assert.equal(resumedJournal.records.filter((record) => record.type === "reply_anchor_rejected").length, 1);
	assert.equal(resumedJournal.records.filter((record) => record.type === "reply_chunk_sent").length, 1);
	assert.equal(resumedJournal.records.filter((record) => record.type === "reply_sent").length, 1);
	assert.equal(resumed.pendingReplyCount, 0);
});

test("extension lifecycle stops the mock source and blocks session replacement during a remote job", async () => {
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, unknown>();
	let injectedPrompt = "";
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerTool() {},
		sendUserMessage(text: string) {
			injectedPrompt = text;
		},
	} as unknown as ExtensionAPI;
	let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined;
	let stops = 0;
	let typingCalls = 0;
	let typingAborts = 0;
	const journal = new MemoryJournal();
	createTelegramOwnerExtension({
		dependencies: {
			journal,
			ownerUserId: OWNER,
			privateChatId: CHAT,
			source: {
				async start(handler) {
					onBatch = handler;
					return async () => {
						stops += 1;
					};
				},
			},
			async sendReply() {
				return "reply";
			},
			async sendTyping(signal) {
				typingCalls += 1;
				await new Promise<void>((resolve) => {
					const aborted = () => {
						typingAborts += 1;
						resolve();
					};
					if (signal.aborted) aborted();
					else signal.addEventListener("abort", aborted, { once: true });
				});
			},
		},
	})(pi);
	const statuses: unknown[] = [];
	const ctx = {
		isIdle: () => true,
		sessionManager: { getSessionId: () => "session-lifecycle" },
		ui: {
			setStatus: (...args: unknown[]) => statuses.push(args),
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([textUpdate(8, "active")]);
	assert.ok(injectedPrompt.includes("telegram-job:"));
	await emit("input", { type: "input", source: "extension", text: injectedPrompt });
	await emit("before_agent_start", { type: "before_agent_start", prompt: injectedPrompt });
	assert.equal(typingCalls, 2);
	assert.deepEqual(await emit("session_before_switch", { type: "session_before_switch", reason: "new" }), {
		cancel: true,
	});
	await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
	assert.equal(stops, 1);
	assert.equal(typingAborts, 2);
	assert.equal(journal.records.some((record) => record.type === "interrupted"), true);
	assert.equal(commands.has("telegram-status"), true);
});

test("quiet timer durably seals once during a busy turn and idle settlement dispatches later", async () => {
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>(); let onBatch: ((updates: TelegramUpdate[]) => Promise<number | undefined>) | undefined; let injected = ""; let idle = false;
	const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, registerTool() {}, sendUserMessage(text: string) { injected = text; } } as unknown as ExtensionAPI;
	const journal = new MemoryJournal();
	createTelegramOwnerExtension({ dependencies: { journal, ownerUserId: OWNER, privateChatId: CHAT, inboundQuietWindowMs: 100, source: { async start(handler) { onBatch = handler; return async () => undefined; } }, async sendReply() { return "1"; } } })(pi);
	const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => "session-busy" }, ui: { setStatus: () => undefined, notify: () => undefined } } as unknown as ExtensionContext;
	const emit = async (name: string, event: object) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	await emit("session_start", { type: "session_start", reason: "startup" });
	await onBatch?.([textUpdate(50, "wait for idle")]);
	await new Promise((resolve) => setTimeout(resolve, 140));
	const batches = journal.records.filter((record) => record.type === "inbound_batch");
	assert.equal(batches.at(-1)?.state, "sealed");
	assert.equal(batches.length, 2);
	assert.equal(journal.records.some((record) => record.type === "dispatch_requested"), false);
	const recordCount = journal.records.length;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(journal.records.length, recordCount, "expired busy timer must not spin or append repeatedly");
	idle = true;
	await emit("agent_settled", { type: "agent_settled" });
	assert.match(injected, /^\[telegram-batch:[0-9a-f-]{36}\]\nwait for idle$/);
	assert.equal(journal.records.filter((record) => record.type === "inbound_batch").at(-1)?.state, "dispatching");
	await emit("session_shutdown", { type: "session_shutdown", reason: "test" });
});

test("explicit plain delivery preserves exact legacy journal behavior", async () => {
	const records: JournalRecord[] = [updateRecord("plain-opt-out", 39), { type: "reply_ready", jobId: "plain-opt-out", text: "**literal**" }];
	const journal = new MemoryJournal(records);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: false, inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const calls: Array<{ text: string; format?: "HTML" | "plain" }> = [];
	await bridge.retryReadyReplies(async (text, _replyTo, format) => (calls.push({ text, format }), "390"));
	assert.deepEqual(calls, [{ text: "**literal**", format: undefined }]);
	assert.equal(journal.records.some((record) => record.type === "reply_plan"), false);
	assert.deepEqual(journal.records.at(-1), { type: "reply_sent", jobId: "plain-opt-out", messageId: "390" });
});

test("durable formatted reply plans record every chunk and recover without resending receipts", async () => {
	const records: JournalRecord[] = [
		updateRecord("formatted", 40),
		{ type: "dispatch_requested", jobId: "formatted", sessionId: "session-format" },
		{ type: "dispatched", jobId: "formatted", sessionId: "session-format" },
		{ type: "reply_ready", jobId: "formatted", text: "**bold**" },
	];
	const journal = new MemoryJournal(records);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const calls: Array<{ text: string; format?: "HTML" | "plain" }> = [];
	await bridge.retryReadyReplies(async (text, _replyTo, format) => {
		calls.push({ text, format });
		return String(100 + calls.length);
	});
	assert.deepEqual(calls, [{ text: "<b>bold</b>", format: "HTML" }]);
	assert.equal(journal.records.filter((record) => record.type === "reply_plan").length, 1);
	assert.equal(journal.records.filter((record) => record.type === "reply_chunk_sent").length, 1);
	assert.deepEqual(journal.records.find((record) => record.type === "reply_sent"), {
		type: "reply_sent",
		jobId: "formatted",
		messageIds: ["101"],
		timestamp: (journal.records.at(-1) as { timestamp: string }).timestamp,
	});

	const replay = new TelegramOwnerBridge(new MemoryJournal(journal.records.filter((record) => record.type !== "reply_sent")), OWNER, CHAT);
	await replay.initialize();
	let resent = 0;
	await replay.retryReadyReplies(async () => String(++resent));
	assert.equal(resent, 0);
});

test("formatted multi-chunk recovery resumes after the last durable receipt without resending", async () => {
	const text = `**${"word ".repeat(1_000)}**`;
	const journal = new MemoryJournal([updateRecord("multi", 45), { type: "reply_ready", jobId: "multi", text }]);
	const first = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await first.initialize();
	let attempts = 0;
	await assert.rejects(() => first.retryReadyReplies(async () => {
		attempts += 1;
		if (attempts === 1) return "451";
		throw new Error("synthetic transport interruption");
	}), /transport interruption/);
	const plan = journal.records.find((record): record is Extract<JournalRecord, { type: "reply_plan" }> => record.type === "reply_plan");
	assert.ok(plan && plan.chunks.length > 1);
	assert.deepEqual(journal.records.filter((record) => record.type === "reply_chunk_sent").map((record) => record.index), [0]);

	const resumed = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await resumed.initialize();
	const resumedPayloads: string[] = [];
	await resumed.retryReadyReplies(async (payload) => {
		resumedPayloads.push(payload);
		return String(452 + resumedPayloads.length);
	});
	assert.deepEqual(resumedPayloads, plan.chunks.slice(1).map((chunk) => chunk.payload));
	assert.deepEqual(journal.records.filter((record) => record.type === "reply_chunk_sent").map((record) => record.index), plan.chunks.map((chunk) => chunk.index));
	const terminal = journal.records.find((record): record is Extract<JournalRecord, { type: "reply_sent" }> => record.type === "reply_sent");
	assert.deepEqual(terminal && "messageIds" in terminal ? terminal.messageIds : undefined, ["451", ...resumedPayloads.map((_payload, index) => String(453 + index))]);
});

test("unclassified formatted transport failures never downgrade to plain text", async () => {
	const journal = new MemoryJournal([updateRecord("no-downgrade", 46), { type: "reply_ready", jobId: "no-downgrade", text: "**bold**" }]);
	const first = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await first.initialize();
	await assert.rejects(() => first.retryReadyReplies(async () => {
		throw new Error("synthetic network failure");
	}), /network failure/);
	assert.equal(journal.records.some((record) => record.type === "reply_chunk_rejected"), false);

	const resumed = new TelegramOwnerBridge(journal, OWNER, CHAT, { inboundQuietWindowMs: 0 });
	await resumed.initialize();
	const calls: Array<{ payload: string; format?: "HTML" | "plain" }> = [];
	await resumed.retryReadyReplies(async (payload, _replyTo, format) => (calls.push({ payload, format }), "461"));
	assert.deepEqual(calls, [{ payload: "<b>bold</b>", format: "HTML" }]);
});

test("classified HTML rejection journals fallback without rerunning reply generation", async () => {
	const records: JournalRecord[] = [
		updateRecord("fallback", 41),
		{ type: "dispatch_requested", jobId: "fallback", sessionId: "session-format" },
		{ type: "dispatched", jobId: "fallback", sessionId: "session-format" },
		{ type: "reply_ready", jobId: "fallback", text: "**bold**" },
	];
	const journal = new MemoryJournal(records);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await bridge.initialize();
	const formats: string[] = [];
	await bridge.retryReadyReplies(async (_text, _replyTo, format) => {
		formats.push(format ?? "plain");
		if (format === "HTML") throw Object.assign(new Error("synthetic parse rejection"), { code: "TELEGRAM_PARSE_REJECTED" });
		return "501";
	});
	assert.deepEqual(formats, ["HTML", "plain"]);
	assert.equal(journal.records.some((record) => record.type === "reply_chunk_rejected"), true);
	assert.equal(journal.records.some((record) => record.type === "reply_chunk_sent" && record.format === "plain"), true);
});

test("durable HTML rejection resumes directly with plain fallback", async () => {
	const records: JournalRecord[] = [
		updateRecord("rejected-restart", 43),
		{ type: "reply_ready", jobId: "rejected-restart", text: "**bold**" },
	];
	const firstJournal = new MemoryJournal(records);
	const first = new TelegramOwnerBridge(firstJournal, OWNER, CHAT, { formattedDelivery: true, inboundQuietWindowMs: 0 });
	await first.initialize();
	await assert.rejects(() => first.retryReadyReplies(async (_text, _replyTo, format) => {
		if (format === "HTML") throw Object.assign(new Error("reject"), { code: "TELEGRAM_PARSE_REJECTED" });
		throw new Error("synthetic crash before fallback receipt");
	}), /synthetic crash/);
	assert.equal(firstJournal.records.some((record) => record.type === "reply_chunk_rejected"), true);

	const resumed = new TelegramOwnerBridge(firstJournal, OWNER, CHAT);
	await resumed.initialize();
	const formats: string[] = [];
	await resumed.retryReadyReplies(async (_text, _replyTo, format) => (formats.push(format ?? "none"), "430"));
	assert.deepEqual(formats, ["plain"]);
});

test("recovered plans reject duplicate indices, corrupt hashes, and out-of-range receipts", async () => {
	const base: JournalRecord[] = [updateRecord("corrupt-plan", 44), { type: "reply_ready", jobId: "corrupt-plan", text: "ok" }];
	const invalidPlans: JournalRecord[][] = [
		[...base, { type: "reply_plan", jobId: "corrupt-plan", renderer: "telegram-html-v1", rawSha256: "0".repeat(64), chunks: [] }],
		[...base, { type: "reply_plan", jobId: "corrupt-plan", renderer: "telegram-html-v1", rawSha256: "0".repeat(64), chunks: [{ index: 1, format: "plain", payload: "ok", plainFallback: "ok", payloadSha256: "0".repeat(64) }] }],
	];
	for (const records of invalidPlans) {
		const bridge = new TelegramOwnerBridge(new MemoryJournal(records), OWNER, CHAT);
		await bridge.initialize();
		await assert.rejects(() => bridge.retryReadyReplies(async () => "440"), StateCorruptionError);
	}
});

test("legacy reply_sent records remain terminal during recovery", () => {
	const records: JournalRecord[] = [updateRecord("legacy", 42), { type: "reply_ready", jobId: "legacy", text: "done" }, { type: "reply_sent", jobId: "legacy", messageId: "old-id" }];
	assert.equal(recover(records).repliesToRetry.length, 0);
});

test("legacy member terminals prevent aggregate batch replay", () => {
	const batch: Extract<JournalRecord, { type: "inbound_batch" }> = {
		type: "inbound_batch", schemaVersion: 1, batchId: "00000000-0000-4000-8000-000000000001", revision: 2, state: "sealed",
		openedAt: "2026-01-01T00:00:00.000Z", readyAt: "2026-01-01T00:00:00.500Z",
		memberJobIds: ["member-1", "member-2"], messageIds: [10, 20],
		segmentSha256: ["a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e", "3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3"],
		boundaries: [{ start: 0, end: 5 }, { start: 7, end: 11 }], text: "first\n\nlast", finalMessageId: 20,
	};
	const base: JournalRecord[] = [
		updateRecord("member-1", 1), updateRecord("member-2", 2),
		{ ...batch, revision: 1, state: "open" }, batch,
	];
	const completed = recover([...base,
		{ type: "reply_sent", jobId: "member-1", messageId: "legacy-reply" },
		{ type: "reply_sent", jobId: "member-2", messageId: "legacy-reply" },
	]);
	assert.equal(completed.queued.length, 0);
	assert.equal(completed.repliesToRetry.length, 0);
	assert.throws(() => recover([...base, { type: "reply_sent", jobId: "member-1", messageId: "legacy-reply" }]), /partially terminal legacy members/);
});

test("same-date inbound batching is durable, restart-safe, and replies to the final member", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const first = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await first.initialize();
	await first.ingestBatch([textUpdate(1, "first", OWNER, CHAT, 100), textUpdate(2, "second", OWNER, CHAT, 100)]);
	assert.equal(first.queueDepth, 0);
	assert.equal(first.nextBatchReadyDelayMs, 4_000);

	now = 1_200;
	const restarted = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await restarted.initialize();
	assert.equal(restarted.nextBatchReadyDelayMs, 3_800);
	now = 5_000;
	let injected = "";
	const job = await restarted.dispatchNext("session", (text) => { injected = text; });
	assert.ok(job?.batchId);
	assert.equal(job.text, "first\n\nsecond");
	assert.deepEqual(job.messageIds, [10, 20]);
	assert.equal(job.messageId, 20);
	assert.match(injected, /^\[telegram-batch:[0-9a-f-]{36}\]\nfirst\n\nsecond$/);
	const snapshots = journal.records.filter((record) => record.type === "inbound_batch");
	assert.equal(snapshots.at(-1)?.state, "dispatching");
	assert.deepEqual(snapshots.at(-1)?.boundaries, [{ start: 0, end: 5 }, { start: 7, end: 13 }]);
});

test("same-date 3511 plus 1960 unit split coalesces across restart after the observed 2106ms gap", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const first = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await first.initialize();
	const left = "x".repeat(3_511); const right = "y".repeat(1_960);
	await first.ingestBatch([textUpdate(1, left, OWNER, CHAT, 100)]);
	assert.equal(first.nextBatchReadyDelayMs, 4_000);

	now = 2_500;
	const restarted = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await restarted.initialize();
	now = 3_106;
	await restarted.ingestBatch([textUpdate(2, right, OWNER, CHAT, 100)]);
	assert.equal(restarted.nextBatchReadyDelayMs, 4_000);
	now = 7_105;
	assert.equal(await restarted.dispatchNext("session", () => undefined), undefined);
	now = 7_106;
	const job = await restarted.dispatchNext("session", () => undefined);
	assert.equal(job?.text, `${left}\n\n${right}`);
	assert.deepEqual(job?.messageIds, [10, 20]);
});

test("same-date arrival at 3999ms remains inside the quiet boundary", async () => {
	let now = 1_000; const journal = new MemoryJournal(); const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now }); await bridge.initialize();
	await bridge.ingestBatch([textUpdate(1, "first", OWNER, CHAT, 100)]);
	now = 4_999;
	await bridge.ingestBatch([textUpdate(2, "inside", OWNER, CHAT, 100)]);
	assert.equal(bridge.nextBatchReadyDelayMs, 4_000);
	now = 8_999;
	assert.equal((await bridge.dispatchNext("session", () => undefined))?.text, "first\n\ninside");
});

test("same-date arrivals at expiry remain separate and duplicate updates do not extend the timer", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await bridge.initialize();
	const first = textUpdate(1, "first", OWNER, CHAT, 100);
	await bridge.ingestBatch([first]);
	now = 3_000;
	await bridge.ingestBatch([first]);
	assert.equal(bridge.nextBatchReadyDelayMs, 2_000);
	now = 5_000;
	await bridge.ingestBatch([textUpdate(2, "after expiry", OWNER, CHAT, 100)]);
	const dispatched = await bridge.dispatchNext("session", () => undefined);
	assert.equal(dispatched?.text, "first");
	assert.equal(bridge.nextBatchReadyDelayMs, 4_000);
});

test("different-date arrival immediately closes the prior batch and queues a new batch in order", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(1, "first", OWNER, CHAT, 100)]);
	now = 3_100;
	await bridge.ingestBatch([textUpdate(2, "separate", OWNER, CHAT, 102)]);
	const first = await bridge.dispatchNext("session", () => undefined);
	assert.equal(first?.text, "first");
	assert.deepEqual(first?.messageIds, [10]);
	assert.equal(bridge.nextBatchReadyDelayMs, 4_000);
	const created = journal.records.filter((record) => record.type === "inbound_batch" && record.revision === 1);
	assert.deepEqual(created.map((record) => record.text), ["first", "separate"]);
});

test("quiet scheduling ignores historical open revisions after a batch is sealed", async () => {
	const open: Extract<JournalRecord, { type: "inbound_batch" }> = { type: "inbound_batch", schemaVersion: 1, batchId: "00000000-0000-4000-8000-000000000001", revision: 1, state: "open", openedAt: "2026-01-01T00:00:00.000Z", readyAt: "2026-01-01T00:00:00.500Z", memberJobIds: ["member-1"], messageIds: [10], segmentSha256: ["a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"], boundaries: [{ start: 0, end: 5 }], text: "first", finalMessageId: 10 };
	const bridge = new TelegramOwnerBridge(new MemoryJournal([open, { ...open, revision: 2, state: "sealed" }]), OWNER, CHAT, { now: () => Date.parse("2026-01-01T00:00:01.000Z") });
	await bridge.initialize();
	assert.equal(bridge.nextBatchReadyDelayMs, undefined);
});

test("dispatch closes the exact queued batch while a newer batch remains open", async () => {
	const oldId = "00000000-0000-4000-8000-000000000001"; const newId = "00000000-0000-4000-8000-000000000002";
	const oldOpen: Extract<JournalRecord, { type: "inbound_batch" }> = { type: "inbound_batch", schemaVersion: 1, batchId: oldId, revision: 1, state: "open", openedAt: "2026-01-01T00:00:00.000Z", readyAt: "2026-01-01T00:00:00.500Z", memberJobIds: ["member-old"], messageIds: [10], segmentSha256: ["a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"], boundaries: [{ start: 0, end: 5 }], text: "first", finalMessageId: 10 };
	const newOpen: Extract<JournalRecord, { type: "inbound_batch" }> = { ...oldOpen, batchId: newId, openedAt: "2026-01-01T00:00:01.000Z", readyAt: "2026-01-01T00:00:01.500Z", memberJobIds: ["member-new"], messageIds: [20], segmentSha256: ["3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3"], boundaries: [{ start: 0, end: 4 }], text: "last", finalMessageId: 20 };
	const journal = new MemoryJournal([updateRecord("member-old", 1), oldOpen, { ...oldOpen, revision: 2, state: "sealed" }, updateRecord("member-new", 2), newOpen]);
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => Date.parse("2026-01-01T00:00:01.100Z") });
	await bridge.initialize();
	const job = await bridge.dispatchNext("session", () => undefined);
	assert.equal(job?.batchId, oldId);
	assert.equal(journal.records.filter((record) => record.type === "inbound_batch" && record.batchId === oldId).at(-1)?.state, "dispatching");
	assert.equal(journal.records.filter((record) => record.type === "inbound_batch" && record.batchId === newId).at(-1)?.state, "open");
});

test("batch recovery rejects identity mutation and illegal state transitions", () => {
	const base: Extract<JournalRecord, { type: "inbound_batch" }> = { type: "inbound_batch", schemaVersion: 1, batchId: "00000000-0000-4000-8000-000000000001", revision: 1, state: "open", openedAt: "2026-01-01T00:00:00.000Z", readyAt: "2026-01-01T00:00:00.500Z", memberJobIds: ["member-1"], messageIds: [10], segmentSha256: ["a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"], boundaries: [{ start: 0, end: 5 }], text: "first", finalMessageId: 10 };
	assert.throws(() => recover([base, { ...base, revision: 2, state: "sealed", text: "other" }]), StateCorruptionError);
	assert.throws(() => recover([base, { ...base, revision: 2, state: "dispatching" }, { ...base, revision: 3, state: "sealed" }]), StateCorruptionError);
});

test("commands and photos never join inbound text batches", async () => {
	let now = 1_000;
	const journal = new MemoryJournal();
	const bridge = new TelegramOwnerBridge(journal, OWNER, CHAT, { now: () => now });
	await bridge.initialize();
	await bridge.ingestBatch([textUpdate(1, "first"), textUpdate(2, "/help"), {
		update_id: 3,
		message: { message_id: 30, caption: "caption", photo: [{ file_id: "photo" }], chat: { id: CHAT, type: "private" }, from: { id: OWNER } },
	}, textUpdate(4, "last")]);
	const batches = journal.records.filter((record) => record.type === "inbound_batch");
	assert.equal(new Set(batches.map((record) => record.batchId)).size, 2);
	assert.deepEqual(batches.filter((record) => record.revision === 1).map((record) => record.text), ["first", "last"]);
	assert.equal(recover(journal.records, now).pendingCommands.length, 1);
	assert.equal(recover(journal.records, now).queued.some((job) => job.images.length > 0), true);
});

test('activity recovery scopes same-numbered old group and new private notices to their actual chats',async()=>{
 const jobId='11111111-2222-4333-8444-555555555555';
 const journal=new MemoryJournal([{type:'work_item',schemaVersion:1,itemId:jobId,channel:'group',authority:'owner',sender:'fixture',text:'Group work.',reply:{kind:'group',chatId:-100,messageId:1},timestamp:'2026-10-29T00:00:00.000Z'},{type:'activity_started',jobId,messageId:'42'},{type:'activity_started',jobId,messageId:'42',destination:'private'},{type:'reply_sent',jobId,messageIds:['43'],timestamp:'2026-10-29T00:00:01.000Z'}]);
 let bridge=new TelegramOwnerBridge(journal,OWNER,CHAT);await bridge.initialize();
 assert.equal(bridge.openActivity(jobId,'private'),'42');assert.equal(bridge.openActivity(jobId,'group'),'42');
 assert.equal(bridge.finishedActivities().length,2);assert.equal(recover(journal.records).orphanedActivities.length,2);
 await bridge.recordActivityCleared(jobId,'42','private');
 bridge=new TelegramOwnerBridge(journal,OWNER,CHAT);await bridge.initialize();
 assert.equal(bridge.openActivity(jobId,'private'),undefined);assert.equal(bridge.openActivity(jobId,'group'),'42');assert.equal(bridge.finishedActivities().length,1);
 // A legacy unscoped clear still means the old reply-target chat.
 await bridge.recordActivityCleared(jobId,'42');assert.equal(bridge.finishedActivities().length,0);assert.equal(recover(journal.records).orphanedActivities.length,0);
});

test("plain-text splitter never exceeds its configured boundary", () => {
	assert.deepEqual(splitPlainText("short", 10), ["short"]);
	assert.ok(splitPlainText("a".repeat(31), 10).every((chunk) => chunk.length <= 10));
});
