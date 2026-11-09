import {access,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const H2='com.h2database:h2:2.3.232';

export async function readGradleBuild(backend){
  for(const name of ['build.gradle','build.gradle.kts']){
    const text=await readFile(path.join(backend,name),'utf8').catch(()=>null);
    if(text!==null)return text;
  }
  return null;
}
export async function unsupportedProject(backend,build,files){
  for(const name of ['settings.gradle','settings.gradle.kts'])
    if(/^\s*include\b/m.test(await readFile(path.join(backend,name),'utf8').catch(()=>'')))return '단일 모듈 Gradle 프로젝트만 지원합니다. 멀티모듈은 UNVERIFIED로 남깁니다.';
  if(/spring-boot-starter-webflux/.test(build)&&!/spring-boot-starter-web\b/.test(build))return 'WebFlux 전용 프로젝트는 아직 자동 검사하지 못합니다. UNVERIFIED로 남깁니다.';
  if(!files.some(f=>/@Entity\b/.test(f.text)))return 'JPA Entity가 없는 프로젝트는 DB 상태를 관찰할 수 없어 UNVERIFIED로 남깁니다.';
  return null;
}
export async function gradleWrapper(backend){
  // Observed: Gradle's test JVM fails with ClassNotFoundException under such a path on Windows.
  if(process.platform==='win32'&&/[^\x00-\x7F]/.test(backend))throw new Error('Windows에서는 폴더 경로에 한글 등 영문 외 문자가 있으면 Gradle 테스트를 실행할 수 없습니다. 영문 경로로 옮겨 주세요.');
  const file=path.join(backend,process.platform==='win32'?'gradlew.bat':'gradlew');
  await access(file).catch(()=>{throw new Error('대상 프로젝트에 Gradle wrapper(gradlew)가 없어 실행할 수 없습니다.');});
  return file;
}
// Tool-owned run settings: the target's own build files stay untouched.
export async function gradleCommand({build,backend,testClass,runDir,attempt}){
  const needsH2=!/\bh2\b|h2database/.test(build);
  // The separate build container cannot see runDir. 'wx' below refuses a file or link left in the shared folder.
  const init=path.join(process.env.BUILD_RUNNER_URL?backend:runDir,`native-${attempt}.init.gradle`);
  // Sized for a small shared server. Tests of earlier checks stay on disk but are not compiled again.
  const heap=`${Number(process.env.BUILD_HEAP_MB)||256}m`,lean="-XX:+UseSerialGC -XX:TieredStopAtLevel=1",current=testClass.split('.').at(-2);
  await writeFile(init,`allprojects {\n  tasks.withType(Test).configureEach { useJUnitPlatform(); maxParallelForks = 1; maxHeapSize = '${heap}'; jvmArgs '-Djava.security.manager=allow', ${lean.split(' ').map(a=>`'${a}'`).join(', ')}, '-XX:MaxMetaspaceSize=192m', '-XX:ReservedCodeCacheSize=64m', '-Xss512k'; outputs.upToDateWhen { false } }\n  tasks.matching { it.name == 'compileTestJava' }.configureEach { exclude { e -> def p = e.file.path.replace('\\\\', '/'); p.contains('/intent/generated/') && !p.contains('/${current}') } }\n${needsH2?`  plugins.withId('java') { dependencies { testRuntimeOnly '${H2}' } }\n`:''}}\n`,{flag:'wx'});
  // Repositories authored on Windows often commit gradlew without its executable bit.
  const wrapper=await gradleWrapper(backend),windows=process.platform==='win32';
  return {executable:windows?wrapper:'sh',args:[...(windows?[]:[wrapper]),'-I',init,'test','--tests',testClass,'--no-daemon','--console=plain','--max-workers=1',`-Dorg.gradle.jvmargs=-Xmx${heap} ${lean} -XX:MaxMetaspaceSize=256m`],needsH2,gradleOpts:lean};
}
export const noTestsFound=log=>/No tests found for given includes/.test(log);
// A result produced while memory ran out says nothing about the target's behaviour.
export const outOfMemory=text=>/OutOfMemoryError|GC overhead limit exceeded|exit value 137|daemon disappeared unexpectedly/.test(text);
// The wrapper itself failed before the build started, so no generated code is involved.
export const gradleDownloadFailed=log=>/at org\.gradle\.wrapper\./.test(log);
