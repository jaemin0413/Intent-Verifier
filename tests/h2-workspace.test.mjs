import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {isolatedPom,contextBindings,javaSources} from '../lib/h2-workspace.mjs';
import {discoverControllers} from '../lib/controller-catalog.mjs';
test('H2 작업 공간은 실제 컨트롤러를 연결하고 외부 서버 설정이나 DB 드라이버를 요구하지 않는다',async()=>{
 const backend='fixtures/h2-write-normal',catalog=await discoverControllers(backend,'src/test/java'),{files}=await javaSources(backend),binding=contextBindings(files,catalog.endpoints);
 assert.deepEqual(binding.imports,['fixture.WriteController']);assert.ok(binding.sources.length);const pom=await isolatedPom(backend);assert.match(pom,/<artifactId>h2<\/artifactId>/);assert.doesNotMatch(pom,/mysql-connector/);
 const harness=await readFile(new URL('../templates/H2ApiHarnessTest.java',import.meta.url),'utf8');assert.match(harness,/status\.setRollbackOnly/);assert.match(harness,/jdbc:h2:mem:/);assert.match(harness,/checkConnect/);assert.match(harness,/handlerMatched/);
});
test('사용하지 않는 외부 설정은 가져오지 않고 실제 보안·서비스 의존성을 유지한다',()=>{
 const files=[{file:'src/main/java/a/Api.java',text:'package a; @RestController public class Api { final Service service; }'},{file:'src/main/java/a/ServiceImpl.java',text:'package a; @Service public class ServiceImpl implements Service { }'},{file:'src/main/java/a/Security.java',text:'package a; @Configuration @EnableWebSecurity public class Security { }'},{file:'src/main/java/a/Firebase.java',text:'package a; @Configuration public class Firebase { @PostConstruct void init() {} }'}];
 const binding=contextBindings(files,[{file:files[0].file}]);assert.ok(binding.imports.includes('a.ServiceImpl'));assert.ok(binding.imports.includes('a.Security'));assert.ok(!binding.imports.includes('a.Firebase'));
});
