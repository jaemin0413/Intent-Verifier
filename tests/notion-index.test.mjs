import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {approve,digest} from '../lib/domain.mjs';
import {formatApiIndex} from '../lib/notion-api-index.mjs';
import {indexProperties,indexResponse} from './fixtures/notion-metadata.mjs';
import {missingApis} from '../lib/api-plan.mjs';
import {parseDto} from '../lib/controller-catalog.mjs';
import {schemaFields} from '../lib/notion-documentation.mjs';
import {apiDocuments,plannedDocument,withoutEnvelope} from '../lib/notion-api-documents.mjs';
import {NotionDatabase,pagePlan,apiDomain} from '../lib/notion-database.mjs';
const spec=approve(JSON.parse(await readFile(new URL('../examples/post-delete.json',import.meta.url),'utf8')));
test('API 목록의 색상·이름·URL·상태와 열 순서를 적용하고 승인 기준은 유지한다',async()=>{
 const before=digest(spec),calls=[],schema={id:'ds',properties:{이름:{id:'title',type:'title'}}};
 const n={async request(route,method='GET',body){calls.push({route,method,body});if(route==='data_sources/ds'){if(method==='PATCH')for(const [name,value] of Object.entries(body.properties))schema.properties[name]={id:name,type:Object.keys(value)[0],...value};return schema;}if(route.startsWith('views?'))return {results:[{id:'view'}]};return {id:'view'};}};
 const docs=apiDocuments(spec),pages={[docs[0].key]:{id:'row'}};
 const result=await formatApiIndex(n,{id:'db',sourceId:'ds'},spec,pages,{[spec.contract.id]:'게시글 삭제'});
 const update=calls.find(c=>c.route==='pages/row');assert.equal(update.body.properties.이름.title[0].text.content,'게시글 삭제');assert.equal(update.body.properties.METHOD.select.name,'DELETE');assert.equal(update.body.properties.URL.rich_text[0].text.content,'/posts/{postId}');assert.equal(update.body.properties.상태.select.name,'완료');
 const view=calls.find(c=>c.route==='views/view');assert.deepEqual(view.body.configuration.properties.map(p=>p.property_id),['METHOD','title','URL','상태','백엔드 담당','프론트 담당','텍스트']);assert.equal(result.version,'api-list-v2');assert.equal(digest(spec),before);
});
test('팀이 바꾼 상태는 다시 작성해도 덮어쓰지 않는다',async()=>{
 const calls=[],n={async request(route,method='GET',body){calls.push({route,body});if(route==='data_sources/ds')return {id:'ds',properties:{이름:{id:'t',type:'title'},METHOD:{id:'m',type:'select'},URL:{id:'u',type:'rich_text'},상태:{id:'s',type:'status',status:{options:[{name:'Done'}]}},'백엔드 담당':{id:'b',type:'people'},'프론트 담당':{id:'f',type:'people'},텍스트:{id:'n',type:'rich_text'}}};if(route.startsWith('views?'))return {results:[{id:'view'}]};return {id:'view'};}};
 const docs=apiDocuments(spec),pages={[docs[0].key]:{id:'row'}};await formatApiIndex(n,{id:'db',sourceId:'ds'},spec,pages);await formatApiIndex(n,{id:'db',sourceId:'ds'},spec,pages);
 const updates=calls.filter(c=>c.route==='pages/row');assert.equal(updates[0].body.properties.상태.status.name,'Done');assert.equal(updates[1].body.properties.상태,undefined);
});
test('API 경로의 첫 고정 구간이 도메인이고 페이지는 양식 순서를 따른다',()=>{
 assert.equal(apiDomain('/api/v1/auth/login'),'auth');assert.equal(apiDomain('/teams/{id}/members'),'teams');assert.equal(apiDomain('/api/{id}'),'common');
 const plan=pagePlan({path:'/login',method:'POST',headers:[],pathParameters:[],queryParameters:[],body:[{key:'email',type:'String',description:''}],example:{email:'a'},declaredResponse:{fields:[{key:'token',type:'String',description:''}],example:{token:'t'}},responses:[{status:200},{status:400,example:{code:'X'}}]});
 const label=p=>p.database||(p.block[p.block.type].rich_text?.map(t=>t.text.content).join('')??p.block.type);
 assert.deepEqual(plan.map(label),['Request URL','/login','HTTP Method','POST','Header','Path Variable','Query Param','Request Body','Request Example','{\n  "email": "a"\n}','divider','200 OK','Response','{\n  "token": "t"\n}','400 Bad Request','{\n  "code": "X"\n}']);
 assert.equal(plan[1].block.paragraph.color,'pink_background');
});
test('블록은 100개씩 순서대로 나눠 보내고 실패한 묶음부터 이어 쓴다',async()=>{
 const doc={path:'/x',method:'GET',headers:[],pathParameters:[],queryParameters:[],body:[],responses:Array.from({length:120},(_,i)=>({status:400+i,example:{i}}))};
 const expected=pagePlan(doc,[]).filter(p=>p.block).map(p=>JSON.stringify(p.block)),sent=[],checkpoints=[];let calls=0;
 const n=new NotionDatabase('test',async(url,options)=>{const children=JSON.parse(options.body).children;if(++calls===2)return {ok:false,status:503,json:async()=>({message:'retry'})};sent.push(children);return {ok:true,json:async()=>({results:children.map((_,i)=>({id:`b${calls}-${i}`}))})};});
 const entry={id:'owned'};
 await assert.rejects(n.renderOwnedPage(entry,doc,[],async()=>checkpoints.push(1)),/503/);
 assert.equal(Object.keys(entry.steps).length,100);
 await n.renderOwnedPage(entry,doc,[],async()=>checkpoints.push(1));
 assert.ok(sent.every(c=>c.length<=100));assert.deepEqual(sent.flat().map(b=>JSON.stringify(b)),expected);
 assert.equal(checkpoints.length,sent.length);assert.equal(entry.steps[0].id,'b1-0');
});
test('원본 양식을 바꾸지 않고 필드 DB를 복제하며 중단 후 중복 생성 없이 이어 쓴다',async()=>{
 const calls=[],entry={id:'owned'},template=[{type:'heading_1',heading_1:{rich_text:[{text:{content:'Request URL'}}]}},{type:'paragraph',paragraph:{color:'pink_background'}},{type:'heading_1',heading_1:{rich_text:[{text:{content:'HTTP Method'}}]}},{id:'template-body',type:'child_database',child_database:{title:'Request Body'}}];
 const original=JSON.stringify(template),doc={path:'/login',method:'POST',headers:[],pathParameters:[],queryParameters:[],body:[{key:'email',type:'String',description:''}],responses:[]};
 let fail=true,rows=0,dbCreates=0;
 const n=new NotionDatabase('test',async(url,options)=>{const route=url.split('/v1/')[1].split('?')[0],body=options.body&&JSON.parse(options.body);calls.push({route,method:options.method,body});let data={};
  if(route==='databases/template-body'||route==='databases/clone')data={data_sources:[{id:route.endsWith('clone')?'clone-ds':'original-ds'}]};
  if(route.startsWith('data_sources/')&&!route.endsWith('query'))data={id:route.endsWith('clone-ds')?'clone-ds':'original-ds',properties:{key:{type:'title'},type:{type:'select',select:{options:[]}},description:{type:'rich_text'}}};
  if(route==='databases'){dbCreates++;data={id:'clone'};}
  if(route.endsWith('/query'))data={results:[]};
  if(route==='views')data={results:[]};
  if(route==='pages'){if(fail){fail=false;return {ok:false,status:503,json:async()=>({message:'retry'})};}rows++;data={id:'field'};}
  if(route==='blocks/owned/children')data={results:[{id:'block-'+calls.length}]};
  return {ok:true,json:async()=>data};
 });
 await assert.rejects(n.renderOwnedPage(entry,doc,template,async()=>{}),/503/);
 await n.renderOwnedPage(entry,doc,template,async()=>{});
 assert.equal(dbCreates,1);assert.equal(rows,1);assert.equal(JSON.stringify(template),original);
 const written=calls.filter(c=>c.route==='blocks/owned/children');
 assert.equal(written.length,1,'이웃한 블록은 한 요청으로 보낸다');assert.equal(written.flatMap(c=>c.body.children).length,4);
 assert.ok(calls.every(c=>!(c.method==='PATCH'&&c.route.includes('template'))));
 assert.equal(calls.flatMap(c=>c.body?.children||[]).find(b=>b.paragraph?.color==='pink_background').paragraph.rich_text[0].text.content,'/login');
});
test('긴 JSON 예시는 자르지 않고 Notion 텍스트 조각으로 보존한다',()=>{
 const example={value:'가'.repeat(4500)},blocks=pagePlan({path:'/long',method:'POST',headers:[],pathParameters:[],queryParameters:[],body:[],example,responses:[]}).map(p=>p.block).filter(Boolean);
 const code=blocks.find(b=>b.type==='code').code.rich_text;assert.ok(code.length>1);assert.deepEqual(JSON.parse(code.map(t=>t.text.content).join('')),example);
});

test('코드에 있는 API는 완료로, 고른 누락 API는 내용 없이 시작 전 행만 쓴다',async()=>{
 const requests=[],pageIds=['real-row','planned-row'];
 const fetchImpl=async(url,options)=>{const index=indexResponse(url,options,'이름');if(index)return index;const route=url.split('/v1/')[1].split('?')[0],body=options.body?JSON.parse(options.body):null;requests.push({route,method:options.method,body});let data;
  if(route==='databases/parent')return {ok:false,status:400,json:async()=>({})};
  if(route==='blocks/parent/children')data={results:[]};
  if(route==='databases'||route==='databases/db')data={id:'db',url:'https://notion.so/db',data_sources:[{id:'source'}]};
  if(route==='data_sources/source')data={id:'source',properties:indexProperties('이름')};
  if(route==='data_sources/source/templates')data={templates:[]};
  if(route.startsWith('blocks/'))data={results:[{id:'block'}]};
  if(route==='pages'){const id=pageIds.shift();data={id,url:'https://notion.so/'+id};}
  assert.ok(data,route);return {ok:true,json:async()=>data};};
 const planned=[plannedDocument({method:'GET',path:'/posts/{postId}/stats',label:'게시글 통계',reason:'화면의 통계 영역에 필요합니다'})];
 const seen=[],withRows=async(url,options)=>{if(url.includes('/pages/')&&options.method==='PATCH')seen.push([url.split('/pages/')[1],JSON.parse(options.body).properties]);return fetchImpl(url,options);};
 const progress={},result=await new NotionDatabase('test',withRows).publish(spec,{parentId:'parent',progress,planned});
 assert.equal(result.pages.length,2);
 assert.equal(requests.filter(r=>r.route==='blocks/planned-row/children'&&r.method==='PATCH').length,0,'세부 내용은 쓰지 않는다');
 const status=id=>seen.find(([row])=>row===id)[1].상태.select.name;
 assert.equal(status('real-row'),'완료');assert.equal(status('planned-row'),'시작 전');
 assert.equal(seen.find(([row])=>row==='planned-row')[1].URL.rich_text[0].text.content,'/posts/{postId}/stats');
});
test('코드에 이미 있는 경로는 누락 API로 보지 않는다',()=>{
 const missing=missingApis([{method:'GET',path:'/teams/{id}',label:'중복',reason:'r'},{method:'POST',path:'/teams/{teamId}/join',label:'참가',reason:'r'},{method:'POST',path:'/teams/{id}/join/',label:'같은 경로',reason:'r'},{method:'GET',path:'teams',label:'잘못된 경로',reason:'r'}],[{method:'GET',path:'/teams/{teamId}'}]);
 assert.deepEqual(missing.map(m=>m.label),['참가']);assert.match(missing[0].id,/^[a-f0-9]{16}$/);
 assert.deepEqual(missingApis(undefined,[]),[]);
});
test('명세 표에서 공통 응답 필드는 빼고 제약은 짧게 적는다',()=>{
 assert.deepEqual(withoutEnvelope([{key:'code'},{key:'message'},{key:'httpStatus'},{key:'data'},{key:'data.code'}]).map(f=>f.key),['data','data.code']);
 const schema={type:'object',fields:[{name:'password',annotations:[{name:'NotBlank',args:''},{name:'Size',args:'min = 8, max = 16'}],schema:{type:'string'}}]};
 assert.equal(schemaFields(schema)[0].description,'필수 · 최소 8 · 최대 16');
});
test('private 없이 선언한 Lombok DTO 필드도 읽는다',()=>{
 assert.deepEqual(parseDto('package a;\n@Getter\npublic class TokenRes {\n\n    String accessToken;\n    String refreshToken;\n}\n','TokenRes').fields.map(f=>[f.type,f.name]),[['String','accessToken'],['String','refreshToken']]);
});
