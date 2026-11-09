import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseController,parseDto,dtoShapes,externalApiReason} from '../lib/controller-catalog.mjs';
import {compileApiPlan,recommendApis} from '../lib/api-plan.mjs';
import {executeApi,checkResponse} from '../lib/http-test-runtime.mjs';
import {coverage} from '../lib/domain.mjs';
const f={id:'valid-proof',name:'로그인',scan:{id:'scan'},analysis:{summary:'올바르지 않은 이메일은 거절',questions:[],findings:[{text:'이메일 형식 확인',quote:'이메일 형식 확인',nodeIds:['1']} ]}};
const java='@RestController public class AuthController { @PostMapping("/login") public Response<Token> login(@RequestBody(required=true) @jakarta.validation.Valid LoginReq request) {return service.login(request);} @GetMapping("/users/{id}") public String get(@NotNull @PathVariable("id") @Valid Long id, @RequestParam(name="q", defaultValue="a,b") @Size(min=1) String query) {return "x";} }';
const endpoints=parseController(java,'AuthController.java');
const catalog={digest:'source',endpoints:[...endpoints,{id:'oauth',method:'GET',path:'/oauth/google',controller:'OAuthController',file:'OAuthController.java',handler:'login'}]};
const entry=(id,status=400)=>({endpointId:id,name:'이메일 형식 검사',findingIndices:[0],auth:'anonymous',pathValues:[],query:[],bodyJson:'{"email":"invalid","password":"example"}',status,checks:[],notCovered:[]});
test('@Valid 순서·정규 이름·인수와 무관하게 RequestBody 및 검증 메타데이터를 보존한다',()=>{
 assert.equal(endpoints[0].requestType,'LoginReq');assert.equal(endpoints[0].requestValidation[0].name,'Valid');assert.equal(endpoints[1].parameters[0].name,'id');assert.equal(endpoints[1].parameters[1].defaultValue,'a,b');assert.doesNotMatch(endpoints[0].declaration,/service.login/);
 assert.equal(parseController(java.replace('@RequestBody(required=true) @jakarta.validation.Valid','@Validated(Create.class) @RequestBody'), 'AuthController.java')[0].requestType,'LoginReq');
 const dto=parseDto('public record LoginReq(@NotBlank @Email String email, @Size(min=8,max=20) @Pattern(regexp="(?=.*[0-9]).{8,20}") String password) {}','LoginReq');
 assert.deepEqual(dto.fields.map(f=>f.name),['email','password']);assert.equal(dto.fields[1].annotations[1].args,'regexp="(?=.*[0-9]).{8,20}"');
 const klass=parseDto('public class Req { @NotBlank private String email; @Size(min=8, max=20) private String password; }','Req');assert.equal(klass.fields[1].annotations[0].name,'Size');
});
test('OAuth 및 응답 기준 없는 성공 제안은 전체 작성 실패 대신 미검증으로 남긴다',()=>{
 const result={cases:[entry(endpoints[0].id),entry('oauth',302),entry(endpoints[1].id,200)],excluded:[]};
 const spec=compileApiPlan(f,{},catalog,catalog.endpoints.map(e=>e.id),result);
 assert.equal(spec.scenarios.length,1);assert.equal(spec.scenarios[0].expected.status,400);
 assert.ok(spec.requirements.some(r=>r.description.includes('/oauth/')));assert.ok(coverage(spec,[]).some(c=>c.conditions.some(x=>x.reason==='SCENARIO_MISSING')));
 const empty=compileApiPlan(f,{},catalog,['oauth'],{cases:[],skippedEndpoints:[{endpointId:'oauth',reason:'외부 연결 필요'}],excluded:[]});assert.equal(empty.scenarios.length,0);
});
test('실제 실패 로그를 재생해 일반 API 검사안을 살리고 OAuth를 실행하지 않는다',async()=>{
 const {proposal}=JSON.parse(await readFile(new URL('./fixtures/validation-plan-replay.json',import.meta.url),'utf8'));
 const ids=[...new Set(proposal.cases.map(c=>c.endpointId))];
 const cat={digest:'replay',endpoints:ids.map((id,i)=>({id,method:'POST',path:'/api/'+i,file:'AuthController.java',handler:'handler'+i,controller:i===4||i===5?'OAuthController':'AuthController'}))};
 const feature={...f,analysis:{...f.analysis,findings:Array.from({length:14},()=>f.analysis.findings[0])}};
 const spec=compileApiPlan(feature,{},cat,ids,proposal);assert.equal(spec.scenarios.length,4);assert.ok(spec.requirements.length>4);
});
test('외부 로그인은 추천에서 제외하고 실제 302도 이동하지 않으며 미검증으로 남긴다',async()=>{
 const out=await recommendApis({...f,scan:{nodes:[]}},catalog,{runtime:{analyze:async()=>({result:{recommendations:[{endpointId:'oauth',recommended:true}]}})}});
 assert.equal(out.candidates.find(e=>e.id==='oauth').recommended,false);assert.ok(externalApiReason(catalog.endpoints.at(-1)));
 const s={id:'redirect',actor:{mode:'anonymous'},action:{method:'GET',path:'/login',pathValues:[],query:[],body:null},expected:{status:200,checks:[]}};
 let count=0;const r=await executeApi(s,{baseUrl:'http://localhost:8080',fetchImpl:async(url,init)=>{count++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://external.invalid'}});}});
 assert.equal(count,1);assert.equal(r.status,'UNVERIFIED');assert.equal(r.evidence.response.status,302);
 const failure=checkResponse(s,{status:400,body:'{}'});assert.equal(failure.status,'FAIL');assert.match(failure.reason,/입력값을 거절/);assert.ok(failure.reason.length<80);
});

test('감싼 클래스 안의 DTO와 제네릭 안 애너테이션 필드를 각각 읽는다',()=>{
 const source='public class TeamRequest { /* record Fake(int a) */ @Getter public static class CreateReq { @NotBlank private String title; @NotEmpty(message = "연락수단") private List<@Valid ContactReq> contacts; private List<String> tags = new ArrayList<>(); } public static class ContactReq { @NotNull private ContactType type; } public enum ContactType {\n KAKAO,\n EMAIL\n } public record Page<T>(@NotNull T item, int size) { public int next() { return size + 1; } } }';
 const shapes=dtoShapes(source,'TeamRequest');
 assert.deepEqual(shapes.map(s=>s.name),['TeamRequest.CreateReq','TeamRequest.ContactReq','TeamRequest.ContactType','TeamRequest.Page']);
 assert.deepEqual(shapes[0].fields.map(f=>[f.name,f.type]),[['title','String'],['contacts','List<ContactReq>'],['tags','List<String>']]);
 assert.equal(shapes[0].fields[1].annotations[0].name,'NotEmpty');assert.deepEqual(shapes[2].enumValues,['KAKAO','EMAIL']);
 assert.deepEqual(shapes[3].parameters,['T']);assert.deepEqual(shapes[3].fields.map(f=>f.name),['item','size']);
 assert.deepEqual(dtoShapes('public record LoginReq(String email) {}','LoginReq').map(s=>s.name),['LoginReq']);
});
