import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {productionState,validateGeneratedJava,verifyNativeJava} from '../lib/native-java-runner.mjs';
import {checkResponse} from '../lib/http-test-runtime.mjs';
import {validStatusPolicy} from '../lib/technical-policy.mjs';
import {compileApiPlan,normalizeApiCheck} from '../lib/api-plan.mjs';
import {approve,freezeSnapshot,supported,digest} from '../lib/domain.mjs';
import {retirePreviousNativeTests} from '../lib/native-test-files.mjs';
import {discoverControllers} from '../lib/controller-catalog.mjs';
import {proposeIntentApis} from '../lib/intent-api-plan.mjs';

test('Backend가 없어도 Figma 의도에서 API와 검증 기준을 만들고 AI 선택 출처를 남긴다',async()=>{
 const feature={id:'intent-feature',name:'조회',scan:{id:'scan-1',nodes:[],images:[]},analysis:{summary:'저장된 자료를 조회한다',findings:[{text:'자료 조회',quote:'자료 조회',nodeIds:['n1']}],questions:[]}};
 const outputs=[{endpoints:[{method:'GET',path:'/api/items',summary:'자료 조회',reason:'조회용 기본 경로',authenticated:false,parameters:[],bodyFields:[]}]},{conditions:[{id:'c-1',description:'자료 목록을 반환한다',kind:'shape',scope:'backend',findingIndices:[0],answerIndices:[]}]},{cases:[{endpointId:'intent-api-1',name:'자료 목록',conditionIds:['c-1'],findingIndices:[0],answerIndices:[],fixtureProfile:'none',fixtureGraphJson:'null',givenDescription:'',givenFacts:[],statusOrigin:'ai_default',statusReason:'조회 성공 기본값',database:[],auth:'anonymous',pathValues:[],query:[],bodyJson:'null',status:200,checks:[{pointer:'/items',operator:'type',valueJson:'"array"'}],notCovered:[]}],skippedEndpoints:[],excluded:[]}];
 const runtime={analyze:async input=>{assert.equal(input.nodes.sources,undefined);return {result:outputs.shift(),evidence:{model:'test-double'}};}};
 const {spec}=await proposeIntentApis(feature,{}, {runtime});
 assert.equal(spec.contract.endpoints[0].documentation.origin,'AI_PROPOSAL');assert.equal(spec.contract.endpoints[0].documentation.reason,'조회용 기본 경로');assert.equal(supported(spec.scenarios[0],spec.contract),true);
 const temp=await mkdtemp(path.join(os.tmpdir(),'unsupported-build-'));
 try{const report=await verifyNativeJava({spec:approve(spec),backend:temp,runtime,outputRoot:path.join(temp,'runs')});assert.equal(report.counts.UNVERIFIED,1);assert.equal(report.counts.BLOCKED,0);assert.equal(outputs.length,0);}finally{await rm(temp,{recursive:true,force:true});}
});

test('AI 기본 HTTP 코드 차이는 참고지만 명시 약속과 업무 성공/거절은 엄격히 검사한다',()=>{
 const s={expected:{status:201,statusPolicy:{origin:'ai_default',mode:'equivalent',reason:'생성 성공의 기본 응답'},checks:[{pointer:'/saved',operator:'equals',value:true}]}};
 const r=checkResponse(s,{status:200,body:'{"saved":true}'});assert.equal(r.status,'PASS');assert.equal(r.technicalDifferences[0].actual,200);
 assert.equal(checkResponse(s,{status:200,body:'{"saved":false}'}).status,'FAIL');
 assert.equal(checkResponse(s,{status:403,body:'{"saved":true}'}).status,'FAIL');
 assert.equal(checkResponse(s,{status:500,body:'{"saved":true}'}).status,'FAIL');
 s.expected.statusPolicy={origin:'user_answer',mode:'strict',reason:'사용자가 명시한 생성 계약'};
 assert.equal(checkResponse(s,{status:200,body:'{"saved":true}'}).status,'FAIL');
 assert.equal(validStatusPolicy({...s.expected.statusPolicy,mode:'equivalent'}),false);
});

test('AI의 목록 ID 표현을 같은 전체 집합 검증으로 정규화한다',()=>{
 const normalized=normalizeApiCheck({pointer:'/items/*/id',operator:'setEquals',valueJson:'["a","b"]'});
 const s={expected:{status:200,checks:[normalized]}};
 assert.equal(checkResponse(s,{status:200,body:'{"items":[{"id":"b"},{"id":"a"}]}'}).status,'PASS');
 assert.equal(checkResponse(s,{status:200,body:'{"items":[{"id":"a"},{"id":"b"},{"id":"other"}]}'}).status,'FAIL');
});
test('Given을 프로젝트 Fixture 없이 의도와 관찰 사실로 승인하고 스냅샷에 보존한다',async()=>{
 const catalog=await discoverControllers('fixtures/controller-api','src/test/java'),endpoint=catalog.endpoints[0];
 const feature={id:'native-example',name:'태그',scan:{id:'scan-1'},analysis:{summary:'다른 계정의 데이터는 표시하지 않는다',findings:[{text:'내 데이터',quote:'내 데이터만',nodeIds:['n1']}],questions:[]}};
 const cases=[{endpointId:endpoint.id,name:'내 데이터만 조회',findingIndices:[0],conditionIds:['owned'],answerIndices:[],auth:'bearer',fixtureProfile:'intent-v1',fixtureGraphJson:'null',givenDescription:'서로 다른 두 사용자와 각 사용자의 데이터가 저장되어 있다.',givenFacts:[{id:'owners_distinct',description:'두 계정은 다르다',expectedJson:'true'},{id:'other_owner_records_exist',description:'타인 데이터도 존재한다',expectedJson:'true'}],pathValues:[],query:[],bodyJson:'null',status:200,statusOrigin:'ai_default',statusReason:'정상 조회의 기본 응답',checks:[{pointer:'/data',operator:'setEquals',valueJson:JSON.stringify({key:'/id',values:['$fixture/records/first/id','$fixture/records/second/id']})}],database:[],notCovered:[]}];
 const spec=compileApiPlan(feature,{}, {...catalog,conditions:[{id:'owned',description:'내 데이터만',kind:'ownership',scope:'backend',findingIndices:[0],answerIndices:[]}]},[endpoint.id],{cases,excluded:[]});
 const snapshot=freezeSnapshot(approve(spec));assert.equal(supported(snapshot.spec.scenarios[0],snapshot.spec.contract),true);assert.equal(snapshot.spec.scenarios[0].given.profile,'intent-v1');assert.throws(()=>snapshot.spec.scenarios[0].given.facts[0].expected=false);assert.equal(spec.requirements.find(r=>r.id==='condition-owned').conditions[0].requiredScenarios.length,1);
});
test('대상 Production/빌드 변경은 탐지하고 새 테스트 파일은 별도로 허용한다',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'native-state-'));
 try{await mkdir(path.join(dir,'src/main/java'),{recursive:true});await mkdir(path.join(dir,'src/test/java'),{recursive:true});await writeFile(path.join(dir,'src/main/java/App.java'),'original');await writeFile(path.join(dir,'build.gradle'),'original');const initial=await productionState(dir);await writeFile(path.join(dir,'src/test/java/Generated.java'),'test');assert.equal((await productionState(dir)).digest,initial.digest);await writeFile(path.join(dir,'src/main/java/App.java'),'changed');assert.notEqual((await productionState(dir)).digest,initial.digest);}finally{await rm(dir,{recursive:true,force:true});}
});
test('Codex가 Harness·파일·프로세스를 대체하는 코드는 실행하지 않는다',()=>{
 const valid='package intent.generated.example; @SpringBootTest(properties={"jdbc:h2:mem:test","spring.config.location=optional:classpath:/test"}) public class GeneratedIntentTest extends NativeIntentHarness {}';
 assert.equal(validateGeneratedJava(valid,'intent.generated.example'),valid);
 for(const code of ['@Test void example(){}','void run(){}','java.nio.file.Files.writeString(p,"x");','new ProcessBuilder("cmd");'])assert.throws(()=>validateGeneratedJava(valid+code,'intent.generated.example'));
 assert.throws(()=>validateGeneratedJava(valid.replace('jdbc:h2:mem:test','jdbc:mysql://host/db'),'intent.generated.example'));
});

test('이전 도구 소유 테스트만 아티팩트에 보존한 뒤 정리하고 사용자 수정은 남긴다',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'native-retire-'));
 try{
  const backend=path.join(dir,'backend'),runs=path.join(dir,'runs'),id='1-native-12345678';
  const files=['Old.java','Edited.java'].map(n=>({relative:'src/test/java/intent/generated/old/'+n,digest:digest('generated')}));
  for(const f of files){f.path=path.join(backend,f.relative);await mkdir(path.dirname(f.path),{recursive:true});await writeFile(f.path,f.relative.endsWith('Edited.java')?'user edit':'generated');}
  await mkdir(path.join(runs,id),{recursive:true});await writeFile(path.join(runs,id,'report.json'),JSON.stringify({runtime:'project-java',backend,featureId:'f',generatedFiles:files}));
  const retired=await retirePreviousNativeTests({id:'2-native-abcdef12',backend,featureId:'f',originalUnchanged:true,counts:{BLOCKED:0},results:[{evidence:{actionExecuted:true}}]},runs);
  assert.equal(retired.length,1);assert.equal(await readFile(retired[0].artifact,'utf8'),'generated');await assert.rejects(readFile(files[0].path));assert.equal(await readFile(files[1].path,'utf8'),'user edit');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('AI가 고른 상태 코드의 같은 계열 차이는 참고이고 입력 검증 거절과 값 없음은 구분한다',()=>{
 const s=status=>({expected:{status,statusPolicy:{origin:'ai_default',mode:'equivalent',reason:'기본값'},checks:[{pointer:'/data',operator:'equals',value:null}]}});
 const passed=checkResponse(s(401),{status:400,body:'{"message":"비밀번호가 다릅니다"}'});assert.equal(passed.status,'PASS');assert.match(passed.reason,/비밀번호가 다릅니다/);
 assert.equal(checkResponse(s(403),{status:400,body:'{}',inputRejected:true}).status,'FAIL');
 assert.equal(checkResponse(s(400),{status:500,body:'{}'}).status,'FAIL');assert.equal(checkResponse(s(400),{status:200,body:'{}'}).status,'FAIL');
 const strict=s(401);strict.expected.statusPolicy={origin:'figma',mode:'strict',reason:'명시'};assert.equal(checkResponse(strict,{status:400,body:'{}'}).status,'FAIL');
 assert.equal(checkResponse(s(400),{status:400,body:'{"data":1}'}).status,'FAIL');
});

test('보안 필터가 본문 없이 거절하면 본문 검사는 건너뛰고 일반 응답은 그대로 검사한다',()=>{
 const s={expected:{status:401,checks:[{pointer:'/code',operator:'type',value:'string'}]}};
 assert.equal(checkResponse(s,{status:401,body:'',securityRejected:true}).status,'PASS');
 assert.equal(checkResponse(s,{status:401,body:''}).status,'FAIL');
 assert.equal(checkResponse(s,{status:401,body:'{"code":1}',securityRejected:true}).status,'FAIL');
});

test('없는 항목을 equals null로 확인하면 빈 목록은 통과하고 값이 있으면 실패한다',()=>{
 const s={name:'이미지 없음',given:{},observations:['response.status','response.json'],expected:{status:200,checks:[{pointer:'/data/imageUrls/0',operator:'equals',value:null}]}};
 assert.equal(checkResponse(s,{status:200,body:'{"data":{"imageUrls":[]}}'}).status,'PASS');
 assert.equal(checkResponse(s,{status:200,body:'{"data":{"imageUrls":["a"]}}'}).status,'FAIL');
});
