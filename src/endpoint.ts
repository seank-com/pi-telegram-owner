import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The endpoint listens only on the local host; the OS account is its security boundary. */
export const QUEUE_ENDPOINT_HOST = "127.0.0.1";

export interface EndpointResponse {
	status: number;
	body: unknown;
}

export interface QueueEndpointHandlers {
	queue(body: unknown): Promise<EndpointResponse>;
	coordinate(body: unknown): Promise<EndpointResponse>;
	status(): Promise<EndpointResponse>;
}

export interface QueueEndpoint {
	readonly port: number;
	close(): Promise<void>;
}

export interface QueueInstruction {
	kind: "instruction";
	text: string;
	reply: "private" | "group" | "none";
	source: string;
	id?: string;
}

export interface GroupMessageWakeUp {
	kind: "group-message";
	messageId: number;
}

export type QueueRequest = QueueInstruction | GroupMessageWakeUp;

export const DEFAULT_INSTRUCTION_SOURCE = "local automation";

const INSTRUCTION_KEYS = new Set(["kind", "text", "reply", "source", "id"]);

/** Validates a POST /queue body, rejecting unknown fields so caller typos are visible. */
export function parseQueueRequest(body: unknown): { ok: true; value: QueueRequest } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be a JSON object" };
	const value = body as Record<string, unknown>;
	if (value.kind === "group-message") {
		if (Object.keys(value).some((key) => key !== "kind" && key !== "messageId")) return { ok: false, error: "group-message accepts only kind and messageId" };
		if (!Number.isSafeInteger(value.messageId) || (value.messageId as number) <= 0) return { ok: false, error: "messageId must be a positive integer" };
		return { ok: true, value: { kind: "group-message", messageId: value.messageId as number } };
	}
	if (value.kind !== "instruction") return { ok: false, error: "kind must be \"instruction\" or \"group-message\"" };
	const unknown = Object.keys(value).filter((key) => !INSTRUCTION_KEYS.has(key));
	if (unknown.length) return { ok: false, error: `Unknown instruction field: ${unknown.join(", ")}` };
	if (typeof value.text !== "string" || !value.text.trim()) return { ok: false, error: "text must be a non-empty string" };
	if (value.reply !== "private" && value.reply !== "group" && value.reply !== "none") return { ok: false, error: "reply must be \"private\", \"group\" or \"none\"" };
	if (value.source !== undefined && (typeof value.source !== "string" || !value.source.trim())) return { ok: false, error: "source must be a non-empty string when given" };
	if (value.id !== undefined && (typeof value.id !== "string" || !value.id.trim())) return { ok: false, error: "id must be a non-empty string when given" };
	return {
		ok: true,
		value: {
			kind: "instruction",
			text: value.text,
			reply: value.reply,
			source: typeof value.source === "string" ? value.source.trim() : DEFAULT_INSTRUCTION_SOURCE,
			...(typeof value.id === "string" ? { id: value.id } : {}),
		},
	};
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, result: EndpointResponse): void {
	const text = JSON.stringify(result.body);
	response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
	response.end(text);
}

async function route(request: IncomingMessage, handlers: QueueEndpointHandlers): Promise<EndpointResponse> {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	if (path === "/status") {
		if (request.method !== "GET") return { status: 405, body: { error: "Use GET /status" } };
		return handlers.status();
	}
	if (path !== "/queue" && path !== "/coordinate") return { status: 404, body: { error: "Unknown path; use POST /queue, POST /coordinate or GET /status" } };
	if (request.method !== "POST") return { status: 405, body: { error: `Use POST ${path}` } };
	let body: unknown;
	try {
		body = JSON.parse(await readBody(request));
	} catch {
		return { status: 400, body: { error: "Request body must be valid JSON" } };
	}
	return path === "/queue" ? handlers.queue(body) : handlers.coordinate(body);
}

/** Starts the local queue endpoint. Port 0 selects a free port, reported by `port`. */
export async function startQueueEndpoint(port: number, handlers: QueueEndpointHandlers): Promise<QueueEndpoint> {
	const server = createServer((request, response) => {
		void route(request, handlers).then(
			(result) => send(response, result),
			(error: unknown) => send(response, { status: 500, body: { error: error instanceof Error ? error.message : "Internal error" } }),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, QUEUE_ENDPOINT_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		port: (server.address() as AddressInfo).port,
		close: () => new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}
