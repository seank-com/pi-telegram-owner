import assert from "node:assert/strict";
import test from "node:test";
import { refreshPublishedPaths, refreshPrivatePublishedPaths } from "../src/datastore.ts";

test("the group publication hook sends store-relative metadata paths before lexical", async () => {
	const calls: { mode: string; paths?: string[] }[] = [];
	const client = { refresh: async (input: { mode: string; paths?: string[] }) => { calls.push({ mode: input.mode, paths: input.paths }); return {}; } };
	await refreshPublishedPaths(client, "telegram-group", ["2026/09/note.md"]);
	assert.deepEqual(calls, [{ mode: "metadata", paths: ["2026/09/note.md"] }, { mode: "lexical", paths: undefined }]);
	calls.length = 0;
	await refreshPublishedPaths(client, "telegram-group", ["2026/09/note.md"], undefined, false);
	assert.deepEqual(calls, []);
});

test("the private publication hook maps archive paths to the narrowed message-store root", async () => {
	const calls: { mode: string; paths?: string[] }[] = [];
	const client = { refresh: async (input: { mode: string; paths?: string[] }) => { calls.push({ mode: input.mode, paths: input.paths }); return {}; } };
	await refreshPrivatePublishedPaths(client, "telegram", ["messages/2026/09/note.md"]);
	assert.deepEqual(calls, [{ mode: "metadata", paths: ["2026/09/note.md"] }, { mode: "lexical", paths: undefined }]);
	calls.length = 0;
	await assert.rejects(refreshPrivatePublishedPaths(client, "telegram", ["outside.md"]), { code: "BACKEND_OUTPUT_INVALID" });
	assert.deepEqual(calls, []);
	await refreshPrivatePublishedPaths(client, "telegram", ["outside.md"], undefined, false);
	assert.deepEqual(calls, []);
});
