import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.mjs";
import { AiRouter } from "../lib/ai-runtime.mjs";
import { MemberBridge } from "../lib/member-bridge.mjs";
import { runMemberAi } from "../lib/member-ai-client.mjs";
import { proposeApiTests } from "../lib/api-plan.mjs";

const host = "tool.example.com", member = "c".repeat(32), stranger = "d".repeat(32), link = "a".repeat(64);
const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const wait = async (check) => { for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await check()); };

function send(port, route, { method = "POST", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, signal, headers: { Host: host, "Content-Type": "application/json", ...headers } }, (res) => {
      let text = ""; res.on("data", (d) => (text += d));
      res.on("end", () => resolve(new Response(res.statusCode === 204 ? null : text, { status: res.statusCode })));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("팀원 PC의 Claude가 그 팀원의 요청만 처리하고 로그인 정보는 서버에 남지 않는다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "member-pc-"));
  const { server, runtime } = await createServer({ directory, runDirectory: path.join(directory, "runs"), publicUrl: `https://${host}`, linkKey: link, adminKey: "x" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let stopped = false;
  runtime.bridge.pollMs = 30;
  try {
    const { token } = await (await send(port, "/api/session", { method: "GET", headers: { "X-App-Key": link } })).json();
    const app = { "X-Local-Token": token, "X-Member-Id": member };
    assert.equal((await send(port, "/api/member-ai/next", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const { command } = await (await send(port, "/api/ai/member/pc/start", { headers: app, body: "{}" })).json();
    const pcToken = command.match(/--token ([a-f0-9]{64})/)[1];
    assert.match(command, new RegExp(`--url https://${host} `));
    assert.equal((await (await send(port, "/api/ai/member", { method: "GET", headers: app })).json()).status, "PC_WAITING");
    await assert.rejects((await runtime.forMember(member)).analyze({ nodes: {}, schema, instructions: "x" }), /연결 창이 꺼져/);

    const seen = [];
    const client = runMemberAi({
      url: `http://127.0.0.1:${port}`, token: pcToken, log: () => {}, retryMs: 5, stop: () => stopped,
      runtime: { status: async () => ({ status: "CONNECTED" }), analyze: async (input) => { seen.push(input); return { result: { ok: true }, evidence: { provider: "claude", auth: "subscription" } }; } },
      fetchImpl: (url, { headers, body, signal }) => send(port, url.pathname, { headers, body, signal }),
    }).catch((e) => e);
    await wait(async () => (await (await send(port, "/api/ai/member", { method: "GET", headers: app })).json()).status === "CONNECTED");
    const answered = await (await runtime.forMember(member)).analyze({ nodes: { a: 1 }, images: [], schema, instructions: "규칙", model: "opus" });
    assert.deepEqual(answered.result, { ok: true });
    assert.equal(answered.evidence.account, "member");
    assert.equal(answered.evidence.location, "member-pc");
    assert.deepEqual(seen[0], { nodes: { a: 1 }, images: [], schema, instructions: "규칙" });
    assert.equal(await runtime.forMember(stranger), runtime, "다른 팀원의 요청은 이 PC로 가지 않는다");

    const stored = await readFile(path.join(directory, "member-bridge.json"), "utf8");
    assert.ok(!stored.includes(pcToken), "연결 토큰은 해시로만 저장한다");
    const { command: next } = await (await send(port, "/api/ai/member/pc/start", { headers: app, body: "{}" })).json();
    assert.notEqual(next.match(/--token (\w+)/)[1], pcToken);
    assert.match((await client).message, /연결이 해제/, "새 명령을 받으면 이전 명령은 끊긴다");
  } finally {
    stopped = true;
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("작업 중 PC가 사라지거나 형식이 틀린 답이 오면 성공으로 처리하지 않는다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "member-bridge-"));
  let clock = 1000;
  const bridge = new MemberBridge({ file: path.join(directory, "t.json"), pollMs: 5, offlineMs: 100, sweepMs: 2, now: () => clock });
  const router = new AiRouter({ shared: true, providers: { codex: {}, claude: {}, gemini: {} }, bridge });
  try {
    await bridge.issue(member);
    await bridge.next(member);
    const pending = (await router.forMember(member)).analyze({ nodes: {}, schema, instructions: "x" });
    const job = await bridge.next(member);
    bridge.finish(member, { id: job.id, result: { ok: "아니요" }, evidence: {} });
    await assert.rejects(pending, /schema/);
    assert.throws(() => bridge.finish(stranger, { id: "없음" }), /요청을 찾지/);
    const lost = (await router.forMember(member)).analyze({ nodes: {}, schema, instructions: "x" });
    clock += 1000;
    await assert.rejects(lost, /연결 창이 꺼져/);
    await router.disconnectMember(member);
    assert.equal(await bridge.registered(member), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI가 조건 목록을 형식에 맞지 않게 돌려주면 한 번 더 요청한다", async () => {
  const feature = { analysis: { findings: [{ text: "일정 조회", quote: "일정", nodeIds: ["n"] }], questions: [] }, scan: { images: [], nodes: [] }, name: "화면" };
  const catalog = { endpoints: [{ id: "e1", method: "GET", path: "/items" }] }, bad = { result: { conditions: [{ id: "BAD ID", kind: "value", findingIndices: [0], answerIndices: [] }] } };
  const good = { result: { conditions: [{ id: "c-1", kind: "value", findingIndices: [0], answerIndices: [] }] } };
  let calls = 0;
  const retried = { analyze: async () => { calls++; if (calls === 1) return bad; if (calls === 2) return good; throw new Error("다음 단계 도달"); } };
  await assert.rejects(proposeApiTests(feature, {}, catalog, ["e1"], { runtime: retried }), /다음 단계 도달/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(proposeApiTests(feature, {}, catalog, ["e1"], { runtime: { analyze: async () => { calls++; return bad; } } }), /독립 항목/);
  assert.equal(calls, 2);
});

test("개인 AI도 기본 AI도 없는 팀원에게는 내 AI 연결을 안내한다", async () => {
  const provider = { analyze: async () => "실행" };
  const missing = new AiRouter({ shared: true, providers: { codex: provider, claude: provider, gemini: provider }, hasDefault: async () => false });
  await assert.rejects(missing.analyze({}), /내 AI에서/);
  assert.equal(await new AiRouter({ shared: true, providers: { codex: provider, claude: provider, gemini: provider } }).analyze({}), "실행");
});

test("Notion 명세 정리는 요청한 팀원의 AI로 실행한다", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /publisher\.automatic\(id, undefined, await runtimeFor\(req\)\)/);
  assert.match(server, /publisher\.publish\(id, \{ runtime: await runtimeFor\(req\) \}\)/);
  assert.match(server, /publisher\.automatic\(feature\.id,report,runtime\)/);
});
