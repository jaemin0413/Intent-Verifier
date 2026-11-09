// Runs the real Java flow on a small Gradle project unrelated to any team's code.
// The AI is a fixed reply, so this needs no subscription and checks the tool, not a model.
import assert from 'node:assert/strict';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {approve} from '../lib/domain.mjs';
import {proposeIntentApis} from '../lib/intent-api-plan.mjs';
import {productionState,verifyNativeJava} from '../lib/native-java-runner.mjs';
import {root} from './setup.mjs';
import {ClaudeRuntime} from '../lib/ai-runtime.mjs';

// Outside this repo: Gradle's test JVM cannot load classes from a non-ASCII path on Windows.
const out=path.join(os.tmpdir(),'figma-intent-build-samples');

const entity=`package sample.domain;
import jakarta.persistence.*;
@Entity public class Item {
  @Id @GeneratedValue private Long id;
  private String name;
  protected Item() {}
  public Item(String name) { this.name = name; }
  public Long getId() { return id; }
  public String getName() { return name; }
}`;
const repository=`package sample.domain;
import org.springframework.data.jpa.repository.JpaRepository;
public interface ItemRepository extends JpaRepository<Item, Long> {}`;
const view=`package sample.domain;
public record ItemView(Long id, String name) {}`;
const service=`package sample.domain;
import org.springframework.stereotype.Service;
@Service public class ItemService {
  private final ItemRepository items;
  public ItemService(ItemRepository items) { this.items = items; }
  public ItemView find(Long id) { Item item = items.findById(id).orElseThrow(); return new ItemView(item.getId(), item.getName().toUpperCase()); }
}`;
// Deliberately not named *Controller, and the DTO is not in a dto package.
const controller=`package sample.web;
import org.springframework.web.bind.annotation.*;
import sample.domain.*;
@RestController @RequestMapping("/api/items") public class ItemResource {
  private final ItemService service;
  public ItemResource(ItemService service) { this.service = service; }
  @GetMapping("/{itemId}") public ItemView get(@PathVariable Long itemId) { return service.find(itemId); }
}`;
const application=`package sample;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
@SpringBootApplication public class SampleApplication { public static void main(String[] args) { SpringApplication.run(SampleApplication.class, args); } }`;

const single=()=>({'src/main/java/sample/SampleApplication.java':application,'src/main/java/sample/domain/Item.java':entity,'src/main/java/sample/domain/ItemRepository.java':repository,'src/main/java/sample/domain/ItemView.java':view,'src/main/java/sample/domain/ItemService.java':service,'src/main/java/sample/web/ItemResource.java':controller});
const samples={
  'gradle-generic':{wrapper:true,files:{
    'settings.gradle':"rootProject.name = 'generic'\n",
    'build.gradle':"plugins { id 'java'; id 'org.springframework.boot' version '3.5.9'; id 'io.spring.dependency-management' version '1.1.7' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\nrepositories { mavenCentral() }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web'; implementation 'org.springframework.boot:spring-boot-starter-data-jpa'; testImplementation 'org.springframework.boot:spring-boot-starter-test'; testRuntimeOnly 'org.junit.platform:junit-platform-launcher' }\n",
    ...single()}},
};

function adapter(packageName,{mockService=false}={}){
  return `package ${packageName};
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import sample.domain.*;
@SpringBootTest(classes=sample.SampleApplication.class,properties={"spring.datasource.url=jdbc:h2:mem:sample;DB_CLOSE_DELAY=-1","spring.jpa.hibernate.ddl-auto=create-drop","spring.config.location=optional:classpath:/intent-generated/empty.properties"})
@AutoConfigureMockMvc
public class GeneratedIntentTest extends NativeIntentHarness {
  @Autowired private ItemRepository items;
  ${mockService?'@org.springframework.boot.test.context.TestConfiguration static class Stub { @org.springframework.context.annotation.Bean @org.springframework.context.annotation.Primary ItemService stub(){ return new ItemService(null){ @Override public ItemView find(Long id){ return null; } }; } }':''}
  @Override protected Map<String,Object> prepareFixture(JsonNode s) throws Exception {
    Item saved=items.saveAndFlush(new Item("apple"));
    Map<String,Object> record=new HashMap<>();record.put("entity","Item");record.put("id",saved.getId());
    Map<String,Object> records=new HashMap<>();records.put("item",record);
    Map<String,Object> relations=new HashMap<>();relations.put("records",records);
    Map<String,Object> facts=new HashMap<>();facts.put("item_saved",items.existsById(saved.getId()));
    Map<String,Object> fixture=new HashMap<>();fixture.put("relations",relations);fixture.put("facts",facts);
    return fixture;
  }
}
`;
}
const check=(name,value)=>({endpointId:'intent-api-1',name,conditionIds:['c-1'],findingIndices:[0],answerIndices:[],fixtureProfile:'intent-v1',fixtureGraphJson:'null',givenDescription:'자료 하나가 저장되어 있다.',givenFacts:[{id:'item_saved',description:'자료가 저장되어 있다',expectedJson:'true'}],statusOrigin:'ai_default',statusReason:'조회 성공 기본값',database:[],auth:'anonymous',pathValues:[{name:'id',value:'$fixture/records/item/id'}],query:[],bodyJson:'null',status:200,checks:[{pointer:'/name',operator:'equals',valueJson:JSON.stringify(value)}],notCovered:[]});
async function approvedSpec(){
  const feature={id:'prove-builds',name:'자료 조회',scan:{id:'scan-1',nodes:[],images:[]},analysis:{summary:'자료 조회',findings:[{text:'자료 조회',quote:'자료 조회',nodeIds:['n1']}],questions:[]}};
  // A different path variable name than the code uses, as an AI proposal before development would.
  const replies=[{endpoints:[{method:'GET',path:'/api/items/{id}',summary:'자료 조회',reason:'기본 경로',authenticated:false,parameters:[{name:'id',type:'long',in:'path',required:true}],bodyFields:[]}]},{conditions:[{id:'c-1',description:'자료 이름을 대문자로 반환한다',kind:'shape',scope:'backend',findingIndices:[0],answerIndices:[]}]},{cases:[check('기획과 일치하는 이름','APPLE'),check('기획과 다른 이름','apple')],skippedEndpoints:[],excluded:[]}];
  const planner={analyze:async()=>({result:replies.shift(),evidence:{model:'fixed-reply'}})};
  return approve((await proposeIntentApis(feature,{}, {runtime:planner})).spec);
}
async function write(dir,files){for(const [name,text] of Object.entries(files)){const file=path.join(dir,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}}

const spec=await approvedSpec();
const only=process.argv[2];
const results={};
await rm(out,{recursive:true,force:true,maxRetries:5,retryDelay:200});
for(const [name,sample] of Object.entries(samples)){
  if(only&&only!==name)continue;
  const dir=path.join(out,name);
  await write(dir,sample.files);
  // --no-validate-url: the wrapper task otherwise probes services.gradle.org before writing files; gradlew downloads (or reuses the cached) distribution when it runs.
  const wrapperArgs=['wrapper','--gradle-version','8.14.3','--no-validate-url','--no-daemon','--console=plain'];
  if(sample.wrapper)execFileSync(process.platform==='win32'?'gradle '+wrapperArgs.join(' '):'gradle',process.platform==='win32'?[]:wrapperArgs,{cwd:dir,stdio:'inherit',shell:process.platform==='win32'});
  const before=await productionState(dir);
  // AI_PROVIDER=claude lets a real model write the bindings for this unrelated project.
  const real=process.env.AI_PROVIDER==='claude';
  const runtime=real?new ClaudeRuntime():{analyze:async input=>({result:{java:adapter(input.nodes.packageName),notes:[],unsupportedScenarioIds:[]},evidence:{provider:'fixed-reply',model:'fixed-reply'}})};
  const report=await verifyNativeJava({spec,backend:dir,runtime,outputRoot:path.join(out,'runs-'+name),maxRepairs:real?2:0,onProgress:()=>{}});
  results[name]={counts:report.counts,unchanged:report.originalUnchanged,beans:report.results.map(r=>r.evidence?.beansVerified),limitations:report.limitations.slice(1)};
  console.log(name,JSON.stringify(results[name]));
  for(const r of report.results)console.log('  ',r.status,r.name,'|',String(r.reason).slice(0,120));
  assert.equal(report.originalUnchanged,true,name);
  assert.equal((await productionState(dir)).digest,before.digest,name);
  assert.deepEqual(report.counts,{PASS:1,FAIL:1,BLOCKED:0,UNVERIFIED:0},name);
  assert.ok(report.results.every(r=>r.evidence.beansVerified===true),name);
  if(!real){
    // The tool must refuse a run where a project service was swapped out, whatever the AI says.
    const cheat={analyze:async input=>({result:{java:adapter(input.nodes.packageName,{mockService:true}).replace('@AutoConfigureMockMvc','@AutoConfigureMockMvc @org.springframework.context.annotation.Import(GeneratedIntentTest.Stub.class)'),notes:[],unsupportedScenarioIds:[]},evidence:{provider:'fixed-reply',model:'fixed-reply'}})};
    const cheated=await verifyNativeJava({spec,backend:dir,runtime:cheat,outputRoot:path.join(out,'runs-cheat'),maxRepairs:0});
    console.log('  stubbed service:',JSON.stringify(cheated.counts));
    assert.equal(cheated.counts.PASS,0,'대체된 Service로 PASS가 나오면 안 된다');
    assert.equal(cheated.counts.FAIL,0,'준비 문제를 업무 실패로 판정하면 안 된다');
    results[name].stubbedServiceBlocked=true;
  }
}
await writeFile(path.join(root,'output/build-proof.json'),JSON.stringify(results,null,2));
console.log('Gradle 범용 샘플 통과: output/build-proof.json');
