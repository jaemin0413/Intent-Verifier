// Shared by the product runner and exported Node.js tests. Tool-owned assertions only.
import assert from "node:assert/strict";
import {statusDifference} from './technical-policy.mjs';
export function localBase(value) {
  const u=new URL(value || "http://127.0.0.1:8080");
  if(!["http:","https:"].includes(u.protocol)||!["localhost","127.0.0.1","[::1]"].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=="/")throw new Error("테스트 서버 주소는 이 컴퓨터의 http://localhost:포트 형식으로 입력해 주세요.");
  return u.origin;
}
const pointer=(data,p)=>{let v=data;for(const k of p===""?[]:p.slice(1).split("/").map(k=>k.replaceAll("~1","/").replaceAll("~0","~")))v=v!=null&&Object.hasOwn(Object(v),k)?v[k]:undefined;return v;};
const valueLabel=(value,at)=>/token|password|secret|authorization/i.test(at)?"[보호된 값]":value===undefined?"값 없음":String(JSON.stringify(redact(value))).slice(0,70);
export function checkResponse(s,response) {
  const mismatch=[],blocked=[];
  const technicalDifference=statusDifference(s.expected,response.status,response.inputRejected);
  if(response.status!==s.expected.status && !technicalDifference) {
    const detail=s.expected.status>=400&&response.status>=200&&response.status<300?"거절해야 할 요청이 정상 처리되었습니다":response.status===400?"서버가 입력값을 거절했습니다":response.status===404?"API 주소 또는 요청한 대상을 찾지 못했습니다":response.status>=500?"백엔드에서 오류가 발생했습니다":"예상한 응답과 다릅니다";
    return {status:"FAIL",reason:`${detail} (예상 ${s.expected.status} · 실제 ${response.status}).`,details:[`승인된 요청값과 서버 응답을 근거에서 확인해 주세요.`]};
  }
  let body;if(!response.securityRejected||String(response.body||"").trim())try{body=JSON.parse(response.body);}catch{if(s.expected.checks.length)mismatch.push("응답이 JSON 형식이 아닙니다");}
  if(body!==undefined) for(const c of s.expected.checks) {
    const indexPart=c.pointer.match(/^(.*?)\/(\d+)(?:\/|$)/);
    // "No such item" is the claim of an equals-null check, not a lack of test data.
    if(indexPart&&!(c.operator==="equals"&&c.value===null)){const list=pointer(body,indexPart[1]);if(Array.isArray(list)&&list.length<=Number(indexPart[2])){(s.given?mismatch:blocked).push(`${indexPart[1]}: 항목 내용을 확인할 테스트 데이터가 부족합니다`);continue;}}
    const v=pointer(body,c.pointer),at=c.pointer||"응답 전체";
    if(c.operator==="equals")try{assert.deepStrictEqual(v===undefined&&c.value===null?null:v,c.value);}catch{mismatch.push(`${at}: 예상 ${valueLabel(c.value,at)} · 실제 ${valueLabel(v,at)}`);}
    if(c.operator==="setEquals")try{assert.ok(Array.isArray(v));assert.deepStrictEqual(v.map(x=>JSON.stringify(pointer(x,c.value.key))).sort(),c.value.values.map(x=>JSON.stringify(x)).sort());}catch{mismatch.push(`${at}: 목록의 항목이 승인 기준과 다릅니다 (비교 위치: ${c.value.key||'항목 전체'})`);}
    if(c.operator==="type" && (v==null?"null":Array.isArray(v)?"array":typeof v)!==c.value)mismatch.push(`${at}: ${c.value} 형식이 아닙니다`);
    if(["maxItems","minItems"].includes(c.operator) && (!Array.isArray(v)||(c.operator==="maxItems"?v.length>c.value:v.length<c.value)))mismatch.push(`${at}: ${c.operator==="maxItems"?"최대":"최소"} ${c.value}개 조건과 다릅니다`);
    if(["descending","ascending"].includes(c.operator)) {
      if(!Array.isArray(v)){mismatch.push(`${at}: 정렬할 목록이 아닙니다`);continue;}
      if(v.length<2){(s.given?mismatch:blocked).push(`${at}: 정렬을 확인하려면 실제 데이터가 2개 이상 필요합니다`);continue;}
      const values=v.map(x=>pointer(x,c.value));
      if(values.some(x=>typeof x!=="number"&&typeof x!=="string")){mismatch.push(`${at}: 정렬 기준 값이 없습니다`);continue;}
      const normalized=values.map(x=>typeof x==="string" && /^\d{4}-\d\d-\d\dT/.test(x) ? Date.parse(x) : x);
      if(normalized.some(x=>typeof x==="number"&&!Number.isFinite(x))){mismatch.push(`${at}: 정렬 값이 올바르지 않습니다`);continue;}
      if(normalized.some((x,i)=>i>0&&(c.operator==="descending"?normalized[i-1]<x:normalized[i-1]>x)))mismatch.push(`${at}: ${c.operator==="descending"?"최신순/내림차순":"오름차순"}이 아닙니다`);
    }
  }
  if(mismatch.length&&s.given&&s.name.includes("업로드 시각"))return {status:"FAIL",reason:"이미지 업로드 시각이 최신인 항목부터 반환되지 않았습니다.",details:mismatch};
  if(mismatch.length)return {status:"FAIL",reason:mismatch[0]+(mismatch.length>1?` 외 ${mismatch.length-1}개 불일치`:""),details:mismatch};
  if(blocked.length)return {status:"BLOCKED",reason:blocked[0],details:blocked};
  if(technicalDifference)return {status:"PASS",reason:`승인한 검사 항목과 일치합니다. 상태 코드만 AI 기본값 ${technicalDifference.expected}과 다른 ${technicalDifference.actual}입니다${typeof body?.message==="string"?` (서버 메시지: ${body.message.slice(0,120)})`:""}.`,technicalDifferences:[technicalDifference]};
  return {status:"PASS",reason:"실제 API 응답이 승인한 검사 항목과 일치합니다"};
}
const redact=v=>{
  if(Array.isArray(v))return v.map(redact);
  if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/token|password|secret|authorization/i.test(k)?"[redacted]":redact(x)]));return v;
};
export async function executeApi(s,{baseUrl,token,allowWrites=false,fetchImpl=fetch,timeoutMs=15000}={}) {
  const e={scenarioId:s.id,expected:s.expected,preconditionOk:false,actionExecuted:false,observationComplete:false,scope:"실행 중인 테스트 서버의 HTTP 응답. DB 내부 상태·실제 사용자 동일성은 별도 미검증."};
  try {
    if(s.given||s.expected.database?.length)return {status:"UNVERIFIED",reason:"이 검사는 H2 데이터 준비와 DB 관찰이 필요합니다.",evidence:e};
    const base=localBase(baseUrl);
    if(s.actor.mode==="bearer"&&!token)throw new Error("로그인이 필요한 API입니다. 프로젝트 설정에 테스트 계정의 액세스 토큰을 입력해 주세요.");
    if(!["GET","HEAD","OPTIONS"].includes(s.action.method)&&!allowWrites)throw new Error("쓰기 API입니다. 프로젝트 설정에서 테스트 서버의 쓰기 요청 실행을 허용해 주세요.");
    let route=s.action.path;
    for(const m of route.matchAll(/\{([^}]+)\}/g)){const value=s.action.pathValues.find(v=>v.name===m[1])?.value;if(!value)throw new Error(`${m[1]} 테스트 입력값이 없습니다. API 요청값을 확인해 주세요.`);route=route.replace(m[0],encodeURIComponent(value));}
    const url=new URL(base+route);for(const q of s.action.query)url.searchParams.set(q.name,q.value);
    if(url.origin!==base)throw new Error("요청 주소가 테스트 서버 밖으로 벗어났습니다.");
    e.preconditionOk=true;e.action={method:s.action.method,url:url.href,authentication:s.actor.mode};
    const response=await fetchImpl(url,{method:s.action.method,redirect:"manual",signal:AbortSignal.timeout(timeoutMs),headers:{Accept:"application/json",...(s.actor.mode==="bearer"?{Authorization:`Bearer ${token}`} : {}),...(s.action.body!==null?{"Content-Type":"application/json"}:{})},...(s.action.body!==null?{body:JSON.stringify(s.action.body)}:{})});
    e.actionExecuted=true;let bytes=0,chunks=[];
    if(response.body)for await(const chunk of response.body){bytes+=chunk.length;if(bytes>5000000)throw new Error("응답이 너무 커서 검사를 중단했습니다.");chunks.push(Buffer.from(chunk));}
    const body=Buffer.concat(chunks).toString("utf8");let safeBody=body;try{safeBody=JSON.stringify(redact(JSON.parse(body)));}catch{safeBody=body.slice(0,10000);}
    e.response={status:response.status,body:safeBody};e.observationComplete=true;
    if(response.status>=300&&response.status<400)return {status:"UNVERIFIED",reason:"로그인 또는 다른 페이지로 이동하는 API는 이번 검사에서 제외했습니다.",evidence:e};
    if(s.actor.mode==="bearer"&&[401,403].includes(response.status)&&![401,403].includes(s.expected.status))throw new Error("테스트 계정의 인증 또는 권한을 확인하지 못했습니다. 유효한 토큰으로 다시 검사해 주세요.");
    return {...checkResponse(s,{status:response.status,body}),evidence:e};
  }catch(error){e.error=/timeout|timed out/i.test(error.name+' '+error.message)?"테스트 서버의 응답 시간이 초과됐습니다. 백엔드 상태를 확인한 뒤 다시 검사해 주세요.":/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)?"테스트 서버에 연결하지 못했습니다. 백엔드를 실행하고 프로젝트 설정의 서버 주소를 확인해 주세요.":error.message;return {status:"BLOCKED",reason:e.error,evidence:e};}
}
