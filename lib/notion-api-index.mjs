import {ensure} from './domain.mjs';
import {apiDocuments} from './notion-api-documents.mjs';
const text=value=>[{type:'text',text:{content:String(value)}}];
export const METHOD_OPTIONS=Object.entries({POST:'blue',PATCH:'green',DELETE:'red',GET:'yellow',PUT:'orange',HEAD:'gray',OPTIONS:'gray'}).map(([name,color])=>({name,color}));
export const STATUS_OPTIONS=[{name:'시작 전',color:'gray'},{name:'진행 중',color:'blue'},{name:'완료',color:'green'}];
export async function formatFieldIndex(n,databaseId,source){
 const title=Object.entries(source.properties).find(([,p])=>p.type==='title')?.[0];
 const columns=[[title,220],['type',140],['description',480]].filter(([name])=>source.properties[name]);
 const views=await n.request('views?database_id='+databaseId);
 const configuration={type:'table',properties:columns.map(([name,width])=>({property_id:source.properties[name].id,visible:true,width,wrap:true})),wrap_cells:true,show_vertical_lines:false};
 if(views.results.length)await n.request('views/'+views.results[0].id,'PATCH',{configuration});
}
// Presentation is separate from the immutable approval and never means test PASS.
export async function formatApiIndex(n,destination,spec,pages,labels={},documents){
 let source=await n.request('data_sources/'+destination.sourceId);
 const add={};
 for(const [name,type] of [['METHOD','select'],['URL','rich_text'],['상태','select'],['백엔드 담당','people'],['프론트 담당','people'],['텍스트','rich_text']]){
  if(source.properties[name])ensure(name==='상태'?['select','status'].includes(source.properties[name].type):source.properties[name].type===type,`Notion ${name} 열의 형식을 확인해 주세요.`);
  else add[name]={[type]:type==='select'?{options:name==='METHOD'?METHOD_OPTIONS:STATUS_OPTIONS}:{}};
 }
 if(Object.keys(add).length)source=await n.request('data_sources/'+destination.sourceId,'PATCH',{properties:add});
 const title=Object.entries(source.properties).find(([,v])=>v.type==='title')?.[0];ensure(title,'API 목록에 제목 열이 필요합니다.');
 const status=source.properties['상태'],statusNames={완료:['완료','Done','Complete'],'시작 전':['시작 전','Not started','To-do']};
 const statusOption=name=>status.type==='status'?status.status.options.find(o=>statusNames[name].includes(o.name))?.name:name;
 const docs=documents||apiDocuments(spec,{labels});
 for(const doc of docs){
  const page=pages[doc.key]||Object.values(pages).find(p=>p.endpointKey===doc.key);
  ensure(page?.id,'Notion API 문서 연결이 없습니다.');
  // Existing code is done and a planned API is not started. Only that fact changing is written, so the team's own edits stay.
  const wanted=doc.status||'완료',option=page.statusWritten===wanted?null:statusOption(wanted);
  await n.request('pages/'+page.id,'PATCH',{properties:{[title]:{title:text(doc.title)},METHOD:{select:{name:doc.method}},URL:{rich_text:text(doc.path)},...(doc.summary?{텍스트:{rich_text:text(doc.summary)}}:{}),...(option?{상태:{[status.type]:{name:option}}}:{})}});
  page.statusWritten=wanted;
  page.title=doc.title;page.endpointKey=doc.key;
 }
 const list=await n.request('views?database_id='+destination.id);
 const views=[];
 for(const item of list.results)views.push(list.results.length===1?item:await n.request('views/'+item.id));
 const view=views.find(v=>v.name==='API 목록')||(views.length===1?views[0]:null);
 const columns=[['METHOD',100],[title,240],['URL',320],['상태',100],['백엔드 담당',110],['프론트 담당',110],['텍스트',300]];
 const properties=columns.map(([name,width])=>({property_id:source.properties[name].id,visible:true,width,wrap:false}));
 const configuration={type:'table',properties,wrap_cells:false,show_vertical_lines:false};
 const updated=view?await n.request('views/'+view.id,'PATCH',{name:'API 목록',configuration}):await n.request('views','POST',{database_id:destination.id,data_source_id:destination.sourceId,name:'API 목록',configuration,position:{type:'start'}});
 return {version:'api-list-v2',viewId:updated.id,columns:columns.map(([name])=>name)};
}
