import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {approve} from '../lib/domain.mjs';
import {NotionPublisher} from '../lib/notion-publisher.mjs';
import {indexProperties,indexResponse} from './fixtures/notion-metadata.mjs';
const original=JSON.parse(await readFile('examples/post-delete.json','utf8'));
function environment(){
 const state={projects:[{id:'p',notion:{parentId:'parent'}}],features:[{id:'f',projectId:'p',spec:approve(original)}]};
 const pages=[],archived=[],blocks=[];let fail=false;
 const store={load:async()=>structuredClone(state),secrets:async()=>({notionToken:'test'}),mutate:async fn=>fn(state)};
 const fetch=async(url,options)=>{
  const route=url.split('/v1/')[1].split('?')[0],body=options.body?JSON.parse(options.body):{};
  const index=indexResponse(url,options);if(index)return index;
  let data;
  if(route.startsWith('databases/'))data={id:'db',url:'https://notion.so/db',data_sources:[{id:'ds'}]};
  else if(route.endsWith('/templates'))data={templates:[]};
  else if(route==='data_sources/ds')data={id:'ds',properties:indexProperties('title')};
  else if(route==='pages'&&options.method==='POST'){data={id:'row-'+pages.length,url:'https://notion.so/row-'+pages.length};pages.push(data);}
  else if(route.endsWith('/children')&&options.method==='PATCH'){
   if(fail){fail=false;return {ok:false,status:503,json:async()=>({message:'interrupted'})};}
   const block={id:'owned-'+blocks.length,...body.children[0]};blocks.push(block);data={results:[block]};
  }else if(route.startsWith('blocks/')&&options.method==='DELETE'){archived.push(route.slice(7));data={};}
  assert.ok(data,route);return {ok:true,json:async()=>data};
 };
 return {state,pages,blocks,archived,publisher:new NotionPublisher(store,fetch),interrupt:()=>{fail=true;}};
}
function revise(e){const next=structuredClone(e.state.features[0].spec);next.version++;next.contract.forbidden=401;next.scenarios.filter(s=>!s.relation.actorIsOwner).forEach(s=>s.expected.status=401);e.state.features[0].spec=approve(next);}
test('재승인과 다른 기능의 같은 API는 기존 행을 개정하고 중단 후 재개해도 중복 생성하지 않는다',async()=>{
 const e=environment();await e.publisher.publish('f');assert.equal(e.pages.length,1);
 const firstBlocks=e.blocks.map(b=>b.id);revise(e);e.interrupt();
 await assert.rejects(e.publisher.publish('f'),/503/);assert.equal(e.pages.length,1);assert.equal(e.archived.length,0);
 await e.publisher.publish('f');assert.equal(e.pages.length,1);assert.deepEqual(e.archived.filter(id=>id.startsWith('owned-')),firstBlocks);
 const registry=Object.values(e.state.notionApiRegistry)[0],entry=Object.values(registry.pages)[0];assert.equal(entry.history.length,1);assert.equal(entry.document.responses.some(r=>r.status===401),true);
 const second=structuredClone(e.state.features[0]);second.id='f2';delete second.publications;delete second.notionDrafts;delete second.notionPublication;e.state.features.push(second);
 await Promise.all([e.publisher.publish('f'),e.publisher.publish('f2')]);assert.equal(e.pages.length,1);
 // Another feature revises the same endpoint; returning to an older approved version must
 // render that revision into the same row rather than trusting its old local checkpoint.
 e.state.features[1].spec=approve(original);await e.publisher.publish('f2');
 let latest=Object.values(Object.values(e.state.notionApiRegistry)[0].pages)[0];assert.ok(latest.document.responses.some(r=>r.status===403));
 await e.publisher.publish('f');latest=Object.values(Object.values(e.state.notionApiRegistry)[0].pages)[0];assert.ok(latest.document.responses.some(r=>r.status===401));assert.equal(e.pages.length,1);
 assert.equal(e.archived.some(id=>id==='user-owned'),false);
});
test('기존 체크포인트도 프로젝트 저장 위치에 맞춰 이관하고 다른 프로젝트는 행을 공유하지 않는다',async()=>{
 const e=environment();await e.publisher.publish('f');delete e.state.notionApiRegistry;
 for(const d of Object.values(e.state.features[0].notionDrafts))delete d.parentId;
 revise(e);await e.publisher.publish('f');assert.equal(e.pages.length,1);
 e.state.projects.push({id:'p2',notion:{parentId:'parent2'}});e.state.features.push({id:'other',projectId:'p2',spec:approve(original)});
 await e.publisher.publish('other');assert.equal(e.pages.length,2);
});
test('중단된 개정 도중 새 승인이 들어오면 미완성 개정만 치우고 최신 문서를 같은 행에 기록한다',async()=>{
 const e=environment();await e.publisher.publish('f');revise(e);e.interrupt();await assert.rejects(e.publisher.publish('f'),/503/);
 const next=structuredClone(e.state.features[0].spec);next.version++;next.contract.forbidden=402;next.scenarios.filter(s=>!s.relation.actorIsOwner).forEach(s=>s.expected.status=402);e.state.features[0].spec=approve(next);
 await e.publisher.publish('f');assert.equal(e.pages.length,1);
 const entry=Object.values(Object.values(e.state.notionApiRegistry)[0].pages)[0];assert.ok(entry.document.responses.some(r=>r.status===402));assert.ok(entry.history.some(h=>h.status==='SUPERSEDED_BEFORE_COMPLETION'));
});
