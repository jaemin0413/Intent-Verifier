# HTTPS 링크 배포

본체는 Node로 유지한다. 브라우저는 HTTPS 주소로 접속하고 리버스 프록시가 앱에 전달한다. 앱 VM과 외부 진입 VM이 나뉜 서버는 아래 Docker Compose와 [Gateway Nginx](#gateway-nginx와-인증서) 구성을, 한 대에서 모두 돌리면 [Compose 없이 설치](#홈서버에-설치-compose-없이)를 따른다. 앱 계정은 만들지 않는다. `npm run deploy:prepare`가 생성하는 `#access=…` 링크를 팀에 전달한다. 이 링크를 아는 사람은 프로젝트와 저장된 명세에 접근할 수 있으므로 비공개로 공유한다. 링크 키는 브라우저의 세션 저장소에 보관되며 서버 재시작에도 유지되는 데이터 디렉터리의 `link-key`에서 복구한다. 키 파일이나 생성된 플러그인을 Git에 올리지 않는다.

## Docker Compose로 설치

앱 VM과 외부 요청을 받는 Gateway가 분리된 서버에 맞춘 방법이다. 컨테이너는 둘이다. `figma-intent`는 앱과 AI 호출을 맡고 키와 데이터가 있는 `figma-intent_data` 볼륨을 쓴다. `build-runner`는 대상 프로젝트의 빌드만 실행하며 그 볼륨을 볼 수 없다. 두 컨테이너는 작업 폴더 볼륨만 공유하고 `docker.sock`은 어디에도 마운트하지 않는다.

1. `deploy/compose.env.example`을 `deploy/.env`로 복사해 값을 넣는다. `BIND_ADDRESS`는 Gateway VM이 이 VM에 접근하는 주소이며 `0.0.0.0`을 쓰지 않는다.
2. `docker compose -f deploy/docker-compose.yml up -d --build`로 시작한다.
3. Gateway의 리버스 프록시는 **원래 Host 헤더를 유지**해 `http://<BIND_ADDRESS>:4318`로 전달한다. 앱은 `PUBLIC_ORIGIN`과 다른 Host를 거절한다.
4. `docker exec figma-intent npm run deploy:prepare`로 팀에 줄 링크와 Figma 플러그인을 만든다.
5. 앱의 왼쪽 아래 '관리자'로 들어가 프로젝트 설정 › 백엔드에 GitHub 저장소 주소와 기본 브랜치를 저장한다. 화면에 나온 공개키를 저장소의 Settings › Deploy keys에 추가하고(쓰기 권한은 끈다) '연결 확인'을 누른다. 저장소 Admin 권한이 필요하고, GitHub 조직이 배포 키를 막아 두었으면 등록이 거절되므로 조직 설정에서 먼저 허용한다.
6. 기존 데이터를 옮길 때는 **먼저 개발 PC에서 새 버전을 한 번 실행**한다. 시작할 때 화면·이력을 기능별 파일로 분리한다. 분리 전 상태 파일은 서버의 128MB 힙으로 읽지 못한다. 그다음 볼륨에 복사하고 백엔드를 5번대로 GitHub 저장소에 다시 연결한다.

### 대상 코드

서버는 GitHub 저장소의 전용 사본으로 검사한다. 읽기 전용 배포 키만 쓰므로 팀 저장소에 push할 수 없고, 생성 테스트는 서버 사본 안에만 생긴다.

- API 찾기와 검사 직전에 선택한 브랜치의 최신 커밋을 받는다. **push하지 않은 코드는 검사되지 않는다.** push 전 코드는 개발 PC의 `npm start`에서 폴더를 연결해 검사한다.
- 팀원은 화면 왼쪽의 브랜치 선택으로 검사할 브랜치를 고른다. 결과와 검사 기록에 브랜치와 커밋이 남는다.
- 읽기용과 검사용 사본을 나누어, 검사 중 다른 팀원이 다른 브랜치를 봐도 실행 중인 코드는 바뀌지 않는다.
- 비공개 서브모듈과 Git LFS 파일은 받지 않는다.

### 빌드 격리

대상 프로젝트의 빌드와 테스트는 프로젝트 코드를 실행하므로 앱의 비밀값과 분리한다.

- `build-runner`에는 환경 파일과 데이터 볼륨이 없다. API 키, Notion 키, 운영자 비밀번호, 배포 개인키, 팀원 AI 로그인을 읽을 수 없다.
- 루트 파일 시스템은 읽기 전용이고 모든 capability를 뺐다. 빌드가 끝나면 남은 프로세스를 모두 종료한다.
- 빌드가 쓸 수 있는 작업 폴더에는 `.git`을 두지 않는다. 저장소에 커밋된 심볼릭 링크는 일반 파일로 받고, 앱은 빌드 결과를 읽을 때 링크를 따라가지 않는다.
- 남는 위험: 빌드는 의존성을 받기 위해 외부 네트워크를 쓰므로 같은 네트워크의 다른 서비스에 접속을 시도할 수 있고, 판정 근거도 그 빌드 안에서 만들어진다. 신뢰하는 팀 저장소만 연결한다.

### 메모리

앱 컨테이너는 850MB, 빌드 컨테이너는 1GB로 제한된다. AI 호출과 빌드는 겹치지 않게 시작하므로 실제 사용량이 두 값의 합까지 오르지 않는다. 넘치면 해당 컨테이너의 작업만 멈추고 같은 VM의 다른 서비스는 영향을 받지 않는다. 빌드는 Gradle·테스트 JVM을 각각 256MB로 실행하며, 큰 프로젝트에서 메모리 부족으로 BLOCKED가 반복되면 `deploy/.env`에 `BUILD_HEAP_MB`를 지정한다. AI 호출과 빌드는 VM의 여유 메모리를 확인한 뒤 순서대로 시작한다(AI 350MB, 빌드 900MB).

## Gateway Nginx와 인증서

아래는 공인 IP가 `203.0.113.10`, 앱 VM의 내부 주소가 `100.64.0.10`인 예시다. 실제 값으로 바꾼다.

Figma 플러그인의 `allowedDomains`는 IP 주소를 받지 않는다. 도메인이 없으면 IP가 들어간 [sslip.io](https://sslip.io) 이름을 쓴다. `tool.203-0-113-10.sslip.io`는 `203.0.113.10`으로 해석되므로 `PUBLIC_ORIGIN=https://tool.203-0-113-10.sslip.io`로 둔다. 하위 경로로는 배포하지 않는다.

1. Gateway의 80번 포트가 `/.well-known/acme-challenge/`를 webroot로 서비스하는지 확인하고 인증서를 받는다. 갱신 뒤 Nginx가 새 인증서를 읽도록 `--deploy-hook`을 함께 지정하면 이 인증서의 갱신 설정에 저장된다.

```bash
sudo certbot certonly --webroot -w /var/www/html --cert-name tool -d tool.203-0-113-10.sslip.io --deploy-hook "systemctl reload nginx"
```

2. `/etc/nginx/sites-available/figma-intent`를 새로 만든다. 다른 사이트 파일은 건드리지 않는다.

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name tool.203-0-113-10.sslip.io;

    ssl_certificate /etc/letsencrypt/live/tool/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tool/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 앱의 요청 크기 제한(22MB)에 맞춘다. 지정하지 않으면 1MB에서 끊겨 Figma 화면 동기화가 실패한다.
    client_max_body_size 22m;

    location / {
        proxy_http_version 1.1;
        # 앱은 PUBLIC_ORIGIN과 다른 Host를 거절한다.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_pass http://100.64.0.10:4318;
    }
}
```

3. 사이트를 켜고 설정을 검사한 뒤 다시 읽는다.

```bash
sudo ln -s /etc/nginx/sites-available/figma-intent /etc/nginx/sites-enabled/figma-intent
```

```bash
sudo nginx -t
```

```bash
sudo systemctl reload nginx
```

공인 IP가 바뀌면 sslip.io 이름, `PUBLIC_ORIGIN`, 인증서, Figma 플러그인을 함께 다시 만들어야 한다.

## 홈서버에 설치 (Compose 없이)

1. Node.js 22 이상, Caddy, 대상 프로젝트가 요구하는 JDK/Gradle과 아래 [AI 연결](#ai-연결)에서 고른 실행 환경을 준비한다. 도구와 대상 Spring 프로젝트를 **같은 서버**에서 실행하고, 대상 프로젝트는 `BACKEND_ROOTS`로 지정한 폴더(예: `/srv/figma-intent/backends`) 아래에 두고, 도구 서비스 계정에 대상 `src/test`와 `build` 작성 권한을 준다. 이 폴더 밖은 연결도 실행도 거부한다. 다른 경로를 쓰면 서비스 파일의 `ReadWritePaths`도 함께 바꾼다. 대상 Production Code/설정은 수정하지 않는다.
2. 도구를 `/opt/figma-intent` 같은 고정 경로에 놓고 `npm ci`를 실행한다. `/var/lib/figma-intent`를 만들고 서비스 계정만 읽고 쓸 수 있게 한다. 기존 데이터를 옮기는 경우 기존 `.local`의 내용 전체를 이 디렉터리로, `.verification/runs`의 내용 전체를 그 안의 `runs`로 복사한다. 기존 데이터에서 연결된 Backend 경로는 새 서버의 절대 경로로 다시 지정한다.
3. [env.example](../../deploy/env.example)의 실제 도메인과 데이터 경로를 `/etc/figma-intent.env`에 설정한다. `ADMIN_KEY`에 운영자 비밀번호를 넣는다. 앱 왼쪽 아래 '관리자'에 이 값을 넣어야 프로젝트 설정이 보이고 API 키, 기본 AI, Notion 링크를 바꿀 수 있다. 링크만 가진 팀원에게는 설정이 보이지 않는다. 저장된 비밀값을 옮기지 않았다면 Notion 연결 키를 앱에서 다시 설정한다. `APP_LINK_KEY`를 별도로 설정할 수 있지만, 비워 두면 데이터 디렉터리에 256비트 키를 한 번 생성한다. 키를 바꾸면 이전 링크와 생성 플러그인은 무효가 된다.
4. [figma-intent.service.example](../../deploy/figma-intent.service.example)을 실제 경로·계정에 맞춰 systemd 서비스로 설치하고 `systemctl enable --now figma-intent`로 부팅 시 자동 실행한다. 앱은 루프백에서만 듣는다. 방화벽으로 4318을 인터넷에 열지 않는다.
5. [Caddyfile.example](../../deploy/Caddyfile.example)의 도메인을 실제 도메인으로 바꾸고 Caddy를 실행한다. DNS A/AAAA가 홈서버를 가리키고 외부 80/443이 Caddy에 도달해야 공개 인증서를 자동 발급·갱신할 수 있다. 포트 개방이 불가능하면 운영자가 관리하는 영구 터널·역방향 프록시가 필요하며, 그 주소를 `PUBLIC_ORIGIN`으로 쓴다. 임시 Quick Tunnel은 운영 배포 수단이 아니다.
6. 서비스 계정 환경에서 `PUBLIC_ORIGIN=https://tool.example.com APP_DATA_DIR=/var/lib/figma-intent npm run deploy:prepare`를 실행한다(실제 값으로 교체). 출력된 HTTPS 링크를 전달하고 생성된 `APP_DATA_DIR/figma-plugin/manifest.json`을 Figma 개발 플러그인으로 가져온다. 이 배포본은 지정한 HTTPS 도메인만 호출하며, Figma 파일별 연결 토큰을 저장한다. 플러그인을 다시 빌드한 경우 Figma에서 해당 배포본을 다시 불러온다.

데이터 디렉터리에는 `state.json`, 기능별 상세(`feature-details/`), `secrets.json`, Figma 화면 보관함, 분석 로그, `runs/`의 명세 Snapshot·Java 생성물·실행 증거, `link-key`, 배포 플러그인이 들어간다. **백업은 이 디렉터리 전체**를 대상으로 하고 서비스 계정 외에는 접근을 막는다. Caddy의 인증서 저장소도 재시작 후 유지한다. 배포 때 코드 디렉터리를 교체해도 데이터 디렉터리는 보존한다.

## AI 연결

앱의 **프로젝트 설정**에서 운영자가 기본 AI를 고른다(운영자 비밀번호 필요). 개인 AI를 연결하지 않은 팀원의 요청이 기본 AI로 실행된다. 비밀값은 데이터 디렉터리의 `secrets.json`에 저장되고 브라우저로 다시 내려가지 않는다.

- **Claude(기본 AI):** 서버에 Claude Code를 설치하고 Anthropic Console API 키를 입력한다. Anthropic은 개인 구독 자격 증명으로 다른 사용자의 요청을 처리하는 것을 허용하지 않으므로 기본 AI에는 구독 경로가 없다.
- **Gemini:** Google AI Studio API 키를 입력한다. 별도 CLI는 필요 없다. 무료 등급의 데이터 처리 조건은 사용 전에 Google 약관에서 확인한다. Figma 내용과 Backend 소스가 전송된다.
- **Codex(팀 공용):** 서비스 계정으로 `codex login --device-auth`를 실행한다. 브라우저 로그인은 서버의 localhost로 돌아오므로 팀원 PC에서 쓸 수 없다. 개인 구독을 팀이 함께 쓰는 것이 허용되는지는 OpenAI 약관에서 직접 확인한다.
- **Codex(팀원 개인):** 팀원이 ‘내 AI’에서 ‘ChatGPT로 로그인’을 누르면 서버가 그 팀원 전용 Codex 홈(`APP_DATA_DIR/members/<개인 코드>/codex`)에서 `codex login --device-auth`를 실행하고 주소와 일회용 코드를 화면에 보여 준다. 팀원은 자기 PC 브라우저에서 ChatGPT에 로그인해 코드를 입력한다(ChatGPT 설정 › 보안에서 기기 코드 로그인 허용 필요, 15분 제한). 연결된 뒤 그 팀원의 해석·기준 작성·검사 요청은 그 계정으로 실행되고 결과 기록에 `account: member`가 남는다. 개인 코드는 브라우저가 보관하며 다른 기기에서는 코드를 입력해 이어 쓴다.
- **Claude(팀원 PC):** 팀원이 ‘내 AI’에서 ‘Claude 연결’을 누르면 연결 명령이 표시된다. 자기 PC의 터미널에서 실행하면 그 PC에 로그인된 공식 Claude CLI가 그 팀원의 요청만 처리한다. SSH가 필요 없고 Claude 로그인 코드와 토큰은 PC를 벗어나지 않는다. 서버에는 앱 자체 연결 토큰의 해시만 저장한다. Node.js 22 이상과 로그인된 Claude Code가 필요하고, 쓰는 동안 창을 켜 둔다. 창이 꺼져 있으면 기본 AI로 넘기지 않고 안내를 보여 준다.
- **Claude(서버 터미널):** ‘Claude 연결’ 뒤 ‘서버 터미널에서 로그인’을 누르면 그 팀원 전용 폴더(`APP_DATA_DIR/members/<개인 코드>/claude`)와 실행할 명령이 표시된다. 서버 터미널에서 그 명령을 실행하면 공식 CLI가 주소를 출력하고, 본인 브라우저에서 Anthropic에 로그인해 받은 코드를 같은 터미널에 붙여 넣는다. 앱은 코드와 토큰을 받거나 읽지 않는다(Anthropic은 앱이 Claude 로그인을 제공하거나 코드·토큰을 중개하는 것을 허용하지 않는다). 연결된 뒤 그 팀원의 요청만 그 계정으로 실행되고 결과 기록에 `account: member`가 남는다. 서버 터미널에 접근할 수 없는 팀원은 Codex나 기본 AI를 쓴다. ChatGPT와 Claude를 모두 연결하면 Claude를 쓴다.

Notion 기능명세서 읽기는 프로젝트 설정의 Notion API 키를 쓰므로, 읽을 페이지의 ‘연결’ 메뉴에 그 API 연결을 추가해 둔다. 서버는 15분마다 연결된 문서를 다시 읽어 바뀐 경우 해당 기능에 표시한다. Notion 키는 만든 워크스페이스 안에서만 동작하므로, API 명세서가 다른 워크스페이스에 있으면 그 워크스페이스에서 만든 키를 ‘API 명세서용 Notion 키’에 넣는다. Notion 저장이 실패해도 검사는 그대로 진행한다.

서비스 파일은 `ProtectHome`을 켜므로 환경 파일의 `HOME`을 데이터 디렉터리 아래로 지정해 CLI 로그인과 Gradle 캐시를 그곳에 둔다.

## 확인

공유 링크를 새 브라우저에서 열어 프로젝트 목록을 확인한다. 잘못된 키로 `/api/session`을 호출하면 403, 올바른 링크는 세션을 받고 앱 상태를 읽어야 한다. 프로젝트를 추가한 뒤 Node 서비스를 재시작해 목록·Figma 완료 리비전·검사 기록이 남는지 확인한다. 플러그인에서 화면을 동기화한 뒤 브라우저 보관함의 완료 리비전과 노드·이미지를 확인한다. Notion은 실제 연결 키와 공유된 페이지에서 승인 명세를 발행하고 그 페이지·버전을 확인한다. 선택한 AI 연결과 `BACKEND_ROOTS` 안의 Backend 경로가 유효해야 Java 검사를 원래 빌드로 실행할 수 있다. 접속 링크를 가진 팀원 모두가 같은 서버 상태를 보므로 팀 내부에서만 공유한다.

개발용 `start.ps1`과 `figma-plugin/manifest.json`은 localhost 경로다. HTTPS 배포에는 생성된 별도 플러그인 manifest와 서비스 구성을 사용한다.
