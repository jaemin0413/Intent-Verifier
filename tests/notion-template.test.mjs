import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { approve, isApproved, supported } from "../lib/domain.mjs";
import { Store } from "../lib/store.mjs";
import { publishNotion } from "../lib/integrations.mjs";
import { DEFAULT_NOTION_TEMPLATE, publicationKey, specMarkdown, specNotionBlocks } from "../lib/notion-template.mjs";

const source = JSON.parse(await readFile(new URL("../examples/post-delete.json", import.meta.url), "utf8"));
function fixture({ method = "DELETE", url = "/posts/{postId}", request, responses } = {}) {
  const spec = structuredClone(source);
  spec.contract.method = method;
  spec.contract.path = url;
  for (const scenario of spec.scenarios) scenario.action = { method, path: url };
  if (request !== undefined) spec.contract.request = request;
  if (responses !== undefined) spec.contract.responses = responses;
  return approve(spec);
}
const unused = { headers: [], queryParameters: [], body: null };
const body = { contentType: "application/json", fields: [{ key: "title", type: "string", description: "게시글 제목" }] };

test("문서화 가능한 Body/Query/응답 필드도 실행 Harness가 지원하지 않으면 미검증이다", () => {
  const request = { ...unused, pathParameters: [{ key: "postId", type: "integer" }] };
  const spec = fixture({ request });
  assert.equal(supported(spec.scenarios[0], spec.contract), true);
  for (const patch of [{ body }, { headers: [{ key: "X-Request-ID" }] }, { queryParameters: [{ key: "dryRun" }] }]) {
    const richer = fixture({ request: { ...request, ...patch } });
    assert.equal(supported(richer.scenarios[0], richer.contract), false);
  }
  const response = fixture({ request, responses: [{ status: 403, fields: [{ key: "message" }] }] });
  assert.equal(supported(response.scenarios[0], response.contract), false);
});

test("본문 전용 계약: 원본 양식 순서를 유지하고 Path/Query/Header/빈 예시를 제거한다", () => {
  const spec = fixture({ method: "POST", url: "/posts", request: { ...unused, body } });
  const markdown = specMarkdown(spec);
  assert.match(markdown, /# Request URL\n\n\/posts\n\n# HTTP Method\n\nPOST/);
  assert.match(markdown, /## Request Body/);
  assert.match(markdown, /\| key \| type \| description \|/);
  for (const section of ["Path Variable", "Query Param", "Header", "Request Example", "200 OK", "400 Bad Request"])
    assert.ok(!markdown.includes(section), section);
  assert.match(markdown, /204 No Content/);
  assert.match(markdown, /403 Forbidden/);
  assert.ok(!markdown.includes("postId (integer)"));
});

test("본문과 경로 변수를 동시에 사용하는 계약은 둘 다 유지하며 계약을 변경하지 않는다", () => {
  const spec = fixture({ method: "PATCH", request: { ...unused, body, example: { title: "새 제목" }, pathParameters: [{ key: "postId", type: "integer", description: "수정할 글" }] } });
  const before = JSON.stringify(spec);
  const markdown = specMarkdown(spec);
  assert.match(markdown, /## Path Variable/);
  assert.match(markdown, /## Request Body/);
  assert.match(markdown, /## Request Example\n\n```json/);
  assert.match(markdown, /새 제목/);
  assert.equal(JSON.stringify(spec), before);
  assert.ok(isApproved(spec));
  const modified = structuredClone(spec);
  modified.contract.request.body.fields[0].type = "integer";
  assert.throws(() => specMarkdown(modified), /승인/);
});

test("본문 미사용과 아직 미정인 항목을 구분하고 응답 코드를 채운다", () => {
  const markdown = specMarkdown(fixture({ request: unused, responses: [{ status: 403, body: null }] }));
  assert.match(markdown, /## Path Variable/);
  assert.doesNotMatch(markdown, /## Request Body|### Response|200 OK|400 Bad Request/);
  const legacy = specMarkdown(fixture());
  assert.match(legacy, /## Request Body\n\n미확정/);
  assert.match(legacy, /\| postId \| 미확정 \| 미확정 \|/);
  assert.match(legacy, /### Response\n\n미확정/);
});

test("Header/Query와 승인된 응답 필드/예시는 보존하고 미검증 조건도 남긴다", () => {
  const draft = structuredClone(source);
  draft.contract.request = { ...unused, headers: [{ key: "X-Request-ID", type: "string", description: "요청 ID" }], queryParameters: [{ key: "dryRun", type: "boolean", description: "미리보기" }] };
  draft.contract.responses = [{ status: 403, fields: [{ key: "message", type: "string", description: "실패 이유" }], example: { message: "권한 없음" } }];
  draft.requirements[0].conditions.push({ id: "unmapped", description: "관리자 예외", requiredScenarios: [] });
  const spec = approve(draft);
  const markdown = specMarkdown(spec);
  for (const text of ["Header", "X-Request-ID", "Query Param", "dryRun", "권한 없음", "UNVERIFIED", "관리자 예외"])
    assert.ok(markdown.includes(text), text);
  const blocks = specNotionBlocks(spec);
  assert.ok(blocks.some((b) => b.type === "table" && b.table.table_width === 3));
  assert.ok(blocks.some((b) => b.type === "code" && b.code.language === "json"));
});

test("서로 모순된 필드나 본문 예시는 삭제로 숨기지 않고 출력 전 차단한다", () => {
  assert.throws(() => specMarkdown(fixture({ request: { ...unused, pathParameters: [] } })), /일치/);
  assert.throws(() => specMarkdown(fixture({ request: { ...unused, example: {} } })), /미사용/);
  assert.throws(() => specMarkdown(fixture({ responses: [{ status: 204, example: {} }] })), /본문 없는/);
});

test("기존 저장소도 기본 양식을 적용하고 출력 양식/대상 변경 시 이전 게시 결과를 재사용하지 않는다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notion-template-"));
  try {
    const store = new Store(directory);
    assert.equal((await store.load()).settings.notionTemplate.id, DEFAULT_NOTION_TEMPLATE.id);
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ settings: { parentId: "old-parent", template: "메모" }, features: [] }));
    await store.init();
    const loaded = await store.load();
    assert.equal(loaded.settings.notionTemplate.url, undefined);
    assert.equal(loaded.settings.template, undefined);
    assert.equal(loaded.settings.notionPageUrl, undefined);
    assert.equal(loaded.settings.parentId, undefined);
    assert.equal(loaded.settings.legacyNotionDestination.parentId, "old-parent");
    const spec = fixture();
    assert.notEqual(publicationKey(spec), spec.approval.digest);
    assert.notEqual(publicationKey(spec, { parentId: "one" }), publicationKey(spec, { parentId: "two" }));
    assert.equal(publicationKey(spec), publicationKey(spec, { template: "이전 설정은 무시" }));
    assert.equal(specMarkdown(spec, "기존 추가 문구"), specMarkdown(spec));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Notion 전송은 원본 템플릿을 수정하지 않고 정리된 네이티브 블록으로 새 페이지만 생성한다", async () => {
  const spec = fixture({ method: "POST", url: "/posts", request: { ...unused, body } });
  let count = 0;
  const result = await publishNotion(spec, { token: "test-only", parentId: "a".repeat(32), fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, "https://api.notion.com/v1/pages");
    assert.equal(options.method, "POST");
    const payload = JSON.parse(options.body);
    assert.ok(payload.children.some((b) => b.type === "table"));
    assert.ok(payload.children.some((b) => b.type === "heading_1"));
    assert.ok(!JSON.stringify(payload).includes("Path Variable"));
    return { ok: true, json: async () => ({ id: "new-page", url: "https://www.notion.so/new-page" }) };
  } });
  assert.equal(count, 1);
  assert.equal(result.template.id, DEFAULT_NOTION_TEMPLATE.id);
});
