import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {createServer} from '../server.mjs';
import {localClient} from '../web/local-client.mjs';
import {questionChoices,renderQuestion} from '../web/question-choices.mjs';

test('실제 서버 재시작 후 동시 요청이 로컬 연결을 한 번 갱신하고 POST를 중복 실행하지 않는다',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'session-recovery-'));let server,store,base,sessions=0;
 async function start(){({server,store}=await createServer({directory,runtime:{close(){}}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;}
 try{
  await start();const client=localClient((route,options)=>{if(route==='/api/session')sessions++;return fetch(base+route,options);});await client.connect();
  await new Promise(r=>server.close(r));await start();
  const [models,post]=await Promise.all([client.request('/api/state'),client.request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'한 번만 생성'})})]);
  assert.equal(models.status,200);assert.equal(post.status,201);assert.equal(sessions,2);assert.equal((await store.load()).projects.filter(p=>p.name==='한 번만 생성').length,1);
  const denied=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':'expired'},body:JSON.stringify({name:'생성 금지'})});
  assert.equal(denied.status,401);assert.equal((await denied.json()).code,'LOCAL_SESSION_EXPIRED');assert.ok(!(await store.load()).projects.some(p=>p.name==='생성 금지'));
 }finally{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
test('접속 링크로 연결에 실패해도 다음 연결 시도는 새로 요청하고 첫 화면을 다시 시작한다',async()=>{
 let sessions=0;const c=localClient(async()=>{sessions++;return sessions===1?new Response('{}',{status:403}):Response.json({token:'t'});});
 await assert.rejects(c.connect(),/접속 링크/);await c.connect();assert.equal(sessions,2);
 const app=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');assert.match(app,/hashchange[\s\S]{0,160}if \(!state\) return boot\(\)/);
 assert.match(app,/intent-form[\s\S]{0,500}backend\?\.repository\) \{ await discoverApis\(answers\); return; \}/);
 const css=await readFile(new URL('../web/style.css',import.meta.url),'utf8');assert.match(css,/\.btn\.primary\.small \{\s*background: var\(--accent\)/);
});
test('Codex 인증 실패·실행 실패·네트워크 오류는 작업을 자동 재실행하지 않는다',async()=>{
 for(const [status,code] of [[401,'LOGIN_REQUIRED'],[500,'FAILED']]){let calls=0,sessions=0;const c=localClient(async route=>{if(route==='/api/session'){sessions++;return Response.json({token:'t'});}calls++;return Response.json({code,error:'인증 필요'},{status});});assert.equal((await c.request('/api/action',{method:'POST'})).status,status);assert.equal(calls,1);assert.equal(sessions,1);}
 let calls=0;const c=localClient(async route=>{if(route==='/api/session')return Response.json({token:'t'});calls++;throw new TypeError('network');});await assert.rejects(c.request('/api/action',{method:'POST'}),e=>e.code==='LOCAL_SERVICE_UNAVAILABLE');assert.equal(calls,1);
});
test('기존 답변은 별도 선택지로 보존하고 직접 입력란에 AI나 이전 답변을 미리 넣지 않는다',()=>{
 const choices=questionChoices({suggestions:['즉시 제외','다음 조회부터 제외'],value:'기존 답변'});
 const html=renderQuestion({index:0,text:'언제 제외할까요?',choices,value:'기존 답변'});
 assert.equal(choices.length,3);assert.match(html,/1안/);assert.match(html,/직접 입력/);assert.match(html,/다른 제안 보기/);assert.match(html,/textarea[^>]+hidden[^>]*><\/textarea>/);assert.match(html,/value="기존 답변" checked/);
 const custom=renderQuestion({index:0,text:'정책',choices,value:'직접 쓴 문장',custom:true,customText:'직접 쓴 문장'});assert.match(custom,/>직접 쓴 문장<\/textarea>/);assert.doesNotMatch(custom,/textarea[^>]*hidden/);
});
