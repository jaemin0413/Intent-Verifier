import {readFile,readdir} from "node:fs/promises";
import path from "node:path";

// Small dependency-free ZIP writer (stored entries, UTF-8 filenames).
export function zipFiles(files) {
  const local=[],central=[];let offset=0;
  for(const [name,text] of Object.entries(files)) {
    const data=Buffer.from(text),n=Buffer.from(name);let crc=0xffffffff;
    for(const b of data) {crc^=b;for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(Buffer.concat(central).length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
export async function testPackage(report) {
  const read=name=>readFile(path.join(report.runDir,name),"utf8");
  if(report.runtime==='project-java'){
    const latest=Math.max(...report.generatedFiles.map(f=>f.attempt));const files={};
    for(const f of report.generatedFiles.filter(f=>f.attempt===latest))files[f.relative]=await readFile(path.join(report.runDir,'generated',f.relative),'utf8');
    return zipFiles({...files,'native.init.gradle':await read(`native-${latest}.init.gradle`),'approved-snapshot.json':await read('snapshot.json'),'execution-report.json':JSON.stringify(report,null,2),'README.md':`# 대상 프로젝트 Java 검사\n\n대상: ${report.backend}\n같은 대상 프로젝트에서 생성 파일을 확인하고 Gradle로 실행합니다. Production Code는 포함하거나 수정하지 않습니다.\n\n./gradlew -I native.init.gradle test --tests ${report.attempts.at(-1)?.generatedClass} --no-daemon\n\nGiven/인증 실패는 BLOCKED입니다. JUnit 성공만으로 전체 조건이 통과한 것은 아닙니다. 실행 보고서의 Coverage와 누락을 확인하세요.\n`});
  }
  if(report.runtime === 'spring-h2') {
    const copied={};
    async function collect(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await collect(full);else if(entry.name.endsWith('.java'))copied[path.relative(path.join(report.runDir,'workspace'),full).replaceAll('\\','/')]=await readFile(full,'utf8');}}
    await collect(path.join(report.runDir,'workspace/src/test/java'));
    return zipFiles({
    ...copied,
    'src/test/java/generated/H2ApiHarnessTest.java':await read('GeneratedTest.java'),
    'pom.xml':await read('workspace/pom.xml'),
    'scenario-input.json':await read('scenario-input.json'),
    'approved-snapshot.json':await read('snapshot.json'),
    'execution-report.json':JSON.stringify(report,null,2),
    'README.md':'# 격리 H2 API 검사\n\n실행한 테스트 공간은 '+report.runDir+'/workspace 입니다. 원본 Production Code는 수정하지 않았습니다.\nJava 21과 Maven에서 압축을 푼 폴더에서 그대로 실행하세요. 대상 Java 소스는 원본을 변경하지 않은 테스트용 복사본으로 포함되어 있습니다. 원본 resources·환경변수·DB 비밀번호는 복사하지 마세요.\n\nmvn -Dtest=generated.H2ApiHarnessTest -Dverification.input=scenario-input.json -Dverification.evidence=evidence test\n\nH2 메모리 DB와 실제 애플리케이션 컨트롤러·서비스를 사용하고 요청별 DB 변경을 롤백합니다. 네트워크는 테스트 프로세스에서 차단합니다. 외부 연결·인증·데이터 준비가 부족하면 미검증 또는 BLOCKED입니다. 출력 evidence와 앱의 execution-report.json을 확인하세요. 응답·소유권·정렬·삭제 후 DB 상태를 Java assertion으로 검사합니다. 실행이 생략되면 통과가 아니므로 종료 코드와 Evidence, 범위별 Coverage를 함께 확인하세요.\n'
  });
  }
  if(report.runtime === "node-http") return zipFiles({
    "BackendContract.test.mjs":await read("BackendContract.test.mjs"),
    "http-test-runtime.mjs":await read("http-test-runtime.mjs"),
    "technical-policy.mjs":await read("technical-policy.mjs"),
    "scenario-input.json":await read("scenario-input.json"),
    "approved-snapshot.json":await read("snapshot.json"),
    "execution-report.json":JSON.stringify(report,null,2),
    "README.md":"# 승인한 API 검사\n\nNode.js 22 이상에서 node --test BackendContract.test.mjs 로 실행합니다.\nVERIFY_BASE_URL 환경 변수에 로컬 테스트 서버 주소를 설정하세요. 기본값은 http://127.0.0.1:8080 입니다. 인증이 필요하면 VERIFY_TOKEN에 테스트 계정의 Bearer 토큰을 지정하세요. 변경 요청은 전용 테스트 서버에서 VERIFY_ALLOW_WRITES=true를 명시해야 실행됩니다.\nBLOCKED는 테스트 생략(skip)으로 표시되므로 종료 코드만으로 전체 통과를 판단하지 마세요. evidence 폴더의 각 결과를 확인하세요. HTTP 응답만 관찰하며 DB 상태, 시간 경과, 계정 소유권 등 별도 근거가 없는 조건은 검증하지 않습니다.\n"
  });
  return zipFiles({
    "src/test/java/generated/VerificationHarnessTest.java":await read("GeneratedTest.java"),
    "scenario-input.json":await read("scenario-input.json"),
    "approved-snapshot.json":await read("snapshot.json"),
    "execution-report.json":JSON.stringify(report,null,2),
    "README.md":`# 승인 기준으로 생성한 백엔드 테스트\n\n실행 ID: ${report.id}\n승인 명세 SHA256: ${report.specDigest}\n\n대상 프로젝트 원본은 수정하지 않았습니다. 이 파일은 별도 테스트 작업 공간에 추가해 실행하세요.\nSpring Boot, JUnit 5, MockMvc, Spring Security Test, JDBC, H2 의존성과 Java 21 이상이 필요합니다. 기존 프로젝트 의존성을 사용하며 Production Code를 포함하지 않습니다.\n\n프로젝트 루트에 압축을 풀고 실행(별도 복사본 권장):\n\n~~~sh\nmvn -Dtest=generated.VerificationHarnessTest -Dverification.input=scenario-input.json -Dverification.evidence=verification-evidence test\n~~~\n\nH2 메모리 DB와 ROLE_USER 테스트 인증만 사용합니다. 실제 로그인/토큰 발급을 검증하지 않습니다. DB 바인딩은 이 실행의 프로젝트 설정 기준입니다. 승인 기준 JSON과 Java 파일을 함께 보관하세요. 생성은 통과를 의미하지 않습니다. execution-report.json의 PASS/FAIL/BLOCKED/UNVERIFIED와 조건별 Coverage를 확인하세요.\n`
  });
}
