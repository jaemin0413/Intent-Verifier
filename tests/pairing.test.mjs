import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginPairing } from "../lib/plugin-pairing.mjs";
import { Store } from "../lib/store.mjs";
import { createServer } from "../server.mjs";

test("연결 링크만으로 토큰을 얻을 수 없고 앱 확인 뒤 해당 프로젝트만 자동 연결한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "plugin-pair-"));
  const {server, store} = await createServer({directory, runtime:{close(){}}});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const localToken = (await fetch(base + "/api/session").then(r=>r.json())).token;
  const call = async (route, data, headers={}) => {
    const response = await fetch(base+route,{method:data?"POST":"GET",headers:{"Content-Type":"application/json",...headers},body:data?JSON.stringify(data):undefined});
    return {status:response.status,data:await response.json()};
  };
  const local = {"X-Local-Token":localToken};
  try {
    const project = (await call("/api/projects",{name:"두 번째 프로젝트"},local)).data;
    await call("/api/connect",{projectId:"local",repository:directory,controllerFolder:"src/first"},local);
    await call("/api/connect",{projectId:project.id,repository:directory,controllerFolder:"src/second"},local);
    const configurations = (await store.load()).projects;
    assert.equal(configurations.find(p=>p.id==="local").backend.controllerFolder,"src/first");
    assert.equal(configurations.find(p=>p.id===project.id).backend.controllerFolder,"src/second");
    const pair = (await call("/api/plugin/pair/start",{fileId:"fileOne",fileName:"기획",fileUrl:"https://www.figma.com/design/fileOne"})).data;
    const route = `/api/figma/pair/${pair.id}`;
    assert.equal((await call(route)).status,401);
    assert.equal((await call(route,{projectId:project.id})).status,401);
    assert.equal((await call(route,{projectId:project.id},{...local,Origin:"https://evil.test"})).status,400);
    assert.equal((await call("/api/plugin/pair/claim",{id:pair.id,claim:"wrong"})).status,400);
    assert.deepEqual((await call("/api/plugin/pair/claim",pair)).data,{status:"WAITING"});
    assert.equal((await call(route,undefined,local)).data.claim,undefined);
    assert.equal((await call(route,{projectId:project.id},local)).status,200);
    assert.equal((await call(route,{projectId:"local"},local)).status,400);
    const grant = (await call("/api/plugin/pair/claim",pair)).data;
    assert.equal(grant.status,"CONNECTED");
    assert.equal(grant.projectId,project.id);
    const plugin = {Authorization:`Bearer ${grant.token}`};
    const projects = (await call("/api/plugin/projects",undefined,plugin)).data.projects;
    assert.deepEqual(projects,[{id:project.id,name:project.name}]);
    assert.equal((await call("/api/plugin/library/begin",{projectId:"local"},plugin)).status,400);
    assert.equal((await call("/api/plugin/library/begin",{projectId:project.id,fileId:"other"},plugin)).status,400);
    assert.equal((await call("/api/plugin/scans",{projectId:"local"},plugin)).status,400);
    assert.equal((await new Store(directory).load()).pluginConnections[0].token,grant.token);
    assert.equal((await store.load()).projects.find(p=>p.id===project.id).figma.fileUrl,"https://www.figma.com/design/fileOne");
    assert.equal((await call(route,undefined,local)).data.token,undefined);
  } finally { await new Promise(r=>server.close(r)); await rm(directory,{recursive:true,force:true}); }
});

test("만료된 연결과 다른 파일의 프로젝트 덮어쓰기를 거절한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"pair-expiry-"));
  try {
    const store = new Store(directory); await store.init();
    let now=0;
    const pairing = new PluginPairing(store,()=>now);
    const first = pairing.start({fileId:"first",fileName:"동일 이름"});
    await pairing.approve(first.id,"local");
    const second = pairing.start({fileId:"second",fileName:"동일 이름"});
    await assert.rejects(pairing.approve(second.id,"local"),e=>e.code==="FIGMA_FILE_MISMATCH"&&/다른 Figma/.test(e.message));
    // Moving from a copy to the original keeps the project; only the old file's plugin tokens go.
    const oldToken=(await store.load()).pluginConnections[0].token;
    await pairing.approve(second.id,"local",{switchFile:true});
    const switched=await store.load();
    assert.equal(switched.projects[0].figma.fileId,"second");
    assert.equal(switched.projects[0].figma.previousFiles[0].fileId,"first");
    assert.deepEqual(switched.pluginConnections.map(c=>c.fileId),["second"]);
    assert.notEqual(switched.pluginConnections[0].token,oldToken);
    now=180001;
    assert.throws(()=>pairing.claim(first),/만료/);
    await assert.rejects(pairing.approve(second.id,"local"),/만료/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("플러그인 UI는 최초 앱 확인 후 프로젝트를 자동 선택하고 재실행 때 입력 없이 복원한다", async () => {
  const html=await readFile(new URL("../figma-plugin/ui.html",import.meta.url),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map([...html.matchAll(/id="([\w-]+)"/g)].map(([,id])=>[id,{value:"",style:{},options:[],add(o){this.options.push(o);},hidden:false}]));
  elements.get("base").value="http://localhost:4318";
  const requests=[],messages=[],timers=[];
  let confirmed=false;
  const scope={document:{getElementById:id=>elements.get(id)},window:{},parent:{postMessage:m=>messages.push(m)},URL,AbortSignal,
    Option:function(text,value){this.text=text;this.value=value;},setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout(){},
    fetch:async(url,options)=>{
      requests.push({url,options});
      const data=url.endsWith("/start")?{id:"pair",claim:"secret"}:url.endsWith("/claim")?(confirmed?{status:"CONNECTED",token:"scoped-token",projectId:"chosen"}:{status:"WAITING"}):{projects:[{id:"chosen",name:"선택한 프로젝트"}],features:[]};
      return {ok:true,json:async()=>data};
    }};
  vm.runInNewContext(script,scope);
  assert.equal(messages[0].pluginMessage.type,"ready");
  const file={fileId:"cloudFile",fileName:"기획",fileUrl:"https://www.figma.com/design/cloudFile"};
  await scope.window.onmessage({data:{pluginMessage:{type:"settings",settings:{},file}}});
  assert.match(messages.find(m=>m.pluginMessage.type==="open").pluginMessage.url,/#pair=pair$/);
  assert.equal(elements.get("sync").disabled,true);
  confirmed=true; await timers.shift()();
  assert.equal(elements.get("project").value,"chosen");
  assert.equal(elements.get("sync").disabled,false);
  const saved=messages.filter(m=>m.pluginMessage.type==="save").at(-1).pluginMessage.settings;
  assert.equal(saved.token,"scoped-token");
  requests.length=0;messages.length=0;
  await scope.window.onmessage({data:{pluginMessage:{type:"settings",settings:saved,file}}});
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/\/projects$/);
  assert.equal(messages.some(m=>m.pluginMessage.type==="open"),false);
  assert.equal(elements.get("connection").open,false);
  assert.equal(elements.get("project").value,"chosen");
  assert.doesNotMatch(html,/id="token"|source-file-url|개발 검증 연결 코드/);
});

test("파일 키와 링크를 자동 전달하고 연결 정보는 파일별로 저장한다", async () => {
  const code=await readFile(new URL("../figma-plugin/code.js",import.meta.url),"utf8");
  const storage=new Map(),metadata=new Map();
  async function run(fileKey) {
    const messages=[];
    const figma={fileKey,showUI(){},on(){},ui:{postMessage:m=>messages.push(m)},currentPage:{id:"page",selection:[]},root:{name:"같은 이름",children:[],getPluginData:k=>metadata.get(k)||"",setPluginData:(k,v)=>metadata.set(k,v)},clientStorage:{getAsync:async k=>storage.get(k),setAsync:async(k,v)=>storage.set(k,v)}};
    vm.runInNewContext(code,{figma,__html__:""});
    await figma.ui.onmessage({type:"ready"});
    return {figma,settings:messages.find(m=>m.type==="settings")};
  }
  const a=await run("cloudA");
  assert.equal(a.settings.file.fileUrl,"https://www.figma.com/design/cloudA");
  await a.figma.ui.onmessage({type:"save",settings:{token:"a",projectId:"a"}});
  assert.equal((await run("cloudA")).settings.settings.projectId,"a");
  assert.equal((await run("cloudB")).settings.settings.token,undefined);
  const noKey=await run(undefined);
  assert.match(noKey.settings.file.fileId,/^document-/);
  assert.equal(noKey.settings.file.fileUrl,undefined);
  assert.equal((await run(undefined)).settings.file.fileId,noKey.settings.file.fileId);
  const manifest=JSON.parse(await readFile(new URL("../figma-plugin/manifest.json",import.meta.url),"utf8"));
  assert.ok(manifest.id, "clientStorage를 사용하려면 고정 플러그인 ID가 필요합니다.");
  assert.equal(manifest.enablePrivatePluginApi,true);
});

test("Figma 저장소 읽기 실패가 최초 연결을 막지 않고 쓰기 실패도 숨기지 않는다", async () => {
  const code=await readFile(new URL("../figma-plugin/code.js",import.meta.url),"utf8");
  const messages=[];
  const figma={fileKey:"file",showUI(){},on(){},ui:{postMessage:m=>messages.push(m)},currentPage:{id:"page",selection:[]},root:{name:"기획",children:[]},clientStorage:{getAsync:async()=>{throw new Error("Cannot access client storage without a plugin ID");},setAsync:async()=>{throw new Error("write failed");}}};
  vm.runInNewContext(code,{figma,__html__:""});
  await figma.ui.onmessage({type:"ready"});
  const ready=messages.find(m=>m.type==="settings");
  assert.equal(ready.file.fileId,"file");
  assert.match(ready.storageError,/plugin ID/);
  await figma.ui.onmessage({type:"save",settings:{}});
  assert.equal(messages.at(-1).type,"storage-error");
});
