import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeScan,
  validateScan,
  specMarkdown,
  publishNotion,
} from "../lib/integrations.mjs";
import { readJson } from "../lib/json-files.mjs";
import { approve } from "../lib/domain.mjs";
const scan = await readJson(
  new URL("../examples/figma-scan.json", import.meta.url),
);
const spec = await readJson(
  new URL("../examples/post-delete.json", import.meta.url),
);
test("기본 분석은 원문만 보관하고 어떤 기능인지 추측하지 않는다", async () => {
  const analysis = await analyzeScan(scan, { localOnly: true });
  assert.equal(analysis.mode, "local");
  assert.equal(analysis.scope.length, 2);
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.supportedCandidate, undefined);
  assert.equal(analysis.question, undefined);
});
test("AI 출력을 사용해도 해석을 자동 CONFIRMED/승인 처리하지 않는다", async () => {
  const analysis = await analyzeScan(scan, {
    runtime: {
      analyze: async (input) => {
        assert.equal(input.schema.additionalProperties, false);
        assert.match(input.instructions, /Never read files/);
        return {
          result: {
            featureName: "게시글 삭제",
            summary: "후보",
            findings: [
              {
                text: "누구나 삭제 가능",
                evidenceStatus: "CONFIRMED",
                nodeIds: ["missing"],
                quote: "없는 문장",
              },
            ],
            questions: ["취소는?"],
          },
          evidence: { provider: "codex" },
        };
      },
    },
  });
  assert.equal(analysis.mode, "codex");
  assert.equal(analysis.findings[0].evidenceStatus, "INFERRED");
  assert.deepEqual(analysis.findings[0].nodeIds, []);
  assert.equal(analysis.approval, undefined);
});
test("AI 장애는 규칙 분석 또는 유료 API로 대체하지 않는다", async () => {
  await assert.rejects(
    analyzeScan(scan, {
      runtime: {
        analyze: async () => {
          throw new Error("usage limit");
        },
      },
    }),
    /usage limit/,
  );
  await assert.rejects(analyzeScan(scan), /AI를 연결/);
});
test("Notion 출력은 승인된 내용만 전송하고 기존 페이지를 덮어쓰지 않는다", async () => {
  assert.throws(() => specMarkdown(spec), /승인/);
  const approved = approve(spec);
  let payload;
  const result = await publishNotion(approved, {
    token: "test-token",
    parentId: "a".repeat(32),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.notion.com/v1/pages");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Notion-Version"], "2025-09-03");
      payload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          id: "page-id",
          url: "https://www.notion.so/page-id",
        }),
      };
    },
  });
  assert.equal(payload.parent.page_id, "a".repeat(32));
  assert.ok(JSON.stringify(payload).includes("403"));
  assert.equal(result.digest, approved.approval.digest);
});
test("Scan이 비었거나 이미지가 임의의 외부 URL이면 거부한다", () => {
  assert.throws(() => validateScan({ nodes: [] }));
  assert.throws(() =>
    validateScan({
      ...scan,
      images: [{ dataUrl: "https://example.com/secret.png" }],
    }),
  );
});
