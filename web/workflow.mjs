import {incompleteBackend,backendCoverage} from './verification-scope.mjs';
export function overall(report, feature) {
  if (!report) return "UNVERIFIED";
  if (report.specDigest !== feature?.spec?.approval?.digest) return "STALE";
  if (report.counts.FAIL) return "FAIL";
  if (report.counts.BLOCKED) return "BLOCKED";
  if (
    !report.results.length ||
    report.counts.UNVERIFIED ||
    incompleteBackend(report)
  )
    return "UNVERIFIED";
  return "PASS";
}
export function currentStep(feature, run, job) {
  if (job?.status === "RUNNING" && job.featureId === feature.id) return 3;
  if (
    feature.analysisStatus === "RUNNING" ||
    feature.analysisStatus === "ERROR"
  )
    return 0;
  if (["RUNNING","ERROR"].includes(feature.apiStatus) || (feature.apiStatus==="DONE"&&!feature.planStatus&&feature.answers) || ["RUNNING","ERROR"].includes(feature.planStatus)) return 2;
  if (feature.status === "READY")
    return run && run.specDigest === feature.spec?.approval?.digest ? 3 : 2;
  return feature.answers && feature.spec ? 2 : 1;
}
export function nextAction(feature, run) {
  if (feature.planStatus === "RUNNING") return "테스트 기준 작성 중";
  if (feature.planStatus === "ERROR") return "테스트 기준 다시 작성하기";
  if (feature.analysisStatus === "ERROR") return "다시 분석하기";
  if (feature.analysisStatus === "RUNNING") return "화면 분석 중";
  if (feature.status !== "READY")
    return feature.answers ? "테스트 기준 확인하기" : "질문 이어서 답하기";
  return run ? "다시 검사하기" : "검사 시작하기";
}
export function behavior(expected) {
  if (!expected) return "실행에 사용한 승인 명세를 확인해 주세요";
  if(Array.isArray(expected.checks)) return `응답 ${expected.status}${expected.statusPolicy?.origin === "ai_default" ? " (AI 기본값 · 동등한 차이는 참고)" : ""} · 응답 내용 ${expected.checks.length}개 조건${expected.database?.length ? " · DB 상태 "+expected.database.length+"개" : ""} 확인`;
  if(Array.isArray(expected.json)) return `응답 ${expected.status} · 대상 ${expected.targetExists ? "유지 ("+expected.targetState+")" : "삭제"}${expected.json.length ? " · 응답 내용 "+expected.json.length+"곳 확인" : ""}`;
  return expected?.targetExists === false
    ? "게시글 삭제를 허용하고 실제로 삭제"
    : expected?.status === 404
      ? "게시글의 존재를 숨기고 원본은 유지"
      : "삭제 권한이 없다고 알리고 게시글은 유지";
}
export function problemSentence(report, feature) {
  const status = overall(report, feature);
  if (status === "STALE")
    return "기획이 바뀌었습니다. 현재 기준으로 다시 검사해 주세요.";
  const failure = report?.results.find((r) => r.status === "FAIL");
  if(Array.isArray(failure?.evidence?.expected?.checks)) return `${failure.name}: ${failure.reason}`;
  if(Array.isArray(failure?.evidence?.expected?.json)) return `${failure.name}: ${failure.reason}`;
  if (
    failure?.evidence?.expected?.targetExists === true &&
    failure.evidence.after?.exists === false
  )
    return "삭제하면 안 되는 게시글이 실제로 삭제됩니다.";
  if (
    failure?.evidence?.expected?.status === 404 &&
    failure.evidence.response?.status === 403
  )
    return "게시글이 없는 것처럼 응답해야 하지만, 권한이 없다는 응답을 보냅니다.";
  if (
    failure?.evidence?.expected?.status === 204 &&
    failure.evidence.response?.status >= 400
  )
    return "삭제를 허용해야 하는 요청이 실제로는 거절됩니다.";
  if (failure) return `${failure.name}: 실제 동작이 승인한 기획과 다릅니다.`;
  if (status === "BLOCKED")
    return report.results.find(r=>r.status==="BLOCKED")?.reason || "실행 환경이나 관찰 문제로 동작을 판단하지 못했습니다.";
  if (status === "UNVERIFIED")
    return "아직 검사하지 못한 조건이 남아 있습니다.";
  return "선택한 백엔드 검사 범위가 모두 통과했습니다.";
}
export function handoffText(report, feature) {
  return [
    problemSentence(report, feature),
    `기능: ${feature.name}`,
    `검사 ID: ${report.id}`,
    `승인 기준: ${report.specDigest}`,
    ...report.results.map(
      (r) =>
        `${r.status} · ${r.name}\n기획: ${behavior(r.expected || r.evidence?.expected)}\n실제: ${r.evidence?.response ? `응답 ${r.evidence.response.status}, ${r.evidence.expected?.checks ? r.reason : "게시글 "+(r.evidence.after ? (r.evidence.after.exists ? "유지" : "삭제") : "관찰 못함")}` : r.reason}\n근거: ${JSON.stringify(r.evidence || {})}`,
    ),
    ...backendCoverage(report).map(
      (c) => `백엔드 조건 검증률: ${c.verifiedConditions}/${c.totalConditions}`,
    ),
  ].join("\n\n");
}
