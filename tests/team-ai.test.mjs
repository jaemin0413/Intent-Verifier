import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiRouter, ClaudeRuntime, GeminiRuntime, schemaErrors } from "../lib/ai-runtime.mjs";
import { createServer, sourceDigest } from "../server.mjs";
import { approve } from "../lib/domain.mjs";
import { teamPolicies, interpretationStatus } from "../web/project-policies.mjs";
import { fixtureReferences, projectTypes, validateGeneratedJava, verifyNativeJava } from "../lib/native-java-runner.mjs";
import { gradleCommand, gradleWrapper, noTestsFound, outOfMemory } from "../lib/build-tool.mjs";
import { AI_WORK, BUILD_WORK, WorkGate, availableMemoryMb } from "../lib/work-gate.mjs";
import { discoverControllers } from "../lib/controller-catalog.mjs";
import { retireFailedNativeTests } from "../lib/native-test-files.mjs";
import { nativeHarness } from "../lib/native-generator.mjs";

const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", enum: ["x"] } } };
const image = { nodeId: "1", dataUrl: "data:image/png;base64,AAAA" };

test("AI 응답은 어떤 제공자든 같은 schema 검사를 통과해야 한다", () => {
  assert.deepEqual(schemaErrors({ a: "x" }, schema), []);
  assert.ok(schemaErrors({}, schema).length);
  assert.ok(schemaErrors({ a: "y" }, schema).length);
  assert.ok(schemaErrors({ a: "x", b: 1 }, schema).length);
  assert.deepEqual(schemaErrors({ list: [1, "two"] }, { type: "object", properties: { list: { type: "array", items: { type: "integer" } } } }).length, 1);
});

function fakeClaude(events, seen) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { on() {}, end(text) {
      Object.assign(seen, { args, env: options.env, input: JSON.parse(text) });
      setImmediate(() => { child.stdout.emit("data", events.map((e) => JSON.stringify(e)).join("\n")); child.emit("close", 0); });
    } };
    return child;
  };
}
const claudeOptions = (extra) => ({ binary: process.execPath, run: async (_b, args) => ({ stdout: args[0] === "--version" ? "2.0" : JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }), ...extra });

test("Claude는 팀 서버에서 구독 대신 API 키를 요구하고 도구 없이 이미지를 전달한다", async () => {
  const shared = new ClaudeRuntime(claudeOptions({ shared: true, env: {} }));
  assert.equal((await shared.status()).status, "API_KEY_REQUIRED");
  await assert.rejects(shared.analyze({ nodes: [], images: [], schema, instructions: "i" }), (e) => e.code === "LOGIN_REQUIRED");

  const seen = {};
  const local = new ClaudeRuntime(claudeOptions({ env: { ANTHROPIC_API_KEY: "inherited", CLAUDECODE: "1", PATH: "p" }, spawnImpl: fakeClaude([{ type: "result", structured_output: { a: "x" }, modelUsage: { "claude-x": {} } }], seen) }));
  assert.equal((await local.status()).plan, "max");
  const out = await local.analyze({ nodes: [{ id: "1" }], images: [image], schema, instructions: "i", model: "opus" });
  assert.deepEqual(out.result, { a: "x" });
  assert.equal(out.evidence.provider, "claude");
  assert.equal(out.evidence.auth, "subscription");
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined, "상속된 키로 몰래 과금하지 않는다");
  assert.equal(seen.env.CLAUDECODE, undefined);
  assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "");
  assert.equal(seen.args[seen.args.indexOf("--model") + 1], "opus");
  assert.equal(seen.input.message.content[1].source.data, "AAAA");

  const keyed = {};
  const server = new ClaudeRuntime(claudeOptions({ shared: true, env: {}, secrets: async () => ({ claudeApiKey: "saved" }), spawnImpl: fakeClaude([{ type: "result", result: '{"a":"x"}' }], keyed) }));
  assert.equal((await server.analyze({ nodes: [], images: [], schema, instructions: "i" })).evidence.auth, "api-key");
  assert.equal(keyed.env.ANTHROPIC_API_KEY, "saved");
});

test("Claude 응답이 schema와 다르거나 오류이면 결과로 쓰지 않는다", async () => {
  for (const events of [[{ type: "result", structured_output: { a: "y" } }], [{ type: "result", is_error: true, result: "rate limit" }], []]) {
    const runtime = new ClaudeRuntime(claudeOptions({ env: {}, spawnImpl: fakeClaude(events, {}) }));
    await assert.rejects(runtime.analyze({ nodes: [], images: [], schema, instructions: "i" }));
  }
});

test("Gemini는 API 키로 이미지와 schema를 보내고 키가 없으면 연결 필요로 남는다", async () => {
  assert.equal((await new GeminiRuntime({ env: {} }).status()).status, "API_KEY_REQUIRED");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/models?")) return { ok: true, json: async () => ({ models: [{ name: "models/gemini-flash-latest", displayName: "Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }] }) };
    return { ok: true, json: async () => ({ modelVersion: "gemini-x", candidates: [{ content: { parts: [{ text: '{"a":"x"}' }] } }] }) };
  };
  const runtime = new GeminiRuntime({ env: {}, secrets: async () => ({ geminiApiKey: "k" }), fetchImpl });
  assert.deepEqual((await runtime.models()).models, [{ id: "gemini-flash-latest", name: "Flash" }]);
  assert.equal((await runtime.status()).status, "CONNECTED");
  const out = await runtime.analyze({ nodes: [], images: [image], schema, instructions: "i" });
  assert.deepEqual(out.result, { a: "x" });
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(calls.at(-1).options.headers["x-goog-api-key"], "k");
  assert.ok(!calls.at(-1).url.includes("k="), "키를 URL에 넣지 않는다");
  assert.equal(body.contents[0].parts[1].inlineData.data, "AAAA");
  assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
  const denied = new GeminiRuntime({ env: {}, secrets: async () => ({ geminiApiKey: "bad" }), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "API key invalid" } }) }) });
  assert.equal((await denied.status()).status, "API_KEY_REQUIRED");
});

test("선택한 AI로만 요청하고 팀 서버의 Codex 로그인은 서버 터미널로 안내한다", async () => {
  const provider = (id, status = "CONNECTED") => ({ analyze: async () => id, status: async () => ({ status }), models: async () => ({ models: [] }), connect: async () => ({ status }) });
  const router = new AiRouter({ shared: true, providers: { codex: provider("codex", "LOGIN_REQUIRED"), claude: provider("claude"), gemini: provider("gemini") } });
  router.select("gemini");
  assert.equal(await router.analyze({}), "gemini");
  assert.throws(() => router.select("other"));
  assert.equal((await router.connect("codex")).loginCommand, "codex login --device-auth");
  assert.deepEqual((await router.describe()).map((p) => [p.id, p.active]), [["codex", false], ["claude", false], ["gemini", true]]);
});

function analysisRuntime() {
  const calls = [];
  return { calls, close() {}, status: async () => ({ status: "CONNECTED" }), models: async () => ({ models: [] }), connect: async () => ({ status: "CONNECTED" }), analyze: async (input) => {
    calls.push(input);
    return { result: { featureName: "조회", summary: "해석 " + calls.length, policyHint: "unknown", deniedHint: "unknown", findings: [], questions: [] }, evidence: { provider: "claude", model: "m", imageCount: 0 } };
  } };
}
async function harnessServer(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-"));
  const runtime = options.runtime || analysisRuntime();
  const { server, store, checkDocuments } = await createServer({ directory: dir, runDirectory: path.join(dir, "runs"), runtime, documentCheckMs: 0, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(base + "/api/session").then((r) => r.json());
  const call = async (route, body, headers = {}) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Local-Token": token, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: response.status === 304 ? null : await response.json() };
  };
  const until = async (fn) => { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); };
  const close = async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { call, until, close, store, runtime, dir, checkDocuments };
}
// A two-level Notion page served from memory; `text` can change between reads.
function fakeNotion(state = { text: "작성자만 삭제할 수 있다" }) {
  const page = "e".repeat(32), child = "f".repeat(32);
  const block = (id, type, text, extra = {}) => ({ id, type, has_children: false, [type]: { rich_text: [{ plain_text: text }] }, ...extra });
  return async (url) => {
    const route = url.replace("https://api.notion.com/v1/", "");
    const body = route.startsWith("pages/") ? { id: page, last_edited_time: "2026-11-08T00:00:00.000Z", properties: { 이름: { type: "title", title: [{ plain_text: "삭제 정책 명세" }] } } }
      : route.startsWith(`blocks/${page}/children`) ? { results: [block("b1", "heading_2", "삭제 규칙"), block("b2", "paragraph", state.text), { id: "b3", type: "child_page", has_children: true, child_page: { title: "예외 사항" } }, { id: "b4", type: "child_database", has_children: true, child_database: { title: "용어집" } }], has_more: false }
      : route.startsWith("blocks/b3/children") ? { results: [block("b5", "bulleted_list_item", "관리자는 모든 글을 삭제할 수 있다"), { id: "b6", type: "child_page", has_children: true, child_page: { title: "두 단계 아래" } }], has_more: false }
      : route.startsWith("blocks/b6/children") ? { results: [block("b7", "paragraph", "읽히면 안 되는 깊은 문단")], has_more: false }
      : null;
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body || { message: "missing" } };
  };
}

test("Notion 기능명세서는 화면 원문에 합쳐져 해석 근거가 되고, 바뀌면 자동으로 알린다", async () => {
  const doc = { text: "작성자만 삭제할 수 있다" };
  const h = await harnessServer({ notionFetch: fakeNotion(doc) });
  try {
    const url = "https://www.notion.so/" + "e".repeat(32);
    const missingKey = await h.call("/api/scans", { projectId: "local", scan: scan(), documentUrls: [url] });
    assert.equal(missingKey.status, 400);
    assert.match(missingKey.data.error, /Notion API 키/);
    await h.store.saveSecrets({ notionToken: "t" });
    const plain = (await h.call("/api/scans", { projectId: "local", scan: scan(), localOnly: true })).data.feature;
    const id = (await h.call("/api/scans", { projectId: "local", scan: scan(), documentUrls: [url] })).data.feature.id;
    assert.notEqual(id, plain.id, "같은 화면이라도 명세서가 붙으면 다른 원문이다");
    await h.until(async () => (await h.call("/api/state")).data.features.find((f) => f.id === id).analysisStatus === "DONE");
    const seen = JSON.stringify(h.runtime.calls.at(-1).nodes);
    assert.match(seen, /작성자만 삭제할 수 있다/);
    assert.match(seen, /관리자는 모든 글을 삭제할 수 있다/, "하위 페이지 한 단계는 읽는다");
    assert.doesNotMatch(seen, /깊은 문단/, "두 단계 아래는 읽지 않는다");
    assert.match(seen, /데이터베이스\(제목만\): 용어집/);
    const listed = (await h.call("/api/state")).data.features.find((f) => f.id === id);
    assert.equal(listed.scan.documents[0].title, "삭제 정책 명세");
    assert.equal(listed.scan.nodeCount, 1, "화면 수에는 문서를 세지 않는다");
    const source = (await h.call(`/api/features/${id}/source`)).data.scan;
    assert.equal(source.nodes.find((n) => n.type === "DOCUMENT").children[1].text, "작성자만 삭제할 수 있다");

    assert.deepEqual(await h.checkDocuments(), []);
    doc.text = "누구나 삭제할 수 있다";
    assert.deepEqual(await h.checkDocuments(), [{ featureId: id, documentId: "e".repeat(32) }]);
    const flagged = (await h.call("/api/state")).data.features.find((f) => f.id === id);
    assert.equal(flagged.documentReviewRequired.title, "삭제 정책 명세");
    assert.equal(flagged.analysisStatus, "DONE", "알림만 하고 해석을 바꾸지 않는다");

    const calls = h.runtime.calls.length;
    assert.equal((await h.call(`/api/features/${id}/analyze`, { force: true, refreshDocuments: true })).status, 202);
    await h.until(() => h.runtime.calls.length === calls + 1);
    assert.match(JSON.stringify(h.runtime.calls.at(-1).nodes), /누구나 삭제할 수 있다/);
    const refreshed = (await h.call("/api/state")).data.features.find((f) => f.id === id);
    assert.equal(refreshed.documentReviewRequired, undefined);
  } finally { await h.close(); }
});
const scan = (text = "내 스크랩") => ({ source: "figma-plugin", nodes: [{ id: "1", name: "화면", type: "FRAME", text }], images: [] });

test("프로젝트에 저장한 기능명세서는 누가 골라도 함께 읽고, 문서가 바뀌어도 같은 해석을 연다", async () => {
  const doc = { text: "작성자만 삭제할 수 있다" };
  const h = await harnessServer({ notionFetch: fakeNotion(doc) });
  try {
    const url = "https://www.notion.so/" + "e".repeat(32);
    const save = (documentUrls) => h.call("/api/projects/local/notion", { notionPageUrl: "", documentUrls });
    assert.match((await save([url])).data.error, /Notion API 키/, "읽을 수 없는 링크는 저장 시점에 알린다");
    assert.equal((await h.store.load()).projects[0].documents, undefined);
    await h.store.saveSecrets({ notionToken: "t" });
    assert.equal((await save([url])).data.documents[0].title, "삭제 정책 명세");

    const first = (await h.call("/api/scans", { projectId: "local", scan: scan() })).data.feature;
    await h.until(async () => (await h.call("/api/state")).data.features.find((f) => f.id === first.id).analysisStatus === "DONE");
    assert.match(JSON.stringify(h.runtime.calls[0].nodes), /작성자만 삭제할 수 있다/);

    doc.text = "누구나 삭제할 수 있다";
    const again = await h.call("/api/scans", { projectId: "local", scan: scan() });
    assert.equal(again.data.reused, true, "문서 수정만으로 새 해석이 생기지 않는다");
    assert.equal(again.data.feature.id, first.id);
    assert.equal(h.runtime.calls.length, 1);
    assert.deepEqual(await h.checkDocuments(), [{ featureId: first.id, documentId: "e".repeat(32) }]);

    assert.deepEqual((await save([])).data.documents, [], "링크를 비우면 연결을 해제한다");
  } finally { await h.close(); }
});

test("같은 화면은 누가 다시 골라도 새로 해석하지 않고 같은 해석을 연다", async () => {
  const h = await harnessServer();
  try {
    const first = await h.call("/api/scans", { projectId: "local", scan: scan() }, { "X-Member": encodeURIComponent("지민") });
    const id = first.data.feature.id;
    await h.until(async () => (await h.call("/api/state")).data.features.find((f) => f.id === id).analysisStatus === "DONE");
    assert.equal(h.runtime.calls.length, 1);
    assert.equal((await h.call("/api/state")).data.features.find((f) => f.id === id).analysisBy, "지민");

    const again = await h.call("/api/scans", { projectId: "local", scan: scan() });
    assert.equal(again.status, 200);
    assert.equal(again.data.reused, true);
    assert.equal(again.data.feature.id, id);
    assert.equal(h.runtime.calls.length, 1, "AI를 다시 호출하지 않는다");

    const changed = await h.call("/api/scans", { projectId: "local", scan: scan("내용 변경") });
    assert.notEqual(changed.data.feature.id, id);
    const other = (await h.call("/api/projects", { name: "다른 프로젝트" })).data;
    assert.notEqual((await h.call("/api/scans", { projectId: other.id, scan: scan() })).data.feature.id, id, "프로젝트 사이에 섞지 않는다");
  } finally { await h.close(); }
});

test("Notion 데이터베이스는 행의 속성과 본문까지 읽고, 읽을 수 없으면 제목만 남긴다", async () => {
  const page = "a".repeat(32), row = "1".repeat(8) + "-" + "2".repeat(24);
  const seen = [];
  const body = (route) => route === `pages/${page}` ? { id: page, properties: { 이름: { type: "title", title: [{ plain_text: "정책서" }] } } }
    : route.startsWith(`blocks/${page}/children`) ? { results: [{ id: "db1", type: "child_database", child_database: { title: "기능명세서" } }, { id: "db2", type: "child_database", child_database: { title: "연결된 보기" } }], has_more: false }
    : route === "databases/db1" ? { data_sources: [{ id: "s1" }] }
    : route.startsWith("data_sources/s1/query") ? { results: [{ id: row, properties: { 상태: { type: "status", status: { name: "확정" } }, 기능: { type: "title", title: [{ plain_text: "로그인" }] }, 담당: { type: "people", people: [{ name: "숨김" }] } } }], has_more: false }
    : route.startsWith(`blocks/${row}/children`) ? { results: [{ id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "5회 실패하면 잠근다" }] } }, { id: "p2", type: "child_page", has_children: true, child_page: { title: "두 단계 아래" } }], has_more: false }
    : route.startsWith("blocks/p2/children") ? { results: [{ id: "b2", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "읽히면 안 됨" }] } }], has_more: false }
    : null;
  const fetchImpl = async (url) => { const route = url.replace("https://api.notion.com/v1/", ""); seen.push(route); const b = body(route); return { ok: Boolean(b), status: b ? 200 : 404, json: async () => b || { message: "missing" } }; };
  const { readNotionDocument } = await import("../lib/notion-documents.mjs");
  const doc = await readNotionDocument(page, { token: "t", fetchImpl });
  const text = JSON.stringify(doc.node);
  assert.match(text, /로그인 \/ 상태: 확정/, "제목이 앞에 오고 속성은 이름과 함께 읽는다");
  assert.match(text, /5회 실패하면 잠근다/, "행의 본문을 읽는다");
  assert.doesNotMatch(text, /읽히면 안 됨/, "행은 하위 페이지 1단계로 친다");
  assert.equal(doc.node.children[0].name, "데이터베이스: 기능명세서");
  assert.equal(doc.node.children[1].name, "데이터베이스(제목만): 연결된 보기", "읽지 못한 DB는 제목만이라고 표시한다");
  const other = await readNotionDocument(page, { token: "t", fetchImpl: async (url) => { const r = await fetchImpl(url); const j = await r.json(); return { ...r, json: async () => (url.includes("children") && j.results?.[0]?.paragraph ? { ...j, results: [{ ...j.results[0], paragraph: { rich_text: [{ plain_text: "3회로 변경" }] } }] } : j) }; } });
  assert.notEqual(other.digest, doc.digest, "행 본문이 바뀌면 변경으로 알린다");
});

test("글자 없는 도형은 AI 입력과 한도에서 빼고 화면과 문구는 남긴다", async () => {
  const { flattenNodes, validateScan } = await import("../lib/integrations.mjs");
  const shapes = Array.from({ length: 4500 }, (_, i) => ({ id: "s" + i, name: "Rectangle", type: "RECTANGLE" }));
  const map = { id: "map", name: "지도", type: "GROUP", children: shapes };
  const screen = { id: "phone", name: "홈", type: "FRAME", children: [map, { id: "t", name: "제목", type: "TEXT", text: "오늘의 행사" }, { id: "tap", name: "버튼", type: "RECTANGLE", reactions: [{ action: "NAVIGATE" }] }] };
  const blank = { id: "blank", name: "빈 화면", type: "FRAME", children: [{ id: "x", name: "장식", type: "GROUP", children: [{ id: "y", name: "v", type: "VECTOR" }] }] };
  const nodes = [{ id: "root", name: "선택", type: "SECTION", children: [{ id: "board", name: "홈", type: "FRAME", children: [screen, blank] }] }];
  assert.ok(validateScan({ nodes }), "도형만 많은 화면은 한도에 걸리지 않는다");
  assert.deepEqual(flattenNodes(nodes).map((n) => n.id), ["root", "board", "phone", "t", "tap", "blank"]);
  assert.throws(() => validateScan({ nodes: Array.from({ length: 2 }, (_, k) => ({ id: "f" + k, name: "a", type: "FRAME", children: Array.from({ length: 2100 }, (_, i) => ({ id: k + "-" + i, name: "b", type: "FRAME" })) })) }), /너무 큽니다/, "도형이 아닌 요소는 계속 한도에 든다");
  assert.equal(flattenNodes([{ id: "d", name: "문서", type: "DOCUMENT", children: [{ id: "b", name: "p", type: "DOCUMENT_BLOCK", text: "정책" }] }]).length, 2);
});

test("같은 원문 판별은 내용만 보고 저장 시각이나 ID는 보지 않는다", () => {
  assert.equal(sourceDigest({ id: "a", createdAt: "1", ...scan() }), sourceDigest({ id: "b", createdAt: "2", ...scan() }));
  assert.notEqual(sourceDigest(scan()), sourceDigest(scan("다름")));
});

test("승인된 팀 기준은 실수로 재해석되지 않는다", async () => {
  const h = await harnessServer();
  try {
    const id = (await h.call("/api/scans", { projectId: "local", scan: scan() })).data.feature.id;
    await h.until(async () => (await h.call("/api/state")).data.features.find((f) => f.id === id).analysisStatus === "DONE");
    const sample = JSON.parse(await readFile(new URL("../examples/post-delete.json", import.meta.url), "utf8"));
    await h.store.mutate((s) => { const f = s.features.find((f) => f.id === id); f.spec = approve(sample); f.status = "READY"; f.answers = {}; });
    const refused = await h.call(`/api/features/${id}/analyze`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /팀 기준/);
    assert.equal(h.runtime.calls.length, 1);
    assert.equal((await h.call(`/api/features/${id}/analyze`, { force: true })).status, 202);
    await h.until(() => h.runtime.calls.length === 2);
  } finally { await h.close(); }
});

test("폴링 상태는 원문과 비밀값을 싣지 않고 변화가 없으면 304를 준다", async () => {
  const h = await harnessServer();
  try {
    const id = (await h.call("/api/scans", { projectId: "local", scan: { ...scan(), images: [{ nodeId: "1", dataUrl: "data:image/png;base64,QUJD" }] }, localOnly: true })).data.feature.id;
    await h.call("/api/settings", { geminiApiKey: "secret-key-value" });
    const state = await h.call("/api/state");
    const text = JSON.stringify(state.data);
    assert.equal(text.includes("QUJD"), false);
    assert.equal(text.includes("secret-key-value"), false);
    assert.equal(text.includes("pluginCode"), false);
    const feature = state.data.features.find((f) => f.id === id);
    assert.equal(feature.scan.nodeCount, 1);
    assert.equal(feature.scan.nodes, undefined);
    assert.equal((await h.call(`/api/features/${id}/source`)).data.scan.images[0].dataUrl.endsWith("QUJD"), true);
    assert.equal((await h.call("/api/state", undefined, { "If-None-Match": state.headers.get("etag") })).status, 304);
  } finally { await h.close(); }
});

test("연결된 Figma 파일 없이는 플러그인 API를 쓸 수 없다", async () => {
  const h = await harnessServer();
  try {
    const { token } = (await h.store.load());
    assert.equal(token, undefined);
    assert.equal((await h.store.load()).pluginToken, undefined);
    for (const value of ["Bearer undefined", "Bearer null", "Bearer "]) assert.equal((await h.call("/api/plugin/projects", undefined, { Authorization: value })).status, 400);
  } finally { await h.close(); }
});

test("검사 실행 중 서버가 재시작되면 중단을 표시한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-restart-"));
  try {
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ projects: [{ id: "local", name: "p" }], features: [{ id: "f", projectId: "local", history: [] }], runs: [], settings: {}, activeVerification: { featureId: "f", startedAt: "t" } }));
    const { server, store } = await createServer({ directory: dir, runtime: analysisRuntime(), runDirectory: path.join(dir, "runs") });
    const state = await store.load();
    assert.equal(state.activeVerification, undefined);
    assert.equal(state.features.find((f) => f.id === "f").verificationInterrupted.startedAt, "t");
    server.close();
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("팀 서버는 BACKEND_ROOTS 밖의 폴더를 검사 대상으로 연결하지 않는다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-roots-"));
  const allowed = path.join(dir, "allowed"), outside = path.join(dir, "outside");
  await mkdir(path.join(allowed, "backend"), { recursive: true });
  await mkdir(outside);
  const key = "a".repeat(64);
  const { server } = await createServer({ directory: path.join(dir, "data"), runDirectory: path.join(dir, "runs"), runtime: analysisRuntime(), publicUrl: "https://tool.example.test", linkKey: key, backendRoots: allowed });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = (route, method, headers, body) => new Promise(async (resolve, reject) => {
    const http = await import("node:http");
    const req = http.request({ port: server.address().port, path: route, method, headers: { Host: "tool.example.test", "Content-Type": "application/json", ...headers } }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const { token } = (await request("/api/session", "GET", { "X-App-Key": key })).data;
    const connect = (repository) => request("/api/connect", "POST", { "X-Local-Token": token }, { projectId: "local", repository });
    const denied = await connect(outside);
    assert.equal(denied.status, 400);
    assert.match(denied.data.error, /BACKEND_ROOTS/);
    assert.equal((await connect(path.join(allowed, "backend"))).status, 200);
  } finally { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("팀 서버의 API 키·팀 AI 변경은 운영자 비밀번호가 있어야 하고, 개인 코드 없이는 개인 AI를 쓸 수 없다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-operator-"));
  const key = "b".repeat(64);
  const { server } = await createServer({ directory: path.join(dir, "data"), runDirectory: path.join(dir, "runs"), runtime: analysisRuntime(), publicUrl: "https://tool.example.test", linkKey: key, adminKey: "op-secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = (route, method, headers, body) => new Promise(async (resolve, reject) => {
    const http = await import("node:http");
    const req = http.request({ port: server.address().port, path: route, method, headers: { Host: "tool.example.test", "Content-Type": "application/json", ...headers } }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const { token } = (await request("/api/session", "GET", { "X-App-Key": key })).data;
    const local = { "X-Local-Token": token };
    const denied = await request("/api/settings", "POST", local, { geminiApiKey: "k" });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, "OPERATOR_KEY_REQUIRED");
    assert.equal((await request("/api/ai/connect", "POST", local, { provider: "gemini" })).status, 403);
    assert.equal((await request("/api/settings", "POST", { ...local, "X-Operator-Key": "wrong" }, { geminiApiKey: "k" })).status, 403);
    assert.equal((await request("/api/settings", "POST", { ...local, "X-Operator-Key": "op-secret" }, { geminiApiKey: "k" })).status, 200);
    assert.equal((await request("/api/settings", "POST", local, { model: "" })).status, 200, "모델 선택은 팀원도 바꿀 수 있다");
    assert.equal((await request("/api/operator/check", "POST", { ...local, "X-Operator-Key": "wrong" }, {})).status, 403);
    assert.equal((await request("/api/operator/check", "POST", { ...local, "X-Operator-Key": "op-secret" }, {})).status, 200);
    assert.equal((await request("/api/projects/local/notion", "POST", local, { notionPageUrl: "", documentUrls: [] })).status, 403, "기능명세서 연결도 관리자만 바꾼다");
    assert.equal((await request("/api/ai/member", "GET", local)).data.status, "NOT_SUPPORTED");
  } finally { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("개인 Codex를 연결한 팀원의 요청만 그 계정으로 실행하고 기록에 남긴다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-member-"));
  const member = "c".repeat(32), stranger = "d".repeat(32);
  const used = [];
  const models = [];
  const fake = (label) => ({ analyze: async (input) => { used.push(label); models.push(input.model); return { result: { featureName: "조회", summary: "s", findings: [], questions: [] }, evidence: { provider: "codex", model: "m" } }; }, status: async () => ({ status: "CONNECTED", plan: "plus" }), models: async () => ({ models: [] }), connect: async () => ({ status: "CONNECTED" }), close() {} });
  const logins = [];
  const router = new AiRouter({ shared: true, providers: { codex: fake("team"), claude: fake("claude"), gemini: fake("gemini") }, memberHome: (id) => path.join(dir, id), memberRuntime: () => fake("member"), login: async ({ codexHome }) => { logins.push(codexHome); const login = { startedAt: "t", status: "WAITING", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGHI", cancel() {} }; login.done = new Promise(() => {}); return login; } });
  try {
    assert.equal((await router.memberStatus(null)).status, "NO_MEMBER");
    assert.equal((await router.memberStatus(member)).status, "NOT_CONNECTED");
    const started = await router.startMemberLogin(member);
    assert.equal(started.code, "ABCD-EFGHI");
    assert.equal(logins[0], path.join(dir, member));
    assert.equal((await router.memberStatus(member)).status, "LOGIN_WAITING");
    assert.equal(await router.forMember(member), router, "로그인이 끝나기 전에는 팀 AI를 쓴다");
    await mkdir(path.join(dir, member), { recursive: true });
    await writeFile(path.join(dir, member, "auth.json"), "{}");
    router.logins.delete(member);
    assert.equal((await router.memberStatus(member)).plan, "plus");
    const mine = await router.forMember(member);
    const out = await mine.analyze({ nodes: [], model: "claude-only-model" });
    assert.equal(models[0], undefined, "기본 AI의 모델 ID를 개인 AI에 넘기지 않는다");
    assert.equal(out.evidence.account, "member");
    assert.equal(out.evidence.memberId, member);
    await (await router.forMember(stranger)).analyze({ nodes: [] });
    await (await router.forMember(null)).analyze({ nodes: [] });
    assert.deepEqual(used, ["member", "team", "team"]);
    await router.disconnectMember(member);
    assert.equal((await router.memberStatus(member)).status, "NOT_CONNECTED");
  } finally { router.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("개인 Claude는 공식 CLI 로그인을 마친 그 팀원의 요청에만 쓴다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-claude-"));
  const member = "e".repeat(32), stranger = "f".repeat(32), used = [];
  const fake = (label) => ({ analyze: async () => { used.push(label); return { result: {}, evidence: { provider: label } }; }, status: async () => ({ status: "CONNECTED", plan: "max" }), models: async () => ({ models: [] }), connect: async () => ({ status: "CONNECTED" }), loginCommand: async () => "login-command", close() {} });
  const router = new AiRouter({ shared: true, providers: { codex: fake("team"), claude: fake("claude"), gemini: fake("gemini") }, memberHome: (id) => path.join(dir, id, "codex"), memberClaudeHome: (id) => path.join(dir, id, "claude"), memberClaudeRuntime: () => fake("mine") });
  try {
    assert.equal((await router.memberStatus(member)).status, "NOT_CONNECTED");
    assert.deepEqual(await router.startMemberClaudeLogin(member), { status: "CLAUDE_LOGIN", command: "login-command" });
    assert.equal(await router.forMember(member), router, "로그인이 끝나기 전에는 팀 AI를 쓴다");
    await writeFile(path.join(dir, member, "claude", ".credentials.json"), "{}");
    assert.equal((await router.memberStatus(member)).provider, "claude");
    const out = await (await router.forMember(member)).analyze({ nodes: [] });
    assert.equal(out.evidence.account, "member");
    assert.equal(out.evidence.memberId, member);
    await (await router.forMember(stranger)).analyze({ nodes: [] });
    await (await router.forMember(null)).analyze({ nodes: [] });
    assert.deepEqual(used, ["mine", "team", "team"], "다른 사람의 요청은 개인 구독으로 처리하지 않는다");
    await router.disconnectMember(member);
    assert.equal((await router.memberStatus(member)).status, "NOT_CONNECTED");
  } finally { router.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

  const seen = {};
  const own = new ClaudeRuntime(claudeOptions({ configDir: "/data/members/a/claude", env: { ANTHROPIC_API_KEY: "team" }, spawnImpl: fakeClaude([{ type: "result", structured_output: { a: "x" } }], seen) }));
  assert.equal((await own.analyze({ nodes: [], images: [], schema, instructions: "i" })).evidence.auth, "subscription");
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, "/data/members/a/claude");
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined, "팀 API 키로 과금하지 않는다");
  assert.match(await own.loginCommand(), /CLAUDE_CONFIG_DIR="\/data\/members\/a\/claude" ".*" auth login$/);
});

test("무거운 작업은 순서대로, 메모리가 있을 때만 시작하고 빌드는 AI와 겹치지 않는다", async () => {
  const log = [], release = [], hold = (name) => () => { log.push(name); return new Promise((resolve) => release.push(resolve)); };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let memory = 1000;
  const gate = new WorkGate({ available: async () => memory, pollMs: 1, timeoutMs: 40 });
  const ai = gate.run(AI_WORK, hold("ai")), build = gate.run(BUILD_WORK, hold("build")), later = gate.run(AI_WORK, hold("later"));
  await tick(); await tick();
  assert.deepEqual(log, ["ai"], "빌드는 진행 중인 AI를 기다리고, 뒤에 온 AI가 새치기하지 않는다");
  release.shift()(); await ai; await tick(); await tick();
  assert.deepEqual(log, ["ai", "build"]);
  release.shift()(); await build; await tick(); await tick();
  assert.deepEqual(log, ["ai", "build", "later"]);
  release.shift()(); await later;
  memory = 100;
  await assert.rejects(gate.run(BUILD_WORK, async () => assert.fail("메모리가 없으면 시작하지 않는다")), /메모리가 부족/);
  assert.equal(gate.used, 0);
  assert.equal(await availableMemoryMb(async () => "MemTotal: 1 kB\nMemAvailable: 2048 kB\n"), 2);
  assert.equal(await availableMemoryMb(async () => { throw new Error("no proc"); }), Infinity);
  assert.ok(outOfMemory("Process 'Gradle Test Executor 1' finished with non-zero exit value 137"));
  assert.ok(!outOfMemory("BUILD SUCCESSFUL"));
});

test("팀 정책 모음은 승인된 답변만 모으고 충돌을 먼저 보여 준다", () => {
  const feature = (id, answer, status = "READY", projectId = "p") => ({ id, name: id, projectId, status, analysis: { mode: "codex", questions: ["보관 기간은?"], questionScopes: ["backend"] }, answers: { extraAnswers: [answer] }, spec: { version: 1, approval: { status: "APPROVED" } } });
  const groups = teamPolicies([feature("a", "30일"), feature("b", "7일"), feature("draft", "1일", "DRAFT"), feature("other", "90일", "READY", "q")], "p");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].conflict, true);
  assert.deepEqual(groups[0].answers.map((a) => a.value), ["30일", "7일"]);
  assert.equal(teamPolicies([feature("a", "30일"), feature("b", "30일")], "p")[0].conflict, false);
  assert.equal(interpretationStatus({ status: "READY", approvedBy: { name: "지민" }, spec: { version: 3, approval: { status: "APPROVED" } } }).by, "지민");
  assert.equal(interpretationStatus({ status: "DRAFT", spec: { version: 3 } }).kind, "CANDIDATE");
  assert.equal(interpretationStatus({ status: "DRAFT", spec: { version: 4 }, history: [{ approval: { status: "APPROVED" } }] }).kind, "CHANGING");
});

test("AI가 대상 프로젝트 Bean을 Mock으로 바꾸거나 보안·판정을 우회하는 코드는 실행하지 않는다", () => {
  const base = 'package p; class GeneratedIntentTest extends NativeIntentHarness { String a="jdbc:h2:mem:x"; String b="spring.config.location";';
  assert.ok(validateGeneratedJava(base + "}", "p"));
  assert.ok(validateGeneratedJava(base + "@Bean FirebaseMessaging m(){return org.mockito.Mockito.mock(FirebaseMessaging.class);}}", "p"), "외부 SDK 경계는 허용한다");
  assert.ok(validateGeneratedJava("import java.io.InputStream;\n" + base + "}", "p"), "메일 대체에 필요한 타입 선언은 허용한다");
  assert.throws(() => validateGeneratedJava("import java.io.File;\n" + base + "}", "p"), /파일 변경/);
  assert.throws(() => validateGeneratedJava("import java.io.*;\n" + base + "}", "p"), /파일 변경/);
  for (const code of ["@MockitoBean ScrapService s;", "@MockBean ScrapService s;", "@SpyBean ScrapService s;", "http.authorizeHttpRequests(a->a.anyRequest().permitAll());", "@Bean SecurityFilterChain c(){return null;}", "@AutoConfigureMockMvc(addFilters = false)", 'Class.forName("x");', 'x.getClass().getMethod("y");', "f.setAccessible(true);", "MethodHandles.lookup();"])
    assert.throws(() => validateGeneratedJava(base + code + "}", "p"), code);
});

test("Harness는 대상 프로젝트 Bean이 실제인지 직접 확인하고 근거에 남긴다", async () => {
  assert.deepEqual(projectTypes([
    { file: "src/a/ScrapService.java", text: "package a; @Service public class ScrapService {}" },
    { file: "src/a/ScrapRepository.java", text: "package a; public interface ScrapRepository extends JpaRepository<S,Long> {}" },
    { file: "src/a/Scrap.java", text: "package a; @Entity public class Scrap {}" },
  ]), ["a.ScrapService", "a.ScrapRepository"]);
  const harness = await nativeHarness({ packageName: "intent.r1", inputResource: "s.json", evidenceDirectory: "/tmp/e", runId: "r1", projectTypes: ["a.ScrapService"] });
  assert.match(harness, /PROJECT_TYPES=List\.of\("a\.ScrapService"\)/);
  assert.match(harness, /verifyRealProjectBeans/);
  assert.match(harness, /evidence\.put\("beansVerified",beansVerified\)/);
  assert.match(harness, /startsWith\("intent\.r1\."\)/);
});

test("실패한 실행의 생성 파일은 다음 검사 전에 치우되 사용자 수정과 정상 실행 파일은 남긴다", async () => {
  const { digest } = await import("../lib/domain.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-failed-"));
  try {
    const backend = path.join(dir, "backend"), runs = path.join(dir, "runs");
    const make = async (id, file, text, report) => {
      const relative = "src/test/java/intent/generated/" + id.replaceAll("-", "") + "/" + file, full = path.join(backend, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text);
      await mkdir(path.join(runs, id), { recursive: true });
      const generatedFiles = [{ relative, path: full, digest: digest("generated") }];
      if (report) await writeFile(path.join(runs, id, "report.json"), JSON.stringify({ ...report, generatedFiles }));
      else await writeFile(path.join(runs, id, "generated-files.json"), JSON.stringify(generatedFiles));
      return full;
    };
    const failed = await make("1-native-aaaaaaaa", "Broken.java", "generated", { results: [{ status: "BLOCKED" }] });
    const crashed = await make("2-native-bbbbbbbb", "Crashed.java", "generated");
    const edited = await make("3-native-cccccccc", "Edited.java", "user edit", { results: [] });
    const healthy = await make("4-native-dddddddd", "Good.java", "generated", { results: [{ evidence: { actionExecuted: true } }] });
    const retired = await retireFailedNativeTests(backend, runs, "9-native-current");
    assert.equal(retired.length, 2);
    await assert.rejects(readFile(failed));
    await assert.rejects(readFile(crashed));
    assert.equal(await readFile(edited, "utf8"), "user edit");
    assert.equal(await readFile(healthy, "utf8"), "generated");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("실행할 수 없거나 지원하지 않는 프로젝트는 AI를 호출하기 전에 멈춘다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-preflight-"));
  const entity = path.join(dir, "src/main/java/a/Item.java");
  try {
    const spec = approve(await harnessSpec());
    const runtime = { analyze: async () => assert.fail("AI를 호출하면 안 된다") };
    const run = () => verifyNativeJava({ spec, backend: dir, runtime, outputRoot: path.join(dir, "runs") });
    const maven = await run();
    assert.equal(maven.counts.UNVERIFIED, maven.results.length, "Gradle이 아니면 미지원으로 남긴다");
    assert.match(maven.results[0].reason, /Gradle/);
    await writeFile(path.join(dir, "build.gradle"), "plugins {}");
    await mkdir(path.dirname(entity), { recursive: true });
    await writeFile(entity, "package a; public class Item {}");
    assert.match((await run()).results[0].reason, /JPA Entity/);
    await writeFile(entity, "package a; @Entity public class Item {}");
    const noWrapper = await run();
    assert.equal(noWrapper.counts.BLOCKED, noWrapper.results.length);
    assert.match(noWrapper.results[0].reason, /wrapper/);
    await writeFile(path.join(dir, "settings.gradle"), "include 'api'\n");
    const multi = await run();
    assert.equal(multi.counts.UNVERIFIED, multi.results.length);
    assert.match(multi.results[0].reason, /멀티모듈/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("Windows의 비영문 경로는 AI 호출 전에 이유를 알려 준다", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(gradleWrapper("C:\프로젝트\backend"), /영문 경로/);
});

test("실행 전용 Gradle 설정이 JUnit을 켜고 H2가 없을 때만 추가한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-build-"));
  try {
    await writeFile(path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew"), "");
    const command = (build, attempt) => gradleCommand({ build, backend: dir, testClass: "p.T", runDir: dir, attempt });
    const initScript = ({ args }) => args[args.indexOf("-I") + 1];
    const without = await readFile(initScript(await command("plugins {}", 0)), "utf8");
    assert.match(without, /useJUnitPlatform/);
    assert.match(without, /com\.h2database:h2/);
    assert.match(without, /maxHeapSize = '256m'/);
    assert.match(without, /contains\('\/p'\)/, "이번 검사가 만든 테스트만 컴파일한다");
    assert.doesNotMatch(await readFile(initScript(await command("testRuntimeOnly 'com.h2database:h2'", 1)), "utf8"), /com\.h2database/);
    assert.equal(noTestsFound("No tests found for given includes"), true);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("AI가 잘린 코드를 주면 바로 끝내지 않고 이유와 함께 다시 작성하게 한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-repair-"));
  try {
    const spec = approve(await harnessSpec()), endpoint = spec.contract.endpoints[0], mapping = endpoint.method[0] + endpoint.method.slice(1).toLowerCase();
    await mkdir(path.join(dir, "src/main/java/a"), { recursive: true });
    await writeFile(path.join(dir, "build.gradle"), "plugins { id 'java' }\n");
    await writeFile(path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew"), "");
    await writeFile(path.join(dir, "src/main/java/a/Item.java"), "package a; @Entity public class Item {}");
    await writeFile(path.join(dir, "src/main/java/a/ItemController.java"), `package a; @RestController public class ItemController { @${mapping}Mapping("${endpoint.path}") public Object a() { return null; } }`);
    const asked = [];
    const runtime = { analyze: async (input) => { asked.push(input.nodes); return { result: { java: "package cut;", notes: "", unsupportedScenarioIds: [] }, evidence: { model: "test-double" } }; } };
    const report = await verifyNativeJava({ spec, backend: dir, runtime, outputRoot: path.join(dir, "runs"), maxRepairs: 1 });
    assert.equal(asked.length, 2);
    assert.match(asked[1].diagnostics, /올바른 Java/);
    assert.equal(report.counts.BLOCKED, report.results.length);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("컨트롤러는 이름이 아니라 어노테이션으로 찾고 DTO 위치를 가리지 않는다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-ai-catalog-"));
  try {
    const base = path.join(dir, "src/main/java/a");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "ItemResource.java"), '@RestController @RequestMapping("/x") public class ItemResource { @GetMapping("/{id}") public ItemView a(@PathVariable Long id){return null;} }');
    await writeFile(path.join(base, "ItemView.java"), "package a; public class ItemView { private String name; }");
    await writeFile(path.join(base, "ItemController.java"), "package a; /* 이름만 비슷한 일반 클래스 */ public class ItemController {}");
    const catalog = await discoverControllers(dir);
    assert.deepEqual(catalog.endpoints.map((e) => [e.method, e.path]), [["GET", "/x/{id}"]]);
    assert.deepEqual(catalog.shapes.map((s) => s.name), ["ItemView"]);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

async function harnessSpec() {
  const { proposeIntentApis } = await import("../lib/intent-api-plan.mjs");
  const feature = { id: "preflight", name: "조회", scan: { id: "scan-1", nodes: [], images: [] }, analysis: { summary: "자료 조회", findings: [{ text: "자료 조회", quote: "자료 조회", nodeIds: ["n1"] }], questions: [] } };
  const source = await readFile(new URL("./native-java.test.mjs", import.meta.url), "utf8");
  // Reuse the planning replies of the existing proposal test instead of copying them.
  const outputs = eval(source.match(/const outputs=(\[.*?\]);\n/s)[1]);
  const runtime = { analyze: async () => ({ result: outputs.shift(), evidence: { model: "test-double" } }) };
  return (await proposeIntentApis(feature, {}, { runtime })).spec;
}

test("AI에게 Harness가 읽을 $fixture 값의 정확한 위치를 알려 준다", () => {
  const refs = fixtureReferences([{ id: "a", expected: { checks: [{ value: "$fixture/tribeId" }, { value: "$fixture/tribeId" }] }, action: { pathValues: [{ value: "$fixture/records/item/id" }] } }, { id: "b", expected: { checks: [] } }]);
  assert.deepEqual(refs, [
    { scenarioId: "a", reference: "$fixture/tribeId", relationsPath: "tribeId" },
    { scenarioId: "a", reference: "$fixture/records/item/id", relationsPath: "records/item/id" },
  ]);
});

test('검사는 팀원끼리 순서대로 기다리고 같은 기능의 중복 실행만 막는다', async () => {
  const h = await harnessServer();
  try {
    const spec = approve(await harnessSpec()), backend = path.join(h.dir, 'backend');
    await mkdir(backend);
    await h.store.mutate((s) => {
      s.projects[0].backend = { repository: backend, execution: 'project-java' };
      for (const id of ['a', 'b']) s.features.push({ id, projectId: s.projects[0].id, status: 'READY', spec, history: [] });
    });
    const first = await h.call('/api/verify', { featureId: 'a' }), second = await h.call('/api/verify', { featureId: 'b' });
    assert.deepEqual([first.status, first.data.error, second.status, second.data.stage], [202, undefined, 202, 'QUEUED']);
    assert.equal((await h.call('/api/verify', { featureId: 'b' })).status, 400);
    const jobs = await h.until(async () => { const { jobs } = (await h.call('/api/state')).data; return jobs.every((j) => j.status !== 'RUNNING') && jobs; });
    assert.equal(jobs.length, 2);
    assert.equal((await h.store.load()).activeVerification, undefined);
  } finally { await h.close(); }
});

test("DTO 안쪽 필드 타입에만 쓰인 enum 값도 요청 작성에 전달한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nested-enum-"));
  try {
    const java = path.join(dir, "src/main/java/app");
    await mkdir(java, { recursive: true });
    await writeFile(path.join(java, "ItemController.java"), '@RestController class ItemController { @PostMapping("/items") public Object create(@RequestBody ItemRequest body) { return null; } }');
    await writeFile(path.join(java, "ItemRequest.java"), "public class ItemRequest { private List<@Valid ItemRequest.Contact> contacts; public static class Contact { private ContactType type; } }");
    await writeFile(path.join(java, "ContactType.java"), "public enum ContactType {\n  KAKAO_OPEN_CHAT,\n  ETC\n}");
    const { shapes } = await discoverControllers(dir);
    assert.deepEqual(shapes.find((s) => s.name === "ContactType").enumValues, ["KAKAO_OPEN_CHAT", "ETC"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
