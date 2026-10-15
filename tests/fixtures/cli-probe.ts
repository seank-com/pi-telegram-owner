import assert from "node:assert/strict";import {createHash} from "node:crypto";import {execFileSync} from "node:child_process";import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";import {existsSync} from "node:fs";
import {markdownCompatibilityKey,TELEGRAM_FORMAT_COMPAT_VERSION,markdownToPlainText} from "@seank/pi-telegram-owner/format";import {TelegramArchiveImporter} from "@seank/pi-telegram-owner/importer";import {TelegramMarkdownProjector} from "@seank/pi-telegram-owner/markdown-projector";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
assert.equal(existsSync("node_modules/@earendil-works"),false);assert.equal(existsSync("node_modules/typebox"),false);assert.equal(markdownToPlainText("**fixture**"),"fixture");assert.equal(typeof TelegramArchiveImporter,"function");assert.equal(typeof TelegramMarkdownProjector,"function");
async function fixture(postText = "answer") {
	const root = await mkdtemp(join(tmpdir(), "telegram-import-"));
	const exportRoot = join(root, "export");
	const sessionRoot = join(root, "sessions");
	const control = join(root, "control");
	await Promise.all([mkdir(join(exportRoot, "photos"), { recursive: true, mode: 0o700 }), mkdir(sessionRoot, { mode: 0o700 }), mkdir(control, { mode: 0o700 })]);
	const html = `<!doctype html><html><body>
<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-02-24T10:00:00Z"></div><div class="text"><strong>old</strong><br>one</div><a class="photo_wrap" href="photos/a.png"><img src="photos/a.png"></a></div>
<div class="message default joined"><div class="date" title="2026-02-24T10:01:00Z"></div><div class="text"><pre>old code</pre></div></div>
<div class="message default"><div class="from_name">Owner</div><div class="date" title="2026-09-20T10:00:00Z"></div><div class="text">first pi.</div></div>
<div class="message default"><div class="from_name">Agent</div><div class="date" title="2026-09-20T10:01:00Z"></div><div class="text"><em>${postText}</em> <a href="tel:+15550100">call</a></div><a class="photo_wrap" href="photos/b.png"><img src="photos/b.png"></a></div>
</body></html>`;
	await writeFile(join(exportRoot, "messages.html"), html);
	const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
	await writeFile(join(exportRoot, "photos", "a.png"), photoBytes);
	await writeFile(join(exportRoot, "photos", "b.png"), photoBytes);
	const source: SourceSetManifest = { schema: "pi-telegram-owner/source-set/v1", sourceSetId: "pre-pi-v1", pages: [{ path: "messages.html", size: Buffer.byteLength(html), sha256: sha(html) }], messageCount: 4 };
	const sourcePath = join(control, "source.json");
	await writeFile(sourcePath, JSON.stringify(source), { mode: 0o600 });
	const speaker: SpeakerMap = { schema: "pi-telegram-owner/speaker-map/v1", revision: 1, speakers: { [sha("Owner")]: "in", [sha("Agent")]: "out" } };
	const speakerPath = join(control, "speakers.json");
	await writeFile(speakerPath, JSON.stringify(speaker), { mode: 0o600 });
	const boundary: BoundaryManifest = { schema: "pi-telegram-owner/first-pi-boundary/v1", admittedPiSessionIds: ["pi-session"], sourceSetManifestSha256: sha(await readFile(sourcePath)), firstPi: { matchKind: "markdown-semantic", sessionId: "pi-session", entryId: "user0001", globalMessageOrdinal: 3, direction: "in", compatibility: TELEGRAM_FORMAT_COMPAT_VERSION, normalizedSha256: sha(markdownCompatibilityKey("first pi\\.")) } };
	const boundaryPath = join(control, "boundary.json");
	await writeFile(boundaryPath, JSON.stringify(boundary), { mode: 0o600 });
	const session = [
		JSON.stringify({ type: "session", version: 3, id: "pi-session", timestamp: "2026-09-20T09:59:00Z", cwd: "/synthetic" }),
		JSON.stringify({ type: "message", id: "user0001", parentId: null, timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: "[telegram-job:synthetic-job]\nfirst pi.", timestamp: 0 } }),
		JSON.stringify({ type: "message", id: "asst0001", parentId: "user0001", timestamp: "2026-09-20T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: `_${postText}_ [call](tel:+15550100)` }], timestamp: 0 } }),
	].join("\n") + "\n";
	await writeFile(join(sessionRoot, "pi.jsonl"), session);
	return { root, exportRoot, sessionRoot, sourcePath, speakerPath, boundaryPath, checkpointPath: join(control, "checkpoint.json"), archiveRoot: join(root, "archive"), photoBytes };
}

const current=await fixture();
try{
const command=join(process.cwd(),"node_modules/.bin/pi-telegram-archive-import");assert.ok((await readFile(command,"utf8")).startsWith("#!/usr/bin/env node"));
const args=["--export-root",current.exportRoot,"--source-set-manifest",current.sourcePath,"--first-pi-anchor",current.boundaryPath,"--speaker-map",current.speakerPath,"--pi-session-root",current.sessionRoot,"--pi-session","pi.jsonl","--checkpoint",current.checkpointPath];
const run=(extra:string[])=>JSON.parse(execFileSync(command,[...args,...extra],{encoding:"utf8",stdio:"pipe",timeout:10000}));
const dry=run(["--dry-run"]);assert.equal(dry.historical,2);assert.equal(dry.piAligned,2);assert.equal(existsSync(current.archiveRoot),false);
const committed=run(["--commit","--output-root",current.archiveRoot]);assert.equal(committed.publication.published,4);const repeat=run(["--commit","--output-root",current.archiveRoot]);assert.equal(repeat.publication.published,0);assert.equal(repeat.publication.unchanged,4);
const archive=new TelegramMarkdownProjector({enabled:true,root:current.archiveRoot,rootId:"fixture"});const timeline=await archive.timeline({operation:"recent",limit:10});assert.equal(timeline.count,4);
const altered=await readFile(join(current.exportRoot,"messages.html"),"utf8");await writeFile(join(current.exportRoot,"messages.html"),altered+"changed");assert.throws(()=>run(["--commit","--output-root",current.archiveRoot]));
const project=join(current.root,"menu-project");const config=join(project,".fixture/telegram-owner");await mkdir(config,{recursive:true,mode:0o700});await writeFile(join(config,"config.json"),JSON.stringify({ownerUserId:7,privateChatId:70,tokenEnv:"FIXTURE_MENU_TOKEN"}),{mode:0o600});
const intercept=join(current.root,"intercept.mjs");await writeFile(intercept,'import assert from "node:assert/strict";globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);if(url==="https://api.telegram.org/botfixture-token/deleteMyCommands"){assert.deepEqual(body,{});return{ok:true,status:200,json:async()=>({ok:true,result:true})};}assert.equal(url,"https://api.telegram.org/botfixture-token/setMyCommands");assert.equal(body.commands.length,5);assert.deepEqual(Object.keys(body),["commands","scope"]);assert.deepEqual(body.scope,{type:"all_private_chats"});assert.deepEqual(body.commands.map(command=>command.command),["help","status","stop","compact","new"]);return{ok:true,status:200,json:async()=>({ok:true,result:true})};};');
const menu=join(process.cwd(),"node_modules/.bin/pi-telegram-register-menu");const output=execFileSync(menu,[project,"--config-dir",".fixture"],{encoding:"utf8",timeout:10000,env:{...process.env,FIXTURE_MENU_TOKEN:"fixture-token",NODE_OPTIONS:"--import="+intercept}});assert.match(output,/Registered the five/);assert.equal(existsSync(join(config,"state.jsonl")),false);assert.equal(existsSync(join(config,"poller.lock")),false);
const groupRoot=join(current.root,"group");const groupExport=join(groupRoot,"export");await mkdir(groupExport,{recursive:true,mode:0o700});
const groupPage='<div class="message default clearfix" id="message5"><div class="body"><div class="date details" title="2026-02-24T10:00:00Z"></div><div class="from_name">Owner</div><div class="text">hello group</div></div></div>';await writeFile(join(groupExport,"messages.html"),groupPage);
const groupCommand=join(process.cwd(),"node_modules/.bin/pi-telegram-group-import");assert.ok((await readFile(groupCommand,"utf8")).startsWith("#!/usr/bin/env node"));
const prepared=JSON.parse(execFileSync(groupCommand,["--export-root",groupExport],{encoding:"utf8",timeout:10000}));assert.deepEqual(prepared.placeholders,["Owner"]);
const groupArgs=["--export-root",groupExport,"--chat-id","-1001","--shared-root",join(groupRoot,"shared")];assert.throws(()=>execFileSync(groupCommand,groupArgs,{encoding:"utf8",timeout:10000,stdio:"pipe"}));
const speakersPath=join(prepared.controlDir,"group-speakers.json");const speakers=JSON.parse(await readFile(speakersPath,"utf8"));speakers.speakers.Owner={kind:"owner",userId:7};await writeFile(speakersPath,JSON.stringify(speakers),{mode:0o600});
const groupDry=JSON.parse(execFileSync(groupCommand,groupArgs,{encoding:"utf8",timeout:10000}));assert.equal(groupDry.mode,"dry-run");assert.equal(groupDry.imported,1);assert.equal(existsSync(join(groupRoot,"shared")),false);
const groupCommit=JSON.parse(execFileSync(groupCommand,[...groupArgs,"--commit"],{encoding:"utf8",timeout:10000}));assert.equal(groupCommit.imported,1);assert.ok(existsSync(join(groupRoot,"shared",".telegram-archive","events.jsonl")));
}finally{await rm(current.root,{recursive:true,force:true});}
