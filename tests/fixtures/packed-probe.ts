import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";import {pathToFileURL} from "node:url";
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
 const configDir=join(project,".pi/markdown-datastore");await mkdir(configDir,{recursive:true,mode:0o700});await mkdir(join(project,"notes"));await writeFile(join(project,"notes/alpha.md"),"# Fixture\nPrior decision\n");
 const config={schemaVersion:1,defaults:{maxResultBytes:4096,maxResultLines:100,operationTimeoutMs:3000},qmd:{enabled:true,installation:{packageRoot:join(project,"synthetic-qmd")},minimumVersion:"2.8.3"},stores:{telegram:{root:"notes",include:["**/*.md"],exclude:[],maxFileBytes:4096,search:{defaultMode:"hybrid",qmdCollection:"telegram"}}}};
 await writeFile(join(configDir,"config.json"),JSON.stringify(config),{mode:0o600});
 const datastoreEntry=join(dsRoot,"dist/index.js"),obsEntry=join(obsRoot,"dist/index.js");
 for(const mode of ["auto","required"]) for(const order of [[wrapper,datastoreEntry,obsEntry],[obsEntry,datastoreEntry,wrapper]]){
  const state=await start(order,{mode,store:"telegram"});const api=(globalThis as any).fixtureApi;const client=createMarkdownDatastoreClient(api.events,{timeoutMs:5000});
  try{
   assert.ok(state.session.getActiveToolNames().includes("telegram_recall"));
   const receipt=await client.refresh({action:"start",store:"telegram",mode:"semantic"});const refreshId=receipt.data.qmd.refreshId;assert.ok(refreshId);
   const deadline=Date.now()+5000;let status:any;do{status=await client.status({store:"telegram"});if(typeof status.data.stores[0].qmd?.semanticAt==="string")break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
   assert.ok(typeof status.data.stores[0].qmd?.semanticAt==="string");
   const recalled=await state.session.getToolDefinition("telegram_recall").execute("recall-fixture",{query:"Prior",limit:2});assert.equal(recalled.details.returned,1);assert.match(recalled.content[0].text,/alpha.md/);
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
}
