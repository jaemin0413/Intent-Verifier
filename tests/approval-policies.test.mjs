import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {approve,isApproved,coverage} from '../lib/domain.mjs';
import {rejectRequirement,replaceDraft} from '../lib/store.mjs';
import {projectPolicies} from '../web/project-policies.mjs';
import {requestDocumentation,supportedDocumentation} from '../lib/api-documentation.mjs';
const sample=JSON.parse(await readFile(new URL('../examples/post-delete.json',import.meta.url),'utf8'));
test('요구사항의 제외와 승인 상태를 구분하고 제외 조건도 Coverage에 남긴다',()=>{
 const feature={status:'DRAFT',spec:structuredClone(sample),history:[]};
 rejectRequirement(feature,sample.requirements[0].id,sample.version);
 assert.equal(feature.spec.requirements[0].approvalStatus,'REJECTED');assert.equal(feature.spec.scenarios.length,0);
 const approved=approve(feature.spec);assert.equal(isApproved(approved),true);assert.equal(approved.requirements[0].approvalStatus,'REJECTED');
 assert.equal(coverage(approved,[])[0].conditions[0].reason,'REQUIREMENT_REJECTED');
 replaceDraft(feature,structuredClone(sample));assert.equal(feature.spec.requirements[0].approvalStatus,'PENDING');
 assert.equal(approve(feature.spec).requirements[0].approvalStatus,'APPROVED');
});
test('같은 프로젝트의 승인 답변만 재사용 후보로 제시하고 충돌 후보를 자동 선택하지 않는다',()=>{
 const current={id:'current',projectId:'p'};
 const make=(id,value,projectId='p')=>({id,name:id,projectId,status:'READY',analysis:{questions:['자동 로그인 기간?'],questionScopes:['backend']},answers:{extraAnswers:[value]},spec:{version:2,approval:{status:'APPROVED'}}});
 const features=[make('a','30일'),make('b','7일'),make('other','90일','other'),{...make('draft','10일'),status:'DRAFT'}, {...make('stale','20일'),sourceReviewRequired:true}];
 const candidates=projectPolicies(features,current,'자동 로그인 기간?');assert.deepEqual(candidates.map(x=>x.value),['30일','7일']);assert.equal(current.answers,undefined);
});
test('명세에는 선언의 필드를 보존하되 검증 제한과 응답 기대값을 복사하지 않는다',()=>{
 const doc=requestDocumentation({requestType:'LoginReq',parameters:[{in:'query',name:'lang',type:'String',required:false}],authentication:'unknown'},[{name:'LoginReq',fields:[{name:'password',type:'String',annotations:[{name:'Size',args:'min=1'}]}]}]);
 assert.equal(doc.request.body.fields[0].key,'password');assert.equal(supportedDocumentation(doc),true);assert.equal(doc.responses,undefined);assert.doesNotMatch(JSON.stringify(doc),/min=1|Size/);
 assert.equal(supportedDocumentation({...doc,responses:[{status:200}]}),false);
});
