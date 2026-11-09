import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {LocalAnalysisRuntime,CodexRuntime,classifyCodexError,redactDiagnostic} from "../lib/codex.mjs";
import {createServer} from "../server.mjs";

test("Codex 오류는 원인별 안내로 분류하며 비밀값을 진단에서 제거한다",()=>{
  for(const [input,code] of [["Analysis timeout","TIMEOUT"],["stream disconnected","NETWORK_ERROR"],["model not supported","MODEL_UNAVAILABLE"],["context window exceeded","INPUT_TOO_LARGE"],["JSON parse error","INVALID_OUTPUT"]]) assert.equal(classifyCodexError(new Error(input)).code,code);
  assert.doesNotMatch(redactDiagnostic('Bearer abc123 access_token="secret" sk-proj-abcdef'),/abc123|secret|abcdef/);
});

test("선택 모델을 실제 thread와 turn 요청에 전달하고 실패 원문을 로그에 보존한다",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"codex-model-"));
  const r=new CodexRuntime({timeout:10});r.logDirectory=directory;
  r.status=async()=>({status:"CONNECTED"});r.models=async()=>({models:[{id:"chosen",effort:"low"}],defaultModel:"chosen"});
  const calls=[];
  r.request=async(method,params)=>{calls.push({method,params});if(method==="thread/start")return {thread:{id:"thread"},model:params.model};if(method==="turn/start")return {turn:{id:"turn"}};return {};};
  try {
    let failure;
    try {await r.analyze({nodes:[],images:[],schema:{},instructions:"",model:"chosen"});}catch(e){failure=e;}
    assert.equal(failure.code,"TIMEOUT");
    assert.equal(calls.find(c=>c.method==="thread/start").params.model,"chosen");
    assert.equal(calls.find(c=>c.method==="turn/start").params.model,"chosen");
    assert.equal(calls.find(c=>c.method==="turn/start").params.effort,"low");
    const log=JSON.parse(await readFile(path.join(directory,failure.diagnosticId+".json"),"utf8"));
    assert.equal(log.model,"chosen");assert.equal(log.events.at(-1).error,"Analysis timeout");
    await assert.rejects(r.analyze({nodes:[],images:[],schema:{},instructions:"",model:"missing"}),e=>e.code==="MODEL_UNAVAILABLE");
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("모델 설정 API는 지원 모델만 저장하고 분석 시작 시 선택을 고정한다",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"codex-model-api-"));let resolve,input;
  const runtime={models:async()=>({models:[{id:"one",name:"One"},{id:"two",name:"Two"}],defaultModel:"one"}),analyze:async i=>{input=i;return new Promise(r=>resolve=r);},close(){}};
  const {server,store}=await createServer({directory,runtime});await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await fetch(base+"/api/session").then(r=>r.json());
  const api=(route,data)=>fetch(base+route,{method:data?"POST":"GET",headers:{"X-Local-Token":token,"Content-Type":"application/json"},body:data?JSON.stringify(data):undefined});
  try {
    assert.equal((await api("/api/settings",{model:"invalid"})).status,400);
    assert.equal((await api("/api/settings",{model:"two"})).status,200);
    const scan=JSON.parse(await readFile(new URL("../examples/figma-scan.json",import.meta.url),"utf8"));
    const added=await (await api("/api/scans",{projectId:"local",scan})).json();
    for(let i=0;!input&&i<1000;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(input.model,"two");
    await api("/api/settings",{model:"one"});assert.equal(input.model,"two");
    resolve({result:{featureName:"테스트",summary:"",findings:[],questions:[],policyHint:"unknown",deniedHint:"unknown"},evidence:{model:"two"}});
    for(let i=0;i<1000;i++){if((await store.load()).features.find(f=>f.id===added.feature.id)?.analysisStatus==="DONE")break;await new Promise(r=>setTimeout(r,5));}
    const completed=(await store.load()).features.find(f=>f.id===added.feature.id); assert.equal(completed.analysisStatus,"DONE",JSON.stringify(completed.analysisError)); assert.equal(completed.analysis.execution.model,"two");
  }finally{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

test("분석마다 공식 런타임 세션을 분리하고 성공·실패 시 종료한다",async()=>{
 const created=[];const r=new LocalAnalysisRuntime({sessionFactory:()=>{const session={closed:false,close(){this.closed=true;},async analyze(input){if(input.fail)throw Error('failure');return input;}};created.push(session);return session;}});r.logDirectory='diagnostics';
 assert.deepEqual(await r.analyze({model:'chosen'}),{model:'chosen'});await assert.rejects(r.analyze({fail:true}));assert.equal(created.length,2);assert.ok(created.every(s=>s.closed&&s.logDirectory==='diagnostics'));assert.equal(r.sessions.size,0);r.close();
});
