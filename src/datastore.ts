import { randomUUID } from "node:crypto";

// Narrow consumer protocol. Datastore owns validation, search, refresh and indexes.
export const CAPABILITY_REQUEST = "pi-markdown-datastore:v1:capability-request";
export const CAPABILITY_REPLY = "pi-markdown-datastore:v1:capability-reply";
export const REQUEST_EVENT = "pi-markdown-datastore:v1:request";
export interface Bus { on(event: string, handler: (value: any) => void): () => void; emit(event: string, value: unknown): unknown }
export interface Capability { readonly version: 1; readonly contractVersion: 1; readonly ready: boolean; readonly stores: readonly string[] }
export type DatastoreMode = "auto" | "off" | "required";
export interface DatastorePolicy { mode: DatastoreMode; store: string }
export function parseDatastorePolicy(value: unknown): DatastorePolicy {
	if (value === undefined) return { mode: "auto", store: "telegram" };
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("datastore must be an object");
	const item = value as Record<string, unknown>;
	if (Object.keys(item).some(key => !["mode", "store"].includes(key))) throw new Error("Unknown datastore option");
	const mode = item.mode ?? "auto", store = item.store ?? "telegram";
	if (!["auto", "off", "required"].includes(String(mode)) || typeof mode !== "string") throw new Error("datastore.mode must be auto, off or required");
	if (typeof store !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(store)) throw new Error("datastore.store must be an exact store identifier");
	return { mode: mode as DatastoreMode, store };
}
export function queryCapability(bus: Bus): Capability | undefined {
	if (!bus || typeof bus.on !== "function" || typeof bus.emit !== "function") return undefined;
	const requestId = randomUUID(); let candidate: Capability | undefined; let replies = 0;
	const unsubscribe = bus.on(CAPABILITY_REPLY, value => {
		if (!value || value.version !== 1 || value.requestId !== requestId) return;
		const c = value.capability;
		if (!c || c.version !== 1 || c.contractVersion !== 1 || typeof c.ready !== "boolean" || !Array.isArray(c.stores) || c.stores.length > 100
			|| c.stores.some((name: unknown) => typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) || new Set(c.stores).size !== c.stores.length) return;
		candidate = c; replies++;
	});
	try { bus.emit(CAPABILITY_REQUEST, { version: 1, requestId }); } finally { unsubscribe(); }
	return replies === 1 ? candidate : undefined;
}
export interface SearchResult {
	contractVersion: 1; operation: "search"; store: string;
	data: { hits: unknown[]; returned: number; [key: string]: unknown };
	provenance: { sources: { kind: string; observationId?: string; freshness?: string; [key: string]: unknown }[]; [key: string]: unknown };
	bounds: Record<string, unknown>; warnings: { code: string; [key: string]: unknown }[];
}
export interface MarkdownDatastoreServiceV1 {
	search(input: { store: string; query: string; mode: "hybrid"; limit: number; includeContent: true }, signal?: AbortSignal): Promise<SearchResult>;
	refresh(input: { action: "start"; store: string; mode: "lexical" }, signal?: AbortSignal): Promise<unknown>;
}
export class IntegrationError extends Error {
	readonly code: "CAPABILITY_UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "BACKEND_OUTPUT_INVALID";
	constructor(code: IntegrationError["code"]) { super(code); this.code = code; }
}
export function createDatastoreIntegration(bus: Bus, getPolicy: () => DatastorePolicy, timeoutMs = 900_000) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new RangeError("datastore timeout must be 1..900000 ms");
	let active = false; let lifetime = new AbortController();
	const available = () => {
		if (!active || getPolicy().mode === "off") return false;
		const capability = queryCapability(bus);
		return !!capability?.ready && capability.stores.includes(getPolicy().store);
	};
	const request = async (operation: "search" | "refresh", input: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
		if (signal?.aborted) throw new IntegrationError("CANCELLED");
		if (!available()) throw new IntegrationError("CAPABILITY_UNAVAILABLE");
		const selected = getPolicy().store;
		if (input.store !== selected) throw new IntegrationError("CAPABILITY_UNAVAILABLE");
		const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
		return new Promise((resolve, reject) => {
			let settled = false; const cancellation = new AbortController();
			const finish = (work: () => void) => { if (settled) return; settled = true; clearTimeout(timer); combined.removeEventListener("abort", onAbort); work(); };
			const cancel = (code: "CANCELLED" | "TIMEOUT") => finish(() => { const error = new IntegrationError(code); cancellation.abort(error); reject(error); });
			const onAbort = () => cancel("CANCELLED");
			const deadline = Date.now() + timeoutMs;
			const timer = setTimeout(() => cancel("TIMEOUT"), timeoutMs); timer.unref?.();
			combined.addEventListener("abort", onAbort, { once: true });
			if (combined.aborted) { onAbort(); return; }
			try { bus.emit(REQUEST_EVENT, { contractVersion: 1, requestId: randomUUID(), request: { operation, input }, deadline, signal: cancellation.signal,
				resolve: (value: any) => finish(() => {
					if (!value || value.contractVersion !== 1 || value.operation !== operation || value.store !== selected || !value.data || !value.provenance || !value.bounds || !Array.isArray(value.warnings)
						|| (operation === "search" && (!Array.isArray(value.data.hits) || !Number.isInteger(value.data.returned) || !Array.isArray(value.provenance.sources)))) reject(new IntegrationError("BACKEND_OUTPUT_INVALID"));
					else resolve(value);
				}), reject: (error: unknown) => finish(() => reject(error)) }); } catch (error) { finish(() => reject(error)); }
		});
	};
	const service: MarkdownDatastoreServiceV1 = { search: (input, signal) => request("search", input, signal), refresh: (input, signal) => request("refresh", input, signal) };
	return { service, available, start() { lifetime.abort(); lifetime = new AbortController(); active = true; }, stop() { active = false; lifetime.abort(); } };
}
