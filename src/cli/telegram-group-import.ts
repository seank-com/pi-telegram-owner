#!/usr/bin/env node
import { resolve } from "node:path";

import { importTelegramGroupExport, prepareTelegramGroupImport } from "../importer.ts";

const ALLOWED = new Set(["--export-root", "--control-dir", "--chat-id", "--shared-root", "--dry-run", "--commit"]);
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
const exportRoot = args.get("--export-root");
if (!exportRoot) throw new Error("Missing --export-root");
const controlDir = args.has("--control-dir") ? resolve(args.get("--control-dir")!) : undefined;
if (args.has("--dry-run") && args.has("--commit")) throw new Error("Choose --dry-run or --commit, not both");

const importing = args.has("--chat-id") || args.has("--shared-root") || args.has("--dry-run") || args.has("--commit");
if (!importing) {
	// Prepare: write the control files to fill in before a dry run.
	process.stdout.write(`${JSON.stringify(await prepareTelegramGroupImport({ exportRoot, ...(controlDir ? { controlDir } : {}) }))}\n`);
} else {
	const chatId = Number(args.get("--chat-id"));
	if (!Number.isSafeInteger(chatId) || chatId >= 0) throw new Error("--chat-id must be the negative supergroup ID");
	const sharedRoot = args.get("--shared-root");
	if (!sharedRoot) throw new Error("Missing --shared-root");
	const report = await importTelegramGroupExport({ exportRoot, ...(controlDir ? { controlDir } : {}), chatId, sharedRoot: resolve(sharedRoot), commit: args.has("--commit") });
	process.stdout.write(`${JSON.stringify(report)}\n`);
}
