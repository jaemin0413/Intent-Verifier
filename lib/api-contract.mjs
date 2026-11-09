import {assertionLinks} from './plan-conditions.mjs';
import {validateGraph,graphSupported} from './entity-graph.mjs';
import {supportedDocumentation} from './api-documentation.mjs';
import {validStatusPolicy} from './technical-policy.mjs';
const ensure=(ok,msg)=>{if(!ok)throw new Error(msg);};
const only=(o,keys)=>o && Object.keys(o).every(k=>keys.includes(k));
const identifier=v=>typeof v==="string"&&/^[\w-]{1,90}$/.test(v);
export function validateApiSpec(s) {
  ensure(identifier(s.feature?.id)&&Number.isInteger(s.version)&&s.version>0,"기능과 버전이 필요합니다.");
  ensure(Array.isArray(s.requirements)&&s.requirements.length && Array.isArray(s.scenarios),"검증 요구사항이 없습니다.");
  const unique=a=>a.every(x=>identifier(x.id))&&new Set(a.map(x=>x.id)).size===a.length;
  const conditions=s.requirements.flatMap(r=>r.conditions||[]);
  ensure(unique(s.requirements)&&unique(s.scenarios)&&unique(conditions),"검증 항목 ID가 중복되었습니다.");
  for(const r of s.requirements) {
    ensure(Number.isInteger(r.version)&&r.version>0 && r.conditions.length && ["INFERRED","UNKNOWN","CONFIRMED"].includes(r.evidenceStatus),"요구사항 버전과 근거를 확인해 주세요.");
    if(r.evidenceStatus==="CONFIRMED")ensure(r.evidence?.scanId&&r.evidence.nodeIds?.length&&r.evidence.excerpt,"원문 근거가 필요합니다.");
    for(const c of r.conditions){
      ensure(Array.isArray(c.requiredScenarios)&&new Set(c.requiredScenarios).size===c.requiredScenarios.length&&c.requiredScenarios.every(id=>s.scenarios.some(x=>x.id===id&&(x.conditionId===c.id||c.assertionBindings?.some(b=>b.scenarioId===id&&assertionLinks(c,x).some(a=>a.target===b.target&&a.index===b.index))))),"시나리오 연결이 다릅니다.");
      if(c.assertionBindings)ensure(Array.isArray(c.assertionBindings)&&c.assertionBindings.every(b=>only(b,['scenarioId','target','index'])&&c.requiredScenarios.includes(b.scenarioId)&&s.scenarios.some(x=>x.id===b.scenarioId&&assertionLinks(c,x).some(a=>a.target===b.target&&a.index===b.index))),"기획 조건의 assertion 연결을 확인해 주세요.");
    }
  }
  const c=s.contract;ensure(Number.isInteger(c.version)&&c.version>0&&Array.isArray(c.endpoints)&&unique(c.endpoints),"API 계약을 확인해 주세요.");
  for(const e of c.endpoints)ensure(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"].includes(e.method)&&/^\/(?!\/)[\w/{}/.\-]*$/.test(e.path),"API 주소를 확인해 주세요.");
  for(const t of s.scenarios) {
    const e=c.endpoints.find(e=>e.id===t.endpointId);
    ensure(e&&Number.isInteger(t.version)&&t.version>0&&t.contractVersion===c.version&&t.requirementVersion===s.requirements.find(r=>r.conditions.some(c=>c.id===t.conditionId))?.version&&conditions.find(c=>c.id===t.conditionId)?.requiredScenarios.includes(t.id),"시나리오 버전이 다릅니다.");
    ensure(t.action.method===e.method&&t.action.path===e.path&&["anonymous","bearer"].includes(t.actor.mode),"API 요청 또는 인증 정보가 다릅니다.");
    for(const pairs of [t.action.pathValues,t.action.query])ensure(Array.isArray(pairs)&&new Set(pairs.map(p=>p.name)).size===pairs.length&&pairs.every(p=>typeof p.name==="string"&&typeof p.value==="string"),"API 입력값을 확인해 주세요.");
    ensure(Number.isInteger(t.expected.status)&&t.expected.status>=100&&t.expected.status<=599&&Array.isArray(t.expected.checks),"응답 기대값이 필요합니다.");
    if(t.expected.statusPolicy)ensure(validStatusPolicy(t.expected.statusPolicy),"기술 선택의 출처와 판정 정책이 필요합니다.");
    if(t.given?.profile==='intent-v1')ensure(typeof t.given.description==='string'&&t.given.description.trim()&&Array.isArray(t.given.facts)&&t.given.facts.length&&new Set(t.given.facts.map(f=>f.id)).size===t.given.facts.length&&t.given.facts.every(f=>identifier(f.id)&&typeof f.description==='string'&&f.description.trim()&&['boolean','string','number'].includes(typeof f.expected)),'Given의 의도와 확인할 사실이 필요합니다.');
    if(t.given)ensure(["scrap-relations-v1","entity-graph-v1","intent-v1"].includes(t.given.profile)&&(t.given.profile!=='scrap-relations-v1'||t.actor.mode==="bearer"),"H2 데이터 준비 프로필을 확인해 주세요.");
    if(t.given?.profile==="entity-graph-v1"){validateGraph(t.given.graph);ensure(t.actor.mode!=='bearer'||t.given.graph.auth!==null,'인증 요청은 저장된 계정에 연결해야 합니다.');}
    if(t.given?.uploadOffsets!==undefined)ensure(t.given.profile==='scrap-relations-v1'&&Array.isArray(t.given.uploadOffsets)&&t.given.uploadOffsets.length===3&&new Set(t.given.uploadOffsets).size===3&&t.given.uploadOffsets.every(n=>Number.isInteger(n)&&n>=0&&n<=1440)&&t.given.uploadOffsets[0]<t.given.uploadOffsets[1],'비교 데이터 시각을 확인해 주세요.');
    for(const d of t.expected.database||[])ensure(/^[A-Za-z][\w]*$/.test(d.entity)&&typeof d.id==="string"&&/^\$fixture\/(?:records\/[A-Za-z][\w]*\/id|(?:scrapIds|imageIds|chatIds)\/[0-3])$/.test(d.id)&&typeof d.exists==="boolean"&&typeof d.label==="string"&&["scrap-relations-v1","entity-graph-v1","intent-v1"].includes(t.given?.profile),"DB 관찰 기준을 확인해 주세요.");
    for(const j of t.expected.checks) {
      ensure(typeof j.pointer==="string"&&(j.pointer===""||j.pointer.startsWith("/"))&&["equals","type","maxItems","minItems","descending","ascending","setEquals"].includes(j.operator),"응답 검사 형식이 올바르지 않습니다.");
      if(["maxItems","minItems"].includes(j.operator))ensure(Number.isInteger(j.value)&&j.value>=0,"목록 개수 기준이 필요합니다.");
      if(j.operator==="setEquals")ensure(typeof j.value?.key==="string"&&j.value.key.startsWith("/")&&Array.isArray(j.value.values),"비교할 데이터 ID 목록이 필요합니다.");
      if(j.operator==="type")ensure(["object","array","string","number","boolean","null"].includes(j.value),"응답 자료형이 올바르지 않습니다.");
      if(["descending","ascending"].includes(j.operator))ensure(typeof j.value==="string"&&(j.value===""||j.value.startsWith("/")),"정렬할 항목 위치가 필요합니다.");
    }
  }return s;
}
export function supportedApi(s,c) {
  return s.behavior==="controller-api-v1" && only(c,["kind","id","version","sourceDigest","endpoints"])&&c.endpoints.every(e=>only(e,["id","method","path","file","handler","documentation"])&&supportedDocumentation(e.documentation)) &&
    only(s,["id","name","version","contractVersion","requirementVersion","conditionId","endpointId","behavior","actor","action","expected","observations","given"])&&only(s.actor,["mode"])&&only(s.action,["method","path","pathValues","query","body"])&&[...s.action.pathValues,...s.action.query].every(p=>only(p,["name","value"]))&&(!s.given||(only(s.given,["profile","uploadOffsets"])&&s.given.profile==="scrap-relations-v1"||only(s.given,["profile","graph"])&&s.given.profile==="entity-graph-v1"&&graphSupported(s.given.graph)||only(s.given,['profile','description','facts'])&&s.given.profile==='intent-v1'&&s.given.facts.every(f=>only(f,['id','description','expected']))))&&only(s.expected,["status","checks","database","statusPolicy"])&&(!s.expected.statusPolicy||validStatusPolicy(s.expected.statusPolicy))&&(s.expected.database||[]).every(d=>only(d,["entity","id","exists","label"]))&&s.expected.checks.every(j=>only(j,["pointer","operator","value"])&&(j.operator!=="setEquals"||only(j.value,["key","values"])))&&s.observations.every(o=>["response.status","response.json","database.exists"].includes(o));
}
