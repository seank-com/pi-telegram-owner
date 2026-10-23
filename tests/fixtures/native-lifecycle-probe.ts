import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const host = resolve(process.env.TEST_PI_HOST ?? "node_modules/@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(host, "package.json")))!);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const entry = process.env.TELEGRAM_TEST_ENTRY ?? new URL("../../src/index.ts", import.meta.url).href;
const root = await mkdtemp(join(tmpdir(), "telegram-native-lifecycle-"));
const sharedRoot = join(root, "group");
await mkdir(sharedRoot, { mode: 0o700 });
const group = -1001234567890;
const actors = [
	{ key: "a", id: 201, username: "example_agent_a_bot", privateChat: 71 },
	{ key: "b", id: 202, username: "example_agent_b_bot", privateChat: 72 },
];
const states: any[] = [];
const fixtures = new Map<string, any>();
(globalThis as any).nativeTelegramFixtures = fixtures;
let nextId = 1000;
const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		assert.ok(
			Date.now() < deadline,
			"native lifecycle did not settle: " +
				JSON.stringify(
					[...fixtures.values()].map((f) => ({
						key: f.key,
						status: f.status,
						errors: f.errors,
						calls: f.calls,
						replies: f.replies,
					})),
				),
		);
		await new Promise((r) => setTimeout(r, 10));
	}
}
try {
	for (const actor of actors) {
		const peer = actors.find((p) => p.id !== actor.id)!;
		const project = join(root, actor.key),
			profile = join(root, actor.key + "-profile");
		await mkdir(project);
		await mkdir(profile, { mode: 0o700 });
		const f: any = { ...actor, project, records: [], replies: [], errors: [], events: [], calls: 0, status: "" };
		fixtures.set(actor.key, f);
		f.port = () => Number(/endpoint=127\.0\.0\.1:(\d+)/.exec(f.status)?.[1]);
		f.journal = {
			async load() {
				return [...f.records];
			},
			async append(record: unknown) {
				f.records.push(structuredClone(record));
			},
		};
		f.api = {
			async getMe() {
				return { id: actor.id, username: actor.username, firstName: actor.key };
			},
			async getChat() {
				return { id: group, type: "supergroup" };
			},
			async getChatMember(id: number) {
				return { status: id === 7 ? "creator" : "administrator", canRestrictMembers: true, canDeleteMessages: true };
			},
			async getChatMemberCount() {
				return 3;
			},
			async removeChatMember() {},
			async leaveChat() {},
			async sendMessage() {
				return String(nextId++);
			},
			async editMessageText() {},
			async deleteMessage() {},
		};
		f.coordinate = async (_peer: unknown, body: unknown) => {
			const port = fixtures.get(peer.key)?.port();
			if (!port) return undefined;
			const response = await fetch(`http://127.0.0.1:${port}/coordinate`, {
				method: "POST",
				body: JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		};
		f.wake = async (_peer: unknown, messageId: number) => {
			const port = fixtures.get(peer.key)?.port();
			if (!port) return "retry";
			const response = await fetch(`http://127.0.0.1:${port}/queue`, {
				method: "POST",
				body: JSON.stringify({ kind: "group-message", messageId }),
			});
			return response.status === 202 ? "accepted" : "rejected";
		};
		const wrapper = join(project, "fixture.ts");
		await writeFile(
			wrapper,
			`import { createTelegramOwnerExtension } from ${JSON.stringify(entry)};
import { TelegramMarkdownProjector } from ${JSON.stringify(new URL(entry.endsWith(".js") ? "./markdown-projector.js" : "./markdown-projector.ts", entry).href)};
export default function(pi) {
 const f = globalThis.nativeTelegramFixtures.get(${JSON.stringify(actor.key)});
 if(f.disabled)return;
 for (const event of ['agent_start','agent_settled']) pi.on(event, () => { f.events.push(event); });
 createTelegramOwnerExtension({ projectRoot:${JSON.stringify(project)}, datastore:{mode:'off',store:'telegram'}, dependencies:{ journal:f.journal, markdownProjector:new TelegramMarkdownProjector({enabled:true,root:${JSON.stringify(project)},rootId:'native-${actor.key}'}), ownerUserId:7, privateChatId:${actor.privateChat}, agentLabel:'Fixture ${actor.key}', queuePort:0, inboundQuietWindowMs:0,
 source:{async start(callback){f.batch=callback;return async()=>{};}}, async sendReply(text,replyTo){f.replies.push({text,replyTo});return String(Date.now());},
 groupChat:{config:{chatId:${group},sharedRoot:${JSON.stringify(sharedRoot)},datastore:{mode:'off',store:'group'},electionStepMs:250,otherAgents:[${JSON.stringify({ telegramAccount: peer.username, telegramName: peer.key, botUserId: peer.id, queuePort: 7000 })}]},api:f.api,coordinate:f.coordinate,wake:f.wake}
 }})(pi);
}`,
		);
		const modelRuntime = await sdk.ModelRuntime.create({
			authPath: join(profile, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(profile, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const provider = "telegram-native-" + actor.key;
		const model = {
			id: "fixture",
			name: "Synthetic",
			api: "openai-completions",
			provider,
			baseUrl: "http://fixture.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		modelRuntime.registerProvider(provider, {
			api: model.api,
			apiKey: "synthetic-only",
			baseUrl: model.baseUrl,
			models: [model],
			streamSimple: (_model: any, context: any, options: any) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					const call = ++f.calls;
					assert.ok(call <= (actor.key === "a" ? 3 : 1), "unexpected automatic acknowledgment or repeated execution");
					if (options.onPayload) await options.onPayload({ messages: context.messages }, _model);
					let content: any[],
						stopReason = "stop";
					if (actor.key === "a" && call === 1) {
						content = [
							{
								type: "toolCall",
								id: "native-request",
								name: "telegram_group_send",
								arguments: {
									kind: "request",
									recipients: ["@example_agent_b_bot"],
									text: "Return the synthetic result",
								},
							},
						];
						stopReason = "toolUse";
					} else if (actor.key === "a" && call === 2) content = [];
					else {
						if (actor.key === "a") assert.match(JSON.stringify(context.messages.at(-1)), /Dependency results/);
						content = [
							{ type: "text", text: actor.key === "a" ? "Synthetic owner result reviewed." : "Synthetic peer result." },
						];
					}
					const message = {
						role: "assistant",
						content,
						api: model.api,
						provider,
						model: model.id,
						usage,
						stopReason,
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: stopReason, message });
					stream.end();
				})().catch((error) => {
					f.errors.push(String(error));
					stream.push({
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							api: model.api,
							provider,
							model: model.id,
							usage,
							stopReason: "error",
							errorMessage: String(error),
							timestamp: Date.now(),
						},
					});
					stream.end();
				});
				return stream;
			},
		});
		const settingsManager = sdk.SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd: project,
			agentDir: profile,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [wrapper],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({
			cwd: project,
			agentDir: profile,
			settingsManager,
			resourceLoader,
			modelRuntime,
			model,
			sessionManager: sdk.SessionManager.create(project, join(profile, "sessions")),
		});
		states.push({ session, modelRuntime, provider, fixture: f });
		await session.bindExtensions({
			onError: (error: unknown) => f.errors.push(String(error)),
			uiContext: {
				setStatus: (_key: string, value: string) => {
					f.status = value ?? "";
				},
			},
		});
	}
	await until(() => [...fixtures.values()].every((f) => f.status.includes("group=verified")));
	const a = fixtures.get("a"),
		b = fixtures.get("b");
	await a.batch([
		{
			update_id: 1,
			message: {
				message_id: 10,
				text: "Ask B, evaluate the result, and reply here.",
				date: Math.floor(Date.now() / 1000),
				from: { id: 7 },
				chat: { id: 71, type: "private" },
			},
		},
	]);
	await until(() => a.replies.some((r: any) => r.text === "Synthetic owner result reviewed."));
	await until(() => a.events.filter((e: string) => e === "agent_settled").length === 2);
	assert.deepEqual(a.errors, []);
	assert.deepEqual(b.errors, []);
	assert.equal(a.calls, 3);
	assert.equal(b.calls, 1);
	assert.equal(a.replies.find((r: any) => r.text === "Synthetic owner result reviewed.").replyTo, 10);
	assert.equal(
		b.replies.some((r: any) => r.text.includes("Synthetic peer result")),
		false,
	);
	const result = await states[0].session.getToolDefinition("telegram_group_timeline").execute("inspect", { limit: 20 });
	const messages = JSON.parse(result.content[0].text).messages;
	assert.deepEqual(
		messages.map((m: any) => m.work.kind),
		["request", "reply"],
	);
	assert.equal(messages[1].work.requestId, messages[0].work.requestId);
	assert.equal(messages[1].work.recipientBotId, 202);
	assert.equal(messages[1].work.disposition, "completed");
	assert.ok(
		messages.every((m: any) => m.replyToMessageId !== 10),
		"private reply anchor stays local",
	);
	assert.equal(
		JSON.stringify(messages).includes("Ask B, evaluate the result, and reply here."),
		false,
		"private task text stays local",
	);
	await until(()=>a.records.some((r:any)=>r.type==='projection_committed'&&r.direction==='out'&&r.jobId===a.records.findLast((record:any)=>record.type==='reply_ready')?.jobId));
	const notes = (await readdir(join(a.project, "messages"), { recursive: true })).filter((p) => p.endsWith(".md"));
	const archive = (await Promise.all(notes.map((p) => readFile(join(a.project, "messages", p), "utf8")))).join("\n");
	assert.equal(
		archive.split("Synthetic owner result reviewed.").length - 1,
		1,
		"terminal result is canonically projected once",
	);
	assert.equal(
		archive.split("Ask B, evaluate the result, and reply here.").length - 1,
		1,
		"continuation is not fabricated as another inbound owner message",
	);
	assert.doesNotMatch(archive, /Dependency results/);
	console.log(
		"PASS: native Request tool, silent waiting, peer terminal Reply, durable continuation, pinned private result and canonical archive",
	);
} finally {
	for (const state of states.reverse()) {
		await state.session.abort();
		state.fixture.disabled = true;
		await state.session.reload();
		state.session.dispose();
		state.modelRuntime.unregisterProvider(state.provider);
	}
	delete (globalThis as any).nativeTelegramFixtures;
	await rm(root, { recursive: true, force: true });
}
