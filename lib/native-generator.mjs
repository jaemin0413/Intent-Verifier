import {readFile} from 'node:fs/promises';
import {root} from '../scripts/setup.mjs';
import path from 'node:path';

// The oracle and action stay in tool-owned Java. Codex only supplies project bindings.
export async function nativeHarness({packageName,inputResource,evidenceDirectory,runId,projectTypes=[]}) {
  const legacy=await readFile(path.join(root,'templates/H2ApiHarnessTest.java'),'utf8');
  let body=legacy.slice(legacy.indexOf('  @TestFactory Stream<DynamicTest> cases()'));
  body=body.replace('@TestFactory Stream<DynamicTest> cases()', '@TestFactory final Stream<DynamicTest> cases()');
  body=body.replace('JsonNode input=mapper.readTree(Files.readString(Path.of(System.getProperty("verification.input"))));', `JsonNode input;try(var stream=getClass().getClassLoader().getResourceAsStream(${JSON.stringify(inputResource)})){if(stream==null)throw new IllegalStateException("Missing frozen scenario resource");input=mapper.readTree(stream);}`);
  body=body.replace('  void run(JsonNode s)', '  private void run(JsonNode s)');
  body=body.replace('prepareFixture(s)', 'prepareChecked(s)');
  body=body.replace('em.find(entityType(em,entity),id)', 'em.find(entityType(em,resolveEntityName(check,relations)),id)');
  body=body.replaceAll('static List<Map<String,Object>> observeDatabase','private List<Map<String,Object>> observeDatabase');
  body=body.replaceAll('System.getProperty("verification.evidence")',JSON.stringify(evidenceDirectory.replaceAll('\\','/')));
  body=body.replace('evidence.put("scenarioId",s.path("id").asText());',`evidence.put("runId",${JSON.stringify(runId)});evidence.put("scenarioId",s.path("id").asText());`);
  body=body.replace('Assertions.assertEquals(s.path("expected").path("status").asInt(),response.get("status"));','int wantedStatus=s.path("expected").path("status").asInt(),actualStatus=((Number)response.get("status")).intValue();\n    boolean advisory=s.path("expected").path("statusPolicy").path("mode").asText().equals("equivalent")&&!Boolean.TRUE.equals(evidence.get("inputRejected"));\n    Assertions.assertTrue(wantedStatus==actualStatus||(advisory&&equivalentStatus(wantedStatus,actualStatus)),"Response outcome differs from approved intent");');
  body=body.replace('"H2 메모리 DB · 실제 컨트롤러/서비스 · 요청별 DB 롤백 · 외부 연결 제외"','"대상 프로젝트 Gradle · AI 작성 Given · 실제 업무 계층 · H2 요청별 롤백"');
  body=body.replace('evidence.put("mockBoundary",java.util.stream.Stream.of("blockedMail","blockedMessaging").filter(context::containsBean).toList());','evidence.put("mockBoundary",mockBoundary());evidence.put("beansVerified",beansVerified);');
  // A rejection returned by the matched business handler is a behavior result.
  // Authentication/filter failures are already BLOCKED by the missing handler check.
  body=body.replace(/      else if\(\(response.getStatus\(\)==401\|\|response.getStatus\(\)==403\).*?\n/,'');
  body=body.replace('evidence.put("failureStage","ACTION");','evidence.put("failureStage","ACTION");\n          if(s.path("actor").path("mode").asText().equals("bearer") && fixtureBearer.get()==null)throw new IllegalStateException("Given did not prepare actor authentication");');
  return `package ${packageName};
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import javax.sql.DataSource;
import jakarta.persistence.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

public abstract class NativeIntentHarness {
  static {
    System.setSecurityManager(new SecurityManager(){
      @Override public void checkPermission(java.security.Permission p) {}
      @Override public void checkConnect(String host,int port){external.set("외부 네트워크 연결은 검증 범위 밖입니다.");throw new SecurityException("EXTERNAL_CONNECTION_DISABLED");}
      @Override public void checkListen(int port){throw new SecurityException("SERVER_LISTEN_DISABLED");}
    });
  }
  protected static final ObjectMapper mapper=new ObjectMapper();
  protected static final AtomicReference<String> external=new AtomicReference<>();
  protected final ThreadLocal<String> fixtureBearer=new ThreadLocal<>();
  @Autowired protected ApplicationContext context;
  @Autowired protected MockMvc mvc;
  private String databaseUrl;
  private boolean beansVerified;
  private static final List<String> PROJECT_TYPES=List.of(${projectTypes.map(t=>JSON.stringify(t)).join(',')});
  protected abstract Map<String,Object> prepareFixture(JsonNode scenario) throws Exception;
  protected List<String> mockBoundary(){return List.of();}
  @BeforeEach final void verifyTestDatabase() throws Exception {
    try(var c=context.getBean(DataSource.class).getConnection()){databaseUrl=c.getMetaData().getURL();Assertions.assertTrue(databaseUrl.startsWith("jdbc:h2:mem:"),"MVP requires an isolated H2 memory database");}
  }
  // Observed by the tool, not self-reported: a project class must be the real one, never a mock or generated stub.
  @BeforeEach final void verifyRealProjectBeans() throws Exception {
    List<String> substituted=new ArrayList<>();
    for(String name:PROJECT_TYPES){
      Class<?> type;try{type=Class.forName(name,false,getClass().getClassLoader());}catch(ClassNotFoundException|LinkageError e){continue;}
      for(Object bean:context.getBeansOfType(type,true,false).values()){
        Object target=org.springframework.test.util.AopTestUtils.getUltimateTargetObject(bean);
        if(isMock(bean)||isMock(target)||target.getClass().getName().startsWith(${JSON.stringify(packageName+'.')}))substituted.add(name);
      }
    }
    Assertions.assertTrue(substituted.isEmpty(),"Project beans must run for real; replace only third-party SDK clients: "+substituted);
    beansVerified=true;
  }
  private static boolean isMock(Object bean) throws Exception {
    Class<?> mockito;try{mockito=Class.forName("org.mockito.Mockito");}catch(ClassNotFoundException e){return false;}
    Object details=mockito.getMethod("mockingDetails",Object.class).invoke(null,bean);
    return (Boolean)details.getClass().getMethod("isMock").invoke(details);
  }
  private static boolean equivalentStatus(int expected,int actual){int family=expected/100;return family==actual/100&&(family==2||family==4);}
  protected final EntityManager entityManager(){return org.springframework.orm.jpa.SharedEntityManagerCreator.createSharedEntityManager(context.getBean(EntityManagerFactory.class));}
  private static Class<?> entityType(EntityManager em,String name){return em.getMetamodel().getEntities().stream().filter(e->e.getName().equals(name)||e.getJavaType().getSimpleName().equals(name)).findFirst().orElseThrow(()->new IllegalStateException("Unknown entity "+name)).getJavaType();}
  private static String resolveEntityName(JsonNode check,JsonNode relations){String ref=check.path("id").asText();if(ref.startsWith("$fixture/records/")){String alias=ref.substring(17).split("/")[0];String type=relations.path("records").path(alias).path("entity").asText();if(!type.isEmpty())return type;}return check.path("entity").asText();}
  private Map<String,Long> rowCounts(EntityManager em){Map<String,Long> rows=new TreeMap<>();for(var e:em.getMetamodel().getEntities())rows.put(e.getName(),(Long)em.createQuery("select count(e) from "+e.getName()+" e").getSingleResult());return rows;}
  private static Object fieldValue(Object object,String name) throws Exception {for(Class<?> c=object.getClass();c!=null;c=c.getSuperclass())try{var f=c.getDeclaredField(name);f.setAccessible(true);return f.get(object);}catch(NoSuchFieldException ignored){}throw new IllegalStateException("Unknown Given field "+name);}
  private Map<String,Object> prepareChecked(JsonNode s) throws Exception {
    var em=entityManager();var before=rowCounts(em);
    Map<String,Object> fixture=new LinkedHashMap<>(prepareFixture(s));
    em.flush();em.clear();
    JsonNode relations=mapper.valueToTree(fixture.getOrDefault("relations",Map.of()));
    JsonNode records=relations.path("records");List<Map<String,Object>> persisted=new ArrayList<>();
    for(var it=records.fields();it.hasNext();){var record=it.next();var value=record.getValue();/* Enum and option values have no row; they only fill $fixture references. */if(!value.path("id").isNumber())continue;Class<?> type=entityType(em,value.path("entity").asText());Object actual=em.find(type,value.path("id").asLong());if(value.path("absent").asBoolean()){Assertions.assertNull(actual,"Given record still exists: "+record.getKey());continue;}Assertions.assertNotNull(actual,"Given record missing: "+record.getKey());persisted.add(Map.of("alias",record.getKey(),"entity",value.path("entity").asText(),"id",value.path("id").asLong(),"persisted",true));}
    if(s.has("given"))Assertions.assertFalse(persisted.isEmpty(),"Given requires persisted records");
    // Legacy approved entity graphs remain frozen; read-only checks protect their meaning.
    for(JsonNode n:s.path("given").path("graph").path("nodes")){
      JsonNode r=records.path(n.path("alias").asText());Assertions.assertFalse(r.isMissingNode());Object actual=em.find(entityType(em,n.path("entity").asText()),r.path("id").asLong());
      for(JsonNode f:n.path("fields")){Object value=fieldValue(actual,f.path("field").asText());String expected=f.path("value").asText();if(value instanceof java.time.LocalDateTime)expected=java.time.LocalDateTime.parse(expected).toString();if(value instanceof java.time.Instant)expected=java.time.Instant.parse(expected).toString();Assertions.assertEquals(expected,String.valueOf(value),"Given field "+n.path("alias").asText()+"."+f.path("field").asText());}
      for(JsonNode link:n.path("relations")){Object related=fieldValue(actual,link.path("field").asText());Assertions.assertNotNull(related);Assertions.assertEquals(records.path(link.path("alias").asText()).path("id").asLong(),((Number)context.getBean(EntityManagerFactory.class).getPersistenceUnitUtil().getIdentifier(related)).longValue(),"Given relation");}
    }
    for(JsonNode link:s.path("given").path("graph").path("idLinks")){
      JsonNode record=records.path(link.path("alias").asText());Object actual=em.find(entityType(em,record.path("entity").asText()),record.path("id").asLong());
      Assertions.assertEquals(records.path(link.path("target").asText()).path("id").asLong(),((Number)fieldValue(actual,link.path("field").asText())).longValue(),"Given generated ID link");
    }
    JsonNode facts=mapper.valueToTree(fixture.getOrDefault("facts",Map.of()));
    for(JsonNode fact:s.path("given").path("facts")){JsonNode want=fact.path("expected"),got=facts.path(fact.path("id").asText());String label="Given fact "+fact.path("description").asText();/* COUNT queries give a Long, the approved value parses as an Int. */if(want.isNumber()&&got.isNumber())Assertions.assertEquals(0,want.decimalValue().compareTo(got.decimalValue()),label);else Assertions.assertEquals(want,got,label);}
    fixture.put("kind","codex-java");fixture.put("persisted",!persisted.isEmpty());fixture.put("rowsBefore",before);fixture.put("rowsPrepared",rowCounts(em));fixture.put("givenObservations",persisted);
    return fixture;
  }
  private void verifyFixtureRollback(Map<String,Object> fixture){var em=context.getBean(EntityManagerFactory.class).createEntityManager();try{var after=rowCounts(em);fixture.put("rowsAfterRollback",after);fixture.put("rollbackVerified",after.equals(fixture.get("rowsBefore")));Assertions.assertEquals(fixture.get("rowsBefore"),after,"Test data must roll back");}finally{em.close();}}
${body}`;
}
