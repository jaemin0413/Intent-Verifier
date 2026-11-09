import {mkdir,readFile,writeFile,readdir,lstat,open,unlink,stat,rmdir} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {freezeSnapshot,digest,coverage,supported,ensure} from './domain.mjs';
import {discoverControllers} from './controller-catalog.mjs';
import {javaSources,contextBindings} from './h2-workspace.mjs';
import {h2Result} from './h2-result.mjs';
import {nativeHarness} from './native-generator.mjs';
import {retirePreviousNativeTests,retireFailedNativeTests} from './native-test-files.mjs';
import {nativeInstructions} from './native-prompt.mjs';
import {readGradleBuild,unsupportedProject,gradleWrapper,gradleCommand,noTestsFound,outOfMemory,gradleDownloadFailed} from './build-tool.mjs';
import {BUILD_WORK} from './work-gate.mjs';
import {root} from '../scripts/setup.mjs';

const exec=promisify(execFile);
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const generatedSchema=obj({java:{type:'string'},notes:{type:'array',items:{type:'string'}},unsupportedScenarioIds:{type:'array',items:{type:'string'}}});
async function reusableBinding(outputRoot,backend,stateDigest,specDigest){
  const names=(await readdir(outputRoot)).filter(n=>/^\d+-native-[\w-]+$/.test(n)).sort().reverse();
  for(const name of names){try{
    const report=JSON.parse(await readFile(path.join(outputRoot,name,'report.json'),'utf8'));
    if(report.backend!==backend||report.backendState?.digest!==stateDigest||report.specDigest!==specDigest||report.originalUnchanged!==true||report.counts.BLOCKED||!report.results.some(r=>r.evidence?.actionExecuted))continue;
    return {sourceRunId:report.id,java:await readFile(path.join(outputRoot,name,'GeneratedTest.java'),'utf8')};
  }catch{}}
  return null;
}
export async function productionState(backend){
  const files=[];
  async function walk(relative){let entries;try{entries=await readdir(path.join(backend,relative),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const e of entries){ensure(!e.isSymbolicLink(),'심볼릭 링크는 자동 테스트 생성 범위 밖입니다.');const file=path.join(relative,e.name);if(e.isDirectory())await walk(file);else files.push({file:file.replaceAll('\\','/'),digest:digest(await readFile(path.join(backend,file)))});}}
  await walk('src/main');
  for(const file of ['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','pom.xml','gradle.properties','gradlew','gradlew.bat','gradle/wrapper/gradle-wrapper.properties','gradle/wrapper/gradle-wrapper.jar','gradle/libs.versions.toml'])try{files.push({file,digest:digest(await readFile(path.join(backend,file)))});}catch(e){if(e.code!=='ENOENT')throw e;}
  files.sort((a,b)=>a.file.localeCompare(b.file));return {digest:digest(files),files};
}
// Every $fixture value the harness will read back, so the AI never has to guess where to put it.
export function fixtureReferences(scenarios){
  return scenarios.flatMap(s=>[...new Set(JSON.stringify(s).match(/"\$fixture\/[^"]+"/g)||[])].map(ref=>{const reference=JSON.parse(ref);return {scenarioId:s.id,reference,relationsPath:reference.slice('$fixture/'.length)};}));
}
export function validateGeneratedJava(source,packageName){
  ensure(typeof source==='string'&&source.length<180000&&source.includes(`package ${packageName};`)&&/class\s+GeneratedIntentTest\s+extends\s+NativeIntentHarness/.test(source),'AI가 올바른 Java 테스트 연결 코드를 만들지 못했습니다.');
  ensure(!/@(?:Test|TestFactory|BeforeAll|BeforeEach|AfterAll|AfterEach)\b|\b(?:java\.io(?!\.InputStream\b)|java\.nio|java\.net|ProcessBuilder|Runtime\.getRuntime|System\.(?:exit|setProperty|setSecurityManager|getenv)|getDeclaredMethod|sun\.misc)\b/.test(source),'생성 Adapter에 실행·파일 변경·별도 테스트 코드가 포함되었습니다.');
  ensure(!/@(?:MockBean|MockitoBean|SpyBean|MockitoSpyBean)\b/.test(source),'생성 코드가 대상 프로젝트의 Bean을 Mock으로 교체할 수 없습니다.');
  ensure(!/\b(?:permitAll|SecurityFilterChain|WebSecurityCustomizer)\b|addFilters\s*=\s*false/.test(source),'생성 코드가 대상 프로젝트의 보안 설정을 대체할 수 없습니다.');
  ensure(!/\b(?:Class\.forName|getMethod|getDeclaredField|setAccessible|MethodHandles|getClassLoader|defineClass)\b/.test(source),'생성 코드에서 리플렉션으로 검증 코드를 우회할 수 없습니다.');
  ensure(!/\b(?:observeDatabase|prepareChecked|verifyFixtureRollback|cases|run)\s*\(/.test(source),'도구 소유 검증 메서드를 Adapter가 대체할 수 없습니다.');
  ensure(source.includes('jdbc:h2:mem:')&&source.includes('spring.config.location'),'테스트 전용 DB와 설정 격리가 필요합니다.');
  ensure(!/jdbc:(?!h2:mem:)/i.test(source),'생성 테스트는 운영 DB에 연결할 수 없습니다.');
  return source;
}
async function writeNew(backend,relative,text){
  const target=path.resolve(backend,relative),base=path.resolve(backend)+path.sep;
  ensure(target.startsWith(base)&&/^src\/test\/(?:java|resources)\//.test(relative),'테스트 코드 영역 밖에 파일을 생성할 수 없습니다.');
  let current=path.resolve(backend);for(const part of path.relative(backend,path.dirname(target)).split(path.sep)){current=path.join(current,part);try{ensure(!(await lstat(current)).isSymbolicLink(),'심볼릭 링크 테스트 폴더는 지원하지 않습니다.');}catch(e){if(e.code!=='ENOENT')throw e;}}
  await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text,{flag:'wx'});return target;
}
const normalizedPath=p=>p.replace(/\{[^}]+\}/g,'{}').replace(/\/+$/,'')||'/';
// The project classes that must really run. Third-party SDK clients stay replaceable.
export function projectTypes(sources){
  return sources.flatMap(f=>{
    const pkg=f.text.match(/\bpackage\s+([\w.]+)/)?.[1],name=path.basename(f.file,'.java');
    const managed=/@(?:Service|Repository|RestController|Controller|Component)\b/.test(f.text)||new RegExp('\\binterface\\s+'+name+'\\s+extends\\s+[\\w<>, ]*Repository\\b').test(f.text);
    return pkg&&managed?[pkg+'.'+name]:[];
  });
}
// Fail before spending AI usage when the build could never start.
async function preflightJava(texts){
  let output;
  try{const {stdout,stderr}=await exec('java',['-version'],{windowsHide:true,timeout:20000});output=stderr+stdout;}
  catch{throw new Error('서버에서 Java를 찾지 못했습니다. JDK 21을 설치해 주세요.');}
  const major=Number(output.match(/version "(\d+)/)?.[1]);
  // The harness blocks network calls with a SecurityManager, which Java 24 removed.
  ensure(!(major>=24)||/toolchain/.test(texts),`현재 Java ${major}에서는 실행할 수 없습니다. JDK 21을 사용해 주세요.`);
}
// The target's build runs project code, which must not see this server's own secrets.
function buildEnv(gradleOpts){
  const env={...process.env,GRADLE_OPTS:[process.env.GRADLE_OPTS,gradleOpts].filter(Boolean).join(' ')};
  for(const name of ['ADMIN_KEY','APP_LINK_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'])delete env[name];
  return env;
}
// Output of a build is untrusted: a link planted there must not make this process read its own keys.
async function readBuildOutput(file){const handle=await open(file,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));try{return await handle.readFile('utf8');}finally{await handle.close();}}
function remoteBuild(input){
  return new Promise((resolve,reject)=>{
    const req=http.request(new URL('/run',process.env.BUILD_RUNNER_URL),{method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',d=>{text+=d;});
      res.on('end',()=>{try{const out=JSON.parse(text);if(res.statusCode===200)resolve(out);else reject(new Error(out.error));}catch{reject(new Error('빌드 실행기의 응답을 읽지 못했습니다. 다시 검사해 주세요.'));}});
    });
    req.on('error',()=>reject(new Error('빌드 실행기에 연결하지 못했습니다. 서버 관리자에게 알려 주세요.')));
    req.end(JSON.stringify(input));
  });
}
async function runBuild(command,args,cwd,logFile,timeoutMs,gradleOpts){
  if(process.env.BUILD_RUNNER_URL){const out=await remoteBuild({cwd,args,gradleOpts,timeoutMs});await writeFile(logFile,out.log);return out;}
  let log='',timedOut=false;
  const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
  const executable=process.platform==='win32'?'powershell.exe':command;
  const params=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',`& ${quote(command)} ${args.map(quote).join(' ')}; exit $LASTEXITCODE`]:args;
  const exitCode=await new Promise(resolve=>{const child=spawn(executable,params,{cwd,windowsHide:true,env:buildEnv(gradleOpts)});
    let writing=Promise.resolve();const append=b=>{log+=String(b);writing=writing.then(()=>writeFile(logFile,log));};
    child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',e=>append(e.stack));
    const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();},timeoutMs);
    child.on('close',code=>{clearTimeout(timer);writing.finally(()=>resolve(code));});
  });return {exitCode,timedOut,log};
}
const activeBackends=new Set();
export async function verifyNativeJava({spec,backend,controllerFolder='src/main/java',runtime,model,outputRoot=path.join(root,'.verification/runs'),onProgress=()=>{},timeoutMs=600000,maxRepairs=2,gate={run:(_work,task)=>task()},codeVersion}){
  backend=path.resolve(backend);ensure(!activeBackends.has(backend),'이 프로젝트의 테스트 생성/실행이 진행 중입니다.');activeBackends.add(backend);
  try{return await executeNative({spec,backend,controllerFolder,runtime,model,outputRoot,onProgress,timeoutMs,maxRepairs,gate,codeVersion});}finally{activeBackends.delete(backend);}
}
async function executeNative({spec,backend,controllerFolder,runtime,model,outputRoot,onProgress,timeoutMs,maxRepairs,gate,codeVersion}){
  const id=`${Date.now()}-native-${crypto.randomUUID().slice(0,8)}`,runDir=path.join(outputRoot,id);
  await mkdir(runDir,{recursive:true});const save=(name,value)=>writeFile(path.join(runDir,name),JSON.stringify(value,null,2));
  const snapshot=freezeSnapshot(spec);await save('snapshot.json',snapshot);
  const report={id,featureId:spec.feature.id,featureName:spec.feature.name,backend,...(codeVersion?{codeVersion}:{}),runDir,startedAt:new Date().toISOString(),snapshotId:snapshot.id,specDigest:snapshot.specDigest,runtime:'project-java',testFile:'GeneratedTest.java',results:[],events:[],generatedFiles:[],attempts:[],limitations:['대상 프로젝트의 원래 Gradle 빌드와 H2 메모리 DB로 실행합니다. 운영 DB 호환성과 외부 제공자 호출은 검증하지 않습니다.']};
  const event=async type=>{report.events.push({type,at:new Date().toISOString()});onProgress(type);await save('events.json',report.events);};
  await event('SNAPSHOT_FROZEN');let blocked;let before;let finalEvidenceDir;let executedEvidence;let unsupportedIds=[];let unsupportedBuild=false;let memoryShort=false;const missingEndpoints=new Map();
  try{
    ensure(runtime?.analyze,'AI를 먼저 연결해 주세요.');
    before=await productionState(backend);report.backendState=before;await save('code-state.json',before);
    const referenceAdapter=await reusableBinding(outputRoot,backend,before.digest,snapshot.specDigest);
    if(referenceAdapter)report.referenceAdapterRunId=referenceAdapter.sourceRunId;
    const build=await readGradleBuild(backend);
    const stopUnsupported=message=>{unsupportedBuild=true;throw new Error(message);};
    if(build===null)stopUnsupported('Gradle 빌드 파일을 찾지 못했습니다. 현재 Gradle 프로젝트만 지원하며 다른 빌드는 UNVERIFIED로 남깁니다.');
    const {files}=await javaSources(backend);
    const unsupported=await unsupportedProject(backend,build,files);if(unsupported)stopUnsupported(unsupported);
    await gradleWrapper(backend);
    await preflightJava(build);
    report.retiredFailedFiles=await retireFailedNativeTests(backend,outputRoot,id);
    const catalog=await discoverControllers(backend,controllerFolder);
    // Path variable names may differ from an AI proposal. One unbuilt API must not block the rest.
    const endpoints=[];
    for(const e of spec.contract.endpoints.filter(e=>spec.scenarios.some(s=>s.endpointId===e.id))){
      const found=catalog.endpoints.filter(x=>x.method===e.method&&normalizedPath(x.path)===normalizedPath(e.path));
      if(found.length===1)endpoints.push({...found[0],id:e.id});else missingEndpoints.set(e.id,{...e,ambiguous:found.length>1});
    }
    report.missingEndpoints=[...missingEndpoints.values()].map(e=>e.method+' '+e.path);
    ensure(endpoints.length,'승인한 API를 현재 Controller에서 하나도 찾지 못했습니다.');
    const binding=contextBindings(files,endpoints);
    const selected=new Set(endpoints.map(e=>e.file));
    for(const f of files)if(/@Entity\b|@EnableWebSecurity\b|implements WebMvcConfigurer/.test(f.text))selected.add(f.file);
    for(const fqn of binding.imports){const f=files.find(f=>f.text.includes('class '+fqn.split('.').at(-1)));if(f)selected.add(f.file);}
    let changed=true;while(changed){changed=false;const text=files.filter(f=>selected.has(f.file)).map(f=>f.text).join('\n');for(const f of files){const name=path.basename(f.file,'.java');if(!selected.has(f.file)&&new RegExp('\\b'+name+'\\b').test(text)){selected.add(f.file);changed=true;}}}
    const sources=files.filter(f=>selected.has(f.file));
    const testSources=[];async function tests(dir){let es;try{es=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}for(const e of es){if(e.name==='intent'||e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())await tests(p);else if(e.name.endsWith('.java')&&testSources.length<20)testSources.push({file:path.relative(backend,p),text:await readFile(p,'utf8')});}}
    await tests(path.join(backend,'src/test/java'));
    const scenarios=snapshot.spec.scenarios.filter(s=>supported(s,snapshot.spec.contract)&&!missingEndpoints.has(s.endpointId)).map(s=>{const e=endpoints.find(e=>e.id===s.endpointId),file=files.find(f=>f.file===e.file);return {...s,binding:{controller:file.text.match(/\bpackage\s+([\w.]+)/)[1]+'.'+path.basename(file.file,'.java'),handler:e.handler}};});
    ensure(scenarios.length,'선택한 조건에 실행 가능한 시나리오가 없습니다.');
    await save('scenario-input.json',scenarios);await save('backend-analysis.json',{files:sources.map(f=>f.file),existingTestFiles:testSources.map(f=>f.file),afterSnapshot:snapshot.id,expectedBehaviorReadFromBackend:false});await event('BACKEND_ANALYZED');
    let previous,diagnostics;
    for(let attempt=0;attempt<=maxRepairs;attempt++){
      const packageName='intent.generated.r'+id.replaceAll('-','')+'a'+attempt;
      const inputResource=`intent-generated/${id}/a${attempt}/scenarios.json`;
      const evidenceDir=path.join(backend,'build/intent-verification',id,'a'+attempt);await mkdir(evidenceDir,{recursive:true});finalEvidenceDir=evidenceDir;
      await event(attempt?'TEST_REPAIRING':'TEST_GENERATING');
      const output=await runtime.analyze({model,images:[],schema:generatedSchema,nodes:{packageName,className:'GeneratedIntentTest',approvedScenarios:scenarios,requiredReferences:fixtureReferences(scenarios),build,sources,existingTests:testSources,referenceAdapter,previous,diagnostics},instructions:nativeInstructions});
      await save(`generation-${attempt}.json`,output);unsupportedIds=output.result.unsupportedScenarioIds;
      ensure(Array.isArray(unsupportedIds)&&unsupportedIds.every(x=>scenarios.some(s=>s.id===x)),'AI가 보고한 미지원 항목 ID가 시나리오에 없습니다.');
      // A cut-off or malformed reply is one bad attempt, not a verdict on the whole run.
      let source;try{source=validateGeneratedJava(output.result.java,packageName);}catch(e){if(attempt===maxRepairs)throw e;previous=output.result.java;diagnostics=JSON.stringify({validation:e.message});continue;}
      const harness=await nativeHarness({packageName,inputResource,evidenceDirectory:evidenceDir,runId:id,projectTypes:projectTypes(sources)});
      const base=`src/test/java/${packageName.replaceAll('.','/')}`;
      for(const [relative,text] of [[base+'/NativeIntentHarness.java',harness],[base+'/GeneratedIntentTest.java',source],['src/test/resources/'+inputResource,JSON.stringify(scenarios.filter(s=>!unsupportedIds.includes(s.id)),null,2)]]){const file=await writeNew(backend,relative,text);report.generatedFiles.push({path:file,relative,digest:digest(text),attempt,owner:relative.endsWith('GeneratedIntentTest.java')?'ai':'tool'});const artifact=path.join(runDir,'generated',relative);await mkdir(path.dirname(artifact),{recursive:true});await writeFile(artifact,text);}
      await writeFile(path.join(runDir,`GeneratedTest-${attempt}.java`),source);await writeFile(path.join(runDir,'GeneratedTest.java'),source);await writeFile(path.join(runDir,'NativeIntentHarness.java'),harness);await save('generated-files.json',report.generatedFiles);await event('TEST_GENERATED');
      const command=await gradleCommand({build,backend,testClass:packageName+'.GeneratedIntentTest',runDir,attempt});
      if(command.needsH2&&!report.limitations.some(l=>l.startsWith('H2')))report.limitations.push('H2 드라이버는 대상 빌드 파일을 바꾸지 않고 이번 테스트 실행에만 추가했습니다.');
      report.command={executable:command.executable,args:command.args,cwd:backend};await save('command.json',report.command);onProgress('QUEUED');
      const execution=await gate.run(BUILD_WORK,async()=>{await event('EXECUTION_STARTED');return runBuild(command.executable,command.args,backend,path.join(runDir,'execution.log'),timeoutMs,command.gradleOpts);});
      report.exitCode=execution.exitCode;report.attempts.push({attempt,generation:output.evidence,exitCode:execution.exitCode,timedOut:execution.timedOut,generatedClass:packageName+'.GeneratedIntentTest'});
      await writeFile(path.join(runDir,`execution-${attempt}.log`),execution.log);
      const junit=[];
      try{for(const file of await readdir(path.join(backend,'build/test-results/test')))if(file.endsWith('.xml')&&file.includes(packageName)){const xml=await readBuildOutput(path.join(backend,'build/test-results/test',file));junit.push(xml.slice(0,32000));await mkdir(path.join(runDir,'junit'),{recursive:true});await writeFile(path.join(runDir,'junit',file),xml);}}catch{}
      const evidenceFiles=(await readdir(evidenceDir)).filter(f=>f.endsWith('.json'));
      const observed=await Promise.all(evidenceFiles.map(async f=>JSON.parse(await readBuildOutput(path.join(evidenceDir,f)))));
      if(evidenceFiles.length)executedEvidence={dir:evidenceDir,attempt};
      const preparationErrors=observed.filter(e=>e.blocked&&!e.actionExecuted&&e.failureStage==='PRECONDITION');
      const repairPreparation=preparationErrors.length>0 && !observed.some(e=>e.javaAssertionsPassed===false);
      // The run never reached a test: asking the AI to repair its code cannot help.
      if(gradleDownloadFailed(execution.log)){blocked='Gradle을 내려받지 못해 검사를 시작하지 못했습니다. 잠시 뒤 다시 검사해 주세요.';break;}
      if(noTestsFound(execution.log)){blocked='Gradle이 생성 테스트를 찾지 못했습니다. 대상 프로젝트의 테스트 설정을 확인해 주세요.';break;}
      if(outOfMemory(execution.log)||junit.some(outOfMemory)){blocked='검사 중 서버 메모리가 부족해 결과를 판단하지 않았습니다. 잠시 뒤 다시 검사해 주세요.';memoryShort=true;break;}
      if(execution.timedOut)blocked=`Gradle 실행이 ${Math.round(timeoutMs/60000)}분 제한을 넘어 중단됐습니다. 실행 로그를 확인해 주세요.`;
      if((evidenceFiles.length&&!repairPreparation)||execution.exitCode===0&&!repairPreparation||execution.timedOut)break;
      // Out of repairs but the tests ran: executed cases keep their own evidence, only the unprepared ones stay BLOCKED.
      if(attempt===maxRepairs&&evidenceFiles.length)break;
      // Keep failed attempts as artifacts only: an uncompilable source would break every later Gradle test run.
      for(const generated of report.generatedFiles.filter(f=>f.attempt===attempt)){
        if(digest(await readFile(generated.path,'utf8'))===generated.digest){await unlink(generated.path);generated.removedAfterCompileFailure=true;await rmdir(path.dirname(generated.path)).catch(()=>{});}
      }
      previous=source;diagnostics=JSON.stringify({build:execution.log.slice(-16000),junit,preparationErrors});if(attempt===maxRepairs)blocked='AI가 테스트 데이터 준비 코드를 끝내 완성하지 못했습니다. 다시 검사해 주세요. 반복되면 실행 로그를 개발자에게 전달해 주세요.';
    }
    if(executedEvidence&&executedEvidence.dir!==finalEvidenceDir&&!(await readdir(finalEvidenceDir).catch(()=>[])).length){finalEvidenceDir=executedEvidence.dir;report.evidenceAttempt=executedEvidence.attempt;blocked=undefined;}
    try{const reports=path.join(backend,'build/test-results/test');const xml=await readdir(reports);await mkdir(path.join(runDir,'junit'),{recursive:true});for(const file of xml.filter(x=>x.endsWith('.xml')&&x.includes(id.replaceAll('-',''))))await writeFile(path.join(runDir,'junit',file),await readBuildOutput(path.join(reports,file)));}catch{}
  }catch(error){blocked=error.message;await writeFile(path.join(runDir,'error.log'),error.stack||String(error));}
  finally{if(before){const after=await productionState(backend);report.originalUnchanged=after.digest===before.digest;await save('code-state-after.json',after);if(!report.originalUnchanged)blocked='검사 중 Production 또는 빌드 상태가 변경되었습니다. 현재 결과를 통과로 사용하지 않습니다.';}}
  for(const s of snapshot.spec.scenarios){let result;
    if(missingEndpoints.has(s.endpointId)){const e=missingEndpoints.get(s.endpointId);result=e.ambiguous?{status:'BLOCKED',failureStage:'API_NOT_FOUND',reason:`승인한 API ${e.method} ${e.path}와 같은 경로 형태의 Controller 메서드가 둘 이상이라 하나를 고르지 못했습니다.`,nextAction:'경로 변수 이름만 다른 API가 겹칩니다. 개발자가 경로를 구분한 뒤 다시 검사해 주세요.'}:{status:'BLOCKED',failureStage:'API_NOT_FOUND',reason:`승인한 API ${e.method} ${e.path}를 현재 Controller에서 찾지 못했습니다.`,nextAction:'아직 구현 전이면 개발 후 다시 검사하고, 경로가 바뀌었다면 기획 변경으로 다시 승인해 주세요.'};}
    else if(unsupportedBuild||!supported(s,snapshot.spec.contract)||unsupportedIds.includes(s.id))result={status:'UNVERIFIED',reason:unsupportedBuild?blocked:'현재 Java 연결에서 지원하지 않는 조건입니다.'};
    else try{const evidence=JSON.parse(await readBuildOutput(path.join(finalEvidenceDir,s.id+'.json')));ensure(evidence.runId===id&&evidence.scenarioId===s.id,'실행 근거 ID가 현재 실행과 다릅니다.');await mkdir(path.join(runDir,'evidence'),{recursive:true});await save('evidence/'+s.id+'.json',evidence);result=h2Result(s,evidence,report);if(result.status==='PASS'&&evidence.beansVerified!==true)result={...result,status:'BLOCKED',reason:'대상 프로젝트의 업무 계층이 실제로 실행됐는지 확인하지 못했습니다.'};}catch(e){result={status:'BLOCKED',reason:blocked||'이번 Java 실행의 근거가 생성되지 않았습니다.',failureStage:'PREPARATION',details:e.code==='ENOENT'?[]:[e.message]};}
    if(blocked&&(result.status==='PASS'||memoryShort||report.originalUnchanged===false))result={...result,status:'BLOCKED',reason:blocked};
    report.results.push({scenarioId:s.id,name:s.name,expected:s.expected,...result});
  }
  report.generatedTestDigest=digest(report.generatedFiles);await save('generated-files.json',report.generatedFiles);
  report.coverage=coverage(snapshot.spec,report.results);report.counts=Object.fromEntries(['PASS','FAIL','BLOCKED','UNVERIFIED'].map(k=>[k,report.results.filter(r=>r.status===k).length]));
  try{report.retiredFiles=await retirePreviousNativeTests(report,outputRoot);}catch(e){report.limitations.push('이전 생성 파일 정리 미완료: '+e.message);}
  report.finishedAt=new Date().toISOString();await event('FINISHED');await save('report.json',report);return report;
}
