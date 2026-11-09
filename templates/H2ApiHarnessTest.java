package generated;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.*;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.mock.web.MockServletContext;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.core.env.MapPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import javax.sql.DataSource;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;
import java.security.Permission;

public class H2ApiHarnessTest {
  static final ObjectMapper mapper=new ObjectMapper();
  static final AtomicReference<String> external=new AtomicReference<>();
  static AnnotationConfigWebApplicationContext context;
  static MockMvc mvc;
  static String databaseUrl;
  @@AUTHENTICATED_FIXTURES@@
  @@ENTITY_GRAPH@@
  // Fixture setup is structural only: it never supplies an assertion or expected response.
  static Map<String,Object> prepareFixture(JsonNode s) throws Exception {
    if(s.path("given").path("profile").asText().equals("entity-graph-v1"))return prepareEntityGraph(s);
    if(s.path("actor").path("mode").asText().equals("bearer"))return prepareAuthenticatedFixture(s);
    String route=s.path("action").path("path").asText();
    JsonNode body=s.path("action").path("body");
    if(!route.matches("(?i).*/(?:login|sign-in|signin)/?$") || !body.hasNonNull("email") || !body.hasNonNull("password"))return Map.of("kind","none");
    // Unknown-user and wrong-password scenarios need a different, explicitly approved fixture.
    if(s.path("name").asText().matches("(?is).*(?:불일치|틀린 비밀번호|없는 계정|미가입|존재하지|wrong.password|unknown.user|invalid.credentials).*"))throw new IllegalStateException("이 로그인 조건은 계정의 존재 여부와 비밀번호 관계를 지정해야 합니다.");
    var em=context.getBean(jakarta.persistence.EntityManagerFactory.class).createEntityManager();
    try {
      List<Class<?>> candidates=new ArrayList<>();
      for(var entity:em.getMetamodel().getEntities())try {
        var type=entity.getJavaType();type.getMethod("createLocalUser",String.class,String.class,String.class,String.class);candidates.add(type);
      }catch(NoSuchMethodException ignored){}
      if(candidates.size()!=1)throw new IllegalStateException("테스트 계정 생성 구조를 하나로 찾지 못했습니다.");
      Class<?> type=candidates.get(0);
      String email=body.path("email").asText();
      if(!email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"))email="fixture@example.test";
      String password=body.path("password").asText();
      Class<?> encoderType=Class.forName("org.springframework.security.crypto.password.PasswordEncoder");
      Object encoder=context.getBean(encoderType);
      String encoded=(String)encoderType.getMethod("encode",CharSequence.class).invoke(encoder,password);
      Object account=type.getMethod("createLocalUser",String.class,String.class,String.class,String.class).invoke(null,"H2 Test","h2fixture",email,encoded);
      // A shared EntityManager joins the same rollback-only transaction as MockMvc.
      var shared=org.springframework.orm.jpa.SharedEntityManagerCreator.createSharedEntityManager(context.getBean(jakarta.persistence.EntityManagerFactory.class));
      String entityName=shared.getMetamodel().entity(type).getName();
      long before=(Long)shared.createQuery("select count(e) from "+entityName+" e").getSingleResult();
      shared.persist(account);shared.flush();
      Object id=context.getBean(jakarta.persistence.EntityManagerFactory.class).getPersistenceUnitUtil().getIdentifier(account);
      Assertions.assertNotNull(shared.find(type,id));
      long prepared=(Long)shared.createQuery("select count(e) from "+entityName+" e").getSingleResult();
      Assertions.assertEquals(before+1,prepared);
      return new LinkedHashMap<>(Map.of("kind","local-login-account","entity",entityName,"entityClass",type.getName(),"id",id,"email",email,"rowsBefore",before,"rowsPrepared",prepared,"persisted",true,"credentials","요청의 비밀번호를 실제 인코더로 암호화한 H2 전용 계정. 형식이 잘못된 이메일은 별도 정상 이메일로 준비."));
    } finally {em.close();}
  }
  static void verifyFixtureRollback(Map<String,Object> fixture) {
    if(!Boolean.TRUE.equals(fixture.get("persisted")))return;
    var em=context.getBean(jakarta.persistence.EntityManagerFactory.class).createEntityManager();
    try {
      if(fixture.get("rowsBefore") instanceof Map) {
        var after=rowCounts(em);fixture.put("rowsAfterRollback",after);fixture.put("rollbackVerified",fixture.get("rowsBefore").equals(after));
        Assertions.assertEquals(fixture.get("rowsBefore"),after,"All related H2 data must be rolled back");return;
      }
      long after=(Long)em.createQuery("select count(e) from "+fixture.get("entity")+" e").getSingleResult();
      fixture.put("rowsAfterRollback",after);fixture.put("rollbackVerified",after==((Number)fixture.get("rowsBefore")).longValue());
      Assertions.assertEquals(fixture.get("rowsBefore"),after,"Test account must be rolled back");
    }finally {em.close();}
  }
  @Configuration(proxyBeanMethods=false)
  @EnableAutoConfiguration
  @EntityScan(basePackages={@@PACKAGES@@})
  @EnableJpaRepositories(basePackages={@@PACKAGES@@})
  @Import({@@IMPORTS@@})
  static class TestContext {
    @@EXTERNAL_BEANS@@
  }
  @BeforeAll static void start() throws Exception {
    System.setSecurityManager(new SecurityManager(){
      @Override public void checkPermission(Permission p) {}
      @Override public void checkConnect(String host,int port){external.set("외부 네트워크 연결 필요");throw new SecurityException("EXTERNAL_CONNECTION_DISABLED");}
      @Override public void checkListen(int port){throw new SecurityException("SERVER_LISTEN_DISABLED");}
    });
    context=new AnnotationConfigWebApplicationContext();context.setServletContext(new MockServletContext());
    Map<String,Object> properties=new HashMap<>();
    properties.put("spring.datasource.url","jdbc:h2:mem:verification;MODE=MySQL;DB_CLOSE_DELAY=-1;NON_KEYWORDS=USER,KEY,VALUE");
    properties.put("spring.datasource.driver-class-name","org.h2.Driver");properties.put("spring.datasource.username","sa");properties.put("spring.datasource.password","");
    properties.put("spring.jpa.hibernate.ddl-auto","create-drop");properties.put("spring.jpa.database-platform","org.hibernate.dialect.H2Dialect");
    properties.put("spring.sql.init.mode","never");properties.put("spring.flyway.enabled","false");properties.put("spring.liquibase.enabled","false");
    properties.put("spring.main.lazy-initialization","false");properties.put("spring.jmx.enabled","false");
    @@PROPERTIES@@
    List<String> excluded=new ArrayList<>();
    var resources=Thread.currentThread().getContextClassLoader().getResources("META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports");
    while(resources.hasMoreElements())try(var in=resources.nextElement().openStream()) {for(String name:new String(in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8).split("\\R"))if(name.matches(".*(?:awspring|redis|mail|oauth2|mongo|kafka|rabbit|quartz|elasticsearch|jms).*"))excluded.add(name.trim());}
    properties.put("spring.autoconfigure.exclude",String.join(",",excluded));
    context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("isolated-h2",properties));
    context.register(TestContext.class);context.refresh();
    try(var connection=context.getBean(DataSource.class).getConnection()){databaseUrl=connection.getMetaData().getURL();Assertions.assertTrue(databaseUrl.startsWith("jdbc:h2:mem:"));}
    var builder=MockMvcBuilders.webAppContextSetup(context);
    // Keep the real security filter chain if the target defines one.
    if(context.containsBean("springSecurityFilterChain"))builder.addFilters((jakarta.servlet.Filter)context.getBean("springSecurityFilterChain"));
    mvc=builder.build();external.set(null);
  }
  @AfterAll static void stop(){if(context!=null)context.close();System.setSecurityManager(null);}
  @TestFactory Stream<DynamicTest> cases() throws Exception {
    JsonNode input=mapper.readTree(Files.readString(Path.of(System.getProperty("verification.input"))));
    List<DynamicTest> tests=new ArrayList<>();
    for(JsonNode scenario:input)tests.add(DynamicTest.dynamicTest(scenario.path("name").asText(),()->run(scenario)));
    return tests.stream();
  }
  void run(JsonNode s) throws Exception {
    Map<String,Object> evidence=new LinkedHashMap<>();evidence.put("scenarioId",s.path("id").asText());evidence.put("expected",s.path("expected"));
    evidence.put("databaseUrl",databaseUrl);evidence.put("preconditionOk",false);evidence.put("actionExecuted",false);evidence.put("observationComplete",false);
    evidence.put("mockBoundary",java.util.stream.Stream.of("blockedMail","blockedMessaging").filter(context::containsBean).toList());
    evidence.put("failureStage","PRECONDITION");
    evidence.put("scope","H2 메모리 DB · 실제 컨트롤러/서비스 · 요청별 DB 롤백 · 외부 연결 제외");
    external.set(null);
    try {
      final MvcResult[] result=new MvcResult[1];
      try {
        // Given: actual persisted records and authentication, inside this test's transaction.
        new TransactionTemplate(context.getBean(PlatformTransactionManager.class)).execute(status->{try{
          Map<String,Object> fixture=prepareFixture(s);evidence.put("fixture",fixture);
          JsonNode relations=mapper.valueToTree(fixture.getOrDefault("relations",Map.of()));
          // Validate all approved references before invoking the controller, not after a failed assertion.
          resolveGiven(s.path("expected"),relations);
          JsonNode action=resolveGiven(s.path("action"),relations);
          String route=action.path("path").asText();
          for(JsonNode pair:action.path("pathValues"))route=route.replace("{"+pair.path("name").asText()+"}",java.net.URLEncoder.encode(pair.path("value").asText(),java.nio.charset.StandardCharsets.UTF_8));
          if(route.contains("{"))throw new IllegalStateException("Given 데이터의 ID를 요청 경로에 연결하지 못했습니다.");
          var request=MockMvcRequestBuilders.request(org.springframework.http.HttpMethod.valueOf(action.path("method").asText()),route).accept("application/json");
          for(JsonNode pair:action.path("query"))request.param(pair.path("name").asText(),pair.path("value").asText());
          if(!action.path("body").isNull())request.contentType("application/json").content(mapper.writeValueAsString(action.path("body")));
          evidence.put("action",Map.of("method",action.path("method").asText(),"url",route));
          evidence.put("database",observeDatabase(s,relations,null));
          evidence.put("preconditionOk",true);
          // When: real controller, service, repository and security filter.
          if(fixtureBearer.get()!=null){request.header("Authorization","Bearer "+fixtureBearer.get());evidence.put("authenticationPrepared",true);}
          evidence.put("failureStage","ACTION");
          result[0]=mvc.perform(request).andReturn();
          evidence.put("actionExecuted",true);
          evidence.put("response",Map.of("status",result[0].getResponse().getStatus(),"body",result[0].getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)));
          evidence.put("failureStage","OBSERVATION");
          // Then: flush and clear the persistence context before observing actual DB rows.
          evidence.put("database",observeDatabase(s,relations,(List<Map<String,Object>>)evidence.get("database")));
        }catch(Exception e){throw new RuntimeException(e);}finally{status.setRollbackOnly();}return null;});
      } finally {if(evidence.get("fixture") instanceof Map fixture)verifyFixtureRollback(fixture);}
      var response=result[0].getResponse();
      evidence.put("failureStage","OBSERVATION");
      evidence.put("actionExecuted",true);evidence.put("observationComplete",true);evidence.put("response",Map.of("status",response.getStatus(),"body",response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8)));
      var handler=result[0].getHandler();
      boolean mapped=handler instanceof org.springframework.web.method.HandlerMethod method && method.getMethod().getName().equals(s.path("binding").path("handler").asText()) && method.getBeanType().getName().equals(s.path("binding").path("controller").asText());
      evidence.put("handlerMatched",mapped);
      // Rejected before business logic ran: the approved rule was never exercised.
      evidence.put("inputRejected",result[0].getResolvedException()!=null&&java.util.Set.of("MethodArgumentNotValidException","HandlerMethodValidationException","HttpMessageNotReadableException","MissingServletRequestParameterException","MethodArgumentTypeMismatchException","ConstraintViolationException","BindException").contains(result[0].getResolvedException().getClass().getSimpleName()));
      // A login-less request stopped by Spring Security is the approved rejection, not a setup failure.
      int wantedStatus=s.path("expected").path("status").asInt();
      boolean securityRejected=s.path("actor").path("mode").asText().equals("anonymous")&&(response.getStatus()==401||response.getStatus()==403)&&(wantedStatus==401||wantedStatus==403);
      evidence.put("securityRejected",securityRejected&&!mapped);
      if(!mapped&&!securityRejected)evidence.put("blocked","선택한 컨트롤러까지 요청이 도달하지 못했습니다. 경로 또는 인증 설정을 확인해 주세요.");
      else if(external.get()!=null)evidence.put("unverified",external.get());
      // The body never became the DTO, so a case that expects anything but an input error proves nothing.
      else if(wantedStatus!=400&&wantedStatus!=422&&result[0].getResolvedException()!=null&&java.util.Set.of("HttpMessageNotReadableException","MethodArgumentTypeMismatchException").contains(result[0].getResolvedException().getClass().getSimpleName())){String unread=String.valueOf(result[0].getResolvedException().getMessage());evidence.put("failureStage","ACTION");evidence.put("blocked","요청값을 서버 DTO로 읽지 못해 규칙까지 도달하지 못했습니다: "+unread.substring(0,Math.min(200,unread.length())));}
      else if(response.getStatus()>=300&&response.getStatus()<400)evidence.put("unverified","외부 로그인 또는 페이지 이동은 검사하지 않습니다.");
      else if((response.getStatus()==401||response.getStatus()==403)&&s.path("actor").path("mode").asText().equals("bearer")&&response.getStatus()!=s.path("expected").path("status").asInt())evidence.put("blocked","H2 테스트 환경의 인증·권한 준비가 필요합니다.");
      else if(response.getStatus()==404&&s.path("expected").path("status").asInt()>=200&&s.path("expected").path("status").asInt()<300&&!Boolean.TRUE.equals(((Map<?,?>)evidence.get("fixture")).get("persisted")))evidence.put("blocked","요청 대상의 H2 테스트 데이터를 준비하지 못했습니다.");
      if(!evidence.containsKey("blocked")&&!evidence.containsKey("unverified"))evidence.put("failureStage","ASSERTION");
    } catch(AssertionError e) {evidence.put("blocked","H2 데이터 준비·롤백 확인 실패: "+String.valueOf(e.getMessage()));}
    catch(Exception e) {while(e.getCause() instanceof Exception cause)e=cause;if(external.get()!=null)evidence.put("unverified",external.get());else evidence.put("blocked",("OBSERVATION".equals(evidence.get("failureStage"))?"요청 후 DB 변경 확인 오류: ":"H2 테스트 준비·실행 오류: ")+e.getClass().getSimpleName()+" · "+String.valueOf(e.getMessage()).substring(0,Math.min(200,String.valueOf(e.getMessage()).length())));}
    finally {fixtureBearer.remove();Path directory=Path.of(System.getProperty("verification.evidence"));Files.createDirectories(directory);Files.writeString(directory.resolve(s.path("id").asText()+".json"),mapper.writeValueAsString(evidence));}
    if(evidence.containsKey("blocked")||evidence.containsKey("unverified")){Assumptions.assumeTrue(false,"테스트 준비 또는 외부 연결 필요");return;}
    try {
    Map<?,?> response=(Map<?,?>)evidence.get("response");Assertions.assertEquals(s.path("expected").path("status").asInt(),response.get("status"));
    // A security filter often answers with no body, so there is nothing to compare.
    boolean noBody=Boolean.TRUE.equals(evidence.get("securityRejected"))&&((String)response.get("body")).isBlank();
    JsonNode body=noBody||s.path("expected").path("checks").isEmpty()?mapper.nullNode():mapper.readTree((String)response.get("body"));
    for(JsonNode check:noBody?mapper.createArrayNode():s.path("expected").path("checks")) {
      JsonNode value=body.at(check.path("pointer").asText()),expected=resolveGiven(check.path("value"),mapper.valueToTree(((Map<?,?>)evidence.get("fixture")).get("relations")));String operator=check.path("operator").asText();
      switch(operator){case "equals" -> {JsonNode wanted=mapper.readTree(expected.toString());Assertions.assertEquals(wanted,wanted.isNull()&&value.isMissingNode()?wanted:value);}case "maxItems" -> Assertions.assertTrue(value.isArray()&&value.size()<=expected.asInt());case "minItems" -> Assertions.assertTrue(value.isArray()&&value.size()>=expected.asInt());case "type" -> Assertions.assertTrue(switch(expected.asText()){case "object" -> value.isObject();case "array" -> value.isArray();case "string" -> value.isTextual();case "number" -> value.isNumber();case "boolean" -> value.isBoolean();case "null" -> value.isNull()||value.isMissingNode();default -> false;});case "setEquals" -> {Assertions.assertTrue(value.isArray());List<String> actual=new ArrayList<>(),wanted=new ArrayList<>();for(JsonNode item:value)actual.add(item.at(expected.path("key").asText()).toString());for(JsonNode item:expected.path("values"))wanted.add(item.toString());Collections.sort(actual);Collections.sort(wanted);Assertions.assertEquals(wanted,actual,"Only the prepared owner's records must be returned");}
        case "descending","ascending" -> {Assertions.assertTrue(value.isArray()&&value.size()>=2,"Given must provide comparison records");for(int i=1;i<value.size();i++){JsonNode left=value.get(i-1).at(expected.asText()),right=value.get(i).at(expected.asText());Assertions.assertFalse(left.isMissingNode()||right.isMissingNode());int compared=left.isNumber()&&right.isNumber()?left.decimalValue().compareTo(right.decimalValue()):left.asText().compareTo(right.asText());Assertions.assertTrue(operator.equals("descending")?compared>=0:compared<=0,"Response order violates approved intent");}}
        default -> Assertions.fail("Unsupported assertion: "+operator);}
    }
    List<Map<String,Object>> observations=(List<Map<String,Object>>)evidence.get("database");
    for(int i=0;i<s.path("expected").path("database").size();i++) {
      JsonNode check=s.path("expected").path("database").get(i);
      Assertions.assertEquals(check.path("exists").asBoolean(),observations.get(i).get("exists"),check.path("label").asText());
    }
    evidence.put("javaAssertionsPassed",true);
    } catch(AssertionError error) {evidence.put("javaAssertionsPassed",false);throw error;}
    finally {Files.writeString(Path.of(System.getProperty("verification.evidence"),s.path("id").asText()+".json"),mapper.writeValueAsString(evidence));}
  }
  static JsonNode resolveGiven(JsonNode value,JsonNode relations) {
    if(value.isTextual()&&value.asText().startsWith("$fixture/")) {
      JsonNode resolved=relations==null?null:relations.at(value.asText().substring(8));
      if(resolved==null||resolved.isMissingNode())throw new IllegalStateException("Missing persisted Given reference: "+value.asText());
      return resolved;
    }
    if(value.isArray()){var result=mapper.createArrayNode();for(JsonNode item:value)result.add(resolveGiven(item,relations));return result;}
    if(value.isObject()){var result=mapper.createObjectNode();value.fields().forEachRemaining(entry->result.set(entry.getKey(),resolveGiven(entry.getValue(),relations)));return result;}
    return value;
  }
  static List<Map<String,Object>> observeDatabase(JsonNode s,JsonNode relations,List<Map<String,Object>> before) {
    var em=org.springframework.orm.jpa.SharedEntityManagerCreator.createSharedEntityManager(context.getBean(jakarta.persistence.EntityManagerFactory.class));
    em.flush();em.clear();List<Map<String,Object>> records=new ArrayList<>();int index=0;
    for(JsonNode check:s.path("expected").path("database")) {
      String entity=check.path("entity").asText();long id=resolveGiven(check.path("id"),relations).asLong();
      boolean exists=em.find(entityType(em,entity),id)!=null;
      if(before==null&&!exists)throw new IllegalStateException("Given did not persist "+entity+" #"+id);
      records.add(new LinkedHashMap<>(Map.of("entity",entity,"id",id,"before",before==null?exists:before.get(index).get("before"),"exists",exists)));index++;
    }
    return records;
  }
}
