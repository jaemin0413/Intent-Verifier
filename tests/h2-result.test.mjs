import test from 'node:test';
import assert from 'node:assert/strict';
import {h2Result,withSnapshotExpected} from '../lib/h2-result.mjs';
import {behavior,handoffText} from '../web/workflow.mjs';
import {backendCoverage,frontendOnly} from '../web/verification-scope.mjs';
import {responseFields} from '../lib/notion-api-documents.mjs';
test('요청 후 DB 관찰 오류는 받은 응답을 유지하고 준비 실패와 구분한다',()=>{
 const s={expected:{status:200,checks:[]}},e={blocked:'요청 후 DB 변경 확인 오류',failureStage:'OBSERVATION',actionExecuted:true,response:{status:200,body:'{}'},fixture:{persisted:true,rollbackVerified:true}};
 const r=h2Result(s,e,{});assert.equal(r.status,'BLOCKED');assert.equal(r.evidence.response.status,200);assert.match(r.nextAction,/요청은 실행/);assert.deepEqual(r.expected,s.expected);
});
test('Given 참조 누락도 승인 Expected와 실제 응답을 보존하며 구체적인 다음 행동을 반환한다',()=>{
 const s={expected:{status:200,checks:[{pointer:'/data/id',operator:'equals',value:'$fixture/tribeId'}]}};
 const evidence={fixture:{relations:{actorId:1}},response:{status:200,body:'{"data":{"id":null}}'}};
 const r=h2Result(s,evidence,{});assert.equal(r.status,'BLOCKED');assert.match(r.reason,/tribeId/);assert.match(r.nextAction,/다시 검사/);assert.match(r.details[0],/tribeId/);assert.deepEqual(r.expected,s.expected);assert.equal(r.evidence,evidence);assert.notEqual(behavior(r.expected),r.reason);
});
test('기획 기대값은 현재 초안 대신 해당 실행의 동결 Snapshot에서 복원한다',()=>{
 const r={specDigest:'old',results:[{scenarioId:'case',reason:'실행 실패'}]};
 const snapshot={specDigest:'old',spec:{scenarios:[{id:'case',expected:{status:204,checks:[],database:[{exists:false}]}}]}};
 assert.equal(withSnapshotExpected(r,snapshot).results[0].expected.status,204);
 assert.equal(withSnapshotExpected({...r,specDigest:'new'},snapshot).results[0].expected,undefined);
});
test('Java 실패와 데이터 미준비를 통과로 바꾸지 않는다',()=>{
 const s={expected:{status:200,checks:[{pointer:'/ok',operator:'equals',value:true}]}};
 const e={fixture:{relations:{}},response:{status:200,body:'{"ok":false}'},javaAssertionsPassed:false};
 assert.equal(h2Result(s,e,{}).status,'FAIL');e.blocked='테스트 데이터 생성 실패';assert.equal(h2Result(s,e,{}).status,'BLOCKED');
});
test('구버전의 명시적인 UI 표시 제외만 분리하고 혼합·백엔드 조건은 유지한다',()=>{
 const conditions=[{description:'이미지 블러 처리는 프런트엔드 표현이므로 API 응답만으로 검증하지 않음'},{description:'최신 트라이브 선택을 확인하지 못함'},{description:'프런트엔드 표시와 API 소유권 검사'},{scope:'backend',description:'이미지 블러 처리는 프런트엔드 표현이므로 API 응답만으로 검증하지 않음'}];
 assert.equal(frontendOnly(conditions[0]),true);assert.equal(backendCoverage({coverage:[{conditions} ]})[0].totalConditions,3);
 const handoff=handoffText({id:'run',specDigest:'same',results:[],counts:{},coverage:[{conditions}]},{name:'test',spec:{approval:{digest:'same'}}});
 assert.match(handoff,/백엔드 조건 검증률: 0\/3/);
});
test('Notion의 같은 200 응답은 서로 다른 조건의 값을 덮어쓰거나 테스트 참조를 노출하지 않는다',()=>{
 const fields=responseFields([{pointer:'/data/hasImages',operator:'equals',value:true},{pointer:'/data/hasImages',operator:'equals',value:false},{pointer:'/data/tribeId',operator:'equals',value:'$fixture/tribeId'},{pointer:'/data/tribeId',operator:'equals',value:null}]);
 assert.match(fields[0].description,/true.*false/);assert.match(fields[1].type,/확인 필요.*null/);assert.doesNotMatch(JSON.stringify(fields),/\$fixture/);
});
