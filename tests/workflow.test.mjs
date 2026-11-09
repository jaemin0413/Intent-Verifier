import test from "node:test";
import assert from "node:assert/strict";
import {
  currentStep,
  nextAction,
  overall,
  problemSentence,
  handoffText,
} from "../web/workflow.mjs";
import { classifyCodexError, AnalysisError } from "../lib/codex.mjs";
import { buildIntent } from "../lib/store.mjs";
const feature = {
  id: "f",
  name: "삭제",
  status: "READY",
  spec: { approval: { digest: "v1" } },
};
const pass = {
  id: "run",
  specDigest: "v1",
  counts: { PASS: 1 },
  results: [{ status: "PASS" }],
  coverage: [{ verifiedConditions: 1, totalConditions: 1 }],
};
test("현재 단계와 작업 버튼은 승인 및 실제 실행 여부로 결정한다", () => {
  assert.equal(currentStep({ ...feature, status: "DRAFT" }, null), 1);
  assert.equal(currentStep(feature, null), 2);
  assert.equal(currentStep(feature, pass), 3);
  assert.equal(currentStep(feature, { ...pass, specDigest: "old" }), 2);
  assert.equal(nextAction(feature, null), "검사 시작하기");
  assert.equal(nextAction(feature, pass), "다시 검사하기");
  assert.equal(
    nextAction({ ...feature, status: "DRAFT" }, null),
    "질문 이어서 답하기",
  );
});
test("실제 PASS 이외 준비·미검증·이전 기준을 전체 통과로 표현하지 않는다", () => {
  assert.equal(overall(null, feature), "UNVERIFIED");
  assert.equal(overall(pass, feature), "PASS");
  assert.equal(
    overall(
      { ...pass, coverage: [{ verifiedConditions: 1, totalConditions: 2 }] },
      feature,
    ),
    "UNVERIFIED",
  );
  assert.equal(overall({ ...pass, specDigest: "old" }, feature), "STALE");
  assert.equal(
    overall({ ...pass, counts: { BLOCKED: 1 } }, feature),
    "BLOCKED",
  );
});
test("실제 문제 문장과 개발자 전달 내용에 Expected와 Evidence가 남는다", () => {
  const r = {
    ...pass,
    counts: { FAIL: 1 },
    results: [
      {
        name: "타인 삭제",
        status: "FAIL",
        evidence: {
          expected: { status: 403, targetExists: true },
          response: { status: 204 },
          after: { exists: false },
        },
      },
    ],
  };
  assert.match(problemSentence(r, feature), /삭제하면 안 되는/);
  assert.match(handoffText(r, feature), /403/);
  assert.match(handoffText(r, feature), /204/);
});
test("Codex 로그인·한도·설치·일반 실패를 구분한다", () => {
  assert.equal(
    classifyCodexError(new Error("401 Unauthorized")).code,
    "LOGIN_REQUIRED",
  );
  assert.equal(
    classifyCodexError(new Error("usageLimitExceeded")).code,
    "USAGE_LIMIT",
  );
  assert.equal(
    classifyCodexError(new Error("network")).code,
    "NETWORK_ERROR",
  );
  assert.equal(
    classifyCodexError(new AnalysisError("RUNTIME_MISSING", "missing")).code,
    "RUNTIME_MISSING",
  );
});
test("AI 질문에 답해도 실행 Harness가 없는 조건은 미검증으로 보존한다", async () => {
  const spec = await buildIntent(
    {
      id: "f",
      name: "삭제",
      analysis: {
        mode: "codex",
        findings: [],
        questions: ["삭제 기록을 남기나요?"],
      },
    },
    { policy: "owner", deniedStatus: 403, extraAnswers: ["30일 보관"] },
  );
  const condition = spec.requirements[0].conditions.at(-1);
  assert.match(condition.description, /30일 보관/);
  assert.deepEqual(condition.requiredScenarios, []);
});

test("API 선택 후 실행 결과와 답변 수정 단계가 새로고침에도 유지된다",()=>{
 const f={id:'api',apiStatus:'DONE',planStatus:'DONE',status:'READY',spec:{approval:{digest:'approved'}},answers:{}};assert.equal(currentStep(f,{specDigest:'approved'}),3);delete f.planStatus;f.answers=null;f.status='DRAFT';assert.equal(currentStep(f),1);f.answers={};assert.equal(currentStep(f),2);
});
