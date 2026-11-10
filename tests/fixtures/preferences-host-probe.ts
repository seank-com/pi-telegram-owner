import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const host = process.env.TEST_PI_HOST ?? fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const entry = process.env.TELEGRAM_TEST_ENTRY ?? new URL("../../src/index.ts", import.meta.url).href;
const root = await mkdtemp(join(tmpdir(), "telegram-save-host-")), profile = join(root, "profile");
const provider = "save-fixture", records: any[] = [], sends: any[] = [], replies: string[] = [];
let batch: any, calls = 0, session: any, runtime: any;
const fixture = { records, sends, replies, install(callback: unknown) { batch = callback; } };
(globalThis as any).preferencesHostFixture = fixture;
try {
	await mkdir(profile, { mode: 0o700 }); await mkdir(join(root, ".pi"));
	const globalPath = join(profile, "settings.json"), projectPath = join(root, ".pi/settings.json");
	const globalJSON = JSON.stringify({ defaultProvider: provider, defaultModel: "a", defaultThinkingLevel: "medium", modelThinkingLevels: { [`${provider}/b`]: "high" }, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	await writeFile(globalPath, globalJSON, { mode: 0o600 });
	await writeFile(projectPath, JSON.stringify({ sessionDir: "retained-sessions", enableAnalytics: false, modelThinkingLevels: { "other/model": "low" } }), { mode: 0o600 });
	const wrapper = join(root, "save-extension.ts");
	await writeFile(wrapper, `import {createTelegramOwnerExtension} from ${JSON.stringify(entry)};
export default function(pi){const f=globalThis.preferencesHostFixture;createTelegramOwnerExtension({projectRoot:${JSON.stringify(root)},datastore:{mode:'off'},dependencies:{ownerUserId:7,privateChatId:70,journal:{async load(){return [...f.records]},async append(r){f.records.push(structuredClone(r))}},selectorTransport:{async send(text,keyboard){f.sends.push({text,keyboard});return String(100+f.sends.length)},async edit(){},async answer(){}},source:{async start(cb){f.install(cb);return async()=>{}}},async sendReply(text){f.replies.push(text);return '42'}}})(pi);}`);
	const model = (id: string) => ({ id, name: id, provider, api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { minimal: null, xhigh: null, max: null } });
	const a = model("a"), b = model("b");
	runtime = await sdk.ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	runtime.registerProvider(provider, { api: a.api, apiKey: "synthetic-only", baseUrl: a.baseUrl, models: [a, b], streamSimple() { calls++; throw new Error("Save must never call a model"); } });
	async function start() {
		const settingsManager = sdk.SettingsManager.create(root, profile, { projectTrusted: true });
		const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: profile, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [wrapper] });
		await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await sdk.createAgentSession({ cwd: root, agentDir: profile, settingsManager, resourceLoader, modelRuntime: runtime, scopedModels: [{ model: a }, { model: b }], sessionManager: sdk.SessionManager.create(root, join(profile, "sessions")) }));
		await session.bindExtensions({ onError: (error: unknown) => { throw error; } });
	}
	await start(); assert.equal(session.model.id, "a"); assert.equal(session.thinkingLevel, "medium");
	let id = 0;
	const command = async (text: string) => batch([{ update_id: ++id, message: { message_id: id, text, from: { id: 7 }, chat: { id: 70, type: "private" } } }]);
	const pick = async (data: string) => batch([{ update_id: ++id, callback_query: { id: `save-${id}`, data, from: { id: 7 }, message: { message_id: 100 + sends.length, chat: { id: 70, type: "private" } } } }]);
	await command("/model"); await pick(sends.at(-1).keyboard.inline_keyboard.flat().find((x: any) => x.text.endsWith("/b")).callback_data);
	assert.equal(session.model.id, "b"); assert.equal(session.thinkingLevel, "high");
	await command("/thinking"); await pick(sends.at(-1).keyboard.inline_keyboard.flat().find((x: any) => x.text.replace("✓ ", "") === "off").callback_data);
	await command("/save"); assert.match(replies.at(-1)!, /Saved project defaults/);
	const saved = JSON.parse(await readFile(projectPath, "utf8"));
	assert.equal(saved.defaultModel, "b"); assert.equal(saved.defaultProvider, provider); assert.equal(saved.defaultThinkingLevel, "off");
	assert.deepEqual(saved.modelThinkingLevels, { "other/model": "low", [`${provider}/b`]: "off" });
	assert.equal(saved.sessionDir, "retained-sessions"); assert.equal(saved.enableAnalytics, false);
	assert.equal(await readFile(globalPath, "utf8"), globalJSON);
	await session.dispose(); session = undefined;
	await start(); assert.equal(session.model.id, "b"); assert.equal(session.thinkingLevel, "off");
	assert.equal(await readFile(globalPath, "utf8"), globalJSON); assert.equal(calls, 0);
	console.log("PASS: real selectors -> /save -> project-only JSON -> fresh session b/off; inherited high override superseded; global settings unchanged; zero inference");
} finally {
	await session?.dispose(); await runtime?.close?.();
	delete (globalThis as any).preferencesHostFixture;
	await rm(root, { recursive: true, force: true });
}
