import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { notionDestination } from "../lib/notion-destination.mjs";
import { createServer } from "../server.mjs";

test("앱 진입점과 모든 상대 모듈을 실제 HTTP로 불러올 수 있다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "app-modules-"));
  const { server } = await createServer({ directory, runtime: { close() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const entry = await fetch(base + "/");
    assert.equal(entry.status, 200);
    const html = await entry.text();
    const pending = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map((m) => new URL(m[1], base));
    assert.ok(pending.length > 0);
    const visited = new Set();
    while (pending.length) {
      const url = pending.pop();
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      const response = await fetch(url);
      assert.equal(response.status, 200, url.pathname);
      assert.match(response.headers.get("content-type"), /javascript/, url.pathname);
      const code = await response.text();
      for (const match of code.matchAll(/\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) pending.push(new URL(match[1], url));
    }
    assert.ok(visited.size > 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("노션 공유 링크에서 페이지 ID를 추출하며 보기 ID와 외부 주소는 사용하지 않는다", () => {
  const id = "11111111111141118111111111111111";
  for (const url of [
    `https://app.notion.com/p/API-${id}?source=copy_link`,
    `https://www.notion.so/API-${id}?v=${"a".repeat(32)}`,
    "https://team.notion.site/11111111-1111-4111-8111-111111111111",
    `https://www.notion.so/${"a".repeat(32)}?p=${id}`,
  ]) assert.deepEqual(notionDestination(url), { parentId: id, notionPageUrl: `https://www.notion.so/${id}` });
  for (const invalid of [id, `https://notion.so.evil.test/${id}`, `http://notion.so/${id}`, `https://www.notion.so/?v=${id}`, `https://user:pass@notion.so/${id}`])
    assert.throws(() => notionDestination(invalid), /링크|페이지/);
  assert.deepEqual(notionDestination(""), { parentId: "", notionPageUrl: "" });
});

test("연결 설정 API는 링크를 저장하고 제거된 문구를 무시하며 유효하지 않은 링크에 기존 설정을 보존한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "connection-ux-"));
  const { server, store } = await createServer({ directory, runtime: { close() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(base + "/api/session").then((r) => r.json());
  const send = (data) => fetch(base + "/api/settings", { method: "POST", headers: { "X-Local-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    const id = "a".repeat(32);
    assert.equal((await send({ notionToken: "test-key", template: "제거해야 할 문구" })).status, 200);
    const projectResponse = await fetch(base + "/api/projects/local/notion", { method: "POST", headers: { "X-Local-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({notionPageUrl: `https://www.notion.so/API-${id}`}) });
    assert.equal(projectResponse.status, 200);
    assert.equal((await store.load()).projects[0].notion.parentId, id);
    const settings = (await store.load()).settings;
    assert.equal(settings.parentId, undefined);
    assert.equal(settings.notionPageUrl, undefined);
    assert.equal(settings.template, undefined);
    assert.equal((await send({ notionPageUrl: "invalid", notionToken: "do-not-save" })).status, 400);
    assert.equal((await store.secrets()).notionToken, "test-key");
    assert.equal((await send({ notionApiToken: " api-key " })).status, 200);
    assert.deepEqual([(await store.secrets()).notionToken, (await store.secrets()).notionApiToken], ["test-key", "api-key"]);
    assert.deepEqual((await store.load()).settings, settings);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Figma 플러그인은 한 번 누르면 추출 후 자동 POST하고 JSON은 전송 실패 때만 표시한다", async () => {
  const html = await readFile(new URL("../figma-plugin/ui.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  for (const id of ["token", "base", "project", "feature", "scan", "status", "connection", "selection", "open", "download", "connect", "sync", "sync-page", "sync-retry", "sync-cancel", "source-file-url", "file-link-field", "reconnect", "connection-state"]) {
    elements.set(id, { value: "", style: {}, hidden: id === "download", add(option) { if (!this.value) this.value = option.value; } });
  }
  elements.get("token").value = "test-plugin-code";
  elements.get("base").value = "http://localhost:4318";
  elements.get("project").value = "local";
  const requests = [], messages = [];
  let fail = false;
  const scope = { document: { getElementById: (id) => elements.get(id) }, window: {}, parent: { postMessage: (message) => messages.push(message) }, URL, AbortSignal, Option: function(text,value) { this.text=text; this.value=value; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fail) throw new Error("network unavailable");
      if (url.endsWith("/projects")) return {ok:true,json:async()=>({projects:[{id:"local",name:"내 프로젝트"}],features:[]})};
      return { ok: true, json: async () => ({ url: "http://localhost:4318/#feature=received" }) };
    },
  };
  vm.runInNewContext(script, scope);
  await scope.window.onmessage({data:{pluginMessage:{type:"settings",settings:{token:"test-plugin-code",projectId:"local"},file:{fileId:"file",fileName:"기획"}}}});
  requests.length = 0; messages.length = 0;
  const scan = { nodes: [{ id: "1", name: "선택 화면", type: "FRAME" }], images: [], source: "figma-plugin" };
  elements.get("scan").onclick();
  assert.equal(messages[0].pluginMessage.type, "scan");
  await scope.window.onmessage({ data: { pluginMessage: { type: "scan", scan } } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://localhost:4318/api/plugin/scans");
  assert.deepEqual(JSON.parse(requests[0].options.body).scan, scan);
  assert.equal(elements.get("download").hidden, true);
  assert.equal(elements.get("scan").disabled, false);
  fail = true;
  await scope.window.onmessage({ data: { pluginMessage: { type: "scan", scan } } });
  assert.equal(elements.get("download").hidden, false);
  assert.match(elements.get("status").textContent, /자동 전송에 실패/);
  fail = false;
  elements.get("scan").onclick();
  assert.equal(elements.get("download").hidden, true);
  await scope.window.onmessage({ data: { pluginMessage: { type: "scan", scan } } });
  assert.equal(elements.get("download").hidden, true);
});
