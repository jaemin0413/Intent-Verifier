# 작업 기준

기본 기준은 **[docs/source/기획안.md](docs/source/기획안.md)**이다. 상세 변경 시 [구현규칙](docs/source/구현규칙.md)을 읽는다. docs/history는 원본 이력이며 기본 작업 지침으로 읽지 않는다. 구현 방법/실험은 docs/implementation, docs/experiments에서 필요한 것만 읽는다.

- Figma와 승인된 의도가 정답이다. Backend에 맞춰 핵심 Expected/Actor/관계/Given/Action/Observation을 바꾸지 않는다.
- 대상 Production Code/설정은 수정하지 않는다. 대상 src/test/java, src/test/resources에 Java 테스트와 Given 코드를 생성할 수 있다. 기존 사용자 파일을 보존한다.
- 사용자에게 Prompt·테스트·데이터를 작성하게 하지 않는다. 중요한 의도만 질문하고 한 번 승인한다. 기술 기본값은 AI 선택임을 기록하고 명시 약속과 판정 강도를 구분한다.
- 승인 후 Notion 작성, 실행 전 freezeSnapshot과 디스크 저장. 승인 전 컨트롤러/DTO 탐색은 후보 연결에만 쓴다.
- Harness가 판정과 기대값을 소유한다. 연결된 AI(Codex·Claude·Gemini)는 프로젝트별 Given·인증·구성 연결을 작성한다. 준비/인증/관찰 실패는 BLOCKED, 기준/지원/시나리오 누락은 UNVERIFIED다.
- 실제 실행 근거만으로 PASS/FAIL을 판단한다. 조건 Coverage·버전·원문을 보존하고 과거 PASS를 재사용하지 않는다. 미확인 외부 연동을 완료라고 주장하지 않는다.
- 같은 화면은 팀이 하나의 해석을 공유한다. 원문은 Figma 화면과, 선택 입력한 Notion 기능명세서(본문+하위 페이지 1단계, DOCUMENT 노드)다. 문서 변경은 알리고 자동 재해석하지 않는다.
- 팀 서버의 기본 AI는 Claude면 운영자 API 키만, Gemini는 API 키만 쓴다(제공자 약관). 팀원마다 AI가 달라도 된다. 팀원은 자기 ChatGPT의 Codex를 기기 코드로, 자기 Claude 구독을 서버 터미널의 공식 CLI 로그인으로 연결할 수 있고 그 팀원의 요청만 그 계정으로 실행한다. Claude 로그인 코드·토큰은 앱이 받거나 읽지 않는다. 연결하지 않은 팀원의 요청은 기본 AI로 실행한다. API 키·기본 AI·Notion 연결 변경은 운영자 비밀번호(ADMIN_KEY)가 필요하다.
- 팀 서버의 대상 코드는 GitHub 저장소의 서버 전용 사본(읽기 전용 배포 키)으로 받고, push된 커밋만 검사하며 결과에 브랜치·커밋을 남긴다. 로컬 실행은 폴더 연결을 유지한다. 대상 빌드는 키와 데이터 볼륨이 없는 별도 컨테이너에서 실행하고 docker.sock을 마운트하지 않는다.
- 설정은 관리자가 한 번 하고 서버에 저장되어 모든 팀원에게 적용한다. 팀 서버의 팀원 화면에는 설정과 부가 설명을 노출하지 않는다.
- Gradle wrapper 단일 모듈 Spring Boot 3·4·JPA만 지원한다. Maven·예제·특정 팀 전용 코드는 두지 않는다. Node 본체 유지. 제품 이름 미정.

검증: npm test, 실행 경로 변경 시 npm run prove(범용 Gradle 샘플), 새 연결 경로 npm run prove:native.
로컬 개발: npm start → http://127.0.0.1:4318. HTTPS 링크 배포는 [배포 방법](docs/implementation/HTTPS-배포.md)을 따른다.
현재 작업/근거: docs/experiments/2026-11-09-서버-메모리-최적화.md, docs/experiments/2026-11-08-설정-단순화.md, docs/experiments/2026-11-08-명세서-연동과-정리.md, docs/experiments/2026-11-05-다중AI-팀해석.md.
