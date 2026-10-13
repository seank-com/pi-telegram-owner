import {
	OBSERVABILITY_CONTRACT_VERSION,
	TOOL_INTENT_ENTRY_TYPE,
	type ToolIntentEntryData,
} from "./observability.ts";

const MAX_AUDIT_INTENT_LENGTH = 1_000;
const MAX_TELEGRAM_INTENT_LENGTH = 160;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff`$\\|;<>"']|&&|https?:\/\/|(?:^|\s)--?[A-Za-z0-9]|(?:^|\s)(?:~\/|\/(?!\s))/im;
const SECRET_ASSIGNMENT = /\b(?:token|secret|password|passwd|credential|cookie|authorization|api[-_ ]?key)\s*(?::|=|\bis\b)\s*(\S+)/gi;
const UNSAFE_BEARER = /\bbearer\s+(?!\[redacted\](?:\s|$))[A-Za-z0-9._~+/=-]+/i;
const COMMON_TOKEN = /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}\b/i;
const TELEGRAM_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/;
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/;

function containsUnsafeSecret(value: string): boolean {
	SECRET_ASSIGNMENT.lastIndex = 0;
	for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
		if (match[1]?.toLowerCase() !== "[redacted]") return true;
	}
	return UNSAFE_BEARER.test(value)
		|| COMMON_TOKEN.test(value)
		|| TELEGRAM_TOKEN.test(value)
		|| OPAQUE_TOKEN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Consumers validate persisted data independently instead of trusting session files. */
function isSafeToolIntentData(value: unknown): value is ToolIntentEntryData {
	if (!isRecord(value)
		|| value.version !== OBSERVABILITY_CONTRACT_VERSION
		|| typeof value.toolCallId !== "string"
		|| typeof value.toolName !== "string"
		|| typeof value.intent !== "string"
		|| typeof value.timestamp !== "string") return false;
	return value.intent.length > 0
		&& value.intent.length <= MAX_AUDIT_INTENT_LENGTH
		&& value.intent.trim() === value.intent
		&& !/\s{2,}/.test(value.intent)
		&& !UNSAFE_TEXT.test(value.intent)
		&& !containsUnsafeSecret(value.intent);
}

function findToolIntent(entries: readonly unknown[], toolCallId: string): ToolIntentEntryData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_INTENT_ENTRY_TYPE) continue;
		if (isSafeToolIntentData(entry.data) && entry.data.toolCallId === toolCallId) return entry.data;
	}
	return undefined;
}

/** Render only versioned persisted observability data, never raw tool input. */
export function formatTelegramToolActivity(
	entries: readonly unknown[],
	toolCallId: string,
	toolName: string,
): string {
	const persisted = findToolIntent(entries, toolCallId);
	if (persisted) {
		if (persisted.intent.length <= MAX_TELEGRAM_INTENT_LENGTH) return persisted.intent;
		return `${persisted.intent.slice(0, MAX_TELEGRAM_INTENT_LENGTH - 1).trimEnd()}…`;
	}
	const safeName = typeof toolName === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(toolName) ? toolName : "tool";
	return `Using ${safeName}…`;
}
