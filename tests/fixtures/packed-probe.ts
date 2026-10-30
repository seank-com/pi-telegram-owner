import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {basename,join,relative} from "node:path";import {pathToFileURL} from "node:url";
const project=process.cwd(),host=process.env.TEST_PI_HOST!;
for(const name of ["@earendil-works","typebox","@seank/pi-markdown-datastore","@seank/pi-observability"])assert.equal(existsSync(join(project,"node_modules",name)),false,name);
const packageRoot=join(project,"node_modules/@seank/pi-telegram-owner");
const {loadExtensions,clearExtensionCache}=await import(pathToFileURL(join(host,"dist/core/extensions/loader.js")).href);
const {createEventBus}=await import(pathToFileURL(join(host,"dist/core/event-bus.js")).href);
const pi=await import(pathToFileURL(join(host,"dist/index.js")).href);
const entry=join(packageRoot,"dist/index.js");
const inactive=await loadExtensions([entry],project,createEventBus());assert.deepEqual(inactive.errors,[]);assert.equal(inactive.extensions.length,1);assert.ok(inactive.extensions[0].tools.has("telegram_timeline"));
// The public default is safe with absent configuration: no poller, lock or journal.
inactive.runtime.getActiveTools=()=>[];inactive.runtime.setActiveTools=()=>{};
const noopCtx={ui:{setStatus(){}},sessionManager:{getBranch:()=>[],getSessionId:()=>"fixture"},isIdle:()=>true};
for(const handler of inactive.extensions[0].handlers.get("session_start")??[])await handler({reason:"startup"},noopCtx);
assert.equal(existsSync(join(project,".pi/telegram-owner")),false);
for(const handler of inactive.extensions[0].handlers.get("session_shutdown")??[])await handler({reason:"fixture"},noopCtx);
// Exercise the public projector export with interruption/model failure,
// lifecycle metadata and a later private turn, never live source data.
for (const failure of [false,true]) {
 const {TelegramMarkdownProjector}=await import('@seank/pi-telegram-owner/markdown-projector');
 const root=join(project,`packed-stop-archive-${failure}`),sessions=join(project,`packed-stop-sessions-${failure}`);await mkdir(sessions,{mode:0o700});
 const stamp='2026-09-22T01:00:00.000Z';
 const msg=(id:string,parentId:string|null,role:string,content:any)=>({type:'message',id,parentId,timestamp:stamp,message:{role,content,timestamp:Date.parse(stamp),...(role==='assistant'?{stopReason:id==='a1'?(failure?'error':'aborted'):'stop'}:{})}});
 const entries=[msg('u1',null,'user','[telegram-job:stop-packed]\nCompute.'),msg('a1','u1','assistant',failure?[]:[{type:'thinking',thinking:'Synthetic placeholder only.'}]),msg('u2','a1','user','[telegram-job:later-packed]\nLater.'),msg('a2','u2','assistant',[{type:'text',text:'Later answer.'}])];
 const file=join(sessions,'session.jsonl');await writeFile(file,[{type:'session',version:3,id:'packed-stop',timestamp:stamp,cwd:project},...entries].map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});const source=await readFile(file);
 const update=(jobId:string,text:string,id:number)=>({type:'update',schemaVersion:2,disposition:'accepted',updateId:id,jobId,text,rawText:text,messageId:id,chatId:70,userId:7,timestamp:stamp});
 const notice=failure?"Couldn't finish this: the model request failed.":'Stopped by /stop.';
 const terminal=failure?{type:'turn_failed',jobId:'stop-packed',code:'MODEL_ERROR',timestamp:stamp}:{type:'interrupted',jobId:'stop-packed',reason:'Stopped by Telegram owner command'};
 const journal:any[]=[update('stop-packed','Compute.',1),{type:'dispatched',jobId:'stop-packed',sessionId:'packed-stop'},terminal,{type:'task_output',taskId:'stop-packed',jobId:'stop-packed',mode:'terminal',disposition:'failed',timestamp:stamp},{type:'reply_ready',jobId:'stop-packed',text:notice},{type:'reply_sent',jobId:'stop-packed',messageIds:['11']},update('later-packed','Later.',2),{type:'dispatched',jobId:'later-packed',sessionId:'packed-stop'},{type:'reply_ready',jobId:'later-packed',text:'Later answer.'},{type:'reply_sent',jobId:'later-packed',messageIds:['12']}];
 const session:any={getSessionId:()=> 'packed-stop',getSessionFile:()=>file,getBranch:()=>entries};const append=async(r:any)=>{journal.push(r);};
 const projector=new TelegramMarkdownProjector({enabled:true,root,sessionRoot:sessions,rootId:'packed-fixture'});
 assert.deepEqual(await projector.reconcile(journal,session,append),{projected:4,unchanged:0,deferred:0});
 assert.deepEqual(await projector.reconcile(journal,session,append),{projected:0,unchanged:4,deferred:0});assert.deepEqual(await readFile(file),source);
 const timeline=await projector.timeline({operation:'recent',limit:10});assert.equal(timeline.messages!.length,4);assert.equal(timeline.messages!.find(m=>m.content===notice)?.messageId,'tgmsg:v1:telegram-job:stop-packed:local-response');assert.equal(timeline.messages!.some(m=>m.messageId==='tgmsg:v1:pi:packed-stop:a1'),false);
}
const wrapper=join(project,"wrapper.ts");
await writeFile(wrapper,`import {createTelegramOwnerExtension} from ${JSON.stringify(pathToFileURL(entry).href)};import {MemoryJournal} from ${JSON.stringify(pathToFileURL(join(packageRoot,"dist/core.js")).href)};import {TelegramMarkdownProjector} from ${JSON.stringify(pathToFileURL(join(packageRoot,"dist/markdown-projector.js")).href)};export default function(pi){globalThis.fixtureApi=pi;createTelegramOwnerExtension({projectRoot:process.cwd(),datastore:globalThis.fixturePolicy,projectionRefreshDebounceMs:5,dependencies:{journal:new MemoryJournal(),ownerUserId:7,privateChatId:70,agentLabel:'Fixture agent',markdownProjector:new TelegramMarkdownProjector({enabled:true,root:process.cwd(),rootId:'fixture'}),source:{async start(callback){globalThis.fixtureBatch=callback;return async()=>{globalThis.fixtureBatch=undefined;};}},async sendReply(text){globalThis.fixtureReplies.push(text);return '1';}}})(pi);}`);
async function start(paths:string[],policy:any){
 (globalThis as any).fixturePolicy=policy;(globalThis as any).fixtureReplies=[];clearExtensionCache();
 const settingsManager=pi.SettingsManager.inMemory({},{projectTrusted:true});const loader=new pi.DefaultResourceLoader({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:paths});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const sessionManager=pi.SessionManager.inMemory(project);const {session}=await pi.createAgentSession({cwd:project,agentDir:process.env.PI_CODING_AGENT_DIR,resourceLoader:loader,settingsManager,sessionManager});
 const errors:any[]=[];const statuses:any[]=[];await session.bindExtensions({onError:(error:any)=>errors.push(error),uiContext:{setStatus:(key:any,value:any)=>statuses.push([key,value])}});assert.deepEqual(errors,[]);
 return{session,sessionManager,loader,statuses,errors};
}
async function stop(state:any){await state.session.abort();for(const extension of state.loader.getExtensions().extensions)for(const handler of extension.handlers.get("session_shutdown")??[])await handler({reason:"fixture"},noopCtx);state.session.dispose();}
for(const mode of ["auto","off","required"]){const state=await start([wrapper],{mode,store:"telegram"});try{
 const active=state.session.getActiveToolNames();assert.ok(active.includes("telegram_timeline"));assert.equal(active.includes("telegram_recall"),mode==="required");
 await assert.rejects(state.session.getToolDefinition("telegram_recall").execute("fixture",{query:"prior"}),/CAPABILITY_UNAVAILABLE/);
 const timeline=await state.session.getToolDefinition("telegram_timeline").execute("fixture",{operation:"recent"});assert.equal(timeline.details.timezone,"UTC");
 await (globalThis as any).fixtureBatch([{update_id:1,message:{message_id:10,text:"/help",from:{id:7},chat:{id:70,type:"private"}}}]);assert.ok((globalThis as any).fixtureReplies.some((text:string)=>text.includes("/status")));
 if(mode==="required")assert.ok(state.statuses.some((row:any)=>String(row[1]).includes("CAPABILITY_UNAVAILABLE")));
}catch(error){console.error("Primary packed fixture failure",error);throw error;}finally{await stop(state);}}
if(process.env.TEST_COMPANIONS){
 const dsRoot=join(project,"datastore-owner/node_modules/@seank/pi-markdown-datastore"),obsRoot=join(project,"observability-owner/node_modules/@seank/pi-observability");
 const dsContract=await import(pathToFileURL(join(dsRoot,"dist/contract.js")).href),obsContract=await import(pathToFileURL(join(obsRoot,"dist/contract.js")).href);
 const local=await import(pathToFileURL(join(packageRoot,"dist/datastore.js")).href),activityWire=await import(pathToFileURL(join(packageRoot,"dist/observability.js")).href),activity=await import(pathToFileURL(join(packageRoot,"dist/activity.js")).href);
 assert.equal(local.CAPABILITY_REQUEST,dsContract.MARKDOWN_DATASTORE_CAPABILITY_REQUEST);assert.equal(local.CAPABILITY_REPLY,dsContract.MARKDOWN_DATASTORE_CAPABILITY_REPLY);assert.equal(local.REQUEST_EVENT,dsContract.MARKDOWN_DATASTORE_REQUEST_EVENT);assert.equal(activityWire.TOOL_INTENT_ENTRY_TYPE,obsContract.TOOL_INTENT_ENTRY_TYPE);assert.equal(activityWire.OBSERVABILITY_CONTRACT_VERSION,obsContract.OBSERVABILITY_CONTRACT_VERSION);
 const {createMarkdownDatastoreClient}=await import(pathToFileURL(join(dsRoot,"dist/client.js")).href);
 const configDir=join(project,".pi/markdown-datastore");await mkdir(configDir,{recursive:true,mode:0o700});
 const {TelegramMarkdownProjector}=await import(pathToFileURL(join(packageRoot,"dist/markdown-projector.js")).href);
 const projector=new TelegramMarkdownProjector({enabled:true,root:project,rootId:"fixture"});
 const evidence=join(project,"evidence");await mkdir(evidence,{mode:0o700});
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
 const photo=join(evidence,"source.png");await writeFile(photo,png);
 await writeFile(join(evidence,"source.html"),"<html>Original export evidence</html>\n");
 await writeFile(join(evidence,"session.jsonl"),'{"type":"session","version":3,"id":"source-session"}\n');
 await writeFile(join(evidence,"journal.jsonl"),'{"type":"fixture-source-evidence"}\n');
 const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
 await projector.publishImport([
  {messageId:"tgmsg:v1:telegram-export-history:root-boundary:1",identityKind:"telegram-export-history",direction:"in",markdown:"Prior decision",occurredAt:"2026-02-24T10:00:00Z",confidence:"historical-html-sequence",html:{page:"source.html",globalMessageOrdinal:1,pageSha256:sha(await readFile(join(evidence,"source.html")))},attachments:[{sourcePath:photo,sha256:sha(png),mimeType:"image/png",size:png.length}]},
  {messageId:"tgmsg:v1:telegram-export-history:root-boundary:2",identityKind:"telegram-export-history",direction:"out",markdown:"Acknowledged",occurredAt:"2026-02-24T10:01:00Z",confidence:"historical-html-sequence",html:{page:"source.html",globalMessageOrdinal:2,pageSha256:sha(await readFile(join(evidence,"source.html")))},attachments:[]},
 ],{sourceSetId:"root-boundary",sourceSetManifestSha256:sha("source-set"),speakerMapRevision:1,boundaryManifestSha256:sha("boundary")});
 const timeline=await projector.timeline({operation:"recent",limit:50});
 const first=timeline.messages.find((message:any)=>message.messageId==="tgmsg:v1:telegram-export-history:root-boundary:1");
 const second=timeline.messages.find((message:any)=>message.messageId==="tgmsg:v1:telegram-export-history:root-boundary:2");
 assert.ok(first&&second);assert.ok(first.path.startsWith("messages/"));
 const messageRoot=join(project,"messages"),messagePath=relative(messageRoot,join(project,first.path));
 assert.match(messagePath,/^2026\/02\/[^/]+\.md$/);
 const firstText=await readFile(join(project,first.path),"utf8"),secondText=await readFile(join(project,second.path),"utf8");
 assert.ok(secondText.includes(`Previous: [[${basename(first.path,".md")}]]`));
 const imageLink=/!\[\[([^|\]]+)\|512\]\]/.exec(firstText);assert.ok(imageLink,"canonical message retains its attachment wikilink");
 const attachmentPath=join(messageRoot,"_attachments",imageLink[1]);
 assert.ok(firstText.includes(`path: messages/_attachments/${imageLink[1]}`),"attachment provenance remains projection-relative");
 assert.deepEqual(await readFile(attachmentPath),png);
 await writeFile(join(project,"sibling.md"),"# Unrelated project note\nWorkspace-only boundary marker\n");
 const sharedRoot=join(project,"shared-group");await mkdir(sharedRoot,{mode:0o700});await writeFile(join(sharedRoot,"room.md"),"# Shared group source\n");
 async function snapshot(root:string,prefix=""):Promise<Record<string,string>>{
  const result:Record<string,string>={};
  for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
   const path=join(prefix,entry.name);
   if(entry.isDirectory())Object.assign(result,await snapshot(root,path));
   else if(entry.isFile())result[path]=(await readFile(join(root,path))).toString("base64");
  }
  return result;
 }
 const sourceSnapshot=await snapshot(evidence),messageSnapshot=await snapshot(messageRoot);
 const config={schemaVersion:1,defaults:{maxResultBytes:12288,maxResultLines:300,operationTimeoutMs:3000},qmd:{enabled:true,installation:{packageRoot:join(project,"synthetic-qmd")},minimumVersion:"2.8.3"},stores:{telegram:{root:"messages",include:["**/*.md"],exclude:[],maxFileBytes:16384,search:{defaultMode:"hybrid",qmdCollection:"telegram"}}}};
 const datastoreEntry=join(dsRoot,"dist/index.js"),obsEntry=join(obsRoot,"dist/index.js");
 // Establish the old projection-relative citation before changing only datastore config.
 const broad={...config,qmd:{...config.qmd,enabled:false},stores:{...config.stores,telegram:{...config.stores.telegram,root:".",include:["messages/**/*.md"]}}};
 await writeFile(join(configDir,"config.json"),JSON.stringify(broad),{mode:0o600});
 const beforeNarrowing=await start([wrapper,datastoreEntry],{mode:"off",store:"telegram"});
 try{
  const client=createMarkdownDatastoreClient((globalThis as any).fixtureApi.events,{timeoutMs:5000});
  assert.equal((await client.find({store:"telegram",selectors:[{kind:"path",path:first.path}]})).data.candidates.length,1);
  assert.match((await client.read({note:{store:"telegram",path:first.path}})).data.content,/Prior decision/);
 }finally{await stop(beforeNarrowing);}
 await writeFile(join(configDir,"config.json"),JSON.stringify(config),{mode:0o600});
 for(const mode of ["auto","required"]) for(const order of [[wrapper,datastoreEntry,obsEntry],[obsEntry,datastoreEntry,wrapper]]){
  const state=await start(order,{mode,store:"telegram"});const api=(globalThis as any).fixtureApi;const client=createMarkdownDatastoreClient(api.events,{timeoutMs:5000});
  try{
   assert.ok(state.session.getActiveToolNames().includes("telegram_recall"));
   const startupDeadline=Date.now()+5000;let status:any;do{status=await client.status({store:"telegram"});if(status.data.stores[0].sourceReconciliation.state==="succeeded")break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<startupDeadline);
   assert.equal(status.data.stores[0].sourceReconciliation.state,"succeeded",JSON.stringify(status.data));
   const receipt=await client.refresh({action:"start",store:"telegram",mode:"semantic"});const refreshId=receipt.data.qmd.refreshId;assert.ok(refreshId);
   const deadline=Date.now()+5000;do{status=await client.status({store:"telegram"});const job=status.data.stores[0].sourceReconciliation.job;if(job?.refreshId===refreshId&&job.state==="succeeded")break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
   assert.equal(status.data.stores[0].sourceReconciliation.job?.refreshId,refreshId);assert.equal(status.data.stores[0].sourceReconciliation.job?.state,"succeeded",JSON.stringify(status.data));
   const recalled=await state.session.getToolDefinition("telegram_recall").execute("recall-fixture",{query:"Prior",limit:2});assert.equal(recalled.details.returned,1);
   const hit=JSON.parse(recalled.content[0].text).data.hits[0];assert.equal(hit.path,messagePath);assert.equal(hit.note.path,messagePath);assert.equal(hit.uri,`datastore://telegram/${messagePath}`);
   assert.equal((await client.find({store:"telegram",selectors:[{kind:"path",path:messagePath}]})).data.candidates[0].uri,hit.uri);
   const read=await client.read({uri:hit.uri});assert.match(read.data.content,/Prior decision/);assert.ok(read.data.content.includes(imageLink[1]));
   assert.deepEqual((await client.find({store:"telegram",selectors:[{kind:"path",path:first.path}]})).data.candidates,[],"old parent-relative references must be re-found, not relabeled");
   await assert.rejects(client.read({note:{store:"telegram",path:"../sibling.md"}}),(error:any)=>error.code==="INVALID_NOTE_REF");
   assert.deepEqual((await client.find({store:"telegram",selectors:[{kind:"path",path:"sibling.md"}]})).data.candidates,[]);
   assert.equal((await client.search({store:"telegram",query:"Workspace-only boundary marker",mode:"lexical"})).data.returned,0);
   assert.equal((await client.search({store:"telegram",query:"Shared group source",mode:"lexical"})).data.returned,0);
   const liveTimeline=await state.session.getToolDefinition("telegram_timeline").execute("root-timeline",{operation:"recent",limit:50});assert.ok(JSON.parse(liveTimeline.content[0].text).messages.some((message:any)=>message.path===first.path));
   const integration=local.createDatastoreIntegration(api.events,()=>({mode:"auto",store:"telegram"}),1000);integration.start();assert.equal((await integration.service.refresh({action:"start",store:"telegram",mode:"lexical"})).operation,"refresh");integration.stop();
   const lexicalDeadline=Date.now()+5000;do{status=await client.status({store:"telegram"});if(status.data.stores[0].sourceReconciliation.state==="succeeded")break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<lexicalDeadline);assert.equal(status.data.stores[0].sourceReconciliation.state,"succeeded");
   // Actual owner persists the intent before Telegram consumes it.
   const owner=state.loader.getExtensions().extensions.find((extension:any)=>extension.path===obsEntry);const branch:any[]=[];const ctx={sessionManager:{getBranch:()=>branch}};
   const loaded=state.loader.getExtensions();const original=loaded.runtime.appendEntry;loaded.runtime.appendEntry=(customType:string,data:any)=>branch.push({type:"custom",customType,data});
   for(const handler of owner.handlers.get("context_with_system")??[])await handler({messages:[{role:"system",content:"Inspect",toolsAdded:[{name:"read",parameters:{type:"object",properties:{},required:[]}}],timestamp:0}]},ctx);
   for(const handler of owner.handlers.get("before_provider_request")??[])await handler({payload:{model:"fixture",stream:true,store:false,instructions:"Inspect",input:[],tools:[{type:"function",name:"read",parameters:{type:"object",properties:{},required:[]}}]}},ctx);
   for(const handler of owner.handlers.get("message_end")??[])await handler({message:{role:"assistant",content:[{type:"toolCall",id:"audited-fixture",name:"read",arguments:{intent:"Inspect the prior decision."}}]}},ctx);
   assert.equal(activity.formatTelegramToolActivity(branch,"audited-fixture","read"),"Inspect the prior decision.");assert.equal(activity.formatTelegramToolActivity([],"missing","read"),"Using read…");loaded.runtime.appendEntry=original;
   // Service teardown revokes captured availability before a new operation.
   const datastore=state.loader.getExtensions().extensions.find((extension:any)=>extension.path===datastoreEntry);for(const handler of datastore.handlers.get("session_shutdown")??[])await handler({},noopCtx);
   await assert.rejects(state.session.getToolDefinition("telegram_recall").execute("after-stop",{query:"Prior"}),/CAPABILITY_UNAVAILABLE/);
   await state.session.extendResourcesFromExtensions("reload");assert.equal(state.session.getActiveToolNames().includes("telegram_recall"),mode==="required");
   for(const handler of datastore.handlers.get("session_start")??[])await handler({reason:"reload"},{cwd:project,isProjectTrusted:()=>true,ui:{setStatus(){}}});
   await state.session.extendResourcesFromExtensions("reload");assert.ok(state.session.getActiveToolNames().includes("telegram_recall"));
   assert.equal((await state.session.getToolDefinition("telegram_recall").execute("after-restart",{query:"Prior"})).details.returned,1);
  }finally{await stop(state);}
 }
 const off=await start([wrapper,datastoreEntry],{mode:"off",store:"telegram"});try{assert.equal(off.session.getActiveToolNames().includes("telegram_recall"),false);await assert.rejects(off.session.getToolDefinition("telegram_recall").execute("off",{query:"Prior"}),/CAPABILITY_UNAVAILABLE/);}finally{await stop(off);}
 const absent=await start([wrapper,datastoreEntry],{mode:"auto",store:"another"});try{assert.equal(absent.session.getActiveToolNames().includes("telegram_recall"),false);await assert.rejects(absent.session.getToolDefinition("telegram_recall").execute("mismatch",{query:"Prior"}),/CAPABILITY_UNAVAILABLE/);}finally{await stop(absent);}
 assert.deepEqual(await snapshot(evidence),sourceSnapshot,"source export, media, sessions and journal bytes stay unchanged");
 assert.deepEqual(await snapshot(messageRoot),messageSnapshot,"message bytes, predecessor links, media and projection metadata stay in place");
}
