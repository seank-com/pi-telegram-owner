import assert from "node:assert/strict";
import test from "node:test";
import { TelegramActivityMessage } from "../src/runtime.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(options: Partial<ConstructorParameters<typeof TelegramActivityMessage>[1]> = {}) {
	const sent: string[] = [], edits: string[] = [], failures: string[] = [];
	const message = new TelegramActivityMessage("age-job", {
		async send(text) { sent.push(text); return "42"; },
		async edit(_id, text) { edits.push(text); },
		async delete() {}, async onStarted() {}, async onCleared() {},
		onFailure(operation) { failures.push(operation); },
		...options,
	}, "Thinking (10%)");
	return { message, sent, edits, failures };
}

test("activity age starts at 30 seconds and its own edits or duplicate statuses do not reset it", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const f = fixture(); t.after(() => f.message.stopAndDelete());
	f.message.start(); await flush();
	assert.deepEqual(f.sent, ["Thinking (10%)"]);
	t.mock.timers.tick(29_999); await flush(); assert.deepEqual(f.edits, []);
	t.mock.timers.tick(1); await flush(); assert.equal(f.edits.at(-1), "Thinking (10%) [00:00:30]");
	f.message.update("Thinking (10%)");
	t.mock.timers.tick(30_000); await flush(); assert.equal(f.edits.at(-1), "Thinking (10%) [00:01:00]");
	t.mock.timers.tick(840_000); await flush(); assert.equal(f.edits.at(-1), "Thinking (10%) [00:15:00]");
});

test("a displayed step change removes the suffix and starts a fresh step clock", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const f = fixture({ prefix: "RE: synthetic request" }); t.after(() => f.message.stopAndDelete());
	f.message.start(); await flush();
	t.mock.timers.tick(30_000); await flush();
	assert.equal(f.edits.at(-1), "RE: synthetic request\nThinking (10%) [00:00:30]");
	f.message.update("Read: notes.md"); t.mock.timers.tick(1_000); await flush();
	assert.equal(f.edits.at(-1), "RE: synthetic request\nRead: notes.md");
	t.mock.timers.tick(29_999); await flush(); assert.equal(f.edits.at(-1), "RE: synthetic request\nRead: notes.md");
	t.mock.timers.tick(1); await flush(); assert.equal(f.edits.at(-1), "RE: synthetic request\nRead: notes.md [00:00:30]");
});

test("halt stops timer edits, annotation removes the suffix and elapsed hours do not wrap at a day", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const f = fixture(); t.after(() => f.message.stopAndDelete());
	f.message.start(); await flush(); t.mock.timers.tick(25 * 60 * 60 * 1_000); await flush();
	assert.equal(f.edits.at(-1), "Thinking (10%) [25:00:00]");
	await f.message.halt(); const count = f.edits.length;
	t.mock.timers.tick(60_000); await flush(); assert.equal(f.edits.length, count);
	await f.message.annotate("Reply delivery failed"); assert.equal(f.edits.at(-1), "Reply delivery failed");
});

test("a failed new status leaves the visible step aging without retrying that failed status", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const edits: string[] = []; let failedAttempts = 0;
	const f = fixture({ async edit(_id, text) {
		if (text === "Read: unavailable.md") { failedAttempts += 1; throw new Error("synthetic edit failure"); }
		edits.push(text);
	} });
	t.after(() => f.message.stopAndDelete()); f.message.start(); await flush();
	f.message.update("Read: unavailable.md"); t.mock.timers.tick(1_000); await flush();
	assert.equal(failedAttempts, 1);
	t.mock.timers.tick(29_000); await flush(); assert.equal(edits.at(-1), "Thinking (10%) [00:00:30]");
	t.mock.timers.tick(30_000); await flush(); assert.equal(edits.at(-1), "Thinking (10%) [00:01:00]");
	assert.equal(failedAttempts, 1, "age updates do not replay the failed tool status");
	f.message.update("Read: next.md"); t.mock.timers.tick(1_000); await flush();
	assert.equal(edits.at(-1), "Read: next.md");
	t.mock.timers.tick(30_000); await flush(); assert.equal(edits.at(-1), "Read: next.md [00:00:30]");
});

test("a slow initial send does not start the displayed-step clock before acceptance", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	let release!: (id: string) => void;
	const pending = new Promise<string>((resolve) => { release = resolve; });
	const f = fixture({ send: () => pending }); t.after(() => f.message.stopAndDelete());
	f.message.start(); t.mock.timers.tick(60_000); await flush(); assert.deepEqual(f.edits, []);
	release("42"); await flush(); t.mock.timers.tick(29_999); await flush(); assert.deepEqual(f.edits, []);
	t.mock.timers.tick(1); await flush(); assert.equal(f.edits.at(-1), "Thinking (10%) [00:00:30]");
});

test("timer edits use the existing coalescing worker and cannot overwrite a newer tool step", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const calls: string[] = [];
	const f = fixture({ async edit(_id, text) { calls.push(text); if (calls.length === 1) await held; } });
	t.after(async () => { release(); await f.message.stopAndDelete(); });
	f.message.start(); await flush(); t.mock.timers.tick(30_000); await flush();
	assert.deepEqual(calls, ["Thinking (10%) [00:00:30]"]);
	f.message.update("Read: latest.md"); t.mock.timers.tick(60_000); await flush(); assert.equal(calls.length, 1);
	release(); await flush(); t.mock.timers.tick(1_000); await flush(); assert.equal(calls.at(-1), "Read: latest.md");
	t.mock.timers.tick(30_000); await flush(); assert.equal(calls.at(-1), "Read: latest.md [00:00:30]");
});
