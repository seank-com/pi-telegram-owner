#!/usr/bin/env node
import { resolve } from "node:path";

import { TelegramArchiveImporter } from "../importer.ts";

function argumentsMap(argv: string[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index]!;
		if (!key.startsWith("--")) throw new Error("Every importer argument must be a named option");
		if (key === "--dry-run" || key === "--commit") { result.set(key, ["true"]); continue; }
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
const allowed = new Set(["--export-root", "--source-set-manifest", "--first-pi-anchor", "--speaker-map", "--pi-session-root", "--pi-session-root-id", "--pi-session", "--journal", "--checkpoint", "--output-root", "--lookahead", "--chunk-candidate-gap-ms", "--chunk-candidate-min-length", "--html-pi-timestamp-offset-seconds", "--deadline-seconds", "--dry-run", "--commit"]);
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
if (args.has("--dry-run") && args.has("--commit")) throw new Error("Choose --dry-run or --commit, not both");
const commit = args.has("--commit");
const outputRoot = one(args, "--output-root", false);
const htmlPiTimestampOffsetSeconds = signedSeconds("--html-pi-timestamp-offset-seconds");
if (commit && !outputRoot) throw new Error("--commit requires --output-root");
const importer = new TelegramArchiveImporter();
const report = await importer.run({
	exportRoot: resolve(one(args, "--export-root")!),
	sourceSetManifestPath: resolve(one(args, "--source-set-manifest")!),
	boundaryManifestPath: resolve(one(args, "--first-pi-anchor")!),
	speakerMapPath: resolve(one(args, "--speaker-map")!),
	piSessionRoot: resolve(one(args, "--pi-session-root")!),
	piSessionRootId: one(args, "--pi-session-root-id", false) ?? "pi-sessions",
	piSessionPaths: args.get("--pi-session") ?? [],
	journalPath: one(args, "--journal", false) ? resolve(one(args, "--journal", false)!) : undefined,
	checkpointPath: resolve(one(args, "--checkpoint")!),
	archiveRoot: outputRoot ? resolve(outputRoot) : undefined,
	dryRun: !commit,
	lookahead: numeric("--lookahead", 12),
	chunkCandidateGapMs: numeric("--chunk-candidate-gap-ms", 2_000),
	chunkCandidateMinLength: numeric("--chunk-candidate-min-length", 3_500),
	deadlineMs: numeric("--deadline-seconds", 60) * 1_000,
	htmlPiTimestampOffsetsMs: htmlPiTimestampOffsetSeconds.map((offset) => offset * 1_000),
});
process.stdout.write(`${JSON.stringify({ sourceSetId: report.sourceSetId, historical: report.historical, piAligned: report.piAligned, unresolvedPostBoundary: report.unresolvedPostBoundary, ambiguous: report.ambiguous, coverageMissing: report.coverageMissing, chunkCandidates: report.chunkCandidates.length, gaps: report.gaps.length, mode: commit ? "commit" : "dry-run", publication: report.publication })}\n`);
