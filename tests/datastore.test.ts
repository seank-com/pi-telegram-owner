import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CAPABILITY_REQUEST,CAPABILITY_REPLY,REQUEST_EVENT,createDatastoreIntegration,parseDatastorePolicy,queryCapability } from "../src/datastore.ts";
function fixture(policy:any={mode:"auto",store:"telegram"},timeout=50){
 const emitter=new EventEmitter();const bus={on:(name:string,fn:any)=>{emitter.on(name,fn);return()=>emitter.off(name,fn);},emit:(name:string,value:any)=>emitter.emit(name,value)};
 let ready=true,stores=["telegram"];const off=bus.on(CAPABILITY_REQUEST,(value:any)=>bus.emit(CAPABILITY_REPLY,{version:1,requestId:value.requestId,capability:{version:1,contractVersion:1,get ready(){return ready},get stores(){return stores}}}));
 const integration=createDatastoreIntegration(bus,()=>policy,timeout);integration.start();
 return{bus,emitter,integration,off,setReady:(value:boolean)=>{ready=value},setStores:(value:string[])=>{stores=value}};
}
const input={store:"telegram",query:"fixture",mode:"hybrid" as const,limit:5,includeContent:true as const};
function result(store="telegram"){return{contractVersion:1,operation:"search",store,data:{hits:[],returned:0},provenance:{sources:[]},bounds:{},warnings:[]};}
test("policy defaults, strict modes and exact namespaces",()=>{assert.deepEqual(parseDatastorePolicy(undefined),{mode:"auto",store:"telegram"});for(const mode of ["auto","off","required"])assert.equal(parseDatastorePolicy({mode}).mode,mode);for(const value of [null,"auto",{mode:"bad"},{store:"../other"},{mode:1},{unknown:true}])assert.throws(()=>parseDatastorePolicy(value));});
test("absent, incompatible, unavailable, duplicate and wrong store never send RPC",async()=>{
 for(const mode of ["auto","required"]){const f=fixture({mode,store:"telegram"});let rpc=0;f.bus.on(REQUEST_EVENT,()=>rpc++);
 f.off();assert.equal(f.integration.available(),false);await assert.rejects(f.integration.service.search(input),/CAPABILITY_UNAVAILABLE/);
 const off=f.bus.on(CAPABILITY_REQUEST,(v:any)=>f.bus.emit(CAPABILITY_REPLY,{version:1,requestId:v.requestId,capability:{version:2,contractVersion:1,ready:true,stores:["telegram"]}}));assert.equal(queryCapability(f.bus),undefined);off();assert.equal(rpc,0);}
 const f=fixture();f.setReady(false);assert.equal(f.integration.available(),false);f.setReady(true);f.setStores(["other"]);await assert.rejects(f.integration.service.search(input),/CAPABILITY_UNAVAILABLE/);f.setStores(["telegram"]);const duplicate=f.bus.on(CAPABILITY_REQUEST,(v:any)=>f.bus.emit(CAPABILITY_REPLY,{version:1,requestId:v.requestId,capability:{version:1,contractVersion:1,ready:true,stores:["telegram"]}}));assert.equal(queryCapability(f.bus),undefined);duplicate();assert.equal(f.emitter.listenerCount(CAPABILITY_REPLY),0);
});
test("off mode never discovers or requests a service",async()=>{const f=fixture({mode:"off",store:"telegram"});let queries=0;f.bus.on(CAPABILITY_REQUEST,()=>queries++);assert.equal(f.integration.available(),false);await assert.rejects(f.integration.service.search(input),/CAPABILITY_UNAVAILABLE/);assert.equal(queries,0);});
test("exact store and bounded deadline propagate, malformed or mismatched results refuse",async()=>{const f=fixture();f.bus.on("pi-markdown-datastore:v1:request",(value:any)=>{assert.equal(value.request.input.store,"telegram");assert.ok(value.deadline-Date.now()<=50);value.resolve(result());});assert.equal((await f.integration.service.search(input)).data.returned,0);await assert.rejects(f.integration.service.search({...input,store:"other"}),/CAPABILITY_UNAVAILABLE/);
 for(const value of [result("other"),{}, {...result(),data:{hits:null}}]){const f=fixture();f.bus.on(REQUEST_EVENT,(v:any)=>v.resolve(value));await assert.rejects(f.integration.service.search(input),/BACKEND_OUTPUT_INVALID/);}
});
test("timeout cancels the parent-owned RPC and discards late results",async()=>{const f=fixture(undefined,15);let envelope:any;f.bus.on(REQUEST_EVENT,(v:any)=>{envelope=v});const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(f.integration.service.search(input),/TIMEOUT/);assert.equal(envelope.signal.aborted,true);envelope.resolve(result());}finally{clearTimeout(keepAlive)}});
test("caller cancellation, teardown, restart and revocation enforce request ownership",async()=>{const f=fixture();let envelope:any;f.bus.on(REQUEST_EVENT,(v:any)=>{envelope=v});let controller=new AbortController();let pending=f.integration.service.search(input,controller.signal);controller.abort();await assert.rejects(pending,/CANCELLED/);assert.equal(envelope.signal.aborted,true);
 pending=f.integration.service.search(input);f.integration.stop();await assert.rejects(pending,/CANCELLED/);assert.equal(envelope.signal.aborted,true);await assert.rejects(f.integration.service.search(input),/CAPABILITY_UNAVAILABLE/);f.integration.start();assert.equal(f.integration.available(),true);f.setReady(false);await assert.rejects(f.integration.service.search(input),/CAPABILITY_UNAVAILABLE/);f.setReady(true);f.bus.on(REQUEST_EVENT,(v:any)=>v.resolve(result()));assert.equal((await f.integration.service.search(input)).data.returned,0);});
