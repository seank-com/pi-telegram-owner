export const TELEGRAM_OWNER_COMMANDS = [
	{ name: "help", description: "Show available commands." },
	{ name: "status", description: "Show runtime and context status." },
	{ name: "stop", description: "Stop the current run." },
	{ name: "compact", description: "Compact the current session context." },
	{ name: "new", description: "Start a fresh session." },
] as const;

export type TelegramOwnerCommandName = (typeof TELEGRAM_OWNER_COMMANDS)[number]["name"];
export interface TelegramBotCommand {
	command: TelegramOwnerCommandName;
	description: string;
}
export type ParsedTelegramOwnerCommand =
	| { kind: "known"; name: TelegramOwnerCommandName }
	| { kind: "unknown"; token: string };

const commandNames = new Set<string>(TELEGRAM_OWNER_COMMANDS.map((command) => command.name));

/** Exact payload source for idempotent server-side menu reconciliation. */
export function telegramOwnerMenuCommands(): TelegramBotCommand[] {
	return TELEGRAM_OWNER_COMMANDS.map(({ name, description }) => ({ command: name, description }));
}

/** Parses only exact, argument-free private-chat commands. */
export function parseTelegramOwnerCommand(text: string): ParsedTelegramOwnerCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [token, ...arguments_] = trimmed.split(/\s+/);
	const bare = token.slice(1);
	if (arguments_.length === 0 && commandNames.has(bare)) {
		return { kind: "known", name: bare as TelegramOwnerCommandName };
	}
	return { kind: "unknown", token };
}

export function telegramOwnerHelpText(): string {
	return [
		"Available commands:",
		...TELEGRAM_OWNER_COMMANDS.map((command) => `/${command.name} - ${command.description}`),
	].join("\n");
}

export function unsupportedTelegramCommandText(): string {
	return "Unsupported command. Use /help to list available commands.";
}

export function initialThinkingText(percent: number | null | undefined): string {
	return percent === null || percent === undefined
		? "Thinking (context recalculating)"
		: `Thinking (${Math.round(percent)}%)`;
}

export function queuedNoticeText(agentLabel: string, position: number): string {
	return position === 0
		? `Queued: ${agentLabel} is busy and will start this next.`
		: `Queued: ${agentLabel} is busy and will start this after ${position} earlier ${position === 1 ? "request" : "requests"}.`;
}
