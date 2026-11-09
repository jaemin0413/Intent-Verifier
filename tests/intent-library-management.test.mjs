import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {backendQuestions} from "../web/intent-questions.mjs";
import {buildIntent,replaceDraft,approveFeature} from "../lib/store.mjs";
import {ScreenLibrary} from "../lib/screen-library.mjs";
import {createServer} from "../server.mjs";

test("프론트 질문을 제외해도 기존 답변 인덱스와 승인 전 서버 정책은 유지한다",async()=>{
  const analysis={supportedCandidate:false,mode:"codex",summary:"로그인",questions:["자동 로그인 유지 기간은?","어떤 화면으로 이동하나요?","다른 로그인 수단을 기존 계정에 연결할 수 있나요?","오류 문구는?"],questionScopes:["backend","frontend","backend","frontend"]};
  assert.deepEqual(backendQuestions(analysis).map(q=>q.index),[0,2]);
  const f={id:"login",name:"로그인",analysis,history:[]};
  const answers={extraAnswers:["미정","비밀번호 찾기","연결 허용","오류"]};
  const draft=await buildIntent(f,answers);replaceDraft(f,draft);f.answers=answers;
  assert.equal(draft.contract.status,"UNRESOLVED");assert.equal(draft.contract.path,undefined);
  assert.equal(draft.scenarios.length,0);assert.equal(draft.requirements[0].conditions.length,2);
  assert.match(draft.requirements[0].conditions[1].description,/연결 허용/);
  assert.doesNotMatch(JSON.stringify(draft),/비밀번호 찾기|오류 문구|posts|403/);
  assert.throws(()=>approveFeature(f,1),/실행 검증/);
  const noQuestions=await buildIntent({...f,analysis:{...analysis,questions:[]}},{extraAnswers:[]});
  assert.ok(noQuestions.requirements[0].conditions.length);assert.equal(noQuestions.scenarios.length,0);
});

test("기존 문자열 질문도 표시 방식은 제외하며 기간과 계정 정책은 유지한다",()=>{
  const a={questions:["자동로그인 유지 기간은 며칠로 확정할까요?","‘비밀번호를 잊어버리셨나요?’를 누르면 어떤 화면이나 절차로 이어져야 하나요?","로그인 실패시 어떤 안내 문구를 보여줄까요?","다른 수단을 선택하면 어떤 안내와 다음 행동을 제공할까요?","여러 오류 문구를 하나만 보여줄까요?","동일 계정에 다른 로그인 수단을 연결할 수 있나요?"]};
  assert.deepEqual(backendQuestions(a).map(q=>q.index),[0,5]);
});

test("보관함 삭제·재동기화·복구는 프로젝트 격리와 이전 원문을 유지한다",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"library-manage-"));
  const {server,store}=await createServer({directory:dir,runtime:{close(){}}});
  const lib=new ScreenLibrary(dir);
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await fetch(base+"/api/session").then(r=>r.json());
  const post=(route,body)=>fetch(base+route,{method:"POST",headers:{"X-Local-Token":token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const metadata={fileId:"file",pages:[{id:"p",name:"페이지"}],screenIds:["1","2"],contexts:[{pageId:"p",nodes:[]}],scope:{kind:"selection"}};
  const sync=async()=>{const session=await lib.begin("local",metadata);for(const id of metadata.screenIds)await lib.put("local",session.id,{id,pageId:"p",name:id,node:{id,name:id,type:"FRAME"}});await lib.complete("local",session.id);};
  try {
    await sync();const scan=await lib.scan("local",["1"],1);
    const before=JSON.stringify(await store.load());
    const running=await lib.begin("local",metadata);
    assert.equal((await post('/api/projects/local/library/remove',{screenIds:["1"],revision:1})).status,200);
    assert.equal(JSON.stringify(await store.load()),before);
    let view=await lib.listing("local");assert.deepEqual(view.screens.map(s=>s.id),["2"]);assert.equal(view.removed[0].id,"1");
    assert.equal(await lib.changed("local",scan.library),false);
    await assert.rejects(lib.scan("local",["1"],2),/복구/);
    assert.equal((await post('/api/projects/local/library/restore',{screenIds:["1"],revision:1})).status,400);
    assert.equal((await post('/api/projects/missing/library/remove',{screenIds:["2"],revision:2})).status,400);
    for(const id of metadata.screenIds)await lib.put("local",running.id,{id,pageId:"p",name:id,node:{id,name:id,type:"FRAME"}});
    await assert.rejects(lib.complete("local",running.id),/다른 동기화/);
    await sync();view=await lib.listing("local");assert.deepEqual(view.screens.map(s=>s.id),["2"]);
    assert.equal((await post('/api/projects/local/library/restore',{screenIds:["1"],revision:view.revision})).status,200);
    view=await lib.listing("local");assert.equal(view.screens.length,2);
    assert.equal((await lib.scan("local",["1"],view.revision)).nodes[0].children[0].id,"1");
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
