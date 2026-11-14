import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = resolve(process.env.TEST_PI_HOST ?? "node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(host, "package.json")))!);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const entry = new URL("../../src/index.ts", import.meta.url).href;
const root = await mkdtemp(join(tmpdir(), "telegram-custom-run-"));
const project = join(root, "project");
const profile = join(root, "profile");
await mkdir(project);
await mkdir(profile, { mode: 0o700 });
const seen: string[] = [];
const errors: string[] = [];
const replies: { text: string; replyTo?: number }[] = [];
const records: any[] = [];
let calls = 0;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const fixture = {
	batch: undefined as ((updates: unknown[]) => Promise<unknown>) | undefined,
	arm: false,
	injected: false,
};
(globalThis as any).customRunFixture = fixture;
let session: InstanceType<typeof sdk.AgentSession> | undefined;
let modelRuntime: InstanceType<typeof sdk.ModelRuntime> | undefined;
const provider = "telegram-custom-run";
try {
	const wrapper = join(project, "fixture.ts");
	await writeFile(wrapper, `import { createTelegramOwnerExtension } from ${JSON.stringify(entry)};
const f = globalThis.customRunFixture;
export default function(pi) {
 createTelegramOwnerExtension({ projectRoot:${JSON.stringify(project)}, datastore:{mode:'off',store:'telegram'}, dependencies:{
  journal:{ async load(){ return []; }, async append(record){ globalThis.customRunRecords.push(structuredClone(record)); } },
  ownerUserId:7, privateChatId:71, agentLabel:'Custom', inboundQuietWindowMs:0,
  source:{ async start(callback){ f.batch = callback; return async()=>{}; } },
  async sendReply(text, replyTo){ globalThis.customRunReplies.push({ text, replyTo }); return "1"; }
 }})(pi);
 pi.on("input", async (event) => {
  if (!f.arm || f.injected || event.source !== "extension") return;
  f.injected = true;
  await pi.sendMessage({ customType:"other-extension", content:"wake up", display:false }, { triggerTurn:true });
 });
 pi.on("before_agent_start", (event) => { globalThis.customRunSeen.push(event.messageType ?? "legacy"); });
 pi.on("agent_settled", () => { globalThis.customRunSettled = (globalThis.customRunSettled ?? 0) + 1; });
}
`);
	(globalThis as any).customRunRecords = records;
	(globalThis as any).customRunReplies = replies;
	(globalThis as any).customRunSeen = seen;
	const model = { id: "fixture", name: "Synthetic", api: "openai-completions", provider, baseUrl: "http://fixture.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 };
	modelRuntime = await sdk.ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: null, modelsStorePath: join(profile, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	modelRuntime.registerProvider(provider, {
		api: model.api, apiKey: "synthetic-only", baseUrl: model.baseUrl, models: [model],
		streamSimple(_model: any, _context: any, options: any) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				calls += 1;
				if (options.onPayload) await options.onPayload({ messages: [] }, _model);
				const text = calls === 1 && seen[0] === "custom" ? "custom-side-effect" : "Queued reply.";
				stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text }], api: model.api, provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() } });
				stream.end();
			})().catch((error) => { errors.push(String(error)); stream.end(); });
			return stream;
		},
	});
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	const resourceLoader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: profile, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [wrapper] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await sdk.createAgentSession({ cwd: project, agentDir: profile, settingsManager, resourceLoader, modelRuntime, model, sessionManager: sdk.SessionManager.create(project, join(profile, "sessions")) }));
	await session.bindExtensions({ onError: (error: unknown) => errors.push(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error)) });
	while (!fixture.batch) {
		assert.deepEqual(errors, []);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await fixture.batch([{ update_id: 1, message: { message_id: 10, text: "Please reply.", date: 1, from: { id: 7 }, chat: { id: 71, type: "private" } } }]);
	while (!replies.some((reply) => reply.text === "Queued reply.")) {
		assert.deepEqual(errors, [], JSON.stringify({ seen, calls, records: records.map((record) => record.type), replies }));
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(seen.includes("user"), true, "queued sendUserMessage did not arrive as a user event");
	assert.equal(records.filter((record) => record.type === "dispatched").length, 1);
	assert.equal(replies.find((reply) => reply.text === "Queued reply.")?.replyTo, 10);
	assert.deepEqual(errors, []);
	fixture.arm = true;
	const dispatchedBeforeReentrant = records.filter((record) => record.type === "dispatched").length;
	await fixture.batch([{ update_id: 2, message: { message_id: 11, text: "Second.", date: 2, from: { id: 7 }, chat: { id: 71, type: "private" } } }]);
	const settled = () => (globalThis as any).customRunSettled ?? 0;
	const settledBefore = settled();
	while (!seen.includes("custom") || settled() === settledBefore) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const reentrancy = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
	const unexpected = errors.filter((error) => !error.includes(reentrancy));
	assert.deepEqual(unexpected, [], "unexpected host error");
	assert.equal(errors.some((error) => error.includes(reentrancy)), true, "the reentrant input hook did not produce the known already-processing host error");
	assert.equal(seen.includes("custom"), true);
	assert.equal(records.filter((record) => record.type === "dispatched").length, dispatchedBeforeReentrant, "custom triggerTurn claimed owner work");
	assert.equal(replies.some((reply) => reply.replyTo === 11), false, "the reentrant window is not a successful delivery");
	assert.equal(replies.some((reply) => reply.text === "custom-side-effect"), false);
	console.log(JSON.stringify({ seen, calls, dispatched: records.filter((record) => record.type === "dispatched").length, reentrancy: true }));
} finally {
	if (session) {
		await session.abort();
		await session.reload();
		session.dispose();
	}
	modelRuntime?.unregisterProvider(provider);
	await rm(root, { recursive: true, force: true });
}
