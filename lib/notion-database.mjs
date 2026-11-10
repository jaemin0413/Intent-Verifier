import {ensure,digest} from './domain.mjs';
import {apiDocuments} from './notion-api-documents.mjs';
import {STATUS_CODES} from 'node:http';
import {formatApiIndex,formatFieldIndex,METHOD_OPTIONS,STATUS_OPTIONS} from './notion-api-index.mjs';
const text=value=>{const chars=Array.from(String(value));return Array.from({length:Math.max(1,Math.ceil(chars.length/1800))},(_,i)=>({type:'text',text:{content:chars.slice(i*1800,(i+1)*1800).join('')}}));};
const plain=block=>(block[block.type]?.rich_text||[]).map(t=>t.plain_text??t.text?.content??'').join('');
const normalized=v=>v.trim().toLowerCase().replace(/\s*\(\d+\)$/,'');
const LIST_PROPERTIES={이름:{title:{}},METHOD:{select:{options:METHOD_OPTIONS}},URL:{rich_text:{}},상태:{select:{options:STATUS_OPTIONS}},'백엔드 담당':{people:{}},'프론트 담당':{people:{}},텍스트:{rich_text:{}}};
// The first fixed path segment names the domain: /api/v1/auth/login belongs to "auth".
export function apiDomain(path){
 return path.split('/').filter(Boolean).filter((s,i)=>!(i<2&&/^(api|v\d+)$/i.test(s))).find(s=>!s.startsWith('{'))||'common';
}
// Follows the team's API template. Requirements, test scenarios and hashes stay in the app.
export function pagePlan(doc,templateBlocks=null){
 const heading=name=>{const original=templateBlocks?.find(b=>plain(b)===name),type=original?.type||'heading_2';return {block:{object:'block',type,[type]:{rich_text:text(name),color:original?.[original.type]?.color||'default'}}};};
 const paragraph=(value,color='default')=>({block:{object:'block',type:'paragraph',paragraph:{rich_text:text(value),color}}});
 const code=value=>({block:{object:'block',type:'code',code:{rich_text:text(JSON.stringify(value,null,2)),language:'json'}}});
 const urlIndex=templateBlocks?.findIndex(b=>plain(b)==='Request URL');
 const plan=[heading('Request URL'),paragraph(doc.path,templateBlocks?.[urlIndex+1]?.paragraph?.color||'pink_background'),heading('HTTP Method'),paragraph(doc.method)];
 const fields=(label,values)=>{
  const original=templateBlocks?.find(b=>b.type==='child_database'&&normalized(b.child_database.title)===normalized(label));
  if(templateBlocks&&!original)return; // A custom template is an allow-list, never add absent sections.
  plan.push({database:label,title:original?.child_database.title||label,source:original?.id,values});
 };
 fields('Header',doc.headers);fields('Path Variable',doc.pathParameters);fields('Query Param',doc.queryParameters);fields('Request Body',doc.body);
 if(doc.example!==undefined&&(!templateBlocks||templateBlocks.some(b=>plain(b)==='Request Example')))plan.push(heading('Request Example'),code(doc.example));
 if(!templateBlocks)plan.push({block:{object:'block',type:'divider',divider:{}}});
 const declared=doc.declaredResponse,isSuccess=r=>r.status>=200&&r.status<300;
 if(declared?.fields?.length&&!doc.responses.some(isSuccess)){plan.push(heading('Response'));fields('Response',declared.fields);if(declared.example!==undefined)plan.push(code(declared.example));}
 for(const response of doc.responses){
  const success=isSuccess(response);
  plan.push(heading(`${response.status} ${STATUS_CODES[response.status]||''}`.trim()));
  const responseFields=(success&&declared?.fields?.length?declared.fields:response.fields)||[];
  if(responseFields.length)fields('Response',responseFields);
  const example=response.example??(success?declared?.example:undefined);
  if(example!==undefined)plan.push(code(example));
 }
 return plan;
}

export class NotionDatabase {
 constructor(token,fetchImpl=fetch){this.token=token;this.fetch=fetchImpl;this.lastRequest=0;}
 async request(route,method='GET',body){
  if(this.fetch===fetch){const wait=350-(Date.now()-this.lastRequest);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));this.lastRequest=Date.now();}
  const response=await this.fetch('https://api.notion.com/v1/'+route,{method,signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+this.token,'Notion-Version':'2025-09-03','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){const error=new Error(response.status===401?'노션 API 키를 확인해 주세요.':response.status===403||response.status===404?'이 Notion 키로 열 수 없는 페이지예요. 페이지 ‘연결’에 키를 만든 통합을 추가하고, 다른 워크스페이스 페이지라면 그 워크스페이스에서 만든 키를 넣어 주세요.':`Notion 저장 오류 (${response.status}): ${String(data.message||'요청을 완료하지 못했습니다.').slice(0,240)}`);error.status=response.status;throw error;}
  return data;
 }
 async list(route,method='GET'){
  const all=[];let cursor;
  do {const result=await this.request(route+(method==='GET'?`?page_size=100${cursor?'&start_cursor='+cursor:''}`:''),method,method==='POST'?{page_size:100,...(cursor?{start_cursor:cursor}:{})}:undefined);all.push(...(result.results||result.templates||[]));cursor=result.has_more?result.next_cursor:null;}while(cursor);
  return all;
 }
 async resolve(parentId,domain){
  let database;
  try{database=await this.request('databases/'+parentId);}catch(error){if(![400,404].includes(error.status))throw error;}
  if(!database){
   const name=domain+' API',found=(await this.list('blocks/'+parentId+'/children')).find(b=>b.type==='child_database'&&b.child_database?.title===name);
   database=found?await this.request('databases/'+found.id):await this.request('databases','POST',{parent:{type:'page_id',page_id:parentId},is_inline:true,title:text(name),initial_data_source:{properties:LIST_PROPERTIES}});
  }
  ensure(database.data_sources?.length===1,'사용할 데이터 소스가 하나인 Notion DB를 연결해 주세요.');
  const source=await this.request('data_sources/'+database.data_sources[0].id);
  const title=Object.entries(source.properties).find(([,p])=>p.type==='title')?.[0];ensure(title,'DB에 제목 속성이 필요합니다.');
  const templates=await this.list('data_sources/'+source.id+'/templates');
  const template=templates.find(t=>t.is_default)||(templates.length===1?templates[0]:null);
  ensure(template||!templates.length,'사용할 양식을 Notion DB의 기본 템플릿으로 지정해 주세요.');
  return {id:database.id,url:database.url,sourceId:source.id,title,templateId:template?.id};
 }
 async fillFields(databaseId,values){
  const db=await this.request('databases/'+databaseId);ensure(db.data_sources?.length===1,'양식 표의 데이터 소스를 확인해 주세요.');
  const ds=await this.request('data_sources/'+db.data_sources[0].id),props=ds.properties;
  await formatFieldIndex(this,databaseId,ds);
  if(values===null)return; // Unknown fields remain blank; they are never invented.
  const key=Object.entries(props).find(([,p])=>p.type==='title')?.[0];ensure(key,'양식 표에 key 제목 속성이 필요합니다.');
  const existing=await this.list('data_sources/'+ds.id+'/query','POST');
  for(const field of values){
   if(existing.some(p=>(p.properties[key]?.title||[]).map(t=>t.plain_text??t.text?.content).join('')===field.key))continue;
   const properties={[key]:{title:text(field.key)}};
   for(const [name,value] of [['type',field.type],['description',field.description]]){
    if(!props[name]||!value)continue;
    // Notion rejects commas in select options, and generic types such as Map<K, V> contain them.
    if(props[name].type==='select')properties[name]={select:{name:String(value).replaceAll(',',' /').slice(0,100)}};
    else if(props[name].type==='rich_text')properties[name]={rich_text:text(value)};
   }
   await this.request('pages','POST',{parent:{type:'data_source_id',data_source_id:ds.id},properties});
  }
 }
 async archive(block){try{await this.request('blocks/'+block.id,'DELETE');}catch(error){
  if(error.status===404)return;
  if(error.status===400){const current=await this.request('blocks/'+block.id);if(current.archived||current.in_trash)return;}
  throw error;
 }}
 async renderOwnedPage(entry,doc,templateBlocks,checkpoint){
  const blockElements=b=>1+(b[b.type]?.children||[]).reduce((n,c)=>n+blockElements(c),0);
  const plan=pagePlan(doc,templateBlocks);
  entry.steps||={};
  for(let index=0;index<plan.length;index++){
   const step=plan[index];let completed=entry.steps[index];if(completed?.done)continue;
   if(step.block){
    // Each checkpoint rewrites the whole state file, so neighbouring blocks share one request and one checkpoint.
    let end=index,elements=0,bytes=0;
    for(;end<plan.length&&end-index<100&&plan[end].block&&!entry.steps[end]?.done;end++){
     elements+=blockElements(plan[end].block);bytes+=JSON.stringify(plan[end].block).length;
     if(end>index&&(elements>900||bytes>400000))break;
    }
    const result=await this.request('blocks/'+entry.id+'/children','PATCH',{children:plan.slice(index,end).map(s=>s.block)});
    for(let i=index;i<end;i++)entry.steps[i]={id:result.results?.[i-index]?.id,done:true};
    await checkpoint();index=end-1;
   }else{
    if(!completed){
     let properties={key:{title:{}},type:{select:{options:[]}},description:{rich_text:{}}};
     if(step.source){const original=await this.request('databases/'+step.source),ds=await this.request('data_sources/'+original.data_sources[0].id);properties=Object.fromEntries(Object.entries(ds.properties).map(([name,p])=>[name,{[p.type]:p.type==='select'?{options:p.select.options.map(o=>({name:o.name,color:o.color}))}:{}}]));}
     const database=await this.request('databases','POST',{parent:{type:'page_id',page_id:entry.id},is_inline:true,title:text(step.title),initial_data_source:{properties}});
     completed=entry.steps[index]={id:database.id,done:false};await checkpoint();
    }
    await this.fillFields(completed.id,step.values);completed.done=true;await checkpoint();
   }
  }
 }
 async publish(spec,{parentId,progress={},checkpoint=async()=>{},labels={},documents,planned=[]}){
  const docs=documents||apiDocuments(spec,{labels});ensure(docs.length,'작성할 승인 API가 없습니다.');
  const allowed=apiDocuments(spec);ensure(docs.length===allowed.length&&new Set(docs.map(d=>d.key)).size===docs.length&&docs.every(d=>allowed.some(a=>a.key===d.key&&a.method===d.method&&a.path===d.path)),'승인된 API와 문서 대상이 다릅니다.');
  progress.pages||={};progress.destinations||={};
  const plannedRows=planned.filter(p=>!docs.some(d=>d.key===p.key)&&!progress.pages[p.key]?.complete),rows=[...docs,...plannedRows];
  const domains=[...new Set(rows.map(d=>apiDomain(d.path)))];
  for(const domain of domains)progress.destinations[domain]||=await this.resolve(parentId,domain);
  await checkpoint(progress);
  // Rebuild allowed sections from the actual template; preserve its headings, color and field DB schemas.
  const templates=new Map();
  for(const domain of domains){
   const id=progress.destinations[domain].templateId;if(!id||templates.has(id))continue;
   const blocks=await this.list('blocks/'+id+'/children');
   ensure(blocks.some(b=>plain(b)==='Request URL')&&blocks.some(b=>plain(b)==='HTTP Method'),'기본 템플릿에 Request URL과 HTTP Method 항목이 필요합니다.');
   templates.set(id,blocks);
  }
  for(const doc of docs){
   const destination=progress.destinations[apiDomain(doc.path)],templateBlocks=templates.get(destination.templateId)||null;
   let entry=progress.pages[doc.key];const contentDigest=digest(doc);
   if(entry?.complete&&entry.contentDigest===contentDigest)continue;
   if(entry?.complete){
    // Append the new revision completely before retiring only blocks owned by the tool.
    if(entry.revision&&entry.revision.contentDigest!==contentDigest){
     for(const step of Object.values(entry.revision.steps||{}))if(step.id&&!step.retired){await this.archive(step);step.retired=true;await checkpoint(progress);}
     entry.history=[...(entry.history||[]),{contentDigest:entry.revision.contentDigest,status:'SUPERSEDED_BEFORE_COMPLETION',at:new Date().toISOString()}];delete entry.revision;
    }
    entry.revision||={id:entry.id,steps:{},contentDigest};await checkpoint(progress);
    await this.renderOwnedPage(entry.revision,doc,templateBlocks,()=>checkpoint(progress));
    for(const step of Object.values(entry.steps||{}))if(step.id&&!step.retired){await this.archive(step);step.retired=true;await checkpoint(progress);}
    entry.history=[...(entry.history||[]),{contentDigest:entry.contentDigest,document:entry.document,retiredSteps:structuredClone(entry.steps),at:new Date().toISOString()}];entry.steps=entry.revision.steps;entry.document=structuredClone(doc);entry.contentDigest=contentDigest;delete entry.revision;progress.indexLayout=null;await checkpoint(progress);continue;
   }
   if(entry&&!entry.manual){await this.request('pages/'+entry.id,'PATCH',{in_trash:true});delete progress.pages[doc.key];entry=null;await checkpoint(progress);}
   if(!entry){const page=await this.request('pages','POST',{parent:{type:'data_source_id',data_source_id:destination.sourceId},properties:{[destination.title]:{title:text(doc.title)}}});entry=progress.pages[doc.key]={id:page.id,url:page.url,title:doc.title,complete:false,manual:true};await checkpoint(progress);}
   if(!entry.complete){await this.renderOwnedPage(entry,doc,templateBlocks,()=>checkpoint(progress));entry.complete=true;entry.contentDigest=contentDigest;entry.document=structuredClone(doc);await checkpoint(progress);}
  }
  for(const row of plannedRows)if(!progress.pages[row.key]){const destination=progress.destinations[apiDomain(row.path)],page=await this.request('pages','POST',{parent:{type:'data_source_id',data_source_id:destination.sourceId},properties:{[destination.title]:{title:text(row.title)}}});progress.pages[row.key]={id:page.id,url:page.url,title:row.title,complete:false,manual:true};progress.indexLayout=null;await checkpoint(progress);}
  if(!progress.indexLayout){
   const layout={version:'api-list-v2',domains:{}};
   for(const domain of domains)layout.domains[domain]=await formatApiIndex(this,progress.destinations[domain],spec,progress.pages,labels,rows.filter(d=>apiDomain(d.path)===domain));
   progress.indexLayout=layout;await checkpoint(progress);
  }
  return {id:parentId,url:'https://www.notion.so/'+parentId.replaceAll('-',''),pages:Object.values(progress.pages),indexLayout:progress.indexLayout,digest:spec.approval.digest,layout:'api-domain-v2',at:new Date().toISOString()};
 }
}
