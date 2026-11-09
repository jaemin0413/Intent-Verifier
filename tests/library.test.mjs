import {indexProperties,indexResponse} from './fixtures/notion-metadata.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { ScreenLibrary } from "../lib/screen-library.mjs";
import { approve } from "../lib/domain.mjs";
import { specMarkdown } from "../lib/notion-template.mjs";
import { createServer } from "../server.mjs";
import { planStoredFeature } from "./fixtures/sample-plan.mjs";

const spec = JSON.parse(await readFile(new URL("../examples/post-delete.json", import.meta.url), "utf8"));
const metadata = (ids = ["1", "2"], note = "작성자만 삭제 가능") => ({ fileId: "file-a", fileName: "기획", pages: [{ id: "p", name: "운영 화면" }], screenIds: ids, contexts: [{ pageId: "p", nodes: [{ id: "note", name: "기획 설명", type: "TEXT", text: note }] }] });
const screen = (id, name = `게시글 삭제 ${id}`) => ({ id, name, pageId: "p", node: { id, name, type: "FRAME", children: [{ id: `${id}-text`, name: "삭제", type: "TEXT", text: "게시글 삭제" }], reactions: [{ action: { type: "NODE", destinationId: "2" } }] } });

test("미완료본 비공개, 재시작 후 이어받기, 이름 변경/삭제 추적과 관련 화면만 검토", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "library-proof-"));
  try {
    let lib = new ScreenLibrary(dir);
    const first = await lib.begin("a", metadata());
    await lib.put("a", first.id, screen("1"));
    assert.equal((await lib.listing("a")).revision, 0);
    await assert.rejects(lib.complete("a", first.id), /전송되지 않은/);
    lib = new ScreenLibrary(dir);
    await lib.put("a", first.id, screen("2"));
    await lib.complete("a", first.id);
    assert.equal((await lib.complete("a", first.id)).revision, 1);
    const selected = await lib.scan("a", ["1"], 1);
    assert.match(JSON.stringify(selected.nodes), /작성자만 삭제 가능/);
    assert.match(JSON.stringify(selected.nodes), /destinationId/);
    const second = await lib.begin("a", metadata());
    await lib.put("a", second.id, screen("1"));
    assert.equal((await lib.listing("a")).revision, 1);
    await lib.put("a", second.id, screen("2", "관계 없는 화면 이름 변경"));
    await lib.complete("a", second.id);
    assert.equal(await lib.changed("a", selected.library), false);
    await assert.rejects(lib.scan("a", ["1"], 1), /갱신/);
    const third = await lib.begin("a", metadata(["1"]));
    await lib.put("a", third.id, screen("1", "게시글 상세로 이름 변경"));
    const latest = await lib.complete("a", third.id);
    assert.equal(latest.deleted[0].id, "2");
    assert.equal(latest.screens[0].id, "1");
    assert.equal(await lib.changed("a", selected.library), false);
    const version3 = await lib.scan("a", ["1"], 3);
    const fourth = await lib.begin("a", metadata(["1"], "관리자도 삭제 가능"));
    await lib.put("a", fourth.id, screen("1", "게시글 상세로 이름 변경"));
    await lib.complete("a", fourth.id);
    assert.equal(await lib.changed("a", version3.library), true);
    assert.equal((await lib.listing("b")).revision, 0);
    await assert.rejects(lib.asset("b", "1"), /찾을 수/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("범위 밖 화면/프로젝트 업로드와 뒤늦은 동기화 덮어쓰기를 차단한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "library-race-"));
  const lib = new ScreenLibrary(dir);
  try {
    const a = await lib.begin("a", metadata(["1"]));
    const b = await lib.begin("a", metadata(["1"]));
    await assert.rejects(lib.put("b", a.id, screen("1")), /찾을 수/);
    await assert.rejects(lib.put("a", a.id, screen("outside")), /범위/);
    await lib.put("a", a.id, screen("1"));
    await lib.complete("a", a.id);
    await lib.put("a", b.id, screen("1", "늦게 도착한 구버전"));
    await assert.rejects(lib.complete("a", b.id), /먼저 완료/);
    assert.equal((await lib.listing("a")).screens[0].name, screen("1").name);
    await assert.rejects(lib.begin("a", { ...metadata(), fileId: "other-file" }), /다른 Figma 파일/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("프로젝트별 노션 전송, 보관함 선택 분석, 원문 변경 후 이전 승인 보존과 계속 승인 가능", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "project-isolation-"));
  const sent = [], inputs = [];
  const runtime = { close() {}, async analyze(input) {
    inputs.push(input);
    return { result: { featureName: "게시글 삭제", summary: "검증용 응답", findings: [], questions: [], policyHint: "unknown", deniedHint: "unknown" }, evidence: { testDouble: true } };
  } };
  const { server, store } = await createServer({ directory: dir, runtime, notionFetch: async (_url, options) => {
    const index=indexResponse(_url,options);if(index)return index;
    if(_url.includes("/blocks/")&&options.method==="PATCH")return {ok:true,json:async()=>({results:[{id:"owned-block"}]})};
    if(options.method==='GET'){let data;if(_url.includes('/databases/')){const id=_url.split('/').at(-1);data={id,url:'https://notion.so/'+id,data_sources:[{id}]};}else if(_url.includes('/templates'))data={templates:[]};else data={id:_url.split('/').at(-1),properties:indexProperties('title')};return {ok:true,json:async()=>data};}
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `page-${sent.length}`, url: `https://notion.so/page-${sent.length}` }) };
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(base + "/api/session").then((r) => r.json());
  const api = async (route, data, plugin = false) => {
    const response = await fetch(base + route, { method: data ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(plugin ? { Authorization: `Bearer plugin-test` } : { "X-Local-Token": token }) }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    await api("/api/settings", { notionToken: "test-only" });
    const a = (await api("/api/projects", { name: "A" })).body;
    const b = (await api("/api/projects", { name: "B" })).body;
    await api(`/api/projects/${a.id}/notion`, { notionPageUrl: `https://notion.so/${"a".repeat(32)}` });
    await api(`/api/projects/${b.id}/notion`, { notionPageUrl: `https://notion.so/${"b".repeat(32)}` });
    await store.mutate((s) => { for (const p of [a,b]) s.features.push({ id: p.id, projectId: p.id, spec: approve(spec), status: "READY" }); });
    assert.equal((await api(`/api/features/${a.id}/notion`, {})).status, 201);
    assert.equal((await api(`/api/features/${b.id}/notion`, {})).status, 201);
    assert.deepEqual(sent.map((p) => p.parent.data_source_id), ["a".repeat(32), "b".repeat(32)]);
    assert.equal((await api(`/api/features/${a.id}/notion`, {})).status, 200);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(specMarkdown(approve(spec)), /app\.notion\.com/);
    assert.equal((await api("/api/state")).body.settings.notionTemplate.url, undefined);
    await store.mutate((s) => { s.pluginConnections = [{ token: "plugin-test", projectId: a.id, fileId: "file-a" }]; });
    const sync = (await api("/api/plugin/library/begin", { projectId: a.id, ...metadata(["1"]) }, true)).body;
    await api("/api/plugin/library/screen", { projectId: a.id, sessionId: sync.id, screen: screen("1") }, true);
    await api("/api/plugin/library/complete", { projectId: a.id, sessionId: sync.id }, true);
    const imported = await api(`/api/projects/${a.id}/library/analyze`, { screenIds: ["1"], revision: 1 });
    assert.equal(imported.status, 201);
    const id = imported.body.feature.id;
    for (let i = 0; i < 30; i++) { if ((await store.load()).features.find((f) => f.id === id)?.analysisStatus === "DONE") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(inputs.length, 1);
    assert.match(JSON.stringify(inputs[0].nodes), /작성자만 삭제 가능/);
    await planStoredFeature(store, id);
    assert.equal((await api(`/api/features/${id}/approve`, { version: 1 })).status, 200);
    const before = (await store.load()).features.find((f) => f.id === id).spec.approval.digest;
    const lib = new ScreenLibrary(dir);
    const next = await lib.begin(a.id, metadata(["1"], "관리자만 삭제"));
    await lib.put(a.id, next.id, screen("1"));
    await lib.complete(a.id, next.id);
    const current = (await api("/api/state")).body.features.find((f) => f.id === id);
    assert.equal(current.sourceReviewRequired, true);
    assert.equal(current.spec.approval.digest, before);
    const blocked = await api("/api/verify", { featureId: id });
    assert.equal(blocked.status,400);assert.match(blocked.body.error,/백엔드/);
    await api(`/api/features/${id}/reopen`,{});
    const draftVersion=(await planStoredFeature(store, id, { extraAnswers: ["다시"] })).version;
    assert.equal((await api(`/api/features/${id}/approve`, {version:draftVersion})).status,200);
    assert.equal((await api(`/api/projects/${b.id}/library`)).body.screens.length, 0);
    // Switching the project to another Figma file keeps the approved feature and its screens readable.
    const moved = await lib.setFileId(a.id, "file-original", "원본 기획");
    assert.equal(moved.fileId, "file-original");
    assert.equal(moved.previousFileId, "file-a");
    assert.equal((await store.load()).features.find((f) => f.id === id).spec.approval.status, "APPROVED");
    assert.ok((await api(`/api/features/${id}/source`)).body.scan.nodes.length);
    assert.equal(await lib.changed(a.id, (await store.load()).features.find((f) => f.id === id).scan.library), true, "이미 표시된 원문 변경은 파일을 바꿔도 그대로 보인다");
    await assert.rejects(lib.begin(a.id, metadata(["1"])), /다른 Figma 파일/);
    const fresh = await lib.begin(a.id, { ...metadata(["9"]), fileId: "file-original" });
    await lib.put(a.id, fresh.id, screen("9"));
    const completed = await lib.complete(a.id, fresh.id);
    assert.deepEqual(completed.deleted.map((s) => s.id), ["1"]);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("Figma 페이지 수집은 프레임 밖 설명과 화면 연결을 함께 보관한다", async () => {
  const messages = [];
  const note = { id: "note", name: "권한 설명", type: "TEXT", characters: "작성자만 삭제 가능" };
  const frame = { id: "frame", name: "게시글 화면", type: "FRAME", children: [], reactions: [{ action: { type: "NODE", destinationId: "other" } }], exportAsync: async () => new Uint8Array([1]) };
  const page = { id: "page", name: "서비스", type: "PAGE", children: [frame,note], selection: [], loadAsync: async () => {} };
  const figma = { showUI() {}, clientStorage: { getAsync: async () => ({}) }, ui: { postMessage: (m) => { messages.push(m); if (m.requestId) queueMicrotask(() => figma.ui.onmessage({type:"sync-ack",requestId:m.requestId})); } }, currentPage: page, root: { name: "기획", children: [page] }, fileKey: "file", on() {}, getNodeByIdAsync: async () => page, base64Encode: () => "AQ==" };
  vm.runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  await figma.ui.onmessage({ type: "sync-page", pageId: "page" });
  const result = messages.find((m) => m.type === "library-start").library;
  const screens = messages.filter((m) => m.type === "library-screen").map(m=>m.screen);
  assert.equal(screens.length, 1);
  assert.equal(result.contexts[0].nodes[0].text, "작성자만 삭제 가능");
  assert.equal(screens[0].node.reactions[0].action.destinationId, "other");
  assert.ok(messages.find(m=>m.type === "library-complete").captureFinishedAt);
  const manifest = JSON.parse(await readFile(new URL("../figma-plugin/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, ["http://localhost:4318"]);
});
