import {indexProperties,indexResponse} from './fixtures/notion-metadata.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {approve} from '../lib/domain.mjs';
import {apiDocuments} from '../lib/notion-api-documents.mjs';
import {NotionDatabase,pagePlan} from '../lib/notion-database.mjs';
const spec=approve(JSON.parse(await readFile(new URL('../examples/post-delete.json',import.meta.url),'utf8')));
test('API별로 통합하고 양식 밖의 기획 근거·시나리오·내부 해시를 출력하지 않는다',()=>{
 const docs=apiDocuments(spec);assert.equal(docs.length,1);assert.equal(docs[0].method,'DELETE');assert.equal(docs[0].responses.length,2);
 const blocks=JSON.stringify(pagePlan(docs[0]));assert.match(blocks,/Request URL/);assert.match(blocks,/HTTP Method/);assert.doesNotMatch(blocks,/기획 근거|검증 범위|원문 근거|Scenario|UNVERIFIED|approval|digest/);
 assert.doesNotMatch(blocks,/Request Example/);
});
test('페이지 안 기존 DB와 기본 사용자 템플릿을 선택한다',async()=>{
 const calls=[];const payloads={
 'databases/parent':{status:400},'blocks/parent/children':{results:[{id:'other',type:'child_database',child_database:{title:'users API'}},{id:'db',type:'child_database',child_database:{title:'auth API'}}]},
 'databases/db':{id:'db',url:'https://notion.so/db',data_sources:[{id:'source'}]},
 'data_sources/source':{id:'source',properties:indexProperties('이름')},
 'data_sources/source/templates':{templates:[{id:'template',is_default:true}]}
 };
 const n=new NotionDatabase('test',async(url)=>{const route=url.split('/v1/')[1].split('?')[0];calls.push(route);const data=payloads[route];return {ok:!data.status,status:data.status||200,json:async()=>data};});
 assert.deepEqual(await n.resolve('parent','auth'),{id:'db',url:'https://notion.so/db',sourceId:'source',title:'이름',templateId:'template'});assert.equal(calls.length,5);
});
test('DB 없는 페이지에만 API 명세 DB를 만들고 데이터 소스 제목 속성으로 API 행 생성',async()=>{
 const requests=[];const fetchImpl=async(url,options)=>{const index=indexResponse(url,options,'이름');if(index)return index;const route=url.split('/v1/')[1].split('?')[0],body=options.body?JSON.parse(options.body):null;requests.push({route,method:options.method,body});let data;
 if(route==='databases/parent')return {ok:false,status:400,json:async()=>({})};
 if(route==='blocks/parent/children')data={results:[]};
 if(route==='databases'||route==='databases/db')data={id:'db',url:'https://notion.so/db',data_sources:[{id:'source'}]};
 if(route==='data_sources/source')data={id:'source',properties:indexProperties('이름')};
 if(route==='data_sources/source/templates')data={templates:[]};
 if(route==='blocks/api-row/children')data={results:[{id:'owned-block'}]};
 if(route==='pages')data={id:'api-row',url:'https://notion.so/api-row'};
 assert.ok(data,route);return {ok:true,json:async()=>data};};
 const progress={},n=new NotionDatabase('test',fetchImpl);let saved=0;const result=await n.publish(spec,{parentId:'parent',progress,checkpoint:async()=>saved++});
 assert.equal(result.pages.length,1);assert.ok(saved>=2);assert.equal(requests.find(r=>r.route==='pages').body.parent.data_source_id,'source');
 assert.equal(requests.find(r=>r.route==='databases').body.parent.page_id,'parent');
 const before=requests.length;await n.publish(spec,{parentId:'parent',progress});assert.equal(requests.length,before);
});
