#!/usr/bin/env node
// Runs the approved features of a connected project against the running app, for CI or a terminal.
import { ensure, isApproved, verificationExitCode } from "./lib/domain.mjs";
const args = process.argv.slice(2),
  command = args[0];
const value = (flag) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const base = value("--url") || "http://127.0.0.1:4318";
async function api(route, body) {
  const session = await fetch(base + "/api/session").then((r) => r.json());
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Token": session.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  ensure(response.ok, data.error || "로컬 서비스 연결 실패");
  return data;
}
try {
  if (command === "verify") {
    const projectId = value("--project") || "local";
    const data = await api("/api/state");
    const project = data.projects.find((p) => p.id === projectId);
    ensure(project?.backend?.repository, "앱의 프로젝트 설정에서 백엔드 폴더를 먼저 연결해 주세요.");
    const features = data.features.filter(
      (f) => f.projectId === projectId && f.status === "READY" && isApproved(f.spec) && (!value("--feature") || f.id === value("--feature")),
    );
    ensure(features.length, "검증할 승인 기능이 없습니다. 화면에서 기획을 먼저 확정해 주세요.");
    const reports = [];
    for (const f of features) {
      console.log(`검증: ${f.name} · v${f.spec.version} · ${f.spec.approval.digest.slice(0, 12)}`);
      const job = await api("/api/verify", { featureId: f.id });
      let status = job;
      while (status.status === "RUNNING") { await new Promise((r) => setTimeout(r, 1000)); status = await api("/api/jobs/" + job.id); }
      ensure(status.status === "DONE", status.error || "검사를 완료하지 못했습니다.");
      reports.push(await api("/api/runs/" + status.runId));
    }
    for (const report of reports) {
      for (const r of report.results) console.log(`${r.status.padEnd(10)} ${r.name} — ${r.reason}`);
      for (const c of report.coverage) console.log(`조건 검증: ${c.verifiedConditions}/${c.totalConditions}${c.verifiedConditions < c.totalConditions ? " (미검증 또는 실패 조건 포함)" : ""}`);
      console.log("실행 근거:", report.runDir);
    }
    process.exitCode = verificationExitCode(reports);
  } else console.log("사용법:\n  tool verify [--project 프로젝트ID] [--feature 기능ID] [--url http://127.0.0.1:4318]");
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
