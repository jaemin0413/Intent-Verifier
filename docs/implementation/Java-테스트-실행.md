# Java 테스트 생성과 실행

제품 방향은 [기획안](../source/기획안.md)을 따른다.

## 업무 계층이 실제로 실행됐는지 확인

도구 Harness가 실행 전에 대상 프로젝트의 Controller·Service·Repository·Component Bean을 직접 검사한다. Mock이거나 생성 코드의 대체 클래스이면 실행을 막고, 이 확인 기록(`beansVerified`)이 없으면 PASS를 주지 않는다. 외부 SDK 클라이언트만 경계로 대체할 수 있다. 생성 코드 검사기는 `@MockBean`류, 보안 설정 대체, 리플렉션을 거부한다. 컴파일에 실패한 파일은 `src/test`에 남기지 않고 실행 기록에만 보관하며, 이전 실패 실행이 남긴 파일도 내용이 같을 때만 다음 검사 전에 치운다.

## 의도와 실행 연결

`intent-api-plan.mjs`는 Backend 없이 Figma·답변에서 API를 제안한다. `api-plan.mjs`는 원문/답변 조건을 분해하고 Given 설명·독립 확인 사실(`intent-v1`)·요청·기대 결과를 만든다. 기존 Controller/DTO로 후보를 연결하는 경로도 유지한다. 기술 선택은 `AI_PROPOSAL`, HTTP 선택은 `ai_default`와 이유/판정 정책으로 기록한다. 원문과 사용자 명시값은 별도로 보존한다.

사용자가 검토할 때는 코드나 SQL 대신 계정·소유권·관계·상태·대조 데이터의 의미를 보여준다. 승인하면 Notion에 개발 기준을 작성한다. 구현이 없는 제안 명세는 Controller 재탐색 없이 작성한다. 명세와 실행 기록을 분리하고 결과는 승인 digest에 연결해 덧붙인다.

## 실행 단계와 소유권

1. `native-java-runner.mjs`가 승인 명세를 동결하고 `snapshot.json`을 먼저 저장한다.
2. `src/main`과 빌드/wrapper 상태를 해시로 기록한다. 승인 API에 필요한 Entity/Repository/보안/컨트롤러 및 기존 테스트를 읽는다. 기존 테스트는 선택 사항이다.
3. 연결된 AI가 `GeneratedIntentTest extends NativeIntentHarness`를 생성한다. 실제 팩토리/Repository로 데이터와 관계를 저장하고 인증 토큰을 준비한다. 테스트 전용 Spring Context도 이 클래스에 둔다. flush/clear 후 DB를 다시 읽어 Given을 확인한다.
4. 도구는 `NativeIntentHarness.java`와 동결 시나리오 JSON을 작성한다. 요청·Assertion·DB 관찰·증거·판정은 도구 소유다. AI는 기대값이나 판정을 반환하지 않는다.
5. 대상 `gradlew`로 생성 클래스만 선택 실행한다. 빌드 파일을 바꾸지 않고 도구 소유 init script를 사용한다. Given 준비와 실제 요청은 같은 Spring 트랜잭션에서 실행하고 롤백을 확인한다.
6. 컴파일/컨텍스트 오류와 요청 전 Given 실패만 최대 2회 수정한다. 업무 Assertion 실패를 통과시키는 자동 수정은 하지 않는다. 실패한 이전 시도의 Java는 자신의 해시가 일치할 때만 제거하고 아티팩트에 보존한다. 마지막 실패 소스는 진단용으로 남긴다.
7. 현재 실행 ID의 Evidence·JUnit XML·종료 코드와 Production/빌드 불변 여부를 확인한다. 준비 실패와 업무 불일치를 구분하며 미생성 조건도 Coverage에 남긴다.

생성 위치: 대상 `src/test/java/intent/generated/<run+attempt>/`, `src/test/resources/intent-generated/<run>/<attempt>/`. 사용자 파일을 덮어쓰지 않는다. 새 실행의 준비·실행이 확인되면 같은 기능의 이전 도구 소유 파일만 해시를 대조해 아티팩트에 보존하고 대상 폴더에서 정리한다. 사용자가 수정한 파일은 남긴다. 재현할 때는 해당 실행 ZIP과 보고서의 `--tests` 선택 명령을 사용한다.

Production과 승인 digest가 모두 같으면 이전 AI 생성 연결 코드를 다음 생성의 참고 입력으로 사용할 수 있다. 이전 결과는 재사용하지 않으며 실제 Given 준비·요청·관찰을 새로 실행한다. 컴파일 로그뿐 아니라 JUnit의 상세 컨텍스트 오류를 수정 입력에 전달한다.

## 판정과 근거

- AI 기본 HTTP 코드는 승인된 정책 안에서만 동등성을 적용한다(2xx, 403/404, 400/422). 성공과 거절, 서버 오류는 섞지 않는다. 응답/DB 검사는 그대로 유지한다. 기존 승인 명세에 정책이 없으면 엄격하게 판정한다.
- 업무 Handler에 도달하지 못한 인증/경로 문제는 BLOCKED다. Handler가 반환한 업무 거절은 기대 결과와 비교한다.
- legacy entity graph는 승인 의미를 바꾸지 않고 typed Java로 준비하며 저장 필드·관계·ID 연결을 도구가 재확인한다. 새 `intent-v1`은 저장 레코드와 AI가 DB에서 관찰한 사실을 기록한다. 자동 생성 코드의 의미가 모든 프로젝트에서 항상 정확하다는 보장은 아니므로 코드와 Given 근거를 결과에 남긴다.
- `snapshot.json`, `scenario-input.json`, `backend-analysis.json`, `generation-N.json`, `generated-files.json`, `code-state*.json`, `command.json`, `execution*.log`, `junit/`, `evidence/`, `report.json`을 보존한다.

## 현재 경계

실증 환경은 단일 모듈 Groovy Gradle / Java 21 / Spring Boot 3.5.9와 4.1.1 / H2다. 새 Maven·Kotlin Gradle·멀티모듈 연결은 UNVERIFIED다. 임의의 Spring 프로젝트 전반에서 검증 완료했다고 주장하지 않는다.

네트워크 차단은 Java 21 테스트 JVM의 SecurityManager 기반이며 OS 격리가 아니다. 원래 Gradle 빌드 자체도 실행된다. 운영 Application Context 전체, 운영 DB SQL 호환성, 로그인 API 자체, Firebase/WebSocket 실연동, 동시성·외부 비동기는 이 실험으로 증명하지 않는다. Production Code 수정, 기존 테스트 임의 변경, 구현에 맞춘 기대값 수정은 하지 않는다.

기존 copied-source Maven/H2 경로는 회귀 실험용으로 남는다. 새 UI의 controller-api 실행은 native Java 경로를 사용한다. `npm test`, `npm run prove`, `npm run prove:native`의 범위는 결과 문서에서 구분한다.
