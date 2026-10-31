import {
	OBSERVABILITY_CONTRACT_VERSION,
	TOOL_INTENT_ENTRY_TYPE,
	type ToolIntentEntryData,
} from "./observability.ts";

const MAX_AUDIT_INTENT_LENGTH = 1_000;
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate the persisted wire shape; observability owns intent content/redaction. */
function isToolIntentData(value: unknown): value is ToolIntentEntryData {
	if (!isRecord(value)
		|| value.version !== OBSERVABILITY_CONTRACT_VERSION
		|| typeof value.toolCallId !== "string"
		|| typeof value.toolName !== "string"
		|| typeof value.intent !== "string"
		|| typeof value.timestamp !== "string") return false;
	return value.intent.length > 0
		&& value.intent.length <= MAX_AUDIT_INTENT_LENGTH;
}

function findToolIntent(entries: readonly unknown[], toolCallId: string): ToolIntentEntryData | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_INTENT_ENTRY_TYPE) continue;
		if (isToolIntentData(entry.data) && entry.data.toolCallId === toolCallId) return entry.data;
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
	if (persisted) return persisted.intent;
	const safeName = typeof toolName === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(toolName) ? toolName : "tool";
	return `Using ${safeName}…`;
}
