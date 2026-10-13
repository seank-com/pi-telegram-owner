import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linuxBootIdentity, PollerLock, systemBootIdentity } from "../src/runtime.ts";

const id = "e4952ef4-69ce-4d82-85e2-803f29cb8304";
const bootIdPath = "/proc/sys/kernel/random/boot_id";

test("Linux boot identity uses the kernel UUID and boot epoch", () => {
	const paths: string[] = [];
	const boot = linuxBootIdentity((path) => {
		paths.push(path);
		return path === bootIdPath ? `${id}\n` : "cpu 1 2 3\nbtime 1700000000\nprocesses 12\n";
	});
	assert.deepEqual(paths, [bootIdPath, "/proc/stat"]);
	assert.deepEqual(boot, { id, startedAtMs: 1700000000000 });
});

test("Linux boot identity refuses missing, malformed and unreadable kernel evidence", () => {
	for (const [uuid, stat] of [
		["", "btime 1700000000\n"], ["not-a-uuid", "btime 1700000000\n"],
		[id, "cpu 1 2 3\n"], [id, "btime 0\n"], [id, "btime -1\n"],
		[id, "btime 1.5\n"], [id, "btime 9007199254740991\n"],
	]) {
		assert.equal(linuxBootIdentity((path) => path === bootIdPath ? uuid! : stat!), undefined);
	}
	for (const unavailable of [bootIdPath, "/proc/stat"]) {
		assert.equal(linuxBootIdentity((path) => {
			if (path === unavailable) throw new Error("unavailable");
			return `${id}\n`;
		}), undefined);
	}
});

test("native boot identity supports exclusive lock acquisition and release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "telegram-native-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const boot = systemBootIdentity();
	assert.ok(boot, "this host must expose a trustworthy boot identity");
	assert.deepEqual(systemBootIdentity(), boot);
	assert.ok(boot.startedAtMs > 0 && boot.startedAtMs <= Date.now());
	const path = join(root, "poller.lock");
	const lock = await PollerLock.acquire(path);
	try {
		assert.equal(JSON.parse(await readFile(path, "utf8")).bootId, boot.id);
		await assert.rejects(PollerLock.acquire(path), /held|cannot be proven dead/);
	} finally {
		await lock.release();
	}
	const replacement = await PollerLock.acquire(path);
	await replacement.release();
});
