import {backendCoverage} from './verification-scope.mjs';
import {
  overall,
  currentStep,
  nextAction,
  behavior,
  problemSentence,
  handoffText,
} from "./workflow.mjs";
import {backendQuestions} from "./intent-questions.mjs";
import {projectPolicies,teamPolicies,interpretationStatus} from './project-policies.mjs';
import {localClient} from './local-client.mjs';
import {questionChoices,renderQuestion} from './question-choices.mjs';
const client=localClient();
function appLocation(params={}) {
  const access=new URLSearchParams(location.hash.slice(1)).get('access') || sessionStorage.getItem('app-access');
  const hash=new URLSearchParams({...params,...(access?{access}:{})}).toString();
  return '/'+(hash?'#'+hash:'');
}
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const app = document.querySelector("#app"),
  dialog = document.querySelector("#dialog");
const saved = JSON.parse(sessionStorage.getItem("workflow-v2") || "{}");
let state,
  activeId =
    new URLSearchParams(location.hash.slice(1)).get("feature") ||
    (new URLSearchParams(location.hash.slice(1)).has("project") ? null : saved.activeId) ||
    null,
  projectId = new URLSearchParams(location.hash.slice(1)).get("project") || localStorage.getItem("project") || "local",
  step = saved.step ?? null,
  screen = saved.screen || "home",
  report = null,
  job = null,
  aiProviders = null,
  modelCatalog = null,
  busy = false;
let discoverAfterConnect=false;
let memberName = localStorage.getItem("member-name") || "";
// A random personal code: it groups this member's own AI login on the server, nothing more.
let memberId = /^[a-f0-9]{32}$/.test(localStorage.getItem("member-id") || "") ? localStorage.getItem("member-id") : crypto.randomUUID().replaceAll("-", "");
localStorage.setItem("member-id", memberId);
let operatorKey = sessionStorage.getItem("operator-key") || "";
let memberAi = null;
const branchLists = {};
const selectedBranch = (p = state.projects.find((x) => x.id === projectId)) => (p?.backend?.source === "github" ? localStorage.getItem("branch:" + p.id) || p.backend.branch : undefined);
const sources = {};
const aiLabel = () => ({ codex: "Codex", claude: "Claude", gemini: "Gemini" })[state?.settings?.aiProvider] || "AI";
// Setup is hidden from teammates on a team server; the running server keeps what the manager saved.
const canManage = () => !state.connections.shared || Boolean(operatorKey);
const NEEDS_BACKEND = "백엔드가 아직 연결되지 않았습니다. 관리자에게 알려 주세요.";
let forms = JSON.parse(localStorage.getItem("intent-answers") || "{}");
const f = () => state.features.find((x) => x.id === activeId);
const latest = (x) => state.runs.find((r) => r.featureId === x.id);
const btn = (text, action, kind = "secondary", attrs = "") =>
  `<button class="btn ${kind}" data-action="${action}" ${attrs}>${text}</button>`;
function badge(status) {
  return `<span class="badge ${esc(status)}">${{ PASS: "✓ PASS", FAIL: "FAIL", BLOCKED: "실행 막힘", UNVERIFIED: "미검증", STALE: "이전 기준", READY: "검사 전", DRAFT: "확인 필요" }[status] || esc(status)}</span>`;
}
async function api(route, body, raw = false) {
  const r = await client.request(route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(memberName ? { "X-Member": encodeURIComponent(memberName) } : {}), ...(memberId ? { "X-Member-Id": memberId } : {}), ...(operatorKey ? { "X-Operator-Key": operatorKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.json();
    if (e.code === "OPERATOR_KEY_REQUIRED") { operatorKey = ""; sessionStorage.removeItem("operator-key"); render(); operatorDialog(); }
    throw Object.assign(new Error(e.error), { code: e.code });
  }
  return raw ? r.text() : r.json();
}
function toast(message) {
  const t = document.querySelector("#toast");
  t.textContent = message;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 5500);
}
function modal(title, body) {
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header class="modal-head"><h2>${esc(title)}</h2>${btn("×", "close", "icon", 'aria-label="닫기"')}</header><div class="modal-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}
let stateTag;
async function refresh() {
  const response = await client.request("/api/state", { cache: "no-store", headers: stateTag ? { "If-None-Match": stateTag } : {} });
  if (response.status === 304) return hydrate();
  if (!response.ok) throw new Error((await response.json()).error);
  stateTag = response.headers.get("ETag");
  state = await response.json();
  if (!state.projects.some((p) => p.id === projectId))
    projectId = state.projects[0].id;
  const runningJobs = state.jobs.filter((j) => j.status === "RUNNING");
  job = runningJobs.find((j) => j.featureId === activeId) || runningJobs[0] || null;
  await hydrate();
}
// The polled state omits screens and history; only the open work loads them.
async function hydrate(x = f()) {
  if (!x?.scan || x.scan.nodes) return;
  const key = [x.scan.id, x.historyCount, x.apiStatus, x.apiStatusRequest, x.planStatus, x.planRequestId].join(":");
  if (sources[x.id]?.key !== key) sources[x.id] = { key, ...(await api(`/api/features/${x.id}/source`)) };
  x.scan = sources[x.id].scan;
  Object.assign(x, { history: sources[x.id].history, apiCatalog: sources[x.id].apiCatalog, apiCandidates: sources[x.id].apiCandidates, apiMissing: sources[x.id].apiMissing, planExecution: sources[x.id].planExecution });
}
function save() {
  sessionStorage.setItem(
    "workflow-v2",
    JSON.stringify({ activeId, step, screen }),
  );
  localStorage.setItem("project", projectId);
  localStorage.setItem("intent-answers", JSON.stringify(forms));
}
async function ensureChoices(){const x=f();if(x && !x.answers && backendQuestions(x.analysis).length && !x.questionChoices && !['RUNNING','ERROR'].includes(x.choicesStatus)){await api('/api/features/'+x.id+'/choices',{});await refresh();render();}}
async function select(id, forcedStep) {
  activeId = id;
  const feature = f();
  await hydrate(feature);
  projectId = feature.projectId;
  screen = "detail";
  report = latest(feature)
    ? await api("/api/runs/" + latest(feature).id)
    : null;
  step = forcedStep ?? currentStep(feature, latest(feature), job);
  history.replaceState(null, "", appLocation({feature:id}));
  window.scrollTo(0, 0);
  render();
  if(step===1)await ensureChoices();
}
function branchControl() {
  const p = state.projects.find((x) => x.id === projectId);
  if (p?.backend?.source !== "github") return "";
  if (!branchLists[p.id]) {
    branchLists[p.id] = [p.backend.branch];
    api(`/api/branches?projectId=${encodeURIComponent(p.id)}`).then((r) => { branchLists[p.id] = r.branches; render(); }).catch(() => {});
  }
  const current = selectedBranch(p);
  return `<label class="project-label" for="branch">브랜치</label><select id="branch">${[...new Set([current, ...branchLists[p.id]])].map((n) => `<option value="${esc(n)}" ${n === current ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
}
function shell(body) {
  const manage = canManage(), shared = state.connections.shared;
  return `<div class="layout"><aside><button class="workspace-title" data-action="home"><span class="app-symbol">▤</span>작업 공간</button><label class="project-label" for="project">프로젝트</label><select id="project">${state.projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>${branchControl()}<nav>${btn("내 작업", "home", screen === "home" ? "nav selected" : "nav")}${btn("팀 해석 기준", "team", screen === "team" ? "nav selected" : "nav")}${btn("검사 기록", "history", screen === "history" ? "nav selected" : "nav")}${manage ? btn("프로젝트 설정", "settings", "nav") : ""}</nav><div class="aside-bottom">${manage ? btn("프로젝트 추가", "new-project", "nav") : btn("내 AI", "settings", "nav")}${btn(memberName ? esc(memberName) + " · 이름 변경" : "내 이름 설정", "member", "nav")}${shared && !manage ? btn("관리자", "operator-login", "nav") : ""}</div></aside><main><header class="topbar"><span>${esc(state.projects.find((p) => p.id === projectId)?.name)}</span></header><div class="page">${body}</div></main></div>`;
}
function render() {
  if (!state) return;
  save();
  document.title = "개발 검증 · 내 작업";
  app.innerHTML = shell(
    screen === "history"
      ? historyView()
      : screen === "team"
      ? teamView()
      : screen === "detail" && f()
        ? detailView(f())
        : homeView(),
  );
}

function homeView() {
  const library = state.libraries?.find(l=>l.projectId===projectId);
  const sync = library?.syncing.at(-1);
  const libraryInfo = sync ? `<p class="notice" role="status">화면을 받는 중 (${sync.received}/${sync.expected})</p>` : "";

  const features = state.features.filter((x) => x.projectId === projectId);
  return `<div class="page-head"><div><h1>${features.length ? "이어서 작업하세요" : "어떤 화면을 검사할까요?"}</h1></div></div><div class="home-actions">${btn("화면 선택하기", "library", "primary")}</div>${libraryInfo}${
    features.length
      ? `<section class="work-list">${features
          .map((x) => {
            const run = latest(x);
            return `<article class="work-row"><div><span class="meta">${x.scan?.nodeCount || 0}개 화면 · ${x.status === "READY" && x.spec ? "팀 기준 v" + x.spec.version : x.spec ? "승인 전 v" + x.spec.version : "의도 확인 중"}</span><h2><button class="work-title" data-action="open-work" data-id="${x.id}">${esc(x.name)}</button></h2><p>${esc(x.analysisStatus === "ERROR" ? x.analysisError.message : x.analysis?.summary || "")}</p></div>${btn(state.jobs.some((j) => j.status === "RUNNING" && j.featureId === x.id) ? "검사 중" : nextAction(x, run), "resume", "secondary", `data-id="${x.id}" ${x.analysisStatus === "RUNNING" || (job && x.status === "READY") ? "disabled" : ""}`)}</article>`;
          })
          .join("")}</section>`
      : '<div class="empty-onboard"><div class="outline-icon">▧</div><ol class="simple-flow"><li>화면 고르기</li><li>의도 확인·명세 승인</li><li>개발 후 검사</li></ol></div>'
  }`;
}
function interpretationBanner(x) {
  const s = interpretationStatus(x), e = x.analysis?.execution;
  const by = e?.model ? `${esc(e.provider || "AI")} ·${esc(e.model)}${x.analysisBy ? " · 요청 " + esc(x.analysisBy) : ""}` : "";
  if (s.kind === "APPROVED") return `<div class="team-status approved" role="status"><strong>팀 기준 v${s.version}</strong><span>${s.by ? esc(s.by) + " 승인" : "승인됨"}${s.at ? " · " + esc(new Date(s.at).toLocaleString("ko-KR")) : ""}${by ? " · " + by : ""}</span></div>`;
  return `<div class="team-status" role="status"><strong>${s.kind === "CHANGING" ? "기준 수정 중" : "승인 전"}</strong><span>AI가 읽은 후보입니다${by ? " (" + by + ")" : ""}.</span></div>`;
}
function teamView() {
  const groups = teamPolicies(state.features, projectId);
  const works = state.features.filter((x) => x.projectId === projectId);
  const approved = works.filter((x) => interpretationStatus(x).kind === "APPROVED");
  const conflicts = groups.filter((g) => g.conflict).length;
  return `<div class="page-head"><div><h1>팀 해석 기준</h1><p>승인 ${approved.length} / 전체 ${works.length}</p></div></div>${conflicts ? `<div class="error-box"><strong>서로 다른 답변이 ${conflicts}건 있습니다.</strong><p>같은 질문에 기능마다 다르게 답했습니다. 팀에서 하나로 정한 뒤 답변을 수정해 주세요.</p></div>` : ""}<section class="work-list">${groups.length ? groups.map((g) => `<article class="work-row team-policy ${g.conflict ? "conflict" : ""}"><div>${g.conflict ? '<span class="badge FAIL">답변 충돌</span>' : ""}<h2>${esc(g.question)}</h2>${g.answers.map((a) => `<p><strong>${esc(a.value)}</strong><br>${a.sources.map((s) => `<button class="work-title small-link" data-action="open-work" data-id="${esc(s.featureId)}">${esc(s.featureName)} v${s.version}</button>`).join(" ")}</p>`).join("")}</div></article>`).join("") : '<div class="empty"><h2>아직 정해진 정책이 없습니다</h2><p>기능을 승인하면 답변한 서버 정책이 여기에 모입니다.</p></div>'}</section>`;
}
function notionStatusView(x) {
  if(x.status!=="READY")return "";
  const dest=state.projects.find(p=>p.id===x.projectId)?.notion;
  const status=x.notionPublication;
  const current=status?.key?.endsWith(":api-domain-v2") && status?.digest===x.spec?.approval?.digest && status?.parentId===dest?.parentId;
  let content;
  if(current && status.status==="DONE")content=`<span>승인한 API 명세를 Notion에 저장했습니다.</span><a class="btn small" href="${esc(status.url)}" target="_blank" rel="noopener">Notion API 목록 열기</a>`;
  else if(current && status.status==="RUNNING")content='<span><span class="spinner"></span> Notion에 저장하고 있습니다.</span>';
  else if(current && status.status==="ERROR")content=`<span>Notion 저장을 마치지 못했어요. ${esc(status.message)}</span>${btn("다시 보내기","notion","small")}`;
  else if(!canManage() && !(state.connections.notion && dest?.parentId))return "";
  else content=`<span>아직 Notion에 저장하지 않았습니다.</span>${btn("Notion에 명세 저장","notion","small")}`;
  return `<div class="notion-status" role="status">${content}</div>`;
}
function detailView(x) {
  const running = job?.featureId === x.id;
  return `${x.sourceReviewRequired ? `<div class="notice"><strong>화면 설명이 달라졌습니다.</strong>${btn("새 화면 검토하기", "review-source", "secondary")}</div>` : ""}${x.documentReviewRequired ? `<div class="notice"><strong>기능명세서 ‘${esc(x.documentReviewRequired.title)}’가 바뀌었습니다.</strong>${btn("문서 다시 읽고 재해석", "refresh-documents", "secondary")}</div>` : ""}<div class="page-head compact"><div>${btn("← 내 작업", "home", "text")}<h1>${esc(x.name)}</h1></div>${x.status === "READY" ? btn("명세 내보내기", "export", "small") : ""}</div>${interpretationBanner(x)}${x.verificationInterrupted ? `<div class="error-box"><strong>이전 검사가 서버 재시작으로 중단됐어요.</strong><p>결과는 저장되지 않았습니다. 다시 검사해 주세요.</p></div>` : ""}${notionStatusView(x)}<section class="detail"><nav class="steps" aria-label="진행 단계">${["가져온 화면", "의도 확인", "명세 검토·승인", "개발 후 검사·결과"].map((t, i) => `<button class="${step === i ? "active" : ""}" data-action="step" data-step="${i}" aria-current="${step === i ? "step" : "false"}"><span>${i + 1}</span>${t}</button>`).join("")}</nav><div class="detail-content">${running && step === 3 ? progressView() : step === 0 ? sourceView(x) : step === 1 ? intentView(x) : step === 2 ? reviewView(x) : resultView(x)}</div><div class="actionbar">${actionBar(x, running)}</div></section>`;
}
function sourceView(x) {
  return `${x.analysisStatus === "RUNNING" ? '<div class="notice"><span class="spinner"></span> AI가 화면과 기획을 읽고 있습니다.</div>' : ""}${x.analysisStatus === "ERROR" ? `<div class="error-box"><strong>${esc(x.analysisError.message)}</strong>${x.analysisError.diagnosticId ? `<details><summary>오류 상세</summary><p>오류 종류: ${esc(x.analysisError.code)}<br>진단 번호: ${esc(x.analysisError.diagnosticId)}</p></details>` : ""}${x.analysisError.code === "LOGIN_REQUIRED" ? btn("AI 연결", "settings", "secondary", 'data-section="ai"') : btn("다시 분석하기", "analyze")}${canManage() ? btn("모델 변경", "settings", "small", 'data-section="ai"') : ""}</div>` : ""}${x.scan.scope ? `<div class="note">분석 범위: 선택 화면 ${x.scan.scope.screenIds.length}개와 ${esc(x.scan.scope.context)}.</div>` : ""}${(x.scan.documents || []).length ? `<section class="documents"><h3>함께 읽은 Notion 기능명세서</h3>${x.scan.documents.map((d) => `<article class="document"><p><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a> <span class="meta">${d.blockCount}개 문단 · ${esc(new Date(d.fetchedAt).toLocaleString("ko-KR"))} 읽음${d.truncated ? " · 길어서 일부만 읽음" : ""}</span></p>${screenFindings(x, "notion-doc-" + d.id)}</article>`).join("")}${x.analysisStatus !== "RUNNING" ? btn("문서 다시 읽고 재해석", "refresh-documents", "text") : ""}</section>` : ""}<div class="source-grid">${(x.scan.images || []).length ? (x.scan.images || []).map((i) => `<figure><img src="${esc(i.dataUrl)}" alt="Figma 원문 화면 ${esc(i.nodeId)}"><figcaption>${esc(x.scan.library?.screens.find((n) => n.id === i.nodeId)?.name || x.scan.nodes.find((n) => n.id === i.nodeId)?.name || i.nodeId)}</figcaption>${screenFindings(x, i.nodeId)}</figure>`).join("") : '<div class="note">화면 이미지가 없습니다.</div>'}</div><section class="summary-box"><span class="meta">${x.analysis?.mode === "codex" ? (x.status === "READY" ? "팀이 승인한 해석의 근거" : "AI가 읽은 기획 · 승인 전 후보") : "AI 분석 전 · 원문 보관"}</span><h2>${esc(x.analysis?.summary)}</h2>${x.analysis?.mode === "codex" && x.analysisStatus !== "RUNNING" ? btn("AI로 다시 해석", "reanalyze", "text") : ""}</section><details><summary>원문과 분석 근거 보기</summary>${(x.analysis?.findings || []).map((a) => `<div class="finding"><p>${esc(a.text)}</p><small>${a.evidenceStatus === "CONFIRMED" ? "원문 사실" : "AI 해석"} · ${esc(a.nodeIds.join(", "))}</small><blockquote>${esc(a.quote)}</blockquote></div>`).join("")}<pre>${esc(JSON.stringify(x.scan.nodes, null, 2))}</pre></details><p class="hint">${(x.analysis?.unobserved || []).map(esc).join(" ")}</p>`;
}
// Shows beside each screen how the team reads it, so nobody has to interpret the image alone.
function screenFindings(x, screenId) {
  const collect = (n) => [n.id, ...(n.children || []).flatMap(collect)];
  const root = x.scan.nodes.find((n) => n.id === screenId);
  if (!root) return "";
  const ids = new Set(collect(root));
  const items = (x.analysis?.findings || []).filter((a) => a.nodeIds?.some((id) => ids.has(id)));
  return items.length ? `<ul class="screen-findings">${items.map((a) => `<li><span class="meta">${a.evidenceStatus === "CONFIRMED" ? "원문 사실" : a.evidenceStatus === "UNKNOWN" ? "미확인" : "AI 해석"}</span> ${esc(a.text)}</li>`).join("")}</ul>` : "";
}
function answerValues(x) {
  return forms[x.id] || x.answers || x.previousAnswers || { extraAnswers: [] };
}
function intentView(x) {
  if (x.analysisStatus === "RUNNING" || x.analysisStatus === "ERROR") return sourceView(x);
  const questions=backendQuestions(x.analysis),a=answerValues(x);
  return `<div class="intent-context"><span class="meta">읽은 기획</span><p>${esc(x.analysis.summary)}</p>${btn("원문 다시 보기","source","text")}</div><h2>${x.answers ? "확인한 서버 정책" : questions.length ? "서버 동작에 필요한 정책만 확인해 주세요" : "추가로 답할 서버 정책 질문이 없습니다"}</h2>${x.answers ? questions.map(({index,text})=>`<p><strong>${esc(text)}</strong><br>${esc(x.answers.extraAnswers?.[index] || "미정")}</p>`).join("")+btn("답변 수정하기","edit") : `<form id="intent-form">${x.choicesStatus === "ERROR" ? `<p class="notice">${esc(x.choicesStatusError || "선택지를 만들지 못했어요. 다시 시도해 주세요.")}</p>` : ""}${x.choicesStatus === "RUNNING" ? '<p class="hint">AI가 답변 선택지를 정리하고 있어요.</p>' : !x.questionChoices && questions.length ? btn("AI 답변 선택지 받기","choices","small",'type="button"') : ""}${questions.map(({index,text})=>choiceQuestion(x,index,text,a.extraAnswers?.[index] || "")).join("")}</form>`}`;
}
function apiSelectionView(x) {
  if(x.apiStatus==='RUNNING') return '<h2>검사할 API를 찾고 있습니다</h2>';
  if(x.apiStatus!=='DONE') return '<h2>이 화면과 관련된 API를 찾아보세요</h2><p>'+esc(x.apiStatusError || '')+'</p>'+btn('코드에서 검사할 API 찾기','discover','primary')+btn('기획으로 명세 만들기','plan','text');
  const savedSelection=forms[x.id]?.apiSelection;
  const checkedIds=savedSelection?.catalog===x.apiCatalog?.digest ? savedSelection.ids : x.apiCandidates.filter(e=>e.recommended&&!e.excludedReason).slice(0,20).map(e=>e.id);
  const row=e=>'<label class="choice"><input type="checkbox" name="endpointId" value="'+esc(e.id)+'" '+(e.excludedReason?'disabled':checkedIds.includes(e.id)?'checked':'')+'><span><strong>'+esc(e.label)+'</strong><br><code>'+esc(e.method+' '+e.path)+'</code><br><small>'+esc(e.reason)+'</small><br><small>'+esc(e.file)+'</small></span></label>';
  const recommended=x.apiCandidates.filter(e=>e.recommended),others=x.apiCandidates.filter(e=>!e.recommended);
  const missing=x.apiMissing||[],missingRow=m=>'<label class="choice"><input type="checkbox" name="plannedApiId" value="'+esc(m.id)+'"><span><strong>'+esc(m.label)+'</strong><br><code>'+esc(m.method+' '+m.path)+'</code><br><small>'+esc(m.reason)+'</small></span></label>';
  return '<h2>검사할 API를 골라 주세요</h2><form id="api-selection-form">'+recommended.map(row).join('')+(others.length?'<details '+(!recommended.length?'open':'')+'><summary>다른 API '+others.length+'개</summary>'+others.map(row).join('')+'</details>':'')+(missing.length?'<h3>코드에 없는 API가 있어요</h3><p class="hint">명세서에 ‘시작 전’으로 추가할 API를 골라 주세요.</p>'+missing.map(missingRow).join(''):'')+'</form><div class="actions">'+btn('API 다시 찾기','discover','text')+btn('기획으로 명세 만들기','plan','text')+'</div>';
}
function choiceQuestion(x,index,text,value) {
  const policies=projectPolicies(state.features,x,text);
  const a=answerValues(x),custom=a.answerModes?.[index]==='custom';
  const previous=x.answers?.extraAnswers?.[index] || x.previousAnswers?.extraAnswers?.[index] || '';
  const choices=questionChoices({suggestions:x.questionChoices?.[index],policies,previous,value,custom});
  return renderQuestion({index,text,choices,value,custom,customText:a.customAnswers?.[index]||''});
}
async function discoverApis(answers) {
  if(!state.projects.find(p=>p.id===projectId)?.backend){if(!canManage()){toast(NEEDS_BACKEND);return;}discoverAfterConnect=true;backendDialog();return;}
  await api('/api/features/'+activeId+'/apis',{answers:answers || f().answers || answerValues(f()),branch:selectedBranch()});
  await refresh();step=2;render();
}
function apiInputs(x){
 const rows=x.spec.scenarios.filter(s=>!s.given&&(s.action.pathValues?.length||s.action.query?.length));
 if(!rows.length)return '';
 return '<details '+(rows.some(s=>s.action.pathValues.some(p=>!p.value))?'open':'')+'><summary>테스트 요청값 확인·수정</summary><form id="api-inputs-form">'+rows.map(s=>'<h3>'+esc(s.name)+'</h3>'+['pathValues','query'].map(k=>s.action[k].map(p=>'<label class="field">'+esc(p.name)+'<input name="'+esc(s.id+'|'+k+'|'+p.name)+'" value="'+esc(p.value)+'" placeholder="테스트할 값"></label>').join('')).join('')).join('')+'<button class="btn secondary" type="submit">요청값 저장</button></form></details>';
}
function reviewView(x) {
  if(x.answers && (x.apiStatus==='RUNNING' || (x.apiStatus==='DONE' && !x.planStatus))) return apiSelectionView(x);
  if(x.answers && !x.spec?.scenarios?.length && !['RUNNING','ERROR','DONE'].includes(x.planStatus)) return apiSelectionView(x);
  if(x.planStatus === "RUNNING") return '<div class="running"><span class="spinner large"></span><h2>기획을 테스트 기준으로 정리하고 있습니다</h2></div>';
  if(x.planStatus === "ERROR") return `<h2>테스트 기준을 작성하지 못했어요</h2><p>${esc(x.planError?.message)}</p>${btn("다시 작성하기","plan","primary")}${btn("API 다시 선택하기","discover","text")}`;
  if(x.answers && x.spec?.contract?.kind!=="controller-api-v1") return `<h2>확인한 기획으로 테스트를 준비하세요</h2>${btn("기획으로 명세 만들기","plan","primary")}${btn("기존 코드의 API 연결하기","discover","text")}`;
  if (!x.spec || !x.answers)
    return `<h2>기획 의도를 확인하면 테스트를 작성할 수 있어요</h2>${btn("기획 확인하고 테스트 준비하기", "intent", "primary")}`;
  const s = x.spec;
  const missing = s.requirements
    .flatMap((r) => r.conditions)
    .filter((c) => c.scope!=="frontend" && !c.requiredScenarios.length);
  return `<span class="meta">${x.status === "READY" ? "승인된 기준" : "승인 전 확인"} · v${s.version}</span><h2>${s.scenarios.length?'이 기준으로 개발하고 검사합니다':'이번에 선택한 API는 별도 연결이 필요합니다'}</h2>${!s.scenarios.length?'<p>아래 제외 이유를 확인하거나 다른 API를 선택해 주세요. 통과로 처리하지 않았습니다.</p>':''}<ul class="behavior-list">${s.scenarios.map((t) => `<li><strong>${esc(t.name)}</strong><p><code>${esc(t.action.method)} ${esc(t.action.path)}</code></p><p>${esc(behavior(t.expected))}</p>${t.expected.statusPolicy?`<p class="hint">${t.expected.statusPolicy.origin==="ai_default"?"AI 기술 선택":"명시된 API 약속"}: ${esc(t.expected.statusPolicy.reason)}${t.expected.statusPolicy.mode==="equivalent"?" · 동등한 상태 차이는 참고로 기록":""}</p>`:""}${t.given?`<p class="hint">Given: ${esc(t.given.description || '승인된 계정·관계·비교 데이터를 저장하고 실제 DB에서 확인합니다.')}</p>${t.given.facts?'<ul>'+t.given.facts.map(f=>'<li>'+esc(f.description)+'</li>').join('')+'</ul>':''}`:""}</li>`).join("")}</ul><p class="meta">작성 모델: ${esc(x.planExecution?.model || "AI")} · ${s.contract.endpoints.some(e=>e.documentation?.origin==="AI_PROPOSAL")?"기획에서 제안한 API · AI 선택":"컨트롤러의 API 선언 연결"}</p><details><summary>AI가 준비한 요청값 확인 (선택)</summary>${apiInputs(x)}</details>${missing.length ? `<details><summary>아직 테스트하지 못한 조건 ${missing.length}개</summary>${missing.map((c) => `<p>${esc(c.description)}</p>`).join("")}</details>` : ""}${btn("검사할 API 다시 선택하기","discover","text")}<details><summary>원문 · 답변 · API · 테스트 상세</summary>${sourceView(x)}<h3>기록한 답변</h3><pre>${esc(JSON.stringify(x.answers || {}, null, 2))}</pre><h3>기획 해석 검토</h3>${s.requirements.map(r=>`<p><strong>${esc(r.description)}</strong><br><small>${esc(r.evidenceStatus)} · ${r.approvalStatus === "REJECTED" ? "제외됨" : x.status === "READY" ? "승인됨" : "승인 대기"} · v${r.version}</small>${x.status === "DRAFT" && r.approvalStatus !== "REJECTED" ? btn("이 해석 제외","reject-requirement","small",`data-id="${esc(r.id)}"`) : ""}</p>`).join("")}<h3>API 계약과 시나리오</h3><pre>${esc(JSON.stringify({ contract: s.contract, scenarios: s.scenarios }, null, 2))}</pre></details>${x.history?.length ? `<details><summary>이전 기준 ${x.history.length}개</summary><pre>${esc(JSON.stringify(x.history, null, 2))}</pre></details>` : ""}`;
}
function resultView(x) {
  if (!report)
    return '<div class="empty"><h2>아직 검사하지 않았습니다</h2><p>승인한 기준으로 실제 백엔드 동작을 확인해 보세요.</p></div>';
  const status = overall(report, x);
  return `<div class="result-title ${status}">${badge(status)}<h2>${esc(problemSentence(report, x))}</h2><p>${new Date(report.finishedAt).toLocaleString("ko-KR")} · ${report.codeVersion ? `${esc(report.codeVersion.branch)} ${esc(report.codeVersion.commit.slice(0, 7))} · ` : ""}실행 ${esc(report.id)}</p></div>${report.results
    .map((r, i) => {
      const e = r.evidence;
      return `<article class="result-item">${badge(r.status)}<h3>${esc(r.name)}</h3><div class="compare"><div><span>기획</span><p>${esc(r.name)}</p><p class="hint">${esc(behavior(r.expected || e?.expected))}</p></div><div><span>실제</span><p>${["node-http","spring-h2","project-java"].includes(report.runtime) ? esc(r.reason) : e?.after ? `대상이 ${e.after.exists ? "남아 있습니다 (상태: " + esc(e.after.state) + ")" : "삭제됐습니다"}.` : "데이터 상태를 판단할 근거가 없습니다."}</p>${r.technicalDifferences?.length ? `<p class="hint">AI 기술 기본값과 동등한 차이: ${r.technicalDifferences.map(d=>esc(d.expected)+" → "+esc(d.actual)).join(", ")} (업무 실패 아님)</p>` : ""}${r.nextAction ? `<p class="hint"><strong>다음 행동</strong> ${esc(r.nextAction)}</p>` : ""}${e?.fixture?.persisted ? `<p class="hint">${typeof e.fixture.rowsPrepared==="object" ? "H2 준비: "+Object.entries(e.fixture.rowsPrepared).filter(([k,v])=>v>0).map(([k,v])=>esc(k)+" "+v+"개").join(" · ") : "H2 테스트 계정 준비"} · ${e.fixture.rollbackVerified ? "요청 후 롤백 확인" : "롤백 확인 필요"}</p>` : ""}${e?.response ? `<small>응답 ${e.response.status}</small><details><summary>API 응답 보기</summary><pre>${esc(e.response.body)}</pre></details>` : ""}</div></div><details ${r.status === "FAIL" ? "open" : ""}><summary>근거 확인</summary><p>${esc(r.reason)}</p>${r.nextAction ? `<p><strong>다음 행동</strong> ${esc(r.nextAction)}</p>` : ""}${r.logFile ? btn("실행 로그 보기", "artifact", "text", `data-kind="log"`) : ""}${r.details?.length?'<ul>'+r.details.map(d=>'<li>'+esc(d)+'</li>').join('')+'</ul>':''}${e ? `<p>${["node-http","spring-h2","project-java"].includes(report.runtime) ? esc(e.action?.method || "")+" "+esc(e.action?.url || "") : "요청자: "+esc(e.actualRequestActor || e.actor?.id)+" · 소유자: "+esc(e.before?.owner)}<br>사전조건 ${e.preconditionOk ? "충족" : "미충족"} · 관찰 ${e.observationComplete ? "완료" : "미완료"}</p>` : ""}${btn("실행 Evidence 보기", "evidence", "text", `data-index="${i}"`)}</details></article>`;
    })
    .join(
      "",
    )}<div class="coverage"><strong>검사 결과: 통과 ${report.counts.PASS} · 위반 ${report.counts.FAIL} · 실행 막힘 ${report.counts.BLOCKED}</strong><p>전체 백엔드 조건 ${backendCoverage(report).reduce((n,c)=>n+c.totalConditions,0)}개 중 ${backendCoverage(report).reduce((n,c)=>n+c.verifiedConditions,0)}개 확인</p></div><details><summary>이번 검사에서 확인하지 않은 조건</summary>${report.coverage
    .flatMap((c) => c.conditions || [])
    .filter((c) => c.reason === "SCENARIO_MISSING" && c.scope!=="frontend")
    .map((c) => `<p class="note">${"테스트 누락"} · ${esc(c.description)}</p>`)
    .join(
      "",
    )}</details><div class="result-actions">${btn("개발자에게 전달할 내용 복사", "copy-result")}${btn("결과 파일 내려받기", "download-report", "text")}</div><details><summary>승인 기준과 실행 파일</summary>${report.generatedFiles?.length?"<ul>"+report.generatedFiles.filter(f=>!f.removedAfterCompileFailure).map(f=>"<li><code>"+esc(f.relative)+"</code> · "+(f.owner==="codex"?"AI 작성":"도구 작성")+"</li>").join("")+"</ul>":""}<div class="result-actions">${btn("승인 기준", "artifact", "text", 'data-kind="snapshot"')}${btn("생성 테스트", "artifact", "text", 'data-kind="test"')}${btn("실행 로그", "artifact", "text", 'data-kind="log"')}</div></details><p class="hint">${report.runtime === "project-java" ? "외부 제공자 연동은 검사하지 않았습니다." : report.runtime === "spring-h2" ? "H2 메모리 DB에서 실제 컨트롤러와 서비스를 실행했습니다. 각 요청의 DB 변경은 롤백합니다. 외부 연결과 준비되지 않은 인증·테스트 데이터는 통과로 처리하지 않습니다." : report.runtime === "node-http" ? "승인한 요청으로 실제 테스트 서버의 응답을 검사했습니다. DB 상태·시간 경과 등 별도 근거가 필요한 정책은 미검증으로 남습니다." : "Spring Security 테스트 인증으로 검사했습니다. 실제 로그인·토큰 발급은 검사 범위에 포함되지 않습니다."}</p>`;
}
function actionBar(x, running) {
  if (running)
    return '<span><span class="spinner"></span> 검사 중 · 다른 화면을 보거나 새로고침해도 됩니다.</span>';
  if(step===2 && x.apiStatus==='RUNNING') return '<span>관련 API를 찾고 있습니다.</span>';
  if(step===2 && x.answers && x.apiStatus==='DONE' && !x.planStatus) return '<span>최대 20개 API를 선택할 수 있어요.</span><button class="btn primary" type="submit" form="api-selection-form">선택한 API로 테스트 기준 만들기</button>';
  if(x.planStatus === "RUNNING") return '<span><span class="spinner"></span> 테스트 기준 작성 중 · 새로고침해도 됩니다.</span>';
  const actions = [];
  if(step === 3 && report?.generatedTestDigest) actions.push(btn("테스트 코드 내려받기","test-download","primary"));
  if (step === 0) {
    if (x.analysisStatus === "ERROR")
      actions.push(btn("다시 분석하기", "analyze", "primary"));
    else if (x.analysisStatus !== "RUNNING")
      actions.push(btn("의도 확인하기", "intent", "primary"));
  } else if (
    step === 1 &&
    !x.answers &&
    x.analysisStatus !== "ERROR" &&
    x.analysisStatus !== "RUNNING"
  )
    actions.push(
      '<button class="btn primary" type="submit" form="intent-form">명세·검증 기준 만들기 →</button>',
    );
  else if (step === 1) actions.push(btn("테스트 기준 보기", "review", "primary"));
  else if(x.answers && (x.planStatus === "ERROR" || x.spec?.contract?.kind!=="controller-api-v1")) actions.push(btn("답변 수정하기","edit","text"));
  else if (x.spec && x.answers) {
    actions.push(btn("답변 수정", "edit", "text"));
    actions.push(
      btn(
        x.status === "READY"
          ? latest(x)
            ? "다시 검사하기"
            : "검사 시작하기"
          : "명세 승인·Notion 작성",
        x.status === "READY" ? "verify" : "approve",
        step === 3 && report?.generatedTestDigest ? "secondary" : "primary",
        x.status === "READY" && !x.spec.scenarios.length ? "disabled" : "",
      ),
    );
  }
  return `<span class="action-note">${x.status === "READY" ? "승인된 기준 v" + x.spec.version : ""}</span><div class="actions">${actions.join("")}</div>`;
}
function progressView() {
  const labels = {
    QUEUED: "검사 순서를 기다리고 있습니다",
    CODE_FETCHING: "GitHub에서 코드를 받고 있습니다",
    SNAPSHOT_FROZEN: "승인한 기준을 고정했습니다",
    BACKEND_ANALYSIS_STARTED: "백엔드 연결을 확인하고 있습니다",
    TEST_GENERATING: "AI가 테스트 코드를 작성하고 있습니다",
    TEST_REPAIRING: "기대값을 유지하며 컴파일·준비 오류를 고치고 있습니다",
    BACKEND_ANALYZED: "프로젝트의 실행 구성을 확인했습니다",
    TEST_GENERATED: "실행할 테스트를 준비했습니다",
    EXECUTION_STARTED: "실제 동작을 검사하고 있습니다",
    EVIDENCE_CLASSIFIED: "실행 근거를 정리하고 있습니다",
  };
  return `<div class="running"><span class="spinner large"></span><h2>${labels[job.stage] || "검사를 준비하고 있습니다"}</h2></div>`;
}
function historyView() {
  const runs = state.runs.filter((r) => r.projectId === projectId);
  return `<div class="page-head"><h1>검사 기록</h1></div>${runs.length ? runs.map((r) => `<button class="history-row" data-action="run" data-id="${r.id}">${badge(r.counts.FAIL ? "FAIL" : r.counts.BLOCKED ? "BLOCKED" : r.counts.UNVERIFIED || r.incomplete ? "UNVERIFIED" : "PASS")}<strong>${esc(r.featureName)}</strong><span>${r.code ? `${esc(r.code.branch)} · ${esc(r.code.commit.slice(0, 7))} · ` : ""}${new Date(r.finishedAt).toLocaleString("ko-KR")}</span></button>`).join("") : '<div class="empty"><h2>아직 검사 기록이 없습니다</h2><p>승인한 기준으로 검사를 실행하면 여기에 기록됩니다.</p></div>'}`;
}
function modelControl() {
  return `<form id="model-form"><label class="field">모델<select name="model" ${modelCatalog?.models?.length ? "" : "disabled"}><option value="">${aiLabel()} 기본값${modelCatalog?.defaultModel ? " · " + esc(modelCatalog.defaultModel) : ""}</option>${(modelCatalog?.models || []).map(m=>`<option value="${esc(m.id)}" ${state.settings.model===m.id ? "selected" : ""}>${esc(m.name)} (${esc(m.id)})</option>`).join("")}</select></label><button class="btn secondary small" type="submit" ${modelCatalog?.models?.length ? "" : "disabled"}>모델 저장</button>${modelCatalog?.error ? `<p class="hint">${esc(modelCatalog.error)}</p>` : ""}</form>`;
}
async function loadModels() {
  try { modelCatalog = await api("/api/ai/models"); }
  catch(e) { modelCatalog={models:[],error:e.message||"모델 목록을 불러오지 못했어요. 다시 시도해 주세요."}; }
}
function providerRow(p) {
  const connected = p.status === "CONNECTED";
  const keyForm = p.key ? `<form class="key-form" data-provider="${esc(p.id)}" id="key-form-${esc(p.id)}"><label class="field">API 키<input name="key" type="password" autocomplete="off" placeholder="${p.keySaved ? "저장됨" : ""}"></label><button class="btn secondary small" type="submit">키 저장</button></form>` : "";
  return `<article class="provider ${p.active && state.connections.ai ? "active" : ""}"><div class="provider-head"><strong>${esc(p.label)}</strong><span class="badge ${connected ? "PASS" : "neutral"}">${connected ? "연결됨" + (p.plan ? " · " + esc(p.plan) : "") : "연결 필요"}</span>${p.active && state.connections.ai ? '<span class="badge neutral">사용 중</span>' : btn(connected ? "이 AI 사용" : "연결 확인", "ai-use", "small", `data-provider="${esc(p.id)}"`)}</div>${p.message && !connected && !p.key ? `<p class="hint">${esc(p.message)}</p>` : ""}${p.loginCommand ? `<p class="hint">터미널에서 실행: <code>${esc(p.loginCommand)}</code></p>` : ""}${keyForm && connected ? `<details><summary>API 키 변경</summary>${keyForm}</details>` : keyForm}</article>`;
}
function connectionPanel() {
  const current = (aiProviders || []).filter((p) => p.active && state.connections.ai);
  const others = (aiProviders || []).filter((p) => !current.includes(p));
  return `${memberAiPanel()}${state.connections.shared ? "<h3>기본 AI</h3>" : ""}${current.map(providerRow).join("")}${others.length ? `<details ${current.length ? "" : "open"}><summary>${current.length ? "다른 AI로 바꾸기" : "AI 선택"}</summary>${others.map(providerRow).join("")}</details>` : ""}${current.length ? modelControl() : ""}`;
}
async function loadProviders() {
  try { aiProviders = (await api("/api/ai/providers")).providers; }
  catch (e) { aiProviders = []; toast(e.message); }
}
function memberDialog() {
  modal("내 이름", `<form id="member-form"><label class="field">이름<input name="name" value="${esc(memberName)}" maxlength="40" required autofocus></label>${state.connections.shared ? `<details><summary>다른 기기에서 이어 쓰기</summary><p class="hint">내 코드: <code>${esc(memberId)}</code></p><label class="field">다른 기기의 코드<input name="code" pattern="[a-f0-9]{32}"></label></details>` : ""}<button class="btn primary" type="submit">저장</button></form>`);
}
function operatorDialog() {
  modal("관리자", `<form id="operator-form"><label class="field">비밀번호<input name="key" type="password" autocomplete="off" required autofocus></label><button class="btn primary" type="submit">확인</button></form>`);
}
function memberAiPanel() {
  if (!state.connections.shared) return "";
  const m = memberAi;
  const body = !m ? '<p class="hint"><span class="spinner"></span></p>'
    // The one-line code notice stays: Codex itself tells people to cancel codes that a site handed them.
    : m.status === "LOGIN_WAITING" ? `<p>아래 주소에서 <strong>내 ChatGPT 계정</strong>으로 로그인하고 코드를 입력하세요.</p><p><a class="btn secondary small" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a> <code class="device-code">${esc(m.code)}</code></p><p class="hint">이 창에서 내가 직접 시작한 로그인의 코드입니다.</p>${btn("로그인 완료 확인", "member-codex-check", "primary small")}${btn("취소", "member-codex-logout", "text small")}`
    : m.status === "CLAUDE_LOGIN" ? `<p>서버 터미널에서 실행하고 <strong>내 Claude 계정</strong>으로 로그인하세요.</p><pre>${esc(m.command)}</pre>${btn("로그인 완료 확인", "member-codex-check", "primary small")}${btn("취소", "member-codex-logout", "text small")}`
    : m.status === "CONNECTED" ? `<p><span class="badge PASS">${m.provider === "claude" ? "Claude" : "ChatGPT"} 연결됨${m.plan ? " · " + esc(m.plan) : ""}</span></p>${btn("연결 해제", "member-codex-logout", "small")}`
    : `${m.message ? `<p class="hint">${esc(m.message)}</p>` : ""}${m.detail ? `<details><summary>오류 상세</summary><pre>${esc(m.detail)}</pre></details>` : ""}${btn("ChatGPT로 로그인", "member-codex-login", "primary small")}${btn("Claude 연결", "member-claude-login", "small")}<p class="hint">ChatGPT 설정 › 보안에서 기기 코드 로그인을 허용해 주세요.</p>`;
  return `<article class="provider ${m?.status === "CONNECTED" ? "active" : ""}"><div class="provider-head"><strong>내 AI</strong></div>${body}</article>`;
}
async function loadMemberAi() {
  if (!state.connections.shared) return;
  try { memberAi = await api("/api/ai/member"); } catch (e) { memberAi = { status: "NOT_CONNECTED", message: e.message }; }
}
async function pairingDialog(id) {
  const request = await api(`/api/figma/pair/${id}`);
  modal("Figma 파일 연결", `<p><strong>${esc(request.fileName)}</strong>을 연결할 프로젝트를 확인해 주세요.</p><form id="pairing-form" data-pair-id="${esc(id)}"><label class="field">프로젝트<select name="projectId">${state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? "selected" : ""}>${esc(p.name)}${p.figma?.fileName && p.figma.fileId !== request.fileId ? " · 현재 파일: " + esc(p.figma.fileName) : ""}</option>`).join("")}</select></label><button type="submit" class="btn primary">이 프로젝트로 연결</button></form>`);
}
function settingSection([id, title, status, ok, body], open) {
  return `<details class="setting" data-section="${id}" ${open.includes(id) ? "open" : ""}><summary><strong>${title}</strong><span class="badge ${ok ? "PASS" : "neutral"}">${esc(status)}</span></summary>${body}</details>`;
}
function figmaSection(p, library) {
  const works = state.features.filter((x) => x.projectId === projectId);
  return `<p>${library?.screenCount ? `${esc(p.figma?.fileName || "")} · 화면 ${library.screenCount}개 · ${esc(new Date(library.completedAt).toLocaleString("ko-KR"))}` : "Figma에서 화면을 저장하면 여기에 표시됩니다."}</p>${btn("화면 보관함", "library", "small")}<details><summary>파일로 가져오기</summary><form id="import-form"><label class="field">작업<select name="featureId"><option value="">새 작업</option>${works.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label><label class="field">파일<input type="file" name="scan" accept=".json,application/json" required></label><button class="btn secondary small" type="submit">가져오기</button></form></details>`;
}
function notionSection(p) {
  const documents = p.documents || [];
  return `<form id="project-notion-form" data-project-id="${esc(p.id)}"><label class="field">Notion API 키<input name="notionToken" type="password" autocomplete="off" placeholder="${state.connections.notion ? "저장됨" : ""}"></label><label class="field">API 명세서 링크<input name="notionPageUrl" type="url" value="${esc(p.notion?.notionPageUrl)}" placeholder="https://www.notion.so/..."></label><label class="field">기능명세서 링크<textarea name="documentUrls" rows="3" placeholder="한 줄에 하나씩, 최대 5개">${esc(documents.map((d) => d.url).join("\n"))}</textarea></label>${documents.length ? `<ul class="hint">${documents.map((d) => `<li>${esc(d.title)}${d.truncated ? " · 길어서 일부만 읽음" : ""}</li>`).join("")}</ul>` : ""}<button class="btn primary" type="submit">저장</button></form>`;
}
async function settingsDialog(section) {
  verifyAfterConnect = false;
  await Promise.all([loadModels(), loadProviders(), loadMemberAi()]);
  if (!canManage()) return modal("내 AI", memberAiPanel());
  const p = state.projects.find((p) => p.id === projectId);
  const library = state.libraries?.find((l) => l.projectId === projectId);
  const active = (aiProviders || []).find((x) => x.active && state.connections.ai && x.status === "CONNECTED");
  const documents = p.documents?.length || 0;
  const sections = [
    ["ai", "AI", active ? active.label + " 연결됨" : "연결 필요", Boolean(active), connectionPanel()],
    ["figma", "Figma", library?.screenCount ? `화면 ${library.screenCount}개` : "연결 필요", Boolean(library?.screenCount), figmaSection(p, library)],
    ["notion", "Notion", state.connections.notion ? `API 명세서 ${p.notion?.parentId ? "연결됨" : "없음"} · 기능명세서 ${documents}개` : "연결 필요", Boolean(state.connections.notion && (p.notion?.parentId || documents)), notionSection(p)],
    ["backend", "백엔드", p.backend?.repo || (p.backend?.repository ? p.backend.repository.split(/[\\/]/).pop() : "연결 필요"), Boolean(p.backend?.repository), backendForm(p)],
  ];
  const wasOpen = dialog.open && dialog.getAttribute("aria-label") === "프로젝트 설정" ? [...dialog.querySelectorAll("details.setting[open]")].map((d) => d.dataset.section) : [];
  const open = section ? [section] : wasOpen.length ? wasOpen : sections.filter((s) => !s[3]).slice(0, 1).map((s) => s[0]);
  modal("프로젝트 설정", sections.map((s) => settingSection(s, open)).join(""));
}
async function libraryDialog(featureId) {
  const library = await api(`/api/projects/${projectId}/library`);
  const current = state.features.find((f) => f.id === featureId);
  const previous = current?.scan?.library?.screens.map((s) => s.id) || [];
  const manage = canManage();
  modal("화면 보관함", `${library.syncing.length ? `<div class="notice">새 화면을 받는 중입니다.</div>` : ""}<div class="actions">${btn("새로고침", "library-refresh", "small", `data-feature-id="${esc(featureId || "")}"`)}</div>${library.screens.length ? `<form id="library-form" data-project-id="${esc(projectId)}" data-revision="${library.revision}" data-feature-id="${esc(featureId || "")}"><p>분석할 화면을 골라 주세요 (최대 6개).</p><div class="library-grid">${library.screens.map((s) => `<article class="library-card"><label><input type="checkbox" name="screenId" value="${esc(s.id)}" ${previous.includes(s.id) ? "checked" : ""}> ${esc(s.name)}</label><p class="hint">${esc(library.pages.find((p) => p.id === s.pageId)?.name)}</p>${btn("화면 보기", "library-preview", "small", `type="button" data-id="${esc(s.id)}"`)}<div class="library-preview"></div></article>`).join("")}</div><div class="actionbar">${manage ? `<button class="btn secondary" type="button" data-action="library-remove">선택한 화면 삭제</button>` : ""}<button class="btn primary" type="submit">선택한 화면으로 기획 확인하기</button></div></form>` : '<div class="note">아직 가져온 화면이 없습니다.</div>'}${manage && library.removed?.length ? `<details><summary>삭제한 화면 ${library.removed.length}개 · 복구하기</summary>${library.removed.map(s=>`<p>${esc(s.name)} ${btn("복구","library-restore","small",`data-id="${esc(s.id)}" data-project-id="${esc(projectId)}" data-revision="${library.revision}"`)}</p>`).join("")}</details>` : ""}${manage && library.deleted.length ? `<details><summary>이번 수집 범위에서 사라진 화면 ${library.deleted.length}개</summary>${library.deleted.map((s) => `<p>${esc(s.name)}</p>`).join("")}</details>` : ""}`);
}
let verifyAfterConnect = false;
function backendForm(p) {
  const github = p.backend?.source === "github" ? p.backend : null;
  if (state.connections.shared) return `<form id="github-form" data-project-id="${esc(p.id)}"><label class="field">GitHub 저장소<input name="repository" value="${github ? esc("https://github.com/" + github.repo) : ""}" placeholder="https://github.com/팀이름/저장소이름" required></label><label class="field">기본 브랜치<input name="branch" value="${esc(github?.branch)}" placeholder="dev" required></label><label class="field">컨트롤러를 찾을 폴더<input name="controllerFolder" value="${esc(p.backend?.controllerFolder || "src/main/java")}" placeholder="src/main/java"></label><button class="btn primary" type="submit">저장</button></form>${github ? `<p>GitHub 저장소의 Settings › Deploy keys에 아래 키를 추가해 주세요. 쓰기 권한은 켜지 않습니다.</p><pre>${esc(github.publicKey)}</pre>${btn("연결 확인", "github-check", "small")}` : ""}`;
  return `<form id="backend-form" data-project-id="${esc(p.id)}"><label class="field">백엔드 프로젝트 폴더<input name="repository" value="${esc(p.backend?.repository)}" placeholder="${state.connections.shared ? "/srv/figma-intent/backends/my-backend" : "C:\\Projects\\my-backend"}" required></label><label class="field">컨트롤러를 찾을 폴더<input name="controllerFolder" value="${esc(p.backend?.controllerFolder || 'src/main/java')}" placeholder="src/main/java"></label><button class="btn primary" type="submit">${verifyAfterConnect ? "연결하고 검사하기" : "저장"}</button></form>`;
}
function backendDialog() {
  const p = state.projects.find((p) => p.id === projectId);
  modal("백엔드 연결", backendForm(p));
}
async function startVerify() {
  const x = f();
  if (!state.projects.find((p) => p.id === projectId).backend) {
    if (!canManage()) { render(); toast(NEEDS_BACKEND); return; }
    verifyAfterConnect = true;
    render();
    backendDialog();
    return;
  }
  job = await api("/api/verify", { featureId: x.id, branch: selectedBranch() });
  step = 3;
  render();
}
function download(name, value, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function connectAi(provider) {
  const result = await api("/api/ai/connect", { provider });
  if (result.authUrl) {
    const u = new URL(result.authUrl);
    if (u.protocol !== "https:" || !["chatgpt.com", "auth.openai.com"].includes(u.hostname))
      throw new Error("공식 로그인 주소를 확인하지 못했습니다.");
    modal(
      "Codex 로그인",
      `<p>ChatGPT 계정으로 로그인해 주세요.</p><a class="btn primary" href="${esc(u.href)}" target="_blank" rel="noopener">ChatGPT로 로그인</a><p>로그인한 뒤 아래 버튼을 눌러 주세요.</p>${btn("로그인 상태 확인", "codex-check")}`,
    );
    return;
  }
  await refresh();
  if (result.status === "CONNECTED") {
    toast("AI를 연결했습니다.");
    render();
    if (dialog.open) await settingsDialog();
  } else {
    toast(result.message || "연결을 확인해 주세요.");
    if (dialog.open) await settingsDialog();
  }
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action;
  try {
    if (a === "close") dialog.close();
    else if (a === "home") {
      screen = "home";
      activeId = null;
      history.replaceState(null, "", appLocation());
      await refresh();
      render();
    } else if (a === "open-work") {
      await select(b.dataset.id);
    } else if (a === "resume") {
      b.disabled = true;
      await select(b.dataset.id);
      if (f().analysisStatus === "ERROR") {
        await api(`/api/features/${activeId}/analyze`, {});
        await refresh();
        step = 0;
        render();
      } else if (f().status === "READY") await startVerify();
    } else if (a === "step") {
      step = Number(b.dataset.step);
      render();if(step===1)await ensureChoices();
      window.scrollTo(0, 0);
    } else if (["source", "intent", "review"].includes(a)) {
      step = { source: 0, intent: 1, review: 2 }[a];
      render();if(step===1)await ensureChoices();
    } else if (a === "operator-login") operatorDialog();
    else if (a === "library-remove") {
      const form=document.querySelector("#library-form");
      const ids=new FormData(form).getAll("screenId");
      if(!ids.length) {toast("삭제할 화면을 선택해 주세요.");return;}
      b.disabled=true;
      await api(`/api/projects/${form.dataset.projectId}/library/remove`,{screenIds:ids,revision:Number(form.dataset.revision)});
      await refresh();await libraryDialog(form.dataset.featureId || undefined);toast(`${ids.length}개 화면을 삭제했습니다. 삭제한 화면에서 복구할 수 있어요.`);
    } else if(a === "library-restore") {
      b.disabled=true;
      await api(`/api/projects/${b.dataset.projectId}/library/restore`,{screenIds:[b.dataset.id],revision:Number(b.dataset.revision)});
      const featureId=document.querySelector("#library-form")?.dataset.featureId;
      await refresh();await libraryDialog(featureId || undefined);toast("화면을 복구했습니다.");
    }
    else if (a === "settings") await settingsDialog(b.dataset.section);
    else if (a === "library") await libraryDialog();
    else if (a === "library-refresh") await libraryDialog(b.dataset.featureId || undefined);
    else if (a === "review-source") await libraryDialog(activeId);
    else if (a === "library-preview") {
      const target = b.closest(".library-card").querySelector(".library-preview");
      if (target.innerHTML) { target.innerHTML = ""; b.textContent = "화면 보기"; }
      else {
        const asset = await api(`/api/projects/${projectId}/library/asset?id=${encodeURIComponent(b.dataset.id)}`);
        target.innerHTML = asset.image ? `<img src="${esc(asset.image.dataUrl)}" alt="${esc(asset.name)}">` : "화면 이미지가 없습니다.";
        b.textContent = "접기";
      }
    }
    else if (a === "backend") {
      verifyAfterConnect = false;
      backendDialog();
    } else if (a === "ai-use") await connectAi(b.dataset.provider);
    else if (a === "codex-check") {
      await connectAi("codex");
    } else if (a === "member-codex-login") {
      b.disabled = true;
      memberAi = await api("/api/ai/member/codex/login", {});
      await settingsDialog();
    } else if (a === "github-check") {
      const found = await api(`/api/branches?projectId=${encodeURIComponent(projectId)}`);
      branchLists[projectId] = found.branches;
      render();
      if (!found.branches.includes(found.default)) toast("저장소는 연결됐지만 기본 브랜치를 찾지 못했습니다. 브랜치 이름을 확인해 주세요.");
      else if (discoverAfterConnect) { discoverAfterConnect = false; dialog.close(); await discoverApis(forms[activeId]); }
      else if (verifyAfterConnect) { verifyAfterConnect = false; dialog.close(); await startVerify(); }
      else toast("GitHub 저장소를 연결했습니다.");
    } else if (a === "member-claude-login") {
      b.disabled = true;
      await api("/api/ai/member/claude/login", {});
      await settingsDialog();
    } else if (a === "member-codex-check") {
      b.disabled = true;
      await loadMemberAi();
      toast(memberAi.status === "CONNECTED" ? "내 AI를 연결했습니다." : ["LOGIN_WAITING", "CLAUDE_LOGIN"].includes(memberAi.status) ? "아직 로그인이 끝나지 않았어요. 로그인을 마친 뒤 다시 확인해 주세요." : memberAi.message || "연결을 확인하지 못했어요.");
      await settingsDialog();
    } else if (a === "member-codex-logout") {
      b.disabled = true;
      await api("/api/ai/member/codex/logout", {});
      await settingsDialog();
    } else if (a === "team") {
      screen = "team"; await refresh(); render();
    } else if (a === "member") memberDialog();
    else if (a === "reanalyze") {
      if (!confirm(f().status === "READY" ? "승인된 팀 기준이 해제되고 AI가 새로 해석합니다. 결과가 달라질 수 있어요. 계속할까요?" : "AI가 새로 해석합니다. 결과가 달라질 수 있어요. 계속할까요?")) return;
      b.disabled = true;
      await api(`/api/features/${activeId}/analyze`, { force: true });
      await refresh();
      step = 0;
      render();
    } else if (a === "refresh-documents") {
      if (!confirm(f().status === "READY" ? "Notion 문서를 다시 읽고 AI가 새로 해석합니다. 승인된 팀 기준이 해제되고 결과가 달라질 수 있어요. 계속할까요?" : "Notion 문서를 다시 읽고 AI가 새로 해석합니다. 계속할까요?")) return;
      b.disabled = true;
      await api(`/api/features/${activeId}/analyze`, { force: true, refreshDocuments: true });
      await refresh();
      step = 0;
      render();
    } else if (a === "analyze") {
      b.disabled = true;
      await api(`/api/features/${activeId}/analyze`, {});
      await refresh();
      step = 0;
      render();
    } else if (a === "discover") {
      await discoverApis();
    } else if (a === "choices") {
      await api(`/api/features/${activeId}/choices`,{});await refresh();render();
    } else if (a === "plan") {
      await api(`/api/features/${activeId}/draft`,{...(f().answers || answerValues(f())),planningMode:"intent"});
      await refresh(); step=2; render();
    } else if (a === "test-download") {
      const r=await client.request(`/api/runs/${report.id}/package`);
      if(!r.ok) throw new Error((await r.json()).error);
      download("backend-tests-"+report.id+".zip",await r.blob(),"application/zip");
      toast("테스트 코드와 승인 기준 ZIP을 준비했어요. 브라우저 다운로드를 확인해 주세요.");
    } else if (a === "reject-requirement") {
      await api(`/api/features/${activeId}/reject-requirement`,{version:f().spec.version,requirementId:b.dataset.id});
      await refresh();render();toast("이 해석을 제외했습니다. 원문과 제외 기록은 남습니다.");
    } else if (a === "approve") {
      b.disabled = true;
      await api(`/api/features/${activeId}/approve`, {
        version: f().spec.version,
      });
      await refresh();
      step = 2;
      render();
      toast("명세를 승인했습니다. Backend 개발을 마치면 검사해 주세요.");
    } else if (a === "verify") {
      b.disabled = true;
      await startVerify();
    } else if (a === "edit") {
      if (f().status === "READY" && !confirm("승인된 팀 기준을 수정하면 다시 승인할 때까지 팀 기준이 해제됩니다. 계속할까요?")) return;
      forms[activeId] = f().answers || answerValues(f());
      await api(`/api/features/${activeId}/reopen`, {});
      await refresh();
      step = 1;
      render();await ensureChoices();
    } else if (a === "copy-result") {
      await navigator.clipboard.writeText(handoffText(report, f()));
      toast("기획·실제 동작·실행 근거를 복사했습니다.");
    } else if (a === "evidence")
      modal(
        "실행 근거",
        `<pre>${esc(JSON.stringify(report.results[Number(b.dataset.index)].evidence, null, 2))}</pre>`,
      );
    else if (a === "artifact")
      modal(
        "실행 파일",
        `<pre>${esc(await api(`/api/runs/${report.id}/${b.dataset.kind}`, undefined, true))}</pre>`,
      );
    else if (a === "download-report")
      download("검사-" + report.id + ".json", JSON.stringify(report, null, 2));
    else if (a === "history") {
      screen = "history";
      await refresh();
      render();
    } else if (a === "run") {
      report = await api("/api/runs/" + b.dataset.id);
      activeId = report.featureId;
      screen = "detail";
      step = 3;
      render();
    } else if (a === "export")
      modal(
        "승인 명세 내보내기",
        `<div class="actions">${btn("Markdown 내려받기", "export-md")}${btn("JSON 내려받기", "export-json")}${btn("Notion에 보내기", "notion", "primary")}</div>`,
      );
    else if (a === "export-md")
      download(
        f().name + ".md",
        await api(`/api/features/${activeId}/markdown`, undefined, true),
        "text/markdown",
      );
    else if (a === "export-json")
      download(f().name + ".json", JSON.stringify(f().spec, null, 2));
    else if (a === "notion") {
      const notionTarget = state.projects.find((p) => p.id === f().projectId)?.notion?.parentId;
      if (!state.connections.notion || !notionTarget) {
        if (!canManage()) { toast("Notion이 아직 연결되지 않았습니다. 관리자에게 알려 주세요."); return; }
        projectId = f().projectId;
        await settingsDialog("notion");
        return;
      }
      b.disabled = true;
      const p = await api(`/api/features/${activeId}/notion`, {});
      await refresh();render();
      toast("Notion에 승인 명세를 만들었습니다.");
      modal(
        "명세를 보냈습니다",
        `<a href="${esc(p.url)}" target="_blank" rel="noopener">Notion에서 열기</a>`,
      );
    } else if (a === "new-project")
      modal(
        "프로젝트 추가",
        '<form id="project-form"><label class="field">프로젝트 이름<input name="name" required maxlength="80" autofocus></label><button class="btn primary" type="submit">만들기</button></form>',
      );
  } catch (e) {
    toast(e.message);
    b.disabled = false;
  }
});
function readAnswers(form) {
  const d = Object.fromEntries(new FormData(form));
  return {
    answerModes: (f().analysis?.questions||[]).map((_,i)=>d['option-'+i]==='__custom'?'custom':'option'),
    customAnswers: (f().analysis?.questions||[]).map((_,i)=>d['custom-'+i]||''),
    retainedAnswers: (f().analysis?.questions||[]).map((_,i)=>[...form.querySelectorAll(`[name="option-${i}"]`)].map(e=>e.value).filter(v=>v&&v!=='__custom')),
    extraAnswers: (f().analysis?.questions || []).map(
      (_, i) => Object.hasOwn(d,"option-"+i) ? (d["option-"+i]==="__custom" ? d["custom-"+i]||"" : d["option-"+i]) : Object.hasOwn(d,"extra-" + i) ? d["extra-" + i] : answerValues(f()).extraAnswers?.[i] || "",
    ),
  };
}
document.addEventListener("input", (event) => {
  if(event.target.closest("#api-selection-form")){forms[activeId]={...answerValues(f()),apiSelection:{catalog:f().apiCatalog.digest,ids:new FormData(document.querySelector("#api-selection-form")).getAll("endpointId")}};save();}
  if (event.target.closest("#intent-form")) {
    if(event.target.name?.startsWith('option-')){const index=event.target.name.slice(7);document.querySelector('[name="custom-'+index+'"]').hidden=event.target.value!=='__custom';}
    forms[activeId] = readAnswers(document.querySelector("#intent-form"));
    save();
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.closest("#intent-form")) {
    forms[activeId] = readAnswers(document.querySelector("#intent-form"));
    save();
  }
  if (event.target.id === "branch") localStorage.setItem("branch:" + projectId, event.target.value);
  if (event.target.id === "project") {
    projectId = event.target.value;
    activeId = null;
    screen = "home";
    history.replaceState(null, "", appLocation());
    render();
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    data = Object.fromEntries(new FormData(form)),
    button =
      document.querySelector(`[form="${form.id}"]`) ||
      form.querySelector("[type=submit]");
  if (button) { button.disabled = true; button.classList.add("waiting"); }
  try {
    if (form.id === "intent-form") {
      const answers = readAnswers(form);
      forms[activeId] = answers;
      save();
      // With code connected the real API is picked first, so the spec does not carry a guessed path.
      if (state.projects.find((p) => p.id === projectId)?.backend?.repository) { await discoverApis(answers); return; }
      await api(`/api/features/${activeId}/draft`, {...answers,planningMode:"intent"});
      await refresh();
      step = 2;
      render();
    } else if(form.id==='api-inputs-form') {
      const scenarios=f().spec.scenarios.map(s=>({id:s.id,pathValues:s.action.pathValues.map(p=>({name:p.name,value:data[s.id+'|pathValues|'+p.name]??p.value})),query:s.action.query.map(p=>({name:p.name,value:data[s.id+'|query|'+p.name]??p.value}))}));
      await api('/api/features/'+activeId+'/inputs',{version:f().spec.version,scenarios});await refresh();render();toast('검사할 요청값을 저장했어요. 기준을 확인하고 검사해 주세요.');
    } else if(form.id==='api-selection-form') {
      const selection=new FormData(form),endpointIds=selection.getAll('endpointId'),plannedApiIds=selection.getAll('plannedApiId');
      if(!endpointIds.length)throw new Error('검사할 API를 하나 이상 골라 주세요.');
      await api('/api/features/'+activeId+'/draft',{...f().answers,endpointIds,plannedApiIds});await refresh();step=2;render();
    } else if (form.id === "import-form") {
      const scan = JSON.parse(await data.scan.text());
      const r = await api("/api/scans", {
        projectId,
        featureId: data.featureId || undefined,
        scan,
      });
      dialog.close();
      await refresh();
      await select(r.feature.id, 0);
    } else if (form.id === "library-form") {
      const selected = new FormData(form).getAll("screenId");
      const result = await api(`/api/projects/${form.dataset.projectId}/library/analyze`, { screenIds: selected, revision: Number(form.dataset.revision), featureId: form.dataset.featureId || undefined });
      dialog.close();
      await refresh();
      await select(result.feature.id, result.reused ? undefined : 0);
      if (result.reused) toast("이미 팀이 읽은 화면이라 같은 해석을 열었어요. 새로 분석하지 않았습니다.");
    } else if (form.id === "pairing-form") {
      try { await api(`/api/figma/pair/${form.dataset.pairId}`, {projectId: data.projectId}); }
      catch (e) {
        if (e.code !== "FIGMA_FILE_MISMATCH" || !confirm(e.message + "\n\n이 파일로 바꿀까요? 이전 파일 연결은 끊어집니다.")) throw e;
        await api(`/api/figma/pair/${form.dataset.pairId}`, {projectId: data.projectId, switchFile: true});
      }
      projectId = data.projectId;
      activeId = null; screen = "home";
      history.replaceState(null, "", appLocation());
      await refresh(); render();
      modal("Figma 연결 완료", `<p><strong>${esc(state.projects.find((p) => p.id === projectId)?.name)}</strong>에 연결했습니다. Figma로 돌아가 필요한 설계서를 드래그로 고른 뒤 선택한 화면설계서 저장을 눌러 주세요.</p>${btn("확인", "close", "primary")}`);
    } else if (form.id === "project-notion-form") {
      if (data.notionToken) await api("/api/settings", { notionToken: data.notionToken });
      await api(`/api/projects/${form.dataset.projectId}/notion`, { notionPageUrl: data.notionPageUrl, documentUrls: data.documentUrls.split(/\s+/).filter(Boolean) });
      await refresh();
      await settingsDialog("notion");
      toast("저장했습니다.");
    } else if (form.id === "model-form") {
      await api("/api/settings", {model:data.model});
      await refresh(); toast("모델을 저장했습니다.");
    } else if (form.id === "member-form") {
      memberName = data.name.trim();
      localStorage.setItem("member-name", memberName);
      if (/^[a-f0-9]{32}$/.test(data.code || "")) memberId = data.code;
      localStorage.setItem("member-id", memberId);
      dialog.close();
      render();
    } else if (form.id === "operator-form") {
      operatorKey = data.key;
      try { await api("/api/operator/check", {}); } catch (e) { operatorKey = ""; throw e; }
      sessionStorage.setItem("operator-key", operatorKey);
      dialog.close();
      render();
      await settingsDialog();
    } else if (form.classList.contains("key-form")) {
      if (!data.key?.trim()) throw new Error("API 키를 입력해 주세요.");
      await api("/api/settings", { [form.dataset.provider + "ApiKey"]: data.key });
      await connectAi(form.dataset.provider);
    } else if (form.id === "backend-form") {
      await api("/api/connect", {
        projectId: form.dataset.projectId,
        repository: data.repository,
        controllerFolder:data.controllerFolder,
      });
      await refresh();
      if (dialog.getAttribute("aria-label") === "프로젝트 설정") await settingsDialog("backend"); else dialog.close();
      if(discoverAfterConnect){discoverAfterConnect=false;await discoverApis(forms[activeId]);}
      else if (verifyAfterConnect) {
        verifyAfterConnect = false;
        await startVerify();
      } else toast("백엔드를 연결했습니다.");
    } else if (form.id === "github-form") {
      await api("/api/connect/github", { projectId: form.dataset.projectId, repository: data.repository, branch: data.branch, controllerFolder: data.controllerFolder });
      delete branchLists[form.dataset.projectId];
      localStorage.removeItem("branch:" + form.dataset.projectId);
      await refresh();
      if (dialog.getAttribute("aria-label") === "프로젝트 설정") await settingsDialog("backend"); else backendDialog();
      toast("키를 GitHub에 추가한 뒤 연결 확인을 눌러 주세요.");
    } else if (form.id === "project-form") {
      const p = await api("/api/projects", data);
      projectId = p.id;
      activeId = null;
      screen = "home";
      await refresh();
      dialog.close();
      render();
      await settingsDialog();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (button) { button.disabled = false; button.classList.remove("waiting"); }
  }
});
window.addEventListener("hashchange", async () => {
  // A tab that never connected has nothing to update: start over with the link just pasted.
  if (!state) return boot();
  const pairingId = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (pairingId) { try { await pairingDialog(pairingId); } catch (e) { toast(e.message); } return; }
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("feature");
  await refresh();
  if (params.has("project") && state.projects.some(p=>p.id===params.get("project"))) {
    projectId=params.get("project"); activeId=null; screen="home"; render();
    if (params.get("library")==="1") await libraryDialog();
    return;
  }
  if (id && state.features.some((x) => x.id === id)) await select(id);
});
// Poll only state, without replacing a form while the user is typing.
setInterval(async () => {
  if (!state || busy) return;
  busy = true;
  try {
    const old = state,
      previousJob = job;
    await refresh();
    const oldLibrary = old.libraries?.find(l=>l.projectId===projectId);
    const newLibrary = state.libraries?.find(l=>l.projectId===projectId);
    const libraryUpdated = newLibrary?.revision && newLibrary.revision !== oldLibrary?.revision;
    if (libraryUpdated) {
      toast(`화면 ${newLibrary.screenCount}개를 받았습니다.`);
      if (dialog.open && dialog.getAttribute("aria-label") === "화면 보관함") await libraryDialog();
    }
    if (screen === "home" && JSON.stringify(oldLibrary) !== JSON.stringify(newLibrary)) render();
    const x = f();
    const changedSource = x && (old.features.find((a) => a.id === x.id)?.sourceReviewRequired !== x.sourceReviewRequired || JSON.stringify(old.features.find((a) => a.id === x.id)?.documentReviewRequired) !== JSON.stringify(x.documentReviewRequired));
    const changedAnalysis =
      x &&
      old.features.find((a) => a.id === x.id)?.analysisStatus !==
        x.analysisStatus;
    const newRun =
      x && latest(x)?.id !== old.runs.find((r) => r.featureId === x.id)?.id;
    if (newRun) {
      report = await api("/api/runs/" + latest(x).id);
      step = 3;
      render();
    } else if (changedSource) {
      render();
    } else if(x && ['apiStatus','choicesStatus'].some(k=>old.features.find(a=>a.id===x.id)?.[k]!==x[k])) {
      if(x.apiStatus==='DONE'&&!x.planStatus)step=2;render();
    } else if(x && old.features.find(a=>a.id===x.id)?.planStatus !== x.planStatus) {
      step=2; render();
    } else if (changedAnalysis) {
      if (x.analysisStatus === "DONE") {
        step = 1;
        delete forms[x.id];
      }
      render();
    } else if (previousJob && previousJob.id !== job?.id) {
      const ended = state.jobs.find((j) => j.id === previousJob.id);
      if (ended?.status === "ERROR") toast(ended.error);
      render();
    } else if (
      job &&
      screen === "detail" &&
      step === 3 &&
      f()?.id === job.featureId
    )
      render();
    else if (screen === "detail" && JSON.stringify(f()?.notionPublication)!==JSON.stringify(old.features.find(y=>y.id===activeId)?.notionPublication)) render();
    else if (screen === "home" && state.features.length !== old.features.length)
      render();
  } catch {
  } finally {
    busy = false;
  }
}, 1500);
async function boot() { try {
  await client.connect();
  await refresh();
  if (activeId && f()) {
    projectId = f().projectId;
    screen = "detail";
    if (latest(f())) report = await api("/api/runs/" + latest(f()).id);
    step = currentStep(f(), latest(f()), job);
  } else {
    activeId = null;
    screen = "home";
  }
  render();
  if (state.connections.shared && !memberName) memberDialog();
  if(step===1)await ensureChoices();
  const pairingId = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (pairingId) await pairingDialog(pairingId);
  else if (new URLSearchParams(location.hash.slice(1)).get("library")==="1") await libraryDialog();
} catch (e) {
  app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
} }
await boot();
