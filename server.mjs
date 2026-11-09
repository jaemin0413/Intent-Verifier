import {proposeIntentApis} from './lib/intent-api-plan.mjs';
import {withSnapshotExpected,h2Result} from './lib/h2-result.mjs';
import {AiRouter,AI_PROVIDERS} from './lib/ai-runtime.mjs';
import {incompleteBackend} from './web/verification-scope.mjs';
import {NotionPublisher,NOTION_LAYOUT} from './lib/notion-publisher.mjs';
import http from "node:http";
import { ScreenLibrary } from "./lib/screen-library.mjs";
import { PluginPairing } from "./lib/plugin-pairing.mjs";
import { notionDestination } from "./lib/notion-destination.mjs";
import { publicationKey } from "./lib/notion-template.mjs";
import { classifyCodexError, redactDiagnostic } from "./lib/codex.mjs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { root } from "./scripts/setup.mjs";
import {
  Store,
  buildIntent,
  replaceDraft,
  approveFeature,
  rejectRequirement,
  reopenFeature,
  publicFeature,
} from "./lib/store.mjs";
import {
  analyzeScan,
  specMarkdown,
  publishNotion,
} from "./lib/integrations.mjs";
import { ensure, isApproved, digest, planInputDigest } from "./lib/domain.mjs";
import { readJson } from "./lib/json-files.mjs";
import {testPackage} from "./lib/test-package.mjs";
import {discoverControllers} from "./lib/controller-catalog.mjs";
import {recommendApis,proposeApiTests} from "./lib/api-plan.mjs";
import {suggestChoices} from "./lib/intent-options.mjs";
import {verifyNativeJava} from "./lib/native-java-runner.mjs";
import { accessKey, keyMatches, publicOrigin } from './lib/deployment.mjs';
import { WorkGate } from './lib/work-gate.mjs';
import { BackendCheckouts, parseGithubRepository, validBranch } from './lib/backend-checkout.mjs';
import { readDocuments, readNotionDocument, attachDocuments } from './lib/notion-documents.mjs';

// What the AI reads, without ids or times, so the same screens are recognised as the same source.
// A document counts by id, not text: an edited spec raises a review notice, never a second reading.
export const sourceDigest = (scan) => {
  const documents = (scan.documents || []).map((d) => d.id).sort();
  return digest({ nodes: scan.nodes.filter((n) => n.type !== "DOCUMENT"), images: (scan.images || []).map((i) => [i.nodeId, i.dataUrl]), ...(documents.length ? { documents } : {}) });
};

export async function createServer({
  directory,
  port = 4318,
  runtime,
  notionFetch = fetch,
  publicUrl = process.env.PUBLIC_ORIGIN,
  linkKey = process.env.APP_LINK_KEY,
  backendRoots = process.env.BACKEND_ROOTS,
  adminKey = process.env.ADMIN_KEY,
  documentCheckMs = 15 * 60000,
  runDirectory,
  checkouts,
} = {}) {
  const store = new Store(directory || process.env.APP_DATA_DIR);
  checkouts ??= new BackendCheckouts({ directory: store.directory });
  const remoteOrigin = publicOrigin(publicUrl);
  const remoteKey = remoteOrigin ? await accessKey(store.directory, linkKey) : null;
  const runRoot = runDirectory || (process.env.APP_DATA_DIR && !directory ? path.join(store.directory, 'runs') : path.join(root, '.verification/runs'));
  const library = new ScreenLibrary(store.directory);
  // Each member's own AI login lives in its own folder under the data directory.
  const memberHome = (id) => path.join(store.directory, "members", id, "codex");
  const memberClaudeHome = (id) => path.join(store.directory, "members", id, "claude");
  const workGate = new WorkGate();
  runtime ??= new AiRouter({ shared: Boolean(remoteOrigin), secrets: () => store.secrets(), memberHome, memberClaudeHome, gate: workGate });
  runtime.logDirectory = path.join(store.directory,"analysis-logs");
  const pairing = new PluginPairing(store);
  await store.init();
  await store.mutate(async (s) => {
    if (s.settings.aiProvider && AI_PROVIDERS[s.settings.aiProvider]) runtime.select?.(s.settings.aiProvider);
    if (s.activeVerification) {
      const f = s.features.find((f) => f.id === s.activeVerification.featureId);
      if (f) f.verificationInterrupted = s.activeVerification;
      delete s.activeVerification;
    }
    for(const f of s.features) if(f.notionPublication?.status === "RUNNING") f.notionPublication={...f.notionPublication,status:"ERROR",message:"명세 전송 중 서버가 재시작됐어요. 노션 저장 위치를 확인하고 다시 보내 주세요."};
    for(const f of s.features) for(const field of ["apiStatus","choicesStatus"]) if(f[field]==="RUNNING") f[field]="ERROR";
    for (const f of s.features) if(f.planStatus === "RUNNING") {
      f.planStatus="ERROR"; f.planError={message:"서버가 다시 시작되어 테스트 기준 작성이 중단됐어요. 다시 작성해 주세요."};
    }
    for (const f of s.features)
      if (f.analysisStatus === "RUNNING") {
        f.analysisStatus = "ERROR";
        f.analysisError = {
          code: "ANALYSIS_FAILED",
          message:
            "서버가 다시 시작되어 분석이 중단됐어요. 다시 분석해 주세요.",
        };
      }
    for (const run of s.runs) {
      if (run.incomplete !== undefined) continue;
      try {
        const evidence = await readJson(
          path.join(runRoot, run.id, "report.json"),
        );
        run.incomplete = incompleteBackend(evidence);
      } catch {
        run.incomplete = true;
      }
    }
    // The old built-in example ran on a Maven sample; this tool now supports Gradle only.
    s.features = s.features.filter((f) => !f.demo);
  });
  const token = randomBytes(32).toString("hex"),
    jobs = new Map(),
    defaultRuntime = runtime,
    publisher = new NotionPublisher(store, notionFetch, {runtime, checkouts});
  // A build needs the target's src/test and build folders to itself, so runs take turns.
  let verifications = Promise.resolve();
  const origin = remoteOrigin || `http://127.0.0.1:${port}`;
  // Anything that runs a build on this server must stay under the folders the operator allowed.
  async function ensureBackendAllowed(repository) {
    if (!remoteOrigin) return;
    const roots = (backendRoots || "").split(path.delimiter).filter(Boolean);
    ensure(roots.length, "서버 설정 BACKEND_ROOTS에 검사를 허용할 폴더를 지정해 주세요.");
    const real = await realpath(repository);
    const allowed = await Promise.all(roots.map((r) => realpath(r).then((p) => real === p || real.startsWith(p + path.sep)).catch(() => false)));
    ensure(allowed.some(Boolean), "이 폴더는 서버에서 검사를 허용한 위치(BACKEND_ROOTS)가 아닙니다.");
  }
  const member = (req) => {
    try { return decodeURIComponent(String(req.headers["x-member"] || "")).trim().slice(0, 40) || null; } catch { return null; }
  };
  // A random code the browser keeps; it groups a member's own AI login, it does not prove identity.
  const memberId = (req) => (/^[a-f0-9]{32}$/.test(String(req.headers["x-member-id"] || "")) ? req.headers["x-member-id"] : null);
  const runtimeFor = async (req) => (runtime.forMember ? await runtime.forMember(memberId(req)) : runtime);
  // Team-wide secrets and the team AI change only with the operator password on a shared server.
  const operatorOnly = (req) => {
    if (!remoteOrigin) return;
    ensure(adminKey, "서버 설정 ADMIN_KEY에 운영자 비밀번호를 지정해 주세요.");
    const given = String(req.headers["x-operator-key"] || "");
    if (!(given.length === adminKey.length && timingSafeEqual(Buffer.from(given), Buffer.from(adminKey))))
      throw Object.assign(new Error("운영자 비밀번호가 필요합니다."), { status: 403, code: "OPERATOR_KEY_REQUIRED" });
  };
  function json(res, status, data) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    let bytes = 0,
      chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      ensure(bytes < 22000000, "요청이 너무 큽니다.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  async function trustedReport(id) {
    ensure(/^[0-9]+-(?:native-)?[a-f0-9]{8}$/.test(id), "잘못된 실행 ID");
    const report=await readJson(path.join(runRoot, id, "report.json"));
    const snapshot=await readJson(path.join(runRoot,id,"snapshot.json")).catch(()=>null);
    const restored=withSnapshotExpected(report,snapshot);
    // Restore diagnostics lost by older catch{} logic, without rewriting historical verdicts.
    if(report.runtime==='spring-h2'&&snapshot?.specDigest===report.specDigest)for(const result of restored.results){
      if(result.status!=='BLOCKED'||result.evidence||!/^[-\w]+$/.test(result.scenarioId))continue;
      const scenario=snapshot.spec.scenarios.find(s=>s.id===result.scenarioId);if(!scenario)continue;
      const evidence=await readJson(path.join(runRoot,id,'evidence',result.scenarioId+'.json')).catch(()=>null);
      if(evidence){const detail=h2Result(scenario,evidence,report);if(detail.status==='BLOCKED')Object.assign(result,detail,{diagnosticsRestored:true});}
    }
    return restored;
  }
  async function addRun(report, projectId) {
    await store.mutate((s) => {
      if (!s.runs.some((r) => r.id === report.id))
        s.runs.unshift({
          id: report.id,
          projectId,
          featureId: report.featureId,
          featureName: report.featureName,
          specDigest: report.specDigest,
          counts: report.counts,
          incomplete: incompleteBackend(report),
          finishedAt: report.finishedAt,
          backend: report.backend,
          ...(report.codeVersion ? { code: report.codeVersion } : {}),
        });
    });
  }
  const analyzing = new Set();
  function beginAnalysis(id, by = null, runtime = defaultRuntime) {
    if (analyzing.has(id)) return;
    analyzing.add(id);
    (async () => {
      let scanId, model;
      try {
        const scan = await store.mutate((s) => {
          const f = s.features.find((f) => f.id === id);
          ensure(f, "기능이 없습니다.");
          if (f.spec) {
            f.history.push(structuredClone(f.spec));
            delete f.spec.approval;
          }
          model = s.settings.model || undefined;
          f.analysisModel = model || null;
          f.analysisBy = by;
          f.answers = null;
          for(const field of ["apiStatus","apiStatusRequest","apiCatalog","apiCandidates","apiMissing","choicesStatus","choicesStatusRequest","questionChoices"])delete f[field];
          delete f.planRequestId; delete f.planStatus; delete f.planError;
          f.status = "DRAFT";
          f.analysisStatus = "RUNNING";
          delete f.analysisError;
          return structuredClone(f.scan);
        });
        scanId = scan.id;
        const analysis = await analyzeScan(scan, { runtime, model });
        await store.mutate((s) => {
          const f = s.features.find((f) => f.id === id);
          if (f.scan.id !== scanId) return;
          f.analysis = analysis;
          f.name = analysis.featureName;
          f.analysisStatus = "DONE";
        });
      } catch (e) {
        const error = classifyCodexError(e);
        await store.mutate((s) => {
          const f = s.features.find((f) => f.id === id);
          if (!f || (scanId && f.scan.id !== scanId)) return;
          f.analysisStatus = "ERROR";
          f.analysisError = { code: error.code, message: error.message, diagnosticId:error.diagnosticId };
        });
      } finally {
        analyzing.delete(id);
      }
    })();
  }
  // Notion functional-spec pages join the scan as text nodes; the AI then reads screens and spec together.
  const linkedDocumentUrls = (state, projectId, data) => data.documentUrls ?? state.projects.find((p) => p.id === projectId)?.documents?.map((d) => d.url) ?? [];
  async function withDocuments(scan, urls) {
    const { notionToken } = await store.secrets();
    return attachDocuments(scan, await readDocuments(urls, { token: notionToken, fetchImpl: notionFetch }));
  }
  // Specs change after approval too: a changed page marks the feature for review, never silently re-reads.
  async function checkDocuments() {
    const { notionToken } = await store.secrets();
    if (!notionToken) return [];
    const changed = [], read = new Map();
    for (const f of (await store.load()).features) for (const d of f.scan?.documents || []) {
      try {
        // Many features share one spec, and reading its database rows takes many requests.
        if (!read.has(d.id)) read.set(d.id, readNotionDocument(d.id, { token: notionToken, fetchImpl: notionFetch }));
        const fresh = await read.get(d.id);
        if (fresh.digest === d.digest) continue;
        changed.push({ featureId: f.id, documentId: d.id });
        await store.mutate((s) => { const x = s.features.find((x) => x.id === f.id); if (x?.scan?.documents?.some((y) => y.id === d.id && y.digest === d.digest)) x.documentReviewRequired = { id: d.id, title: fresh.title, checkedAt: new Date().toISOString() }; });
      } catch {}
    }
    return changed;
  }
  const documentTimer = documentCheckMs ? setInterval(() => checkDocuments().catch(() => {}), documentCheckMs) : null;
  documentTimer?.unref();
  // Same screens in one project keep one team reading unless someone explicitly asks for another.
  function sameInterpretation(state, projectId, scan, data) {
    if (data.force) return null;
    const wanted = sourceDigest(scan);
    const reusable = (f) => f && !f.demo && f.projectId === projectId && f.scan && f.analysisStatus !== "ERROR" && f.analysis?.mode === "codex" && sourceDigest(f.scan) === wanted;
    if (data.featureId) { const f = state.features.find((f) => f.id === data.featureId); return reusable(f) ? f : null; }
    return state.features.find(reusable) || null;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin),
        route = url.pathname;
      ensure(remoteOrigin ? req.headers.host === new URL(remoteOrigin).host :
        ["127.0.0.1", "localhost"].includes((req.headers.host || "").split(":")[0]),
        "허용되지 않은 Host");
      const plugin = route.startsWith("/api/plugin/");
      if (plugin) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-App-Key",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      } else if (req.headers.origin)
        ensure(
          (remoteOrigin ? [origin] : [origin, `http://localhost:${port}`]).includes(req.headers.origin),
          "다른 사이트에서 요청할 수 없습니다.",
        );
      if (route === "/api/session" && req.method === "GET") {
        res.setHeader('Cache-Control','no-store');
        if (remoteOrigin && !keyMatches(req.headers['x-app-key'], remoteKey))
          return json(res, 403, {code:'LINK_REQUIRED',error:'접속 링크를 확인해 주세요.'});
        return json(res, 200, { token });
      }
      if (route === "/api/plugin/pair/start" && req.method === "POST") {
        if (remoteOrigin && !keyMatches(req.headers['x-app-key'], remoteKey)) return json(res,403,{code:'LINK_REQUIRED',error:'접속 링크를 확인해 주세요.'});
        return json(res, 201, pairing.start(await body(req)));
      }
      if (route === "/api/plugin/pair/claim" && req.method === "POST") {
        if (remoteOrigin && !keyMatches(req.headers['x-app-key'], remoteKey)) return json(res,403,{code:'LINK_REQUIRED',error:'접속 링크를 확인해 주세요.'});
        return json(res, 200, pairing.claim(await body(req)));
      }
      if (route.startsWith("/api/")) {
        const state = await store.load();
        const connection = state.pluginConnections?.find((c) => req.headers.authorization === `Bearer ${c.token}`);
        if (plugin) ensure(connection, "앱에서 Figma 연결을 다시 확인해 주세요.");
        else if(req.headers['x-local-token']!==token)
          return json(res,401,{code:'LOCAL_SESSION_EXPIRED',error:'앱 연결이 갱신됐어요. 다시 눌러 주세요. AI 로그인은 그대로 유지됩니다.'});
        const pairingRoute = route.match(/^\/api\/figma\/pair\/([a-f0-9]{48})$/);
        if (pairingRoute && req.method === "GET") return json(res, 200, pairing.describe(pairingRoute[1]));
        if (pairingRoute && req.method === "POST") {
          const data = await body(req);
          const item = pairing.describe(pairingRoute[1]);
          const previous = await library.listing(data.projectId);
          if (previous.fileId && previous.fileId !== item.fileId && !data.switchFile)
            throw Object.assign(new Error(`보관함에 다른 Figma 파일 ‘${previous.fileName}’의 화면이 있습니다. 이 파일로 바꾸면 기존 해석과 승인 기록은 남고, 화면 목록은 새 파일에서 다시 동기화합니다.`), { code: "FIGMA_FILE_MISMATCH" });
          const approved = await pairing.approve(pairingRoute[1], data.projectId, { switchFile: Boolean(data.switchFile) });
          if (data.switchFile) await library.setFileId(data.projectId, item.fileId, item.fileName);
          return json(res, 200, approved);
        }
        if (route === "/api/state" && req.method === "GET") {
          const secrets = await store.secrets();
          const stateBody = JSON.stringify({
            projects: state.projects,
            libraries: await Promise.all(state.projects.map(async (p) => {
              const l=await library.listing(p.id);
              return {projectId:p.id,revision:l.revision,screenCount:l.screens.length,completedAt:l.completedAt,syncing:l.syncing};
            })),
            features: await Promise.all(state.features.map(async (f) => ({ ...publicFeature(f), sourceReviewRequired: await library.changed(f.projectId, f.scan?.library) }))),
            runs: state.runs,
            settings: { model:state.settings.model || "", aiProvider: state.settings.aiProvider, notionTemplate: state.settings.notionTemplate },
            connections: {
              ai: Boolean(state.settings.aiProvider),
              notion: Boolean(secrets.notionToken),
              shared: Boolean(remoteOrigin),
              operator: Boolean(remoteOrigin),
            },
            jobs: [...jobs.values()],
          });
          // Tabs poll every 1.5s; an unchanged state costs only a 304.
          const etag = '"' + createHash("sha256").update(stateBody).digest("base64url") + '"';
          if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" }); return res.end(); }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": "no-cache" });
          return res.end(stateBody);
        }
        const librarySync = route.match(/^\/api\/plugin\/library\/(begin|screen|complete)$/);
        if (librarySync && req.method === "POST") {
          const data = await body(req);
          ensure(!connection || connection.projectId === data.projectId, "연결된 프로젝트에만 동기화할 수 있습니다.");
          if (connection && librarySync[1] === "begin") ensure(connection.fileId === data.fileId, "연결된 Figma 파일이 아닙니다.");
          ensure(state.projects.some((p) => p.id === data.projectId), "프로젝트가 없습니다.");
          if (librarySync[1] === "begin") return json(res, 201, await library.begin(data.projectId, data));
          if (librarySync[1] === "screen") return json(res, 200, await library.put(data.projectId, data.sessionId, data.screen));
          return json(res, 200, await library.complete(data.projectId, data.sessionId, data.captureFinishedAt));
        }
        const libraryRoute = route.match(/^\/api\/projects\/([\w-]+)\/library(?:\/(asset|analyze|remove|restore))?$/);
        if (libraryRoute) {
          const projectId = libraryRoute[1];
          ensure(state.projects.some((p) => p.id === projectId), "프로젝트가 없습니다.");
          if (req.method === "GET" && !libraryRoute[2]) return json(res, 200, await library.listing(projectId));
          if (req.method === "GET" && libraryRoute[2] === "asset") return json(res, 200, await library.asset(projectId, url.searchParams.get("id")));
          if(req.method==="POST" && ["remove","restore"].includes(libraryRoute[2])) {
            const data=await body(req);
            return json(res,200,await library.setRemoved(projectId,data.screenIds,data.revision,libraryRoute[2]==="remove"));
          }
          if (req.method === "POST" && libraryRoute[2] === "analyze") {
            const data = await body(req);
            ensure(!data.featureId || !analyzing.has(data.featureId), "진행 중인 분석을 기다려 주세요.");
            const scan = await library.scan(projectId, data.screenIds, data.revision);
            const documentUrls = linkedDocumentUrls(state, projectId, data);
            if (documentUrls.length) await withDocuments(scan, documentUrls);
            const same = sameInterpretation(state, projectId, scan, data);
            if (same) return json(res, 200, { feature: same, reused: true });
            const analysis = await analyzeScan(scan, { localOnly: true });
            const feature = await store.mutate((s) => {
              let feature;
              if (data.featureId) {
                feature = s.features.find((f) => f.id === data.featureId && f.projectId === projectId && !f.demo);
                ensure(feature, "기존 작업을 찾을 수 없습니다.");
                if (feature.spec) feature.history.push(structuredClone(feature.spec));
                if (feature.spec) delete feature.spec.approval;
              } else {
                feature = { id: crypto.randomUUID(), projectId, history: [] };
                s.features.push(feature);
              }
              Object.assign(feature, { name: analysis.featureName, scan, analysis, answers: null, status: "DRAFT" });
              return feature;
            });
            beginAnalysis(feature.id, member(req), await runtimeFor(req));
            return json(res, 201, { feature });
          }
        }
        if (route === "/api/plugin/projects" && req.method === "GET")
          return json(res, 200, {
            projects: state.projects.filter((p) => !connection || p.id === connection.projectId).map((p) => ({id:p.id, name:p.name})),
            features: state.features.filter((f) => !f.demo && (!connection || f.projectId === connection.projectId)).map((f) => ({
              id: f.id,
              name: f.name,
              projectId: f.projectId,
            })),
          });
        if (route === "/api/ai/models" && req.method === "GET") return json(res,200,await runtime.models());
        if (route === "/api/ai/status" && req.method === "GET")
          return json(res, 200, await runtime.status());
        if (route === "/api/ai/providers" && req.method === "GET") {
          const secrets = await store.secrets();
          return json(res, 200, { providers: (await (runtime.describe?.() ?? [])).map((p) => ({ ...p, keySaved: Boolean(p.key && secrets[p.key]) })) });
        }
        if (route === "/api/ai/member" && req.method === "GET")
          return json(res, 200, runtime.memberStatus ? await runtime.memberStatus(memberId(req)) : { status: "NOT_SUPPORTED" });
        if (route === "/api/ai/member/codex/login" && req.method === "POST") {
          ensure(runtime.startMemberLogin, "이 서버는 팀원 개인 AI 연결을 지원하지 않습니다.");
          return json(res, 200, await runtime.startMemberLogin(memberId(req)));
        }
        if (route === "/api/ai/member/claude/login" && req.method === "POST") {
          ensure(runtime.startMemberClaudeLogin, "이 서버는 팀원 개인 AI 연결을 지원하지 않습니다.");
          return json(res, 200, await runtime.startMemberClaudeLogin(memberId(req)));
        }
        if (route === "/api/ai/member/codex/logout" && req.method === "POST") {
          ensure(memberId(req) && runtime.disconnectMember, "연결을 해제할 개인 코드가 없습니다.");
          await runtime.disconnectMember(memberId(req));
          return json(res, 200, { status: "NOT_CONNECTED" });
        }
        if (route === "/api/ai/connect" && req.method === "POST") {
          const { provider } = await body(req);
          ensure(!provider || AI_PROVIDERS[provider], "지원하지 않는 AI입니다.");
          if (provider) operatorOnly(req);
          if (provider) ensure(![...jobs.values()].some((j) => j.status === "RUNNING"), "검사가 끝난 뒤 AI를 바꿔 주세요.");
          const connection = await runtime.connect(provider);
          if (connection.status === "CONNECTED") {
            if (provider) runtime.select?.(provider);
            await store.mutate((s) => {
              if (provider && s.settings.aiProvider !== provider) s.settings.model = "";
              s.settings.aiProvider = provider || s.settings.aiProvider || "codex";
            });
          }
          return json(res, 200, connection);
        }
        const projectNotion = route.match(/^\/api\/projects\/([\w-]+)\/notion$/);
        if (projectNotion && req.method === "POST") {
          operatorOnly(req);
          const data = await body(req);
          ensure(data.documentUrls === undefined || Array.isArray(data.documentUrls), "기능명세서 링크를 확인해 주세요.");
          const destination = notionDestination(data.notionPageUrl);
          // Read before saving: a bad link or missing access shows here, not in a teammate's analysis.
          const { notionToken } = await store.secrets();
          const documents = data.documentUrls && (await readDocuments(data.documentUrls, { token: notionToken, fetchImpl: notionFetch })).map(({ node, ...meta }) => meta);
          const project = await store.mutate((s) => {
            const p = s.projects.find((p) => p.id === projectNotion[1]);
            ensure(p, "프로젝트가 없습니다.");
            p.notion = destination;
            if (documents) p.documents = documents;
            return p;
          });
          return json(res, 200, project);
        }
        if (route === "/api/operator/check" && req.method === "POST") {
          operatorOnly(req);
          return json(res, 200, { ok: true });
        }
        if (route === "/api/projects" && req.method === "POST") {
          const data = await body(req);
          ensure(data.name?.trim(), "프로젝트 이름이 필요합니다.");
          const project = {
            id: crypto.randomUUID(),
            name: data.name.trim().slice(0, 80),
          };
          await store.mutate((s) => s.projects.push(project));
          return json(res, 201, project);
        }
        if (
          ["/api/scans", "/api/plugin/scans"].includes(route) &&
          req.method === "POST"
        ) {
          const data = await body(req);
          ensure(!connection || connection.projectId === data.projectId, "연결된 프로젝트에만 전송할 수 있습니다.");
          ensure(
            state.projects.some((p) => p.id === data.projectId),
            "프로젝트를 선택해 주세요.",
          );
          ensure(
            !data.featureId || !analyzing.has(data.featureId),
            "진행 중인 분석이 끝난 뒤 화면을 업데이트해 주세요.",
          );
          const scan = {
            ...data.scan,
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          };
          const documentUrls = linkedDocumentUrls(state, data.projectId, data);
          if (documentUrls.length) await withDocuments(scan, documentUrls);
          // Preserve source immediately. Failure never becomes successful rule-based AI.
          const same = sameInterpretation(state, data.projectId, scan, data);
          if (same) return json(res, 200, { feature: same, reused: true, url: origin + "/#feature=" + same.id });
          const analysis = await analyzeScan(scan, { localOnly: true });
          let result;
          await store.mutate((s) => {
            if (data.featureId) {
              result = s.features.find(
                (f) =>
                  f.id === data.featureId && f.projectId === data.projectId,
              );
              ensure(
                result && !result.demo,
                "기존 사용자 기능을 찾을 수 없습니다. 예제는 새 기능으로 가져와 주세요.",
              );
              if (result.spec) {
                result.history.push(structuredClone(result.spec));
                result.spec = { ...result.spec, approval: undefined };
              }
              result.status = "DRAFT";
              result.scan = scan;
              result.analysis = analysis;
              result.answers = null;
            } else {
              result = {
                id: crypto.randomUUID(),
                projectId: data.projectId,
                name: analysis.featureName,
                status: "DRAFT",
                scan,
                analysis,
                history: [],
              };
              s.features.push(result);
            }
          });
          if (!data.localOnly) beginAnalysis(result.id, member(req), await runtimeFor(req));
          return json(res, 201, {
            feature: result,
            url: origin + "/#feature=" + result.id,
          });
        }
        const featureRoute = route.match(
          /^\/api\/features\/([\w-]+)\/(draft|approve|reject-requirement|reopen|spec|source|markdown|notion|analyze|apis|choices|inputs)$/,
        );
        if (featureRoute) {
          const [, id, action] = featureRoute;
          const feature = state.features.find((f) => f.id === id);
          ensure(feature, "기능을 찾을 수 없습니다.");
          if(action==='reject-requirement' && req.method==='POST') {
            const data=await body(req);
            return json(res,200,await store.mutate(s=>rejectRequirement(s.features.find(f=>f.id===id),data.requirementId,data.version)));
          }
          if(action==="inputs" && req.method==="POST") {
            const data=await body(req);
            ensure(feature.planStatus==="DONE"&&feature.spec?.contract.kind==="controller-api-v1"&&feature.spec.version===data.version,"최신 API 검사 기준에서 요청값을 수정해 주세요.");
            const spec=structuredClone(feature.spec);
            for(const input of data.scenarios || []) {
              const scenario=spec.scenarios.find(s=>s.id===input.id);ensure(scenario,"알 수 없는 검사 항목입니다.");
              for(const key of ["pathValues","query"]) for(const pair of input[key]||[]) {
                const target=scenario.action[key].find(p=>p.name===pair.name);ensure(target && typeof pair.value==="string"&&pair.value.length<=2000,"요청값을 확인해 주세요.");target.value=pair.value;
              }
            }
            const result=await store.mutate(s=>replaceDraft(s.features.find(f=>f.id===id),spec));
            return json(res,200,result);
          }
          if(["apis","choices"].includes(action) && req.method==="POST") {
            const data=await body(req),field=action==="apis"?"apiStatus":"choicesStatus";
            ensure(feature[field]!=="RUNNING","현재 분석 중입니다.");
            const project=state.projects.find(p=>p.id===feature.projectId);
            if(action==="apis")ensure(project?.backend?.repository,"프로젝트 설정에서 백엔드 폴더를 먼저 연결해 주세요.");
            const branch=action==="apis"&&data.branch?validBranch(data.branch):project?.backend?.branch;
            const source=digest({scan:feature.scan,analysis:feature.analysis}),requestId=crypto.randomUUID(),runtime=await runtimeFor(req);
            await store.mutate(s=>{const f=s.features.find(f=>f.id===id);f[field]="RUNNING";f[field+"Request"]=requestId;delete f[field+"Error"];if(action==="apis"){if(branch)f.backendBranch=branch;if(data.answers)f.answers=data.answers;delete f.planStatus;delete f.planRequestId;if(f.spec?.approval){f.history.push(structuredClone(f.spec));delete f.spec.approval;}f.status="DRAFT";}});
            (async()=>{
              const catalog=action==="apis"?await checkouts.withCode(project,branch,code=>discoverControllers(code,project.backend.controllerFolder)):null;
              if(catalog)ensure(catalog.endpoints.length,"지정한 폴더에서 Spring 컨트롤러 API를 찾지 못했어요. 폴더 범위를 확인해 주세요.");
              const output=catalog?await recommendApis(feature,catalog,{runtime,model:state.settings.model}):await suggestChoices(feature,{runtime,model:state.settings.model});
              await store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f[field+"Request"]!==requestId)return;ensure(digest({scan:f.scan,analysis:f.analysis})===source,"분석 중 원문이 변경되었습니다. 다시 시도해 주세요.");if(catalog){ensure(digest(s.projects.find(p=>p.id===f.projectId).backend)===digest(project.backend),"백엔드 설정이 바뀌었습니다. API를 다시 찾아 주세요.");f.apiCatalog=catalog;f.apiCandidates=output.candidates;f.apiMissing=output.missing;f.apiExecution=output.execution;}else f.questionChoices=output;f[field]="DONE";});
            })().catch(async e=>{await store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f[field+"Request"]===requestId){f[field]="ERROR";f[field+"Error"]=classifyCodexError(e).message;f[field+"ErrorDetail"]=redactDiagnostic(e.message);}});});
            return json(res,202,{started:true});
          }
          if (action === "source" && req.method === "GET")
            return json(res, 200, { scan: feature.scan, history: feature.history || [], apiCatalog: feature.apiCatalog, apiCandidates: feature.apiCandidates, apiMissing: feature.apiMissing, planExecution: feature.planExecution });
          if (action === "analyze" && req.method === "POST") {
            const data = await body(req);
            ensure(
              !feature.demo && feature.analysisStatus !== "RUNNING",
              "이미 분석 중입니다.",
            );
            // A new AI reading can differ, so nobody loses the team's approved one by accident.
            ensure(data.force || feature.analysisStatus === "ERROR" || !isApproved(feature.spec), "승인된 팀 기준이 있어 다시 해석하려면 확인이 필요합니다.");
            const urls = data.documentUrls ?? (data.refreshDocuments ? feature.scan.documents?.map((d) => d.url) || [] : null);
            if (urls) {
              const scan = await withDocuments(structuredClone(feature.scan), urls);
              await store.mutate((s) => { const f = s.features.find((f) => f.id === id); f.scan = scan; delete f.documentReviewRequired; });
            }
            beginAnalysis(id, member(req), await runtimeFor(req));
            return json(res, 202, { started: true });
          }
          if (action === "reopen" && req.method === "POST") {
            const result = await store.mutate((s) =>
              reopenFeature(s.features.find((f) => f.id === id)),
            );
            return json(res, 200, result);
          }
          if (action === "draft" && req.method === "POST") {
            const data = await body(req);
            ensure(
              feature.analysisStatus !== "RUNNING",
              "분석이 끝난 뒤 기준을 확인해 주세요.",
            );
            if(data.planningMode==='intent' || data.endpointIds) {
              ensure(feature.planStatus!=="RUNNING","테스트 기준을 작성하고 있습니다.");
              const requestId=crypto.randomUUID(),runtime=await runtimeFor(req);
              const inputDigest=planInputDigest(feature,data);
              const input=structuredClone(feature);
              const selected=data.endpointIds;
              if(selected)ensure(Array.isArray(selected)&&selected.length>0&&selected.length<=20&&new Set(selected).size===selected.length&&feature.apiStatus==="DONE"&&selected.every(id=>feature.apiCatalog?.endpoints.some(e=>e.id===id)),"검사할 실제 API를 먼저 선택해 주세요.");
              const planned=(Array.isArray(data.plannedApiIds)?data.plannedApiIds:[]).map(id=>feature.apiMissing?.find(m=>m.id===id));
              ensure(planned.every(Boolean),"명세서에 추가할 API를 다시 골라 주세요.");
              await store.mutate(s=>{
                const f=s.features.find(f=>f.id===id);
                if(f.spec?.approval) {f.history.push(structuredClone(f.spec));delete f.spec.approval;}
                f.status="DRAFT"; f.answers=data; f.plannedApis=planned; f.answeredBy=member(req); f.planStatus="RUNNING"; f.planRequestId=requestId; delete f.planError;
              });
              const propose=selected?(async()=>{
                // Re-read declarations so retries also repair older/incomplete DTO catalogs.
                const project=state.projects.find(p=>p.id===feature.projectId),backend=project?.backend;
                ensure(backend?.repository,"프로젝트 설정에서 백엔드를 연결해 주세요.");
                const catalog=await checkouts.withCode(project,feature.backendBranch,code=>discoverControllers(code,backend.controllerFolder||"src/main/java"));
                return proposeApiTests(input,data,catalog,selected,{runtime,model:state.settings.model || undefined});
              })():proposeIntentApis(input,data,{runtime,model:state.settings.model || undefined});
              propose.then(async output=>{
                await store.mutate(s=>{
                  const f=s.features.find(f=>f.id===id);
                  if(f.planRequestId!==requestId) return;
                  ensure(planInputDigest(f,f.answers)===inputDigest,"작성 중 원문이나 답변이 바뀌었습니다. 다시 작성해 주세요.");
                  replaceDraft(f,output.spec); f.planStatus="DONE"; f.planExecution=output.execution; f.planInputDigest=inputDigest;
                });
              }).catch(async e=>{
                const error=classifyCodexError(e);
                await store.mutate(s=>{
                  const f=s.features.find(f=>f.id===id);
                  if(f.planRequestId!==requestId) return;
                  f.planStatus="ERROR";f.planError={message:error.message,code:error.code,diagnosticId:error.diagnosticId,detail:redactDiagnostic(e.message)};
                });
              });
              return json(res,202,{started:true});
            }
            const draft = buildIntent(feature, data);
            const result = await store.mutate((s) => {
              const f = s.features.find((f) => f.id === id);
              f.answers = data;
              f.answeredBy = member(req);
              return replaceDraft(f, draft);
            });
            return json(res, 200, result);
          }
          if (action === "approve" && req.method === "POST") {
            const data = await body(req);
            const result = await store.mutate((s) => {
              const f = approveFeature(s.features.find((f) => f.id === id), data.version);
              f.approvedBy = { name: member(req), at: new Date().toISOString(), version: f.spec.version };
              return f;
            });
            void publisher.automatic(id);
            return json(res, 200, result);
          }
          if (action === "spec" && req.method === "GET")
            return json(res, 200, feature.spec);
          if (action === "markdown" && req.method === "GET") {
            const markdown = specMarkdown(feature.spec);
            res.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
            });
            return res.end(markdown);
          }
          if (action === "notion" && req.method === "POST") {
            ensure(isApproved(feature.spec), "기획을 먼저 확정해 주세요.");
            const destination = state.projects.find((p) => p.id === feature.projectId)?.notion;
            ensure(destination?.parentId, "이 프로젝트에 명세서를 저장할 노션 페이지를 먼저 지정해 주세요.");
            const key = publicationKey(feature.spec, destination)+NOTION_LAYOUT;
            const cached = feature.publications?.[key];
            return json(res, cached ? 200 : 201, await publisher.publish(id));
          }
        }
        if (route === "/api/settings" && req.method === "POST") {
          const data = await body(req);
          if (["notionToken", "claudeApiKey", "geminiApiKey"].some((k) => data[k] !== undefined)) operatorOnly(req);
          ensure(data.notionPageUrl === undefined && data.parentId === undefined, "노션 페이지 링크는 프로젝트 설정에 입력해 주세요.");
          if (data.model !== undefined) {
            ensure(typeof data.model === "string", "모델을 선택해 주세요.");
            if (data.model) ensure((await runtime.models()).models.some(m=>m.id===data.model), "선택한 AI에서 사용할 수 있는 모델을 골라 주세요.");
          }
          for (const k of ["claudeApiKey", "geminiApiKey"]) ensure(data[k] === undefined || (typeof data[k] === "string" && data[k].length < 500), "API 키 형식을 확인해 주세요.");
          await store.saveSecrets({ notionToken: data.notionToken, claudeApiKey: data.claudeApiKey?.trim(), geminiApiKey: data.geminiApiKey?.trim() });
          await store.mutate((s) => {
            if (data.model !== undefined) s.settings.model = data.model;
            delete s.settings.template;
          });
          return json(res, 200, { saved: true });
        }
        if (route === "/api/connect/github" && req.method === "POST") {
          operatorOnly(req);
          const data = await body(req);
          const repo = parseGithubRepository(data.repository), branch = validBranch(data.branch);
          ensure(typeof data.projectId === "string" && (await store.load()).projects.some((p) => p.id === data.projectId), "프로젝트를 찾을 수 없습니다.");
          const publicKey = await checkouts.publicKey(data.projectId);
          checkouts.branchLists.delete(data.projectId);
          await store.mutate((s) => {
            const p = s.projects.find((p) => p.id === data.projectId);
            p.backend = { source: "github", repo, branch, publicKey, repository: checkouts.folder(p.id, "read"), controllerFolder: data.controllerFolder || "src/main/java", execution: "project-java" };
          });
          return json(res, 200, { connected: true, publicKey });
        }
        if (route === "/api/branches" && req.method === "GET") {
          const project = (await store.load()).projects.find((p) => p.id === url.searchParams.get("projectId"));
          ensure(project?.backend?.source === "github", "GitHub 저장소가 연결되어 있지 않습니다.");
          return json(res, 200, { branches: await checkouts.branches(project), default: project.backend.branch });
        }
        if (route === "/api/connect" && req.method === "POST") {
          const data = await body(req);
          ensure(
            path.isAbsolute(data.repository),
            "백엔드의 절대 경로를 입력해 주세요.",
          );
          // Allowed-folder check first, so a link holder cannot probe which server paths exist.
          await ensureBackendAllowed(data.repository);
          ensure(
            (await stat(data.repository)).isDirectory(),
            "폴더가 아닙니다.",
          );
          await store.mutate((s) => {
            const p = s.projects.find((p) => p.id === data.projectId);
            ensure(p, "프로젝트를 찾을 수 없습니다.");
            p.backend = { repository: data.repository, controllerFolder:data.controllerFolder||"src/main/java",execution:"project-java" };
          });
          return json(res, 200, { connected: true });
        }
        if (route === "/api/verify" && req.method === "POST") {
          const data = await body(req);
          const feature = state.features.find((f) => f.id === data.featureId);
          ensure(
            feature?.status === "READY" && isApproved(feature.spec),
            "기획을 먼저 확정해 주세요.",
          );
          const project = state.projects.find(
            (p) => p.id === feature.projectId,
          );
          ensure(project.backend, "연결 설정에서 백엔드를 먼저 연결해 주세요.");
          ensure(feature.spec.contract.kind === "controller-api-v1", "현재 Gradle 실행 경로가 지원하는 승인 기준이 아닙니다. 기준을 다시 작성해 주세요.");
          if (project.backend.source !== "github") await ensureBackendAllowed(project.backend.repository);
          const branch = data.branch ? validBranch(data.branch) : feature.backendBranch;
          // Resolved before the job exists: a failure here must not leave one stuck as RUNNING.
          const runtime = await runtimeFor(req);
          // Last check before registering the job: a double click must not start two builds.
          ensure(
            ![...jobs.values()].some((j) => j.status === "RUNNING" && j.featureId === feature.id),
            "이 기능의 검사가 이미 진행 중입니다.",
          );
          for (const old of [...jobs.values()].filter((j) => j.status !== "RUNNING").slice(0, -20)) jobs.delete(old.id);
          const job = {
            id: crypto.randomUUID(),
            featureId: feature.id,
            status: "RUNNING",
            stage: "QUEUED",
          };
          jobs.set(job.id, job);
          const by = member(req), spec = structuredClone(feature.spec);
          const finished = () => store.mutate((s) => { delete s.activeVerification; }).catch(() => {});
          // shortcut: the queue lives in memory, so waiting runs vanish on restart; persist it if restarts happen during work.
          verifications = verifications.then(async () => {
            try {
              job.stage = "SNAPSHOT_FROZEN";
              await store.mutate((s) => {
                s.activeVerification = { featureId: feature.id, startedAt: new Date().toISOString(), by };
                const f = s.features.find((f) => f.id === feature.id);
                if (f) delete f.verificationInterrupted;
              });
              job.stage = "CODE_FETCHING";
              const code = await checkouts.forVerification(project, branch);
              const report = await verifyNativeJava({spec,outputRoot:runRoot,onProgress:(stage)=>{job.stage=stage;},backend:code?.repository || project.backend.repository,controllerFolder:project.backend.controllerFolder,runtime,model:state.settings.model || undefined,gate:workGate,codeVersion:code && {repo:code.repo,branch:code.branch,commit:code.commit,subject:code.subject}});
              await addRun(report, feature.projectId);
              void publisher.automatic(feature.id,report);
              await finished();
              job.status = "DONE";
              job.runId = report.id;
            } catch (e) {
              await finished();
              job.status = "ERROR";
              job.error = e.message;
            }
          });
          return json(res, 202, job);
        }
        if (route.startsWith("/api/jobs/") && req.method === "GET") {
          const job = jobs.get(route.split("/").at(-1));
          ensure(
            job,
            "실행 정보를 찾을 수 없습니다. 결과 기록을 확인해 주세요.",
          );
          return json(res, 200, job);
        }
        if (route === "/api/results" && req.method === "POST") {
          const data = await body(req);
          const report = await trustedReport(data.report.id);
          const feature = state.features.find((f) => f.id === report.featureId);
          ensure(feature, "연결된 기능을 찾을 수 없습니다.");
          await addRun(report, feature.projectId);
          return json(res, 200, { saved: true });
        }
        const runRoute = route.match(
          /^\/api\/runs\/([\w-]+)(?:\/(log|test|snapshot|package))?$/,
        );
        if (runRoute && req.method === "GET") {
          const [, id, artifact] = runRoute,
            report = await trustedReport(id);
          if (!artifact) return json(res, 200, report);
          if(artifact === "package") {
            ensure(report.generatedTestDigest,"아직 테스트 파일을 생성하지 못했습니다. 실행이 막힌 이유를 확인해 주세요.");
            const zip=await testPackage(report);
            res.writeHead(200,{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="backend-tests-${id}.zip"`});
            return res.end(zip);
          }
          const file = {
            log: "execution.log",
            test: report.testFile || "GeneratedTest.java",
            snapshot: "snapshot.json",
          }[artifact];
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end(
            await readFile(path.join(report.runDir, file), "utf8"),
          );
        }
        return json(res, 404, { error: "요청한 기능이 없습니다." });
      }
      const files = {
        "/": "index.html",
        "/app.mjs": "app.mjs",
        "/workflow.mjs": "workflow.mjs",
        "/verification-scope.mjs": "verification-scope.mjs",
        "/intent-questions.mjs": "intent-questions.mjs",
        "/project-policies.mjs": "project-policies.mjs",
        "/local-client.mjs": "local-client.mjs",
        "/question-choices.mjs": "question-choices.mjs",
        "/style.css": "style.css",
        "/favicon.svg": "favicon.svg",
      };
      ensure(
        req.method === "GET" && files[route],
        "페이지를 찾을 수 없습니다.",
      );
      const filename = files[route],
        mime = filename.endsWith(".html")
          ? "text/html"
          : filename.endsWith(".css")
            ? "text/css"
            : filename.endsWith(".svg")
              ? "image/svg+xml"
              : "text/javascript";
      res.writeHead(200, {
        "Content-Type": mime + "; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
      res.end(await readFile(path.join(root, "web", filename)));
    } catch (e) {
      json(res, e.status || (e.code === "ENOENT" ? 404 : 400), {
        error: e.message,
        code: e.code,
      });
    }
  });
  server.on("close", () => { runtime.close?.(); if (documentTimer) clearInterval(documentTimer); });
  return { server, store, publicOrigin: origin, checkDocuments };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4318);
  const { server } = await createServer({ port });
  server.on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`이미 ${port}번 포트에서 실행 중입니다. http://127.0.0.1:${port} 을 열거나, 실행 중인 창을 먼저 닫아 주세요.`);
    process.exit(1);
  });
  server.listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`${process.env.PUBLIC_ORIGIN ? 'HTTPS 프록시 주소' : '개발 검증 화면'}: ${process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`}\n종료: Ctrl+C`),
  );
}
