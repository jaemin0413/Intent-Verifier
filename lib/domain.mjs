import {incompleteBackend} from '../web/verification-scope.mjs';
import { createHash, randomUUID } from "node:crypto";
import {validateApiSpec,supportedApi} from "./api-contract.mjs";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export const content = (spec) => ({
  feature: spec.feature,
  version: spec.version,
  requirements: spec.requirements,
  contract: spec.contract,
  scenarios: spec.scenarios,
});
export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
const id = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,90}$/.test(value);
function unique(items, label) {
  ensure(Array.isArray(items), `${label}: 배열이 필요합니다.`);
  const ids = items.map((x) => x.id);
  ensure(
    ids.every(id) && new Set(ids).size === ids.length,
    `${label}: 유효하고 고유한 ID가 필요합니다.`,
  );
}
export function validateSpec(spec) {
  if(spec?.contract?.kind === "controller-api-v1") return validateApiSpec(spec);
  ensure(spec && id(spec.feature?.id), "기능 ID가 필요합니다.");
  ensure(
    Number.isInteger(spec.version) && spec.version > 0,
    "양의 버전이 필요합니다.",
  );
  unique(spec.requirements, "Requirement");
  unique(spec.scenarios, "Scenario");
  const conditions = spec.requirements.flatMap((r) => r.conditions || []);
  unique(conditions, "Condition");
  for (const r of spec.requirements) {
    ensure(
      Number.isInteger(r.version) && r.version > 0 && r.description?.trim(),
      "Requirement 버전과 설명이 필요합니다.",
    );
    ensure(
      ["CONFIRMED", "INFERRED", "UNKNOWN"].includes(r.evidenceStatus),
      "근거 상태가 필요합니다.",
    );
    if (r.evidenceStatus === "CONFIRMED")
      ensure(
        r.evidence?.scanId &&
          r.evidence?.nodeIds?.length &&
          r.evidence?.excerpt,
        "CONFIRMED는 Scan, Node, 원문 근거가 필요합니다.",
      );
    ensure(r.conditions?.length, "Requirement에 검증 조건이 필요합니다.");
  }
  ensure(
    spec.contract &&
      id(spec.contract.id) &&
      Number.isInteger(spec.contract.version) &&
      spec.contract.version > 0,
    "Contract ID와 버전이 필요합니다.",
  );
  ensure(
    [spec.contract.success, spec.contract.forbidden].every(
      (s) => Number.isInteger(s) && s >= 100 && s <= 599,
    ),
    "API 응답 상태를 명시해야 합니다.",
  );
  ensure(
    typeof spec.contract.path === "string" &&
      /^\/[\w/{}-]+$/.test(spec.contract.path),
    "유효한 API 경로가 필요합니다.",
  );
  for (const c of conditions) {
    ensure(
      Array.isArray(c.requiredScenarios) &&
        new Set(c.requiredScenarios).size === c.requiredScenarios.length,
      "필수 Scenario 목록이 필요합니다.",
    );
    ensure(
      c.requiredScenarios.every((s) =>
        spec.scenarios.some((x) => x.id === s && x.conditionId === c.id),
      ),
      "Condition 연결이 일치하지 않습니다.",
    );
  }
  for (const s of spec.scenarios) {
    const req = spec.requirements.find((r) =>
      r.conditions.some((c) => c.id === s.conditionId),
    );
    ensure(
      req &&
        s.requirementVersion === req.version &&
        s.contractVersion === spec.contract.version,
      "Scenario의 참조 버전이 일치하지 않습니다.",
    );
    ensure(
      Number.isInteger(s.version) && s.version > 0,
      "Scenario 버전이 필요합니다.",
    );
    ensure(
      id(s.actor?.id) && id(s.target?.owner),
      "Actor와 소유자가 필요합니다.",
    );
    ensure(
      s.actor.state === "normal_authenticated_user",
      "첫 버전은 정상 인증 사용자를 지원합니다.",
    );
    ensure(
      typeof s.relation?.actorIsOwner === "boolean" &&
        s.relation.actorIsOwner === (s.actor.id === s.target.owner),
      "Actor-Target 관계가 모순됩니다.",
    );
    ensure(
      s.target.resource === "post" &&
        Number.isInteger(s.target.id) &&
        s.target.id > 0,
      "게시글 Target이 필요합니다.",
    );
    ensure(
      s.preconditions?.exists === true &&
        s.preconditions?.targetState === "normal",
      "존재하는 정상 게시글 사전조건이 필요합니다.",
    );
    ensure(
      s.action?.method === spec.contract.method &&
        s.action?.path === spec.contract.path,
      "Action은 승인 API Contract와 일치해야 합니다.",
    );
    ensure(
      Number.isInteger(s.expected?.status) &&
        s.expected.status >= 100 &&
        s.expected.status <= 599 &&
        typeof s.expected.targetExists === "boolean",
      "명시적인 Expected가 필요합니다.",
    );
    ensure(
      [spec.contract.success, spec.contract.forbidden].includes(
        s.expected.status,
      ),
      "Scenario Expected가 API Contract에 없는 응답입니다.",
    );
    ensure(
      Array.isArray(s.observations) &&
        s.observations.includes("response.status") &&
        s.observations.includes("target.exists"),
      "필수 Observation이 필요합니다.",
    );
  }
  return spec;
}
export function approve(spec, actor = "local-user") {
  validateSpec(spec);
  const copy = structuredClone(spec);
  for (const requirement of copy.requirements) {
    if(requirement.approvalStatus === 'REJECTED') ensure(requirement.conditions.every(c=>!c.requiredScenarios.length),'제외한 요구사항에는 실행 시나리오를 연결할 수 없습니다.');
    else requirement.approvalStatus = 'APPROVED';
  }
  copy.approval = {
    status: "APPROVED",
    by: actor,
    at: new Date().toISOString(),
    digest: digest(content(copy)),
  };
  return copy;
}
export function isApproved(spec) {
  return (
    spec?.approval?.status === "APPROVED" &&
    spec.approval.digest === digest(content(spec))
  );
}
export function freezeSnapshot(spec) {
  validateSpec(spec);
  ensure(
    isApproved(spec),
    "승인된 버전 조합이 없거나 승인 이후 내용이 변경되었습니다.",
  );
  const snapshot = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    spec: structuredClone(spec),
    specDigest: digest(content(spec)),
  };
  const freeze = (v) => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(snapshot);
}
export function supported(s, contract) {
  if(contract.kind === "controller-api-v1") return supportedApi(s,contract);
  const only = (value, keys) =>
    value && Object.keys(value).every((k) => keys.includes(k));
  return (
    s.behavior === "ownership-delete" &&
    contract.method === "DELETE" &&
    contract.path === "/posts/{postId}" &&
    // Export supports richer contracts than this first execution harness.
    // Never silently drop documented request/response requirements at runtime.
    (contract.request === undefined || (
      only(contract.request, ["headers", "pathParameters", "queryParameters", "body"]) &&
      Array.isArray(contract.request.headers) && contract.request.headers.length === 0 &&
      Array.isArray(contract.request.queryParameters) && contract.request.queryParameters.length === 0 &&
      contract.request.body === null &&
      Array.isArray(contract.request.pathParameters) && contract.request.pathParameters.length === 1 &&
      contract.request.pathParameters[0].key === "postId" &&
      contract.request.pathParameters[0].type === "integer" &&
      only(contract.request.pathParameters[0], ["key", "type", "description"])
    )) &&
    contract.responses === undefined &&
    only(s, [
      "id",
      "version",
      "requirementVersion",
      "contractVersion",
      "conditionId",
      "name",
      "behavior",
      "actor",
      "target",
      "relation",
      "preconditions",
      "action",
      "expected",
      "observations",
    ]) &&
    only(s.actor, ["id", "state"]) &&
    only(s.target, ["id", "resource", "owner"]) &&
    only(s.relation, ["actorIsOwner"]) &&
    only(s.preconditions, ["exists", "targetState"]) &&
    only(s.action, ["method", "path"]) &&
    only(s.expected, ["status", "targetExists"]) &&
    s.observations.every((o) =>
      [
        "response.status",
        "target.exists",
        "target.owner",
        "target.state",
      ].includes(o),
    )
  );
}
// What the AI planning read, so a later approval can prove the answers did not change underneath.
export const planInputDigest=(feature,answers)=>digest({scan:feature.scan,analysis:feature.analysis,answers});
export function classify(s, e) {
  if (!e || e.unsupported)
    return { status: "UNVERIFIED", reason: e?.reason || "실행 근거 없음" };
  if (
    e.scenarioId !== s.id ||
    e.preconditionOk !== true ||
    e.actionExecuted !== true ||
    e.observationComplete !== true ||
    e.error
  )
    return {
      status: "BLOCKED",
      reason: e.error || "실행 단계의 필수 근거 부족",
    };
  if (
    e.before?.exists !== true ||
    e.before.owner !== s.target.owner ||
    e.before.state !== s.preconditions.targetState ||
    e.actor?.id !== s.actor.id ||
    e.actor.enabled !== true ||
    e.actualRequestActor !== s.actor.id ||
    e.actorTargetRelation?.actorIsOwner !== s.relation.actorIsOwner ||
    e.action?.method !== s.action.method ||
    e.action?.uri !== s.action.path.replace("{postId}", String(s.target.id)) ||
    !e.handler ||
    !Number.isInteger(e.response?.status) ||
    typeof e.after?.exists !== "boolean"
  )
    return {
      status: "BLOCKED",
      reason:
        "실제 실행 근거가 승인된 Actor·Target·Action 또는 Observation과 일치하지 않습니다.",
    };
  const mismatch = [];
  if (e.response.status !== s.expected.status)
    mismatch.push(`응답: 기대 ${s.expected.status}, 실제 ${e.response.status}`);
  if (e.after.exists !== s.expected.targetExists)
    mismatch.push(
      `게시글 존재: 기대 ${s.expected.targetExists}, 실제 ${e.after.exists}`,
    );
  if (
    s.expected.targetExists &&
    e.after.exists &&
    (e.after.owner !== s.target.owner ||
      e.after.state !== s.preconditions.targetState)
  )
    mismatch.push("게시글 소유자 또는 상태가 변경됨");
  return {
    status: mismatch.length ? "FAIL" : "PASS",
    reason: mismatch.length
      ? mismatch.join(" · ")
      : "승인된 응답과 데이터 상태 일치",
  };
}
export function coverage(spec, results) {
  return spec.requirements.map((r) => {
    const conditions = r.conditions.map((c) => {
      const found = c.requiredScenarios.map((id) =>
        results.find((x) => x.scenarioId === id),
      );
      const verified =
        r.approvalStatus !== 'REJECTED' && found.length > 0 && found.every((x) => x?.status === "PASS");
      return {
        ...c,
        verified,
        reason: r.approvalStatus === 'REJECTED' ? 'REQUIREMENT_REJECTED' : !found.length
          ? "SCENARIO_MISSING"
          : verified
            ? "ALL_PASSED"
            : "INCOMPLETE",
        results: found.map(
          (x, i) =>
            x || { scenarioId: c.requiredScenarios[i], status: "UNVERIFIED" },
        ),
      };
    });
    return {
      requirementId: r.id,
      approvalStatus: r.approvalStatus || 'APPROVED',
      description: r.description,
      verifiedConditions: conditions.filter((c) => c.verified).length,
      totalConditions: conditions.length,
      conditions,
    };
  });
}
export function verificationExitCode(reports) {
  if (reports.some((r) => r.counts.FAIL)) return 1;
  if (reports.some((r) => r.counts.BLOCKED)) return 2;
  if (
    reports.some(
      (r) =>
        r.counts.UNVERIFIED ||
        incompleteBackend(r),
    )
  )
    return 3;
  return 0;
}
