/** Explicit group semantics. Local task origins are deliberately absent. */
export const GROUP_LIFECYCLE_VERSION = 1;
export type Disposition = "completed" | "failed" | "blocked" | "cancelled";
export interface RequestWork {
	version: 1;
	kind: "request";
	requestId: string;
	chainId: string;
	parentRequestId?: string;
	recipients: number[];
}
export interface ReplyWork {
	version: 1;
	kind: "reply";
	requestId: string;
	chainId: string;
	recipientBotId: number;
	requesterBotId: number;
	disposition: Disposition;
}
export interface NotifyWork {
	version: 1;
	kind: "notify";
	recipients: number[];
}
export type GroupWork = RequestWork | ReplyWork | NotifyWork;
export interface Obligation {
	requestId: string;
	chainId: string;
	parentRequestId?: string;
	requesterBotId: number;
	recipientBotId: number;
}
export type GroupSendInput =
	| { kind: "request"; text: string; recipients: string[]; replyToMessageId?: number }
	| { kind: "reply"; text: string; requestId: string; disposition?: Disposition; replyToMessageId?: number }
	| { kind: "notify"; text: string; recipients?: string[]; replyToMessageId?: number };
export const dispositions = ["completed", "failed", "blocked", "cancelled"] as const;
export function parseGroupSend(value: unknown): GroupSendInput {
	const v = value as Record<string, unknown>;
	if (
		!v ||
		typeof v !== "object" ||
		!["request", "reply", "notify"].includes(v.kind as string) ||
		typeof v.text !== "string" ||
		!v.text.trim()
	)
		throw new Error("kind and nonempty text are required");
	const allowed = [
		"kind",
		"text",
		"replyToMessageId",
		...(v.kind === "reply" ? ["requestId", "disposition"] : ["recipients"]),
	];
	if (Object.keys(v).some((key) => !allowed.includes(key)))
		throw new Error("Fields belonging to another work kind are invalid");
	if (
		v.replyToMessageId !== undefined &&
		(!Number.isSafeInteger(v.replyToMessageId) || (v.replyToMessageId as number) <= 0)
	)
		throw new Error("Invalid replyToMessageId");
	if (v.kind === "reply") {
		if (
			typeof v.requestId !== "string" ||
			!v.requestId ||
			(v.disposition !== undefined && !dispositions.includes(v.disposition as Disposition))
		)
			throw new Error("Reply needs requestId and a valid disposition");
	} else if (v.recipients !== undefined) {
		if (
			!Array.isArray(v.recipients) ||
			v.recipients.some((x) => typeof x !== "string" || !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(x)) ||
			new Set(v.recipients.map((x) => x.toLowerCase())).size !== v.recipients.length
		)
			throw new Error("recipients must be distinct configured @username accounts");
	}
	if (v.kind === "request" && (!Array.isArray(v.recipients) || !v.recipients.length))
		throw new Error("Request requires explicit recipients");
	return v as unknown as GroupSendInput;
}
export function validWork(value: unknown): value is GroupWork {
	const v = value as GroupWork;
	if (!v || v.version !== 1) return false;
	const id = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
	const text = (x: unknown) => typeof x === "string" && !!x;
	if (v.kind === "request" || v.kind === "notify") {
		if (!Array.isArray(v.recipients) || !v.recipients.every(id) || new Set(v.recipients).size !== v.recipients.length)
			return false;
		return (
			v.kind === "notify" ||
			(!!v.recipients.length &&
				text(v.requestId) &&
				text(v.chainId) &&
				(v.parentRequestId === undefined || text(v.parentRequestId)))
		);
	}
	return (
		v.kind === "reply" &&
		text(v.requestId) &&
		text(v.chainId) &&
		id(v.recipientBotId) &&
		id(v.requesterBotId) &&
		dispositions.includes(v.disposition)
	);
}
export function validObligation(v: unknown): v is Obligation {
	const o = v as Obligation;
	return (
		!!o &&
		typeof o.requestId === "string" &&
		!!o.requestId &&
		typeof o.chainId === "string" &&
		!!o.chainId &&
		Number.isSafeInteger(o.requesterBotId) &&
		o.requesterBotId > 0 &&
		Number.isSafeInteger(o.recipientBotId) &&
		o.recipientBotId > 0 &&
		(o.parentRequestId === undefined || (typeof o.parentRequestId === "string" && !!o.parentRequestId))
	);
}
export type TaskRecord =
	| {
			type: "task_state";
			taskId: string;
			state: "executing" | "waiting" | "completed";
			disposition?: Disposition;
			timestamp: string;
	  }
	| { type: "task_dependency"; taskId: string; requestId: string; recipients: number[]; timestamp: string }
	| {
			type: "task_result";
			taskId: string;
			requestId: string;
			recipientBotId: number;
			messageId: number;
			text: string;
			disposition: Disposition;
			timestamp: string;
	  }
	| { type: "task_presented"; taskId: string; jobId: string; messageIds: number[]; timestamp: string }
	| {
			type: "task_output";
			taskId: string;
			jobId: string;
			mode: "terminal" | "progress";
			disposition: Disposition;
			work?: GroupWork;
			timestamp: string;
	  }
	| { type: "task_abandoned"; taskId: string; timestamp: string }
	| { type: "turn_finished"; jobId: string; mode: "waiting" | "silent"; timestamp: string };
export function validateTaskRecords(records: readonly unknown[]): void {
	const states = new Map<string, string>();
	const dependencies = new Map<string, { taskId: string; recipients: number[] }>();
	const results = new Map<string, Extract<TaskRecord, { type: "task_result" }>>();
	for (const value of records) {
		const r = value as Record<string, any>;
		if (!r || typeof r.type !== "string" || (!r.type.startsWith("task_") && r.type !== "turn_finished")) continue;
		const text = (v: unknown) => typeof v === "string" && !!v;
		const ids = (v: unknown) =>
			Array.isArray(v) && v.every((x) => Number.isSafeInteger(x) && x > 0) && new Set(v).size === v.length;
		let ok = text(r.taskId) && Number.isFinite(new Date(r.timestamp).valueOf());
		switch (r.type) {
			case "task_state":
				ok &&=
					["executing", "waiting", "completed"].includes(r.state) &&
					(r.disposition === undefined || dispositions.includes(r.disposition));
				if (states.get(r.taskId) === "completed" && r.state !== "completed") ok = false;
				states.set(r.taskId, r.state);
				break;
			case "task_dependency": {
				ok &&= text(r.requestId) && ids(r.recipients) && r.recipients.length > 0;
				const previous = dependencies.get(r.requestId);
				if (
					previous &&
					(previous.taskId !== r.taskId ||
						JSON.stringify([...previous.recipients].sort()) !== JSON.stringify([...r.recipients].sort()))
				)
					ok = false;
				if (ok) dependencies.set(r.requestId, { taskId: r.taskId, recipients: r.recipients });
				break;
			}
			case "task_result": {
				ok &&=
					text(r.requestId) &&
					[r.recipientBotId, r.messageId].every((x) => Number.isSafeInteger(x) && x > 0) &&
					typeof r.text === "string" &&
					dispositions.includes(r.disposition);
				const dep = dependencies.get(r.requestId);
				ok &&= !!dep && dep.taskId === r.taskId && dep.recipients.includes(r.recipientBotId);
				const key = `${r.taskId}:${r.requestId}:${r.recipientBotId}`,
					previous = results.get(key);
				if (
					previous &&
					(previous.messageId !== r.messageId || previous.text !== r.text || previous.disposition !== r.disposition)
				)
					ok = false;
				if (ok) results.set(key, r as Extract<TaskRecord, { type: "task_result" }>);
				break;
			}
			case "task_presented":
				ok &&=
					text(r.jobId) &&
					ids(r.messageIds) &&
					r.messageIds.every((id: number) =>
						[...results.values()].some((result) => result.taskId === r.taskId && result.messageId === id),
					);
				break;
			case "task_output":
				ok &&=
					text(r.jobId) &&
					["terminal", "progress"].includes(r.mode) &&
					dispositions.includes(r.disposition) &&
					(r.work === undefined || validWork(r.work));
				break;
			case "task_abandoned":
				break;
			case "turn_finished":
				ok =
					text(r.jobId) && ["waiting", "silent"].includes(r.mode) && Number.isFinite(new Date(r.timestamp).valueOf());
				break;
			default:
				ok = false;
		}
		if (!ok) throw new Error("Invalid task lifecycle record");
	}
}
export function taskResultContext(records: readonly unknown[], jobId: string): string {
	const all = records as TaskRecord[];
	const shown = all.findLast(
		(r): r is Extract<TaskRecord, { type: "task_presented" }> => r.type === "task_presented" && r.jobId === jobId,
	);
	if (!shown) return "";
	const results = shown.messageIds.map((id) => {
		const result = all.find(
			(r): r is Extract<TaskRecord, { type: "task_result" }> =>
				r.type === "task_result" && r.taskId === shown.taskId && r.messageId === id,
		);
		if (!result) throw new Error("Presented dependency evidence is missing");
		return result;
	});
	return `\n\nDependency results:\n${results.map((r) => `Request ${r.requestId}, recipient ${r.recipientBotId}, ${r.disposition}, group message ${r.messageId}: ${r.text}`).join("\n\n")}`;
}
export const GroupSendParameters = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["request", "reply", "notify"] },
		text: { type: "string", minLength: 1 },
		recipients: {
			type: "array",
			items: { type: "string", pattern: "^@[A-Za-z][A-Za-z0-9_]{3,31}$" },
			uniqueItems: true,
		},
		requestId: { type: "string", minLength: 1 },
		disposition: { type: "string", enum: dispositions },
		replyToMessageId: { type: "integer", minimum: 1 },
	},
	required: ["kind", "text"],
	additionalProperties: false,
	oneOf: [
		{
			type: "object",
			properties: { kind: { const: "request" }, recipients: { minItems: 1 } },
			required: ["recipients"],
			not: { type: "object", anyOf: [{ type: "object", required: ["requestId"] }, { type: "object", required: ["disposition"] }] },
		},
		{ type: "object", properties: { kind: { const: "reply" } }, required: ["requestId"], not: { type: "object", required: ["recipients"] } },
		{
			type: "object",
			properties: { kind: { const: "notify" } },
			not: { type: "object", anyOf: [{ type: "object", required: ["requestId"] }, { type: "object", required: ["disposition"] }] },
		},
	],
};
