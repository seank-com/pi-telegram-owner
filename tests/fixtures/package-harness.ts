import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";import {fileURLToPath} from "node:url";import type {TestContext} from "node:test";
import {piPackageRoot} from "../pi-host.ts";import {createQmdFixture} from "./qmd-fixture.ts";
const root=fileURLToPath(new URL("../../",import.meta.url));
export async function verifyPacked(t:TestContext,companions=false){
 const consumer=await mkdtemp(join(tmpdir(),"telegram-packed-"));t.after(()=>rm(consumer,{recursive:true,force:true}));
 const packed=JSON.parse(execFileSync("npm",["pack","--json","--pack-destination",consumer],{cwd:root,encoding:"utf8",timeout:30000}))[0];
 assert.ok(packed.files.every((file:any)=>/^(dist\/(cli\/)?[^/]+\.(js|d\.ts)|docs\/[^/]+\.md|README\.md|LICENSE|package\.json)$/.test(file.path)));
 const install=async(directory:string,tarball:string)=>{await mkdir(directory,{recursive:true});await writeFile(join(directory,"package.json"),JSON.stringify({private:true,type:"module"}));execFileSync("npm",["install","--cache",join(consumer,"npm-cache"),"--ignore-scripts","--legacy-peer-deps","--no-audit","--no-fund",tarball],{cwd:directory,stdio:"pipe",timeout:30000});};
 await install(consumer,join(consumer,packed.filename));await mkdir(join(consumer,"home"));await writeFile(join(consumer,"home/.env"),"");
 if(companions){await install(join(consumer,"datastore-owner"),process.env.DATASTORE_TARBALL!);await install(join(consumer,"observability-owner"),process.env.OBSERVABILITY_TARBALL!);await createQmdFixture(consumer);}
 await writeFile(join(consumer,"types.ts"),'import {TelegramArchiveImporter} from "@seank/pi-telegram-owner/importer";import {TelegramMarkdownProjector} from "@seank/pi-telegram-owner/archive";import {markdownToPlainText} from "@seank/pi-telegram-owner/format";void TelegramArchiveImporter;void TelegramMarkdownProjector;void markdownToPlainText;');
 // The archive declarations contain Pi type views; resolve only those host peers for
 // this isolated declaration check, without installing another runtime.
 const typeConfig={compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,target:"ES2023",module:"NodeNext",paths:{"@earendil-works/pi-coding-agent":[join(piPackageRoot(),"dist/index.d.ts")]},baseUrl:consumer},files:["types.ts"]};await writeFile(join(consumer,"tsconfig.json"),JSON.stringify(typeConfig));
 execFileSync(process.execPath,[join(root,"node_modules/typescript/bin/tsc"),"-p","tsconfig.json"],{cwd:consumer,stdio:"pipe",timeout:30000});
 for(const file of ["packed-probe.ts","cli-probe.ts"])await writeFile(join(consumer,file),await readFile(new URL(file,import.meta.url),"utf8"));
 execFileSync(process.execPath,[join(consumer,"cli-probe.ts")],{cwd:consumer,env:{...process.env,HOME:join(consumer,"home"),PI_CODING_AGENT_DIR:join(consumer,"profile")},stdio:"pipe",timeout:30000});
 execFileSync(process.execPath,[join(consumer,"packed-probe.ts")],{cwd:consumer,env:{...process.env,HOME:join(consumer,"home"),PI_CODING_AGENT_DIR:join(consumer,"profile"),TEST_PI_HOST:piPackageRoot(),TEST_COMPANIONS:companions?"1":""},stdio:"pipe",timeout:45000});
}
