#!/usr/bin/env node
import { resolve } from "node:path";

import { importTelegramGroupExport } from "../importer.ts";

const ALLOWED = new Set(["--export-root", "--source-set-manifest", "--speaker-map", "--chat-id", "--shared-root", "--dry-run", "--commit"]);
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
	const key = argv[index]!;
	if (!ALLOWED.has(key)) throw new Error(`Unknown option ${key}`);
	if (args.has(key)) throw new Error(`${key} may be supplied once`);
	if (key === "--dry-run" || key === "--commit") { args.set(key, "true"); continue; }
	const value = argv[++index];
	if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
	args.set(key, value);
}
const required = (key: string): string => {
	const value = args.get(key);
	if (value === undefined) throw new Error(`Missing ${key}`);
	return value;
};
if (args.has("--dry-run") && args.has("--commit")) throw new Error("Choose --dry-run or --commit, not both");
const chatId = Number(required("--chat-id"));
if (!Number.isSafeInteger(chatId) || chatId >= 0) throw new Error("--chat-id must be the negative supergroup ID");
const report = await importTelegramGroupExport({
	exportRoot: resolve(required("--export-root")),
	sourceSetManifestPath: resolve(required("--source-set-manifest")),
	speakerMapPath: resolve(required("--speaker-map")),
	chatId,
	sharedRoot: resolve(required("--shared-root")),
	commit: args.has("--commit"),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
