import {ensure,isApproved,digest} from './domain.mjs';

const type=v=>v===null?'null':Array.isArray(v)?'Array':typeof v==='string'?'String':typeof v==='boolean'?'boolean':Number.isInteger(v)?'Long':typeof v==='number'?'Number':'Object';
const fields=values=>[...new Set(values.flatMap(v=>Object.keys(v||{})))].map(key=>({key,type:[...new Set(values.filter(v=>v&&key in v).map(v=>type(v[key])))].join(' | '),description:''}));
const fixtureRef=v=>typeof v==='string'&&v.startsWith('$fixture/');
export function responseFields(checks){
 const grouped=new Map();
 for(const c of checks.filter(c=>c.pointer&&['type','equals'].includes(c.operator))){
  const key=c.pointer.slice(1).replaceAll('/','.');
  const field=grouped.get(key)||{key,types:new Set(),values:new Set()};
  field.types.add(c.operator==='type'?c.value:fixtureRef(c.value)?'확인 필요':type(c.value));
  if(c.operator==='equals')field.values.add(fixtureRef(c.value)?'사전 저장된 데이터의 식별자':JSON.stringify(c.value));
  grouped.set(key,field);
 }
 return [...grouped.values()].map(f=>({key:f.key,type:[...f.types].join(' | '),description:f.values.size?'조건별 응답 값: '+[...f.values].join(' / '):''}));
}
// The envelope is the same on every API, so listing it only buries the real fields.
export const withoutEnvelope=fields=>fields?.filter(f=>!/^(code|message|httpStatus)$/i.test(f.key));
// A planned API has a list row only; its page is written once the code exists and is checked.
export const plannedDocument=({method,path,label,reason})=>({key:digest({method,path}),title:label,method,path,summary:reason,status:'시작 전'});
// Only contract data belongs in an API document. Requirements and test DSL stay in the app.
export function apiDocuments(spec,{labels={}}={}){
 ensure(isApproved(spec),'승인된 API 계약만 Notion에 작성할 수 있습니다.');
 const endpoints=spec.contract.endpoints||[{id:spec.contract.id,method:spec.contract.method,path:spec.contract.path}];
 return endpoints.map(endpoint=>{
  const scenarios=spec.scenarios.filter(s=>s.endpointId===endpoint.id||!spec.contract.endpoints);
  const bodies=scenarios.map(s=>s.action.body).filter(v=>v&&typeof v==='object'&&!Array.isArray(v));
  const request=endpoint.documentation?.request||(!spec.contract.endpoints?spec.contract.request:null);
  const headers=request?.headers??(scenarios.length?[...(bodies.length?[{key:'Content-Type',type:'String',description:'application/json'}]:[]),...(scenarios.some(s=>s.actor.mode==='bearer')?[{key:'Authorization',type:'String',description:'Bearer token'}]:[])]:null);
  const pathParameters=request?.pathParameters??[...endpoint.path.matchAll(/\{([^}]+)\}/g)].map(m=>({key:m[1],type:'',description:''}));
  const queryParameters=request?.queryParameters??(scenarios.length?fields(scenarios.map(s=>Object.fromEntries((s.action.query||[]).map(p=>[p.name,p.value])))):null);
  const body=request?.body===null?[]:request?.body?.fields??(scenarios.length?fields(bodies):null);
  const responses=endpoint.documentation?.responses||(!spec.contract.endpoints?spec.contract.responses:null)||[...new Set(scenarios.map(s=>s.expected.status))].map(status=>{
    const checks=scenarios.filter(s=>s.expected.status===status).flatMap(s=>s.expected.checks||[]);
    return {status,fields:responseFields(checks),bodyType:checks.find(c=>c.pointer===''&&c.operator==='type')?.value};
  });
  // Negative requests are not presented as valid request examples.
  const success=scenarios.find(s=>s.expected.status>=200&&s.expected.status<300&&s.action.body);
  const example=request?.example??success?.action.body;
  return {key:digest({method:endpoint.method,path:endpoint.path}),title:endpoint.name||labels[endpoint.id]||`${endpoint.method} ${endpoint.path}`,method:endpoint.method,path:endpoint.path,headers,pathParameters,queryParameters,body,example,responses:responses.map(r=>({...r,fields:withoutEnvelope(r.fields)})),status:endpoint.documentation?.origin==='AI_PROPOSAL'?'시작 전':'완료'};
 });
}
