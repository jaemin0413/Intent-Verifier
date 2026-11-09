import test from 'node:test';
import assert from 'node:assert/strict';
import {describeType,schemaFields,syntheticExample,enrichDocumentation,documentationShapes} from '../lib/notion-documentation.mjs';
import {NotionDatabase} from '../lib/notion-database.mjs';
import {approve,digest} from '../lib/domain.mjs';
import {apiDocuments} from '../lib/notion-api-documents.mjs';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('관련 DTO만 재귀 탐색하고 숨김 필드와 메서드 본문을 문서 입력에서 제외한다',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'doc-shapes-'));
 try{
  const dir=path.join(root,'src/main/java');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'Envelope.java'),'class Envelope<T> { private T data; public String service() { return "never-send-body"; } }');
  await writeFile(path.join(dir,'Account.java'),'class Account { @JsonProperty("display_name") private String name; @JsonIgnore private String secret; }');
  const shapes=await documentationShapes(root,['Envelope<Account>']);
  assert.doesNotMatch(JSON.stringify(shapes),/never-send-body|"secret"/);
  assert.deepEqual(schemaFields(describeType('Envelope<Account>',shapes)).map(f=>f.key),['data','data.display_name']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('제네릭 반환 DTO를 펼치고 중첩 필드와 안전한 예시를 만든다',()=>{
 const shapes=[{name:'Envelope',parameters:['T'],enumValues:[],fields:[{name:'data',type:'T',annotations:[]},{name:'message',type:'String',annotations:[]}]},{name:'Tokens',enumValues:[],fields:[{name:'accessToken',type:'String',annotations:[]},{name:'refreshToken',type:'String',annotations:[]}]}];
 const schema=describeType('ResponseEntity<Envelope<Tokens>>',shapes);
 assert.deepEqual(schemaFields(schema).map(f=>f.key),['data','data.accessToken','data.refreshToken','message']);
 assert.deepEqual(syntheticExample(schema),{data:{accessToken:'<accessToken>',refreshToken:'<refreshToken>'},message:'<message>'});
 assert.equal(syntheticExample({type:'string'},'email'),'user@example.com');
 assert.equal(describeType('ResponseEntity<?>',shapes).unknown,true);
});

test('AI는 설명만 채우고 경로·상태·필드·가상 예시를 수정할 수 없다',async()=>{
 const docs=[{key:'api',path:'/login',method:'POST',title:'로그인',headers:[],pathParameters:[],queryParameters:[],body:[{key:'email',type:'string',description:'DTO 제약: @Email'}],responses:[{status:400}],declaredResponse:{fields:[]},context:{summary:'로그인'},example:{email:'user@example.com'}}];
 const prepared={docs,inputDigest:'input'},before=digest(prepared);
 const runtime={async analyze(input){assert.doesNotMatch(JSON.stringify(input.nodes),/user@example/);return {result:{documents:[{key:'api',summary:'이메일로 로그인합니다.',fields:[{id:'body:email',description:'로그인할 계정의 이메일 주소'}],responses:[{status:400,description:'잘못된 입력 형식'}]}]},evidence:{provider:'codex'}};}};
 const result=await enrichDocumentation(prepared,{runtime});assert.equal(digest(prepared),before);assert.equal(result.docs[0].body[0].description,'로그인할 계정의 이메일 주소 · DTO 제약: @Email');assert.equal(result.docs[0].responses[0].status,400);assert.deepEqual(result.docs[0].example,docs[0].example);
 await assert.rejects(enrichDocumentation(prepared,{runtime:{async analyze(){return {result:{documents:[{key:'api',summary:'설명',fields:[{id:'body:invented',description:'새 필드'}],responses:[]}]}};}}}),/선언에 없는/);
});

test('상세 문서 재발행은 동일 API 행을 유지하고 새 내용 완료 후 소유 블록만 교체한다',async()=>{
 const spec=approve(JSON.parse(await readFile(new URL('../examples/post-delete.json',import.meta.url),'utf8'))),doc=apiDocuments(spec)[0];
 const progress={destinations:{posts:{id:'db',url:'https://notion.so/db',sourceId:'ds',title:'이름'}},pages:{[doc.key]:{id:'row',url:'row',manual:true,complete:true,steps:{0:{id:'old-owned',done:true}}}},indexLayout:{version:'old'}};
 const n=new NotionDatabase('test'),events=[];let fail=true;
 n.renderOwnedPage=async(entry)=>{events.push('render');if(fail){fail=false;throw Error('중단');}entry.steps={0:{id:'new-owned',done:true}};};
 n.archive=async block=>events.push('archive:'+block.id);
 n.request=async(route,method)=>{if(route==='data_sources/ds')return {properties:{이름:{id:'title',type:'title'},METHOD:{id:'m',type:'select'},URL:{id:'u',type:'rich_text'},상태:{id:'s',type:'select'},'백엔드 담당':{id:'b',type:'people'},'프론트 담당':{id:'f',type:'people'},텍스트:{id:'n',type:'rich_text'}}};if(route.startsWith('views?'))return {results:[{id:'view'}]};events.push(route);return {id:'view'};};
 const options={parentId:'parent',progress,documents:[{...doc,summary:'작성자 소유의 게시글을 삭제합니다.'}]};
 await assert.rejects(n.publish(spec,options),/중단/);assert.ok(!events.some(e=>e.startsWith('archive:')));assert.equal(progress.pages[doc.key].steps[0].id,'old-owned');
 await n.publish(spec,options);assert.ok(events.indexOf('archive:old-owned')>events.lastIndexOf('render'));assert.equal(progress.pages[doc.key].id,'row');assert.equal(progress.pages[doc.key].steps[0].id,'new-owned');
 const count=events.length;await n.publish(spec,options);assert.equal(events.length,count);
});

test('감싼 클래스의 DTO는 전체 이름과 짧은 이름 모두로 구조를 찾는다',()=>{
 const shapes=[{name:'TeamRequest.CreateReq',fields:[{name:'contacts',annotations:[],type:'List<ContactReq>'}],enumValues:[],parameters:[]},{name:'TeamRequest.ContactReq',fields:[{name:'value',annotations:[],type:'String'}],enumValues:[],parameters:[]}];
 assert.deepEqual(schemaFields(describeType('TeamRequest.CreateReq',shapes)).map(f=>f.key),['contacts','contacts[].value']);
});
