import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { GROUP_MESSAGE_NOTE_SCHEMA, GroupJournal, groupNotePath, type GroupMessage } from "../src/group-journal.ts";

const GROUP = -1001234567890;
const boot = () => ({ id: "synthetic-boot", startedAtMs: 1 });

function journal(root: string): GroupJournal {
	return new GroupJournal(root, { bootIdentity: boot, pidState: (pid) => (pid === process.pid ? "alive" : "dead"), sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
}

function ownerMessage(messageId: number, text: string, extra: Partial<GroupMessage> = {}): GroupMessage {
	return { chatId: GROUP, messageId, senderId: 7, sender: "Owner", senderKind: "owner", date: 1_790_000_000 + messageId, text, entities: [], ...extra };
}

async function shared(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "group-journal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("a message is recorded once with a monthly note directly under the shared root", async (t) => {
	const root = await shared(t);
	const agentA = journal(root);
	const message = ownerMessage(10, "  Can anyone look at this? \n", { entities: [{ type: "bold", offset: 2, length: 3 }] });
	assert.equal((await agentA.recordMessage(message, "agent_a_bot")).outcome, "recorded");
	assert.equal((await journal(root).recordMessage({ ...message }, "agent_b_bot")).outcome, "duplicate", "another agent's identical observation is a no-op");
	assert.equal((await agentA.events()).length, 1);
	assert.equal(groupNotePath(message), join("2026", "09", "2026-09-21T141330Z-10.md"));
	const note = await readFile(join(root, groupNotePath(message)), "utf8");
	const frontmatter = parseYaml(/^---\n([\s\S]*?)---\n/.exec(note)![1]!) as Record<string, unknown>;
	assert.equal(frontmatter.schema, GROUP_MESSAGE_NOTE_SCHEMA);
	assert.deepEqual(frontmatter.telegramMessageIds, [10]);
	assert.ok(note.endsWith("\n\n  Can anyone look at this? \n\n"), "message text is kept untrimmed");
	assert.deepEqual((await readdir(root)).sort(), [".telegram-archive", "2026"]);
	assert.deepEqual((await agentA.message(GROUP, 10))?.entities, [{ type: "bold", offset: 2, length: 3 }]);
});

test("a conflicting observation is recorded as a conflict and never overwrites the message", async (t) => {
	const root = await shared(t);
	const store = journal(root);
	await store.recordMessage(ownerMessage(11, "original"), "agent_a_bot");
	const result = await store.recordMessage(ownerMessage(11, "different"), "agent_b_bot");
	assert.equal(result.outcome, "conflict");
	assert.equal((await store.message(GROUP, 11))?.text, "original");
	assert.deepEqual((await store.events()).map((event) => event.kind), ["message", "conflict"]);
});

test("concurrent writers serialize under the lock: one record and one claim winner", async (t) => {
	const root = await shared(t);
	const agents = [journal(root), journal(root), journal(root)];
	const message = ownerMessage(12, "unaddressed");
	const outcomes = await Promise.all(agents.map((agent, index) => agent.recordMessage(message, `agent_${index}`)));
	assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["duplicate", "duplicate", "recorded"]);
	const claims = await Promise.all(agents.map((agent, index) => agent.claim(GROUP, 12, `agent_${index}`)));
	assert.equal(claims.filter((claim) => claim.won).length, 1);
	assert.equal(new Set(claims.map((claim) => claim.agent)).size, 1, "every agent sees the same winner");
	assert.equal(await agents[0]!.claimFor(GROUP, 12), claims.find((claim) => claim.won)!.agent);
	const events = await agents[0]!.events();
	assert.deepEqual(events.map((event) => event.seq), [1, 2]);
});

test("a fragment left by a crashed writer is kept, terminated and skipped by readers", async (t) => {
	const root = await shared(t);
	const store = journal(root);
	await store.recordMessage(ownerMessage(13, "before crash"), "agent_a_bot");
	await appendFile(store.eventsPath, "{\"schema\":\"pi-telegram-owner/group-event/v1\",\"seq\":2,\"ki");
	assert.equal((await store.events()).length, 1);
	await store.recordMessage(ownerMessage(14, "after crash"), "agent_b_bot");
	const raw = await readFile(store.eventsPath, "utf8");
	assert.ok(raw.includes("\"seq\":2,\"ki\n"), "the fragment bytes are preserved");
	assert.deepEqual((await store.events()).map((event) => event.kind === "message" ? event.message.text : event.kind), ["before crash", "after crash"]);
});

test("a lock held by a dead process is reclaimed", async (t) => {
	const root = await shared(t);
	await mkdir(join(root, ".telegram-archive"), { recursive: true, mode: 0o700 });
	await writeFile(join(root, ".telegram-archive", "lock"), `${JSON.stringify({ pid: 999_999_999, nonce: "dead", bootId: "synthetic-boot" })}\n`, { mode: 0o600 });
	assert.deepEqual(await journal(root).claim(GROUP, 15, "agent_a_bot"), { agent: "agent_a_bot", won: true });
});

test("timeline reads in Telegram order and finds split posts by any part", async (t) => {
	const root = await shared(t);
	const store = journal(root);
	await store.recordMessage(ownerMessage(30, "third"), "a");
	await store.recordMessage(ownerMessage(10, "first"), "a");
	await store.recordMessage({ ...ownerMessage(20, "second, long"), partIds: [20, 21, 22], senderKind: "agent", sender: "Agent B", senderId: 200 }, "b");
	assert.deepEqual((await store.timeline({ chatId: GROUP, limit: 10 })).map((message) => message.text), ["first", "second, long", "third"]);
	assert.deepEqual((await store.timeline({ chatId: GROUP, limit: 1 })).map((message) => message.text), ["third"]);
	assert.deepEqual((await store.timeline({ chatId: GROUP, before: 30, limit: 10 })).map((message) => message.messageId), [10, 20]);
	assert.deepEqual((await store.timeline({ chatId: GROUP, after: 10, limit: 1 })).map((message) => message.messageId), [20]);
	assert.equal((await store.message(GROUP, 22))?.messageId, 20);
});

test("deleted notes are rebuilt from the event log", async (t) => {
	const root = await shared(t);
	const store = journal(root);
	const message = ownerMessage(40, "keep me", { media: { kind: "document", fileName: "report.json", mimeType: "application/json", size: 12 } });
	await store.recordMessage(message, "a");
	const path = join(root, groupNotePath(message));
	const original = await readFile(path, "utf8");
	assert.ok(original.includes("[document: report.json]"));
	await rm(join(root, "2026"), { recursive: true });
	assert.equal(await store.rebuildProjection(), 1);
	assert.equal(await readFile(path, "utf8"), original);
	assert.equal(await store.rebuildProjection(), 0);
});

test("separate processes share the journal without duplicate records or split claims", async (t) => {
	const root = await shared(t);
	const { spawn } = await import("node:child_process");
	const writer = new URL("./fixtures/group-writer.ts", import.meta.url).pathname;
	const runs = ["agent_a", "agent_b", "agent_c"].map((agent) => new Promise<number>((resolve, reject) => {
		const child = spawn(process.execPath, [writer, root, agent, "15"], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(stderr))));
	}));
	await Promise.all(runs);
	const events = await new GroupJournal(root).events();
	assert.equal(events.filter((event) => event.kind === "message").length, 15);
	assert.equal(events.filter((event) => event.kind === "claim").length, 15);
	assert.equal(events.filter((event) => event.kind === "conflict").length, 0);
	assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1), "sequence numbers are unique and contiguous");
});

test("the group timeline tool pages the shared journal and reports when no group is available", async (t) => {
	const root = await shared(t);
	const store = journal(root);
	for (const id of [1, 2, 3]) await store.recordMessage(ownerMessage(id, `m${id}`, id === 3 ? { replyToMessageId: 2 } : {}), "a");
	const { registerGroupTimelineTool } = await import("../src/group-tools.ts");
	let tool: any;
	let available = true;
	registerGroupTimelineTool({ registerTool(definition: unknown) { tool = definition; } } as any, () => (available ? { journal: store, chatId: GROUP } : undefined));
	const result = await tool.execute("call", { before: 3, limit: 5 });
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.count, 2);
	assert.deepEqual(body.messages.map((message: any) => message.text), ["m1", "m2"]);
	assert.equal(body.messages[0].sender, "Owner");
	const latest = JSON.parse((await tool.execute("call", {})).content[0].text);
	assert.equal(latest.messages.at(-1).replyToMessageId, 2);
	available = false;
	await assert.rejects(tool.execute("call", {}), /CAPABILITY_UNAVAILABLE/);
});
