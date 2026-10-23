#!/usr/bin/env node
import { join, resolve } from "node:path";

import { defaultPrivateControlDir, prepareTelegramPrivateImport, PRIVATE_BOUNDARY_FILE, PRIVATE_CHECKPOINT_FILE, PRIVATE_SOURCE_FILE, PRIVATE_SPEAKERS_FILE, TelegramArchiveImporter } from "../importer.ts";

function argumentsMap(argv: string[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index]!;
		if (!key.startsWith("--")) throw new Error("Every importer argument must be a named option");
		if (["--prepare", "--dry-run", "--commit"].includes(key)) { result.set(key, ["true"]); continue; }
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
		result.set(key, [...(result.get(key) ?? []), value]);
	}
	return result;
}

function one(values: Map<string, string[]>, key: string, required = true): string | undefined {
	const found = values.get(key);
	if (!found?.length) { if (required) throw new Error(`Missing ${key}`); return undefined; }
	if (found.length !== 1) throw new Error(`${key} may be supplied once`);
	return found[0];
}

const args = argumentsMap(process.argv.slice(2));
const allowed = new Set(["--prepare", "--control-dir", "--export-root", "--source-set-manifest", "--first-pi-anchor", "--speaker-map", "--pi-session-root", "--pi-session-root-id", "--pi-session", "--journal", "--checkpoint", "--output-root", "--lookahead", "--chunk-candidate-gap-ms", "--chunk-candidate-min-length", "--html-pi-timestamp-offset-seconds", "--deadline-seconds", "--dry-run", "--commit"]);
for (const key of args.keys()) if (!allowed.has(key)) throw new Error(`Unknown option ${key}`);
const numeric = (key: string, fallback: number): number => {
	const raw = one(args, key, false);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
	return value;
};
const signedSeconds = (key: string): number[] => (args.get(key) ?? []).map((raw) => {
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || Math.abs(value) > 24 * 60 * 60) throw new Error(`${key} must contain integers within plus or minus 86400 seconds`);
	return value;
});
if (["--prepare", "--dry-run", "--commit"].filter((key) => args.has(key)).length > 1) throw new Error("Choose --prepare, --dry-run or --commit, not more than one");
const exportRoot = resolve(one(args, "--export-root")!);
const controlDir = resolve(one(args, "--control-dir", false) ?? defaultPrivateControlDir(exportRoot));
const common = {
	exportRoot,
	piSessionRoot: resolve(one(args, "--pi-session-root")!),
	piSessionRootId: one(args, "--pi-session-root-id", false) ?? "pi-sessions",
	piSessionPaths: args.get("--pi-session") ?? [],
	journalPath: one(args, "--journal", false) ? resolve(one(args, "--journal", false)!) : undefined,
	deadlineMs: numeric("--deadline-seconds", 60) * 1_000,
};
if (args.has("--prepare")) {
	for (const key of ["--source-set-manifest", "--first-pi-anchor", "--speaker-map", "--checkpoint", "--output-root", "--lookahead", "--chunk-candidate-gap-ms", "--chunk-candidate-min-length", "--html-pi-timestamp-offset-seconds"]) if (args.has(key)) throw new Error(`${key} is not used with --prepare; use --control-dir for generated controls`);
	const report = await prepareTelegramPrivateImport({ ...common, controlDir });
	process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
	const commit = args.has("--commit");
	const outputRoot = one(args, "--output-root", false);
	if (commit && !outputRoot) throw new Error("--commit requires --output-root");
	const report = await new TelegramArchiveImporter().run({
		...common,
		sourceSetManifestPath: resolve(one(args, "--source-set-manifest", false) ?? join(controlDir, PRIVATE_SOURCE_FILE)),
		boundaryManifestPath: resolve(one(args, "--first-pi-anchor", false) ?? join(controlDir, PRIVATE_BOUNDARY_FILE)),
		speakerMapPath: resolve(one(args, "--speaker-map", false) ?? join(controlDir, PRIVATE_SPEAKERS_FILE)),
		checkpointPath: resolve(one(args, "--checkpoint", false) ?? join(controlDir, PRIVATE_CHECKPOINT_FILE)),
		archiveRoot: outputRoot ? resolve(outputRoot) : undefined,
		dryRun: !commit,
		lookahead: numeric("--lookahead", 12),
		chunkCandidateGapMs: numeric("--chunk-candidate-gap-ms", 2_000),
		chunkCandidateMinLength: numeric("--chunk-candidate-min-length", 3_500),
		htmlPiTimestampOffsetsMs: signedSeconds("--html-pi-timestamp-offset-seconds").map((offset) => offset * 1_000),
	});
	process.stdout.write(`${JSON.stringify({ sourceSetId: report.sourceSetId, historical: report.historical, piAligned: report.piAligned, unresolvedPostBoundary: report.unresolvedPostBoundary, ambiguous: report.ambiguous, coverageMissing: report.coverageMissing, chunkCandidates: report.chunkCandidates.length, gaps: report.gaps.length, mode: commit ? "commit" : "dry-run", publication: report.publication })}\n`);
}
