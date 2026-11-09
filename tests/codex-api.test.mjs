import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.mjs";
const scan = JSON.parse(
  await readFile(
    new URL("../examples/figma-scan.json", import.meta.url),
    "utf8",
  ),
);
test("비동기 Codex 분석 실패 시 원문을 보존하고 실패 종류와 재시도를 제공한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-api-"));
  let rejectAnalysis, resolveAnalysis;
  const runtime = {
    status: async () => ({ status: "CONNECTED" }),
    connect: async () => ({ status: "CONNECTED" }),
    analyze: () =>
      new Promise((resolve, reject) => {
        rejectAnalysis = reject;
        resolveAnalysis = resolve;
      }),
    close() {},
  };
  const { server } = await createServer({ directory, runtime });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const token = (await fetch(base + "/api/session").then((r) => r.json()))
    .token;
  const api = async (route, body) => {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { "X-Local-Token": token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      const result = await fn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("state timeout");
  };
  try {
    const added = await api("/api/scans", { projectId: "local", scan });
    const id = added.feature.id;
    await until(() => rejectAnalysis);
    const loading = (await api("/api/state")).features.find((f) => f.id === id);
    assert.equal(loading.analysisStatus, "RUNNING");
    assert.equal(loading.scan.nodeCount, scan.nodes.length);
    assert.deepEqual((await api(`/api/features/${id}/source`)).scan.nodes, scan.nodes);
    assert.equal(loading.analysis.mode, "local");
    rejectAnalysis(new Error("usageLimitExceeded"));
    const failed = await until(async () => {
      const f = (await api("/api/state")).features.find((f) => f.id === id);
      return f.analysisStatus === "ERROR" ? f : null;
    });
    assert.equal(failed.analysisError.code, "USAGE_LIMIT");
    assert.equal(failed.status, "DRAFT");
    assert.equal(failed.analysis.execution, undefined);
    rejectAnalysis = null;
    await api(`/api/features/${id}/analyze`, {});
    await until(() => rejectAnalysis);
    resolveAnalysis({
      result: {
        featureName: "삭제",
        summary: "실제 호출 대신 주입한 테스트 결과",
        policyHint: "unknown",
        deniedHint: "unknown",
        findings: [],
        questions: ["댓글도 삭제하나요?"],
      },
      evidence: { provider: "codex", threadId: "test-only" },
    });
    const done = await until(async () => {
      const f = (await api("/api/state")).features.find((f) => f.id === id);
      return f.analysisStatus === "DONE" ? f : null;
    });
    assert.equal(done.analysis.mode, "codex");
    assert.equal(done.spec, undefined);
    assert.equal(done.scan.id, failed.scan.id);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
  }
});
