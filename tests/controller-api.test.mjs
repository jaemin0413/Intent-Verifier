import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {parseController,discoverControllers} from "../lib/controller-catalog.mjs";
import {compileApiPlan,recommendApis} from "../lib/api-plan.mjs";
import {suggestChoices} from "../lib/intent-options.mjs";
import {approve,freezeSnapshot,supported,coverage} from "../lib/domain.mjs";
import {executeApi,checkResponse,localBase} from "../lib/http-test-runtime.mjs";
import {createServer} from "../server.mjs";

export const feature={id:"api-example",name:"태그",scan:{id:"scan",nodes:[{id:"1",name:"기획",type:"TEXT",characters:"태그는 최대 3개"}]},analysis:{supportedCandidate:false,summary:"태그 목록",findings:[{text:"최대 3개",quote:"태그는 최대 3개",nodeIds:["1"]}],questions:["태그를 언제 새로 고르나요?"],questionScopes:["backend"]},history:[],analysisStatus:"DONE"};
export const proposal=id=>({cases:[{endpointId:id,name:"태그 목록은 최대 3개",findingIndices:[0],auth:"anonymous",pathValues:[],query:[],bodyJson:"null",status:200,checks:[{pointer:"/data",operator:"maxItems",valueJson:"3"}],notCovered:[]}],excluded:[]});
test("컨트롤러의 실제 경로·파라미터만 찾고 구현 본문은 AI에 전달하지 않는다",()=>{
 const text='@RestController @RequestMapping("/api") public class TagController { @GetMapping(path={"/tags/{id}","/other/{id}"}) @Operation(summary="태그") public Response<Tag> read(@PathVariable Long id, @RequestParam(defaultValue="3") int size) { return secretService.read(); } // @DeleteMapping("/gone")\n }';
 const endpoints=parseController(text,"TagController.java");assert.equal(endpoints.length,2);assert.equal(endpoints[0].path,"/api/tags/{id}");assert.equal(endpoints[0].parameters[1].defaultValue,"3");assert.doesNotMatch(endpoints[0].declaration,/secretService/);
});
test("선택 API와 Figma 기대값을 고정하고 추가 관찰 필드는 미지원으로 남긴다",async()=>{
 const catalog=await discoverControllers("fixtures/controller-api","src/test/java"),id=catalog.endpoints[0].id;
 const spec=compileApiPlan(feature,{extraAnswers:["매번"]},catalog,[id],proposal(id));assert.equal(spec.scenarios[0].expected.checks[0].value,3);
 const frozen=freezeSnapshot(approve(spec));assert.throws(()=>frozen.spec.scenarios[0].expected.status=201);assert.ok(coverage(spec,[]).some(r=>r.conditions.some(c=>!c.requiredScenarios.length)));
 assert.equal(supported(spec.scenarios[0],spec.contract),true);const added=structuredClone(spec.scenarios[0]);added.expected.databaseDeleted=true;assert.equal(supported(added,spec.contract),false);
 assert.throws(()=>compileApiPlan(feature,{},catalog,[id],proposal("invented")),/빠졌/);
});
test("실제 응답 위반은 FAIL, 정렬 자료 부족과 인증·연결 부족은 BLOCKED",async()=>{
 const s={id:"sample",actor:{mode:"anonymous"},action:{method:"GET",path:"/tags",pathValues:[],query:[],body:null},expected:{status:200,checks:[{pointer:"/data",operator:"maxItems",value:3}]}};
 assert.equal(checkResponse(s,{status:200,body:'{"data":[1,2,3]}'}).status,"PASS");assert.equal(checkResponse(s,{status:200,body:'{"data":[1,2,3,4]}'}).status,"FAIL");
 s.expected.checks=[{pointer:"/data",operator:"descending",value:"/time"}];assert.equal(checkResponse(s,{status:200,body:'{"data":[{"time":2}]}'}).status,"BLOCKED");assert.equal(checkResponse(s,{status:200,body:'{"data":[{"time":1},{"time":2}]}'}).status,"FAIL");
 s.expected.checks=[{pointer:"/data/0/id",operator:"type",value:"number"}];assert.equal(checkResponse(s,{status:200,body:'{"data":[]}'}).status,"BLOCKED");
 s.actor.mode="bearer";assert.match((await executeApi(s)).reason,/토큰/);s.actor.mode="anonymous";s.action.method="DELETE";assert.match((await executeApi(s)).reason,/쓰기/);
 assert.throws(()=>localBase("https://example.com"));assert.throws(()=>localBase("http://localhost:8000/x"));
});
test("AI 선택지는 승인 답변을 만들지 않고 질문 인덱스를 유지한다",async()=>{
 const answers={0:["매번 새로 선정","하루 동안 유지"]};const out=await suggestChoices(feature,{runtime:{analyze:async()=>({result:{questions:[{index:0,clarity:"ambiguous",quote:"",choices:answers[0]}]}})}});assert.deepEqual(out[0].choices,answers[0]);assert.equal(feature.answers,undefined);
});
test("API 추천부터 선택·초안·승인까지 서버에서 유지된다",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"controller-flow-"));const catalog=await discoverControllers("fixtures/controller-api","src/test/java"),id=catalog.endpoints[0].id;
 const runtime={close(){},analyze:async input=>input.schema.properties.conditions?{result:{conditions:[{id:'c-1',description:'최대 3개',scope:'backend',kind:'shape',findingIndices:[0],answerIndices:[]},{id:'c-2',description:'매번 새로 선정',scope:'backend',kind:'unsupported',findingIndices:[],answerIndices:[0]}]}}:input.schema.properties.recommendations?{result:{recommendations:[{endpointId:id,label:"태그 목록",reason:"태그 개수 확인",recommended:true}]},evidence:{model:"test-double"}}:{result:{...proposal(id),cases:proposal(id).cases.map(c=>({...c,conditionIds:['c-1']}))},evidence:{model:"test-double"}}};
 const {server,store}=await createServer({directory,runtime});await store.mutate(s=>{s.projects[0].backend={repository:path.resolve("fixtures/controller-api"),controllerFolder:"src/test/java"};s.features.push({...structuredClone(feature),projectId:s.projects[0].id,status:"DRAFT"});});await new Promise(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${server.address().port}`;const {token}=await fetch(base+"/api/session").then(r=>r.json());
 const post=async(action,data)=>{const r=await fetch(base+"/api/features/api-example/"+action,{method:"POST",headers:{"X-Local-Token":token,"Content-Type":"application/json"},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};
 const wait=async field=>{for(let i=0;i<1000;i++){const f=(await store.load()).features.find(f=>f.id===feature.id);if(f[field]!=="RUNNING")return f;await new Promise(r=>setTimeout(r,10));}throw Error("timeout");};
 try {assert.equal((await post("draft",{endpointIds:["invented"]})).status,400);assert.notEqual((await wait("planStatus")).planStatus,"RUNNING");assert.equal((await post("apis",{answers:{extraAnswers:["매번"]}})).status,202);let f=await wait("apiStatus");assert.equal(f.apiStatus,"DONE",f.apiStatusError+" / "+f.apiStatusErrorDetail);assert.equal(f.apiCandidates[0].recommended,true);assert.equal((await post("draft",{extraAnswers:["매번"],endpointIds:[id]})).status,202);f=await wait("planStatus");assert.equal(f.planStatus,"DONE",JSON.stringify(f.planError));assert.equal(f.spec.contract.kind,"controller-api-v1");assert.equal((await post("approve",{version:f.spec.version})).body.status,"READY");const before=JSON.stringify(f.spec.scenarios.map(s=>s.expected));const edited=await post("inputs",{version:f.spec.version,scenarios:[]});assert.equal(edited.body.status,"DRAFT");assert.equal(JSON.stringify(edited.body.spec.scenarios.map(s=>s.expected)),before);assert.equal((await post("approve",{version:f.spec.version})).status,400);}
 finally {await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
