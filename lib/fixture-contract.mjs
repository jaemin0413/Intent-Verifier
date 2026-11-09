import {isDeepStrictEqual} from 'node:util';
// References resolve only against persisted Given data, never against the response.
export function resolveFixture(value,relations) {
  if(typeof value==='string'&&value.startsWith('$fixture/')) {
    let current=relations;
    for(const key of value.slice(9).split('/'))current=current?.[key];
    if(current===undefined)throw new Error(`준비한 데이터 참조를 찾지 못했습니다: ${value}`);
    return current;
  }
  if(Array.isArray(value))return value.map(v=>resolveFixture(v,relations));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveFixture(v,relations)]));
  return value;
}
export function resolveScenario(s,evidence){return {...s,expected:resolveFixture(s.expected,evidence.fixture?.relations||{})};}
export function checkDatabase(s,evidence) {
  const checks=s.expected.database||[];
  if(!checks.length)return null;
  if(!Array.isArray(evidence.database)||evidence.database.length!==checks.length)return {status:'BLOCKED',reason:'요청 후 DB 상태를 관찰하지 못했습니다.'};
  for(const [i,c] of checks.entries()) {
    const observed=evidence.database[i];
    if(observed.entity!==c.entity||!isDeepStrictEqual(observed.id,resolveFixture(c.id,evidence.fixture?.relations))||observed.before!==true)return {status:'BLOCKED',reason:'DB 검사 대상의 사전 저장 근거가 일치하지 않습니다.'};
    if(observed.exists!==c.exists)return {status:'FAIL',reason:`${c.label}: ${c.exists?'남아 있어야 하는 데이터가 삭제됐습니다.':'삭제되어야 하는 데이터가 남아 있습니다.'}`};
  }
  return {status:'PASS',reason:'승인한 응답과 DB 변경이 일치합니다.'};
}
