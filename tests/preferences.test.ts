import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProjectPreferences } from "../src/preferences.ts";

const choice = { provider: "fixture", model: "chosen", thinking: "off" };
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
	const root = await mkdtemp(join(tmpdir(), "save-project-preferences-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".pi"));
	return { root, path: join(root, ".pi/settings.json") };
}

test("save changes only this project's defaults and current model override, preserving unrelated fields and permissions", async t => {
	const f = await fixture(t);
	const original = { defaultProvider: "old", defaultModel: "old", defaultThinkingLevel: "medium", sessionDir: "sessions", enableAnalytics: false, custom: { retained: true }, modelThinkingLevels: { "fixture/chosen": "high", "other/model": "low" } };
	await writeFile(f.path, JSON.stringify(original)); await chmod(f.path, 0o640);
	const sibling = join(f.root, "sibling.json"), shared = join(f.root, "shared-profile.json");
	await writeFile(sibling, "sibling unchanged"); await writeFile(shared, "profile unchanged");
	assert.equal(await saveProjectPreferences(f.root, ".pi", choice), f.path);
	assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { ...original, defaultProvider: "fixture", defaultModel: "chosen", defaultThinkingLevel: "off", modelThinkingLevels: { "fixture/chosen": "off", "other/model": "low" } });
	assert.equal((await stat(f.path)).mode & 0o777, 0o640);
	assert.equal(await readFile(sibling, "utf8"), "sibling unchanged"); assert.equal(await readFile(shared, "utf8"), "profile unchanged");
	assert.deepEqual(await readdir(join(f.root, ".pi")), ["settings.json"]);
});

test("save creates missing project settings without a shared-profile dependency", async t => {
	const f = await fixture(t);
	await saveProjectPreferences(f.root, ".pi", choice);
	assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { defaultProvider: "fixture", defaultModel: "chosen", defaultThinkingLevel: "off", modelThinkingLevels: { "fixture/chosen": "off" } });
	await saveProjectPreferences(f.root, ".pi", { ...choice, thinking: "high" });
	assert.equal(JSON.parse(await readFile(f.path, "utf8")).defaultThinkingLevel, "high");
	assert.deepEqual(await readdir(join(f.root, ".pi")), ["settings.json"]);
});

for (const invalid of ["{broken", "[]", "null", '{"modelThinkingLevels":[]}', '{"modelThinkingLevels":null}']) {
	test(`invalid existing settings are preserved without publication: ${invalid}`, async t => {
		const f = await fixture(t); await writeFile(f.path, invalid);
		await assert.rejects(saveProjectPreferences(f.root, ".pi", choice));
		assert.equal(await readFile(f.path, "utf8"), invalid);
		assert.deepEqual(await readdir(join(f.root, ".pi")), ["settings.json"]);
	});
}

test("failed temporary-file publication preserves the original settings", async t => {
	const f = await fixture(t); const original = '{"retained":true}'; await writeFile(f.path, original);
	await chmod(join(f.root, ".pi"), 0o500);
	try {
		await assert.rejects(saveProjectPreferences(f.root, ".pi", choice));
		assert.equal(await readFile(f.path, "utf8"), original);
	} finally {
		await chmod(join(f.root, ".pi"), 0o700);
	}
	assert.deepEqual(await readdir(join(f.root, ".pi")), ["settings.json"]);
});

test("a filesystem read failure never replaces the original target", async t => {
	const f = await fixture(t); await mkdir(f.path);
	await assert.rejects(saveProjectPreferences(f.root, ".pi", choice));
	assert.equal((await stat(f.path)).isDirectory(), true);
});
