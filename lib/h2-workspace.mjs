import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {digest,ensure} from './domain.mjs';
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export async function javaSources(root) {
  const files=[];
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){ensure(!e.isSymbolicLink(),'심볼릭 링크가 포함된 소스는 별도 설정이 필요합니다.');const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.java'))files.push({file:path.relative(root,p).replaceAll('\\','/'),text:await readFile(p,'utf8')});}}
  let sourceRoot='src/main/java';try{await walk(path.join(root,sourceRoot));}catch(e){if(e.code!=='ENOENT')throw e;sourceRoot='src/test/java';await walk(path.join(root,sourceRoot));}return {files,sourceRoot};
}
export async function isolatedPom(root) {
  let source,version,deps=[];
  try {
    source=await readFile(path.join(root,'build.gradle'),'utf8');version=source.match(/id\s+['"]org\.springframework\.boot['"]\s+version\s+['"]([\d.]+)['"]/)?.[1];
    ensure(version,'Spring Boot 버전을 읽지 못했습니다. 현재 단일 모듈 Java 프로젝트를 지원합니다.');
    for(const m of source.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor)\s*(?:\(\s*)?['"]([\w.-]+):([\w.-]+)(?::([\w.-]+))?['"]/g))deps.push({group:m[1],artifact:m[2],version:m[3]});
  } catch(e) {
    if(e.code!=='ENOENT')throw e;
    source=await readFile(path.join(root,'pom.xml'),'utf8');version=source.match(/<parent>[\s\S]*?<artifactId>spring-boot-starter-parent<\/artifactId>[\s\S]*?<version>([\d.]+)<\/version>/)?.[1];ensure(version,'Spring Boot parent가 있는 단일 모듈 Maven 프로젝트가 필요합니다.');
    for(const m of source.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)){const tag=n=>m[1].match(new RegExp(`<${n}>([^<]+)</${n}>`))?.[1];if(tag('scope')==='test')continue;deps.push({group:tag('groupId'),artifact:tag('artifactId'),version:tag('version')});}
  }
  const required=['spring-boot-starter-web','spring-boot-starter-data-jpa','spring-boot-starter-validation','spring-boot-starter-test'];
  deps.push(...required.map(artifact=>({group:'org.springframework.boot',artifact})),{group:'com.h2database',artifact:'h2'});
  deps=deps.filter(d=>d.group&&d.artifact&&!/mysql|postgresql|mariadb|ojdbc/.test(d.artifact));
  deps=[...new Map(deps.map(d=>[d.group+':'+d.artifact,d])).values()];
  ensure(deps.every(d=>!d.version||/^[\w.-]+$/.test(d.version)),'변수로 지정한 의존성 버전은 아직 자동 연결하지 못합니다.');
  return `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${version}</version><relativePath/></parent><groupId>local.verification</groupId><artifactId>isolated-h2-tests</artifactId><version>1</version><properties><java.version>21</java.version><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><dependencies>${deps.map(d=>`<dependency><groupId>${xml(d.group)}</groupId><artifactId>${xml(d.artifact)}</artifactId>${d.version?`<version>${xml(d.version)}</version>`:''}</dependency>`).join('')}</dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><configuration><argLine>-Djava.security.manager=allow</argLine></configuration></plugin></plugins></build></project>`;
}
export function contextBindings(files,endpoints) {
  const classes=files.map(f=>{const pkg=f.text.match(/\bpackage\s+([\w.]+)\s*;/)?.[1],name=f.text.match(/\bpublic\s+(?:abstract\s+)?(?:class|interface|record)\s+(\w+)/)?.[1];return {...f,pkg,name,fqn:pkg+'.'+name};}).filter(f=>f.pkg&&f.name);
  const components=classes.filter(f=>/@(?:Service|Component|Configuration|RestController|Controller|RestControllerAdvice|ControllerAdvice)\b/.test(f.text));
  const chosen=new Map();
  const add=f=>{if(f)chosen.set(f.fqn,f);};
  for(const e of endpoints){const f=classes.find(f=>f.file===e.file);ensure(f,'선택한 컨트롤러 소스가 없습니다. API를 다시 찾아 주세요.');add(f);}
  for(const f of components)if(/@(?:RestControllerAdvice|ControllerAdvice|EnableWebSecurity)\b|implements\s+WebMvcConfigurer/.test(f.text))add(f);
  let changed=true;
  while(changed){changed=false;const text=[...chosen.values()].map(f=>f.text).join('\n');
    for(const f of components){if(chosen.has(f.fqn)||/@SpringBootApplication/.test(f.text))continue;
      const implemented=f.text.match(/\bimplements\s+([\w,\s]+)/)?.[1]?.split(/[\s,]+/).filter(Boolean)||[];
      const beanTypes=[...f.text.matchAll(/@Bean(?:\([^)]*\))?\s+(?:public\s+)?([\w.]+)\s+\w+\s*\(/g)].map(m=>m[1]);
      if([f.name,...implemented,...beanTypes].some(name=>new RegExp(`\\b${name}\\b`).test(text))){add(f);changed=true;}
    }
  }
  const values={};
  for(const f of chosen.values())for(const m of f.text.matchAll(/@Value\("\$\{([^}:]+)(?::([^}]*))?\}"\)\s+(?:private|public|protected)?\s*(?:final\s+)?([\w.]+)\s+\w+/g)){
    const key=m[1];if(/^(spring\.datasource|spring\.jpa|spring\.sql|spring\.config)/.test(key))continue;
    values[key]=/secret|signing.key/i.test(key)?Buffer.alloc(64,17).toString('base64'):/int|long|Long|Integer/.test(m[3])?'3600000':/boolean/i.test(m[3])?'false':/url|uri|host/i.test(key)?'http://127.0.0.1:1':'isolated-test';
  }
  return {imports:[...chosen.keys()],packages:[...new Set(classes.map(f=>f.pkg).filter(p=>p))],values,sources:files.map(f=>({file:f.file,digest:digest(f.text)}))};
}
export async function writeSources(workspace,files,sourceRoot){for(const f of files){const relative=path.relative(sourceRoot,f.file);ensure(!relative.startsWith('..'),'잘못된 Java 소스 경로입니다.');const dest=path.join(workspace,'src/test/java',relative);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,f.text);}}
