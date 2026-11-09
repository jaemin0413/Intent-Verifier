import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../lib/json-files.mjs";
import {
  approve,
  isApproved,
  freezeSnapshot,
  validateSpec,
  coverage,
  classify,
  supported,
  verificationExitCode,
} from "../lib/domain.mjs";
const input = await readJson(
  new URL("../examples/post-delete.json", import.meta.url),
);
test("승인 이후 Expected 변경은 실행 승인과 분리된다", () => {
  const spec = approve(input);
  assert.equal(isApproved(spec), true);
  spec.scenarios[1].expected.status = 204;
  assert.equal(isApproved(spec), false);
  assert.throws(() => freezeSnapshot(spec), /승인/);
});
test("동결 Snapshot은 원본 변경 및 직접 변경으로부터 보호된다", () => {
  const spec = approve(input);
  const snapshot = freezeSnapshot(spec);
  spec.scenarios[1].actor.id = "user-a";
  assert.equal(snapshot.spec.scenarios[1].actor.id, "user-b");
  assert.throws(() => {
    snapshot.spec.scenarios[1].expected.status = 204;
  }, TypeError);
});
test("잘못된 Actor-Target 관계는 승인할 수 없다", () => {
  const spec = structuredClone(input);
  spec.scenarios[1].actor.id = "user-a";
  assert.throws(() => approve(spec), /관계/);
});
test("CONFIRMED에는 원문 위치 근거가 필요하다", () => {
  const spec = structuredClone(input);
  spec.requirements[0].evidenceStatus = "CONFIRMED";
  assert.throws(() => validateSpec(spec), /근거/);
});
test("시나리오가 없는 조건도 Coverage 분모에 포함한다", () => {
  const spec = structuredClone(input);
  spec.requirements[0].conditions.push({
    id: "admin",
    description: "관리자 삭제",
    requiredScenarios: [],
  });
  const result = coverage(
    spec,
    spec.scenarios.map((s) => ({ scenarioId: s.id, status: "PASS" })),
  )[0];
  assert.equal(result.totalConditions, 3);
  assert.equal(result.verifiedConditions, 2);
  assert.equal(result.conditions[2].reason, "SCENARIO_MISSING");
});
test("응답이 기대와 같아도 Precondition이나 Observation 실패는 BLOCKED", () => {
  const s = input.scenarios[1];
  for (const evidence of [
    { scenarioId: s.id, preconditionOk: false },
    {
      scenarioId: s.id,
      preconditionOk: true,
      actionExecuted: true,
      observationComplete: false,
    },
  ])
    assert.equal(classify(s, evidence).status, "BLOCKED");
});
test("지원하지 않는 Observation을 축소하여 실행하지 않는다", () => {
  const s = structuredClone(input.scenarios[1]);
  s.observations.push("audit.event");
  assert.equal(supported(s, input.contract), false);
});
test("추가된 사전조건이나 Expected 필드를 무시하여 PASS하지 않는다", () => {
  const s = structuredClone(input.scenarios[1]);
  s.preconditions.accountBalance = 100;
  assert.equal(supported(s, input.contract), false);
  delete s.preconditions.accountBalance;
  s.expected.responseBody = { code: "FORBIDDEN" };
  assert.equal(supported(s, input.contract), false);
});
test("모든 생성 시나리오가 통과해도 미검증 조건이 있으면 종료 코드 3", () => {
  assert.equal(
    verificationExitCode([
      {
        counts: { PASS: 2, FAIL: 0, BLOCKED: 0, UNVERIFIED: 0 },
        coverage: [{ verifiedConditions: 2, totalConditions: 3 }],
      },
    ]),
    3,
  );
});
