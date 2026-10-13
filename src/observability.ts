// Persisted activity consumer wire shape; checked against the owner's packed contract.
export const OBSERVABILITY_CONTRACT_VERSION = 1;
export const TOOL_INTENT_ENTRY_TYPE = "tool-intent";
export interface ToolIntentEntryData { version: 1; toolCallId: string; toolName: string; intent: string; timestamp: string }
