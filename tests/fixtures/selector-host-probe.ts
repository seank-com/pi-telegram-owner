import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const host = process.env.TEST_PI_HOST ?? fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const entry = process.env.TELEGRAM_TEST_ENTRY ?? new URL("../../src/index.ts", import.meta.url).href;
const root = await mkdtemp(join(tmpdir(), "telegram-selector-host-"));
const profile = join(root, "profile");
const records: any[] = [], sends: any[] = [], edits: any[] = [], answers: string[] = [], errors: unknown[] = [];
let batch: any, calls = 0;
let beforeCompacts = 0;
let compactionMode: "cancel" | "complete" = "cancel";
const fixture = {
	journal: { async load() { return [...records]; }, async append(record: unknown) { records.push(structuredClone(record)); } },
	transport: {
		async send(text: string, keyboard: unknown) { sends.push({ text, keyboard }); return String(899 + sends.length); },
		async edit(message: string, text: string, keyboard: unknown) { edits.push({ message, text, keyboard }); },
		async answer(id: string) { answers.push(id); },
	},
	install(callback: unknown) { batch = callback; },
	beforeCompact(event: any) {
		beforeCompacts++;
		return compactionMode === "cancel" ? { cancel: true } : { compaction: {
			summary: "Synthetic public-hook summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
		} };
	},
};
(globalThis as any).selectorHostFixture = fixture;
let session!: AgentSession;
let runtime: any;
try {
	await mkdir(profile, { mode: 0o700 });
	const wrapper = join(root, "fixture.ts");
	await writeFile(wrapper, `import { createTelegramOwnerExtension } from ${JSON.stringify(entry)};
export default function(pi) {
 const f = globalThis.selectorHostFixture;
 createTelegramOwnerExtension({projectRoot:${JSON.stringify(root)},datastore:{mode:'off'},dependencies:{
 journal:f.journal,ownerUserId:7,privateChatId:70,selectorTransport:f.transport,
 source:{async start(callback){f.install(callback);return async()=>{}}},async sendReply(){return '42'}
 }})(pi);
 // Register after the owner extension so cancellation also tests its guard reset.
 pi.on("session_before_compact", (event) => f.beforeCompact(event));
}`);
	runtime = await sdk.ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: null, modelsStorePath: join(profile, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	const provider = "telegram-selector-fixture";
	const makeModel = (id: string, reasoning: boolean) => ({ id, name: `Synthetic ${id}`, provider, api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning,
		input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: null, xhigh: null, max: null } });
	const a = makeModel("a", true), b = makeModel("b", false), outsideScope = makeModel("outside-scope", true);
	runtime.registerProvider(provider, { api: a.api, apiKey: "synthetic-only", baseUrl: a.baseUrl, models: [a, b, outsideScope], streamSimple: () => { calls++; throw new Error("Selectors must not create model turns"); } });
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 }, retry: { enabled: false }, cacheWarming: "off" });
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: profile, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [wrapper] });
	await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await sdk.createAgentSession({ cwd: root, agentDir: profile, settingsManager, resourceLoader, modelRuntime: runtime, model: a,
		scopedModels: [{ model: a }, { model: b }], sessionManager: sdk.SessionManager.create(root, join(profile, "sessions")) }));
	await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
	assert.ok(session.model);
	assert.equal(typeof batch, "function");
	let updateId = 0;
	const command = async (text: string) => { const id = ++updateId; await batch([{ update_id: id, message: { message_id: id + 100, text, from: { id: 7 }, chat: { id: 70, type: "private" } } }]); };
	const select = async (message: number, data: string) => { const id = ++updateId; await batch([{ update_id: id, callback_query: { id: `native-${id}`, from: { id: 7 }, message: { message_id: message, chat: { id: 70, type: "private" } }, data } }]); };
	const entriesBefore = session.sessionManager.getEntries().filter((entry: any) => entry.type === "message").length;
	// Public manual compaction rejects a too-small session without latching the guard.
	await assert.rejects(session.compact(), /Nothing to compact/);
	assert.equal(beforeCompacts, 0); assert.equal(session.isIdle, true);
	await command("/model");
	assert.deepEqual(sends[0].keyboard.inline_keyboard.flat().map((button: any) => button.text), [`✓ ${provider}/a`, `${provider}/b`]);
	await command("/thinking");
	assert.deepEqual(sends[1].keyboard.inline_keyboard.flat().map((button: any) => button.text.replace("✓ ", "")), ["off", "low", "medium", "high"]);
	await select(901, sends[1].keyboard.inline_keyboard.at(-1)[0].callback_data);
	assert.equal(session.thinkingLevel, "high");
	// The old model picker must actually reject after the thinking setter, not merely go unused.
	await select(900, sends[0].keyboard.inline_keyboard[1][0].callback_data);
	assert.equal(session.model.id, "a"); assert.equal(records.findLast(r => r.type === "selector" && r.phase === "outcome").outcome, "stale");
	// Open a fresh picker after a thinking-level change.
	await command("/model");
	await select(902, sends[2].keyboard.inline_keyboard[1][0].callback_data);
	assert.equal(session.model.id, "b"); assert.equal(session.thinkingLevel, "off");
	assert.match(edits.at(-1).text, /Thinking: off \(was high; adjusted by host\)/);
	// Thinking buttons opened before a model setter become stale too.
	await select(901, sends[1].keyboard.inline_keyboard[0][0].callback_data);
	assert.equal(session.model.id, "b"); assert.equal(session.thinkingLevel, "off");
	assert.equal(records.findLast(r => r.type === "selector" && r.phase === "outcome").outcome, "stale");
	await command("/model");
	const oldApiToken = sends[3].keyboard.inline_keyboard[0][0].callback_data;
	runtime.registerProvider(provider, { api: "openai-responses", apiKey: "synthetic-only", baseUrl: a.baseUrl,
		models: [{ ...a, api: "openai-responses" }, b, outsideScope], streamSimple: () => { calls++; throw new Error("No turns"); } });
	await select(903, oldApiToken);
	assert.match(edits.at(-1).text, /changed/); assert.equal(session.model.id, "b");
	assert.ok(!JSON.stringify(records).includes("fixture.invalid"));
	assert.equal(calls, 0); assert.equal(answers.length, 5); assert.deepEqual(errors, []);
	assert.equal(session.sessionManager.getEntries().filter((entry: any) => entry.type === "message").length, entriesBefore);
	assert.equal(records.filter(r => r.type === "selector" && r.phase === "mutation_started").length, 2);
	assert.ok(!records.some(r => r.type === "dispatch_requested" || r.type === "work_item"));
	// Seed synthetic history through SessionManager's public append API. A public
	// compaction hook supplies the summary, so neither case calls a model.
	session.sessionManager.appendMessage({ role: "user", content: "Earlier synthetic conversation", timestamp: Date.now() });
	session.sessionManager.appendMessage({ role: "user", content: "Recent synthetic conversation", timestamp: Date.now() });
	for (const mode of ["cancel", "complete"] as const) {
		compactionMode = mode;
		if (mode === "cancel") await assert.rejects(session.compact(), /Compaction cancelled/);
		else assert.equal((await session.compact()).summary, "Synthetic public-hook summary");
		assert.equal(session.isIdle, true);
		await command("/model");
		const active = sends.at(-1).keyboard.inline_keyboard.flat().find((button: any) => button.text.startsWith("✓ "));
		assert.ok(active);
		await select(899 + sends.length, active.callback_data);
		assert.equal(records.findLast(r => r.type === "selector" && r.phase === "outcome").outcome, "applied");
	}
	assert.equal(beforeCompacts, 2); assert.equal(calls, 0); assert.deepEqual(errors, []);
	console.log("PASS: public Pi selectors and compaction rejection/cancellation/completion, zero model calls");
} finally {
	await session?.dispose();
	await runtime?.close?.();
	delete (globalThis as any).selectorHostFixture;
	await rm(root, { recursive: true, force: true });
}
