import {indexProperties,indexResponse} from './fixtures/notion-metadata.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {approve} from '../lib/domain.mjs';
import {canPublishAutomatically} from '../lib/notion-publication-policy.mjs';
import {NotionPublisher} from '../lib/notion-publisher.mjs';
const spec=approve(JSON.parse(await readFile(new URL('../examples/post-delete.json',import.meta.url),'utf8')));

test('승인 명세는 검사 전과 실패·준비 막힘에도 작성하고 다른 버전 결과는 거절한다',async()=>{
 let calls=0;const {state,publisher}=setup(async()=>{calls++;return {ok:true,json:async()=>({id:'manual-page',url:'https://notion.so/manual-page'})};});
 for(const status of ['FAIL','BLOCKED','UNVERIFIED']){
   const report=structuredClone(passed);report.results[0].status=status;report.counts.PASS--;report.counts[status]++;
   await publisher.automatic('f',report);assert.equal(calls,1);
 }
 assert.equal(canPublishAutomatically(state.features[0]),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,results:[]},state.runs),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,coverage:[{totalConditions:22,verifiedConditions:1}]},state.runs),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,coverage:[]},state.runs),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,exitCode:1},state.runs),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,originalUnchanged:false},state.runs),true);
 assert.equal(canPublishAutomatically(state.features[0],{...passed,specDigest:'older'},state.runs),false);
 state.runs.unshift({...passed,id:'new-failed'});await publisher.automatic('f',passed);assert.equal(calls,1);
 await publisher.automatic('f');assert.equal(calls,1);
 await publisher.publish('f');assert.equal(calls,1);assert.equal(state.features[0].notionPublication.status,'DONE');
});
const passed={id:'run-1',featureId:'f',specDigest:spec.approval.digest,exitCode:0,originalUnchanged:true,coverage:[{totalConditions:2,verifiedConditions:2}],results:spec.scenarios.map(s=>({scenarioId:s.id,status:'PASS'})),counts:{PASS:spec.scenarios.length,FAIL:0,BLOCKED:0,UNVERIFIED:0}};
function setup(fetchImpl){const state={runs:[passed],projects:[{id:'p',notion:{parentId:'a'.repeat(32)}}],features:[{id:'f',projectId:'p',spec:structuredClone(spec)}]};let token='test-only';const store={async load(){return structuredClone(state);},async secrets(){return {notionToken:token};},async mutate(fn){return fn(state);}};return {state,publisher:new NotionPublisher(store,async(url,opts)=>{const index=indexResponse(url,opts);if(index)return index;if(url.includes('/blocks/')&&opts.method==='PATCH')return {ok:true,json:async()=>({results:[{id:'owned-block'}]})};if(opts.method==='GET'){let data;if(url.includes('/databases/'))data={id:'db',url:'https://notion.so/db',data_sources:[{id:'ds'}]};else if(url.includes('/templates'))data={templates:[]};else data={id:'ds',properties:indexProperties('title')};return {ok:true,json:async()=>data};}const result=await fetchImpl(url,opts);if(!result.json)result.json=async()=>({});return result;}),clearToken(){token='';}};}
test('승인 명세 자동 저장, 동시 실행과 재검사 중복 발행 방지',async()=>{
 let calls=0;const {state,publisher}=setup(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {ok:true,json:async()=>({id:'page',url:'https://notion.so/page'})};});
 await Promise.all([publisher.automatic('f',passed),publisher.automatic('f',passed)]);await publisher.automatic('f',passed);
 assert.equal(calls,1);assert.equal(state.features[0].notionPublication.status,'DONE');
 state.projects[0].notion.parentId='b'.repeat(32);await publisher.automatic('f',passed);assert.equal(calls,2);
 state.projects[0].notion.parentId='a'.repeat(32);await publisher.automatic('f',passed);assert.equal(calls,2);assert.equal(state.features[0].notionPublication.parentId,'a'.repeat(32));
});
test('Notion 실패 상태를 남기며 검사 흐름을 중단하지 않고 재전송 가능',async()=>{
 let calls=0;const {state,publisher}=setup(async()=>++calls===1?{ok:false,status:403}:{ok:true,json:async()=>({id:'page',url:'https://notion.so/page'})});
 assert.equal(await publisher.automatic('f',passed),null);assert.equal(state.features[0].notionPublication.status,'ERROR');assert.match(state.features[0].notionPublication.message,/연결/);
 assert.equal(Object.keys(state.features[0].publications||{}).length,0);
 await publisher.publish('f');assert.equal(state.features[0].notionPublication.status,'DONE');
});
test('설정 없는 프로젝트, 예제, 미승인 문서는 자동 발행하지 않는다',async()=>{
 let calls=0;const {state,publisher,clearToken}=setup(async()=>{calls++;throw Error('must not send');});
 state.features[0].demo=true;await publisher.automatic('f',passed);delete state.features[0].demo;
 delete state.features[0].spec.approval;await assert.rejects(publisher.publish('f'),/확정/);
 state.features[0].spec=spec;clearToken();await publisher.automatic('f',passed);assert.equal(calls,0);
});
