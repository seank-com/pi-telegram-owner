import assert from "node:assert/strict";
import test from "node:test";
import { refreshPublishedPaths } from "../src/datastore.ts";

test("the publication hook sends metadata paths before lexical and skips an absent datastore", async () => {
	const calls: { mode: string; paths?: string[] }[] = [];
	const client = { refresh: async (input: { mode: string; paths?: string[] }) => { calls.push({ mode: input.mode, paths: input.paths }); return {}; } };
	await refreshPublishedPaths(client, "telegram", ["messages/2026/09/note.md"]);
	assert.deepEqual(calls, [{ mode: "metadata", paths: ["messages/2026/09/note.md"] }, { mode: "lexical", paths: undefined }]);
	calls.length = 0;
	await refreshPublishedPaths(client, "telegram", ["messages/2026/09/note.md"], undefined, false);
	assert.deepEqual(calls, []);
});
