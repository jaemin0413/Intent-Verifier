import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.mjs";
import { readJson } from "../lib/json-files.mjs";
import { planStoredFeature } from "./fixtures/sample-plan.mjs";
test("로컬 API: 원문 → 질문 → 승인 → 명세 → 재스캔과 승인 해제", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verification-api-"));
  let publicationRequests=0;
  const { server,store } = await createServer({ directory, port: 4329,notionFetch:async()=>{publicationRequests++;return {ok:false,status:403,json:async()=>({message:'test connection denied'})};} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (await fetch(base + "/api/session").then((r) => r.json()))
    .token;
  async function api(route, body) {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { "X-Local-Token": token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/session", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      400,
    );
    const scan = await readJson(
      new URL("../examples/figma-scan.json", import.meta.url),
    );
    const added = await api("/api/scans", {
      projectId: "local",
      scan,
      localOnly: true,
    });
    assert.equal(added.status, 201);
    const id = added.data.feature.id;
    assert.equal(added.data.feature.status, "DRAFT");
    assert.equal((await api("/api/verify", { featureId: id })).status, 400);
    const kept = await api(`/api/features/${id}/draft`, { extraAnswers: [] });
    assert.equal(kept.status, 200, JSON.stringify(kept.data));
    assert.equal(kept.data.spec.contract.status, "UNRESOLVED", "API 계획 없는 답변은 미확정 계약으로 보관한다");
    assert.equal((await api(`/api/features/${id}/approve`, { version: 1 })).status, 400);
    const draft = await planStoredFeature(store, id);
    assert.equal(draft.version, 2);
    await store.saveSecrets({notionToken:'test-only'});
    await store.mutate(s=>{s.projects.find(p=>p.id==='local').notion={parentId:'a'.repeat(32)};});
    assert.equal(
      (await api(`/api/features/${id}/approve`, { version: 2 })).data.status,
      "READY",
    );
    const approved = await api(`/api/features/${id}/spec`);
    assert.equal(approved.data.approval.status, "APPROVED");
    assert.equal((await api('/api/state')).data.jobs.length,0,'승인은 검사 작업을 시작하지 않는다');
    for(let i=0;i<30&&!publicationRequests;i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(publicationRequests>0,'테스트 결과 없이 승인 직후 Notion 전송을 시도한다');
    const exported = await fetch(base + `/api/features/${id}/markdown`, {
      headers: { "X-Local-Token": token },
    }).then((r) => r.text());
    assert.match(exported, /\/api\/items/);
    const reopened = await api(`/api/features/${id}/reopen`, {});
    assert.equal(reopened.data.status, "DRAFT");
    assert.equal(reopened.data.spec.approval, undefined);
    assert.equal((await api("/api/verify", { featureId: id })).status, 400);
    const revised = await planStoredFeature(store, id, { extraAnswers: ["변경"] });
    assert.equal(revised.version, 3);
    assert.equal(
      (await api(`/api/features/${id}/approve`, { version: 2 })).status,
      400,
    );
    assert.equal(
      (await api(`/api/features/${id}/approve`, { version: 3 })).data.status,
      "READY",
    );
    const updated = await api("/api/scans", {
      projectId: "local",
      featureId: id,
      scan,
      localOnly: true,
    });
    assert.equal(updated.data.feature.status, "DRAFT");
    assert.equal(updated.data.feature.spec.approval, undefined);
    assert.equal(
      (await api(`/api/features/${id}/approve`, { version: 3 })).status,
      400,
    );
    const state = await api("/api/state");
    assert.equal(state.data.features.find((f) => f.id === id).scan.nodes, undefined);
    assert.ok(
      (await api(`/api/features/${id}/source`)).data.history.some((h) => h.approval?.status === "APPROVED"),
      "이전 승인본은 기록에 남는다",
    );
    assert.equal(JSON.stringify(state.data).includes("apiKey"), false);
    const badPlugin = await fetch(base + "/api/plugin/projects", {
      headers: { Authorization: "Bearer bad" },
    });
    assert.equal(badPlugin.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
