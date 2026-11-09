import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, publicFeature } from "../lib/store.mjs";
import { digest } from "../lib/domain.mjs";

const image = { nodeId: "1", dataUrl: "data:image/png;base64," + "A".repeat(4000) };
const feature = (id) => ({ id, projectId: "local", status: "DRAFT", history: [{ version: 1 }], apiCatalog: { digest: "c" }, scan: { id: "s", source: "screen-library", nodes: [{ id: "1", type: "FRAME" }, { id: "2", type: "DOCUMENT" }], images: [image], documents: [] } });
const legacy = (features) => JSON.stringify({ projects: [{ id: "local", name: "p" }], features, runs: [], settings: {} }, null, 2);

async function legacyStore(features) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "store-details-"));
  await writeFile(path.join(directory, "state.json"), legacy(features));
  return { directory, store: new Store(directory) };
}

test("기존 상태 파일의 무거운 데이터를 분리해도 읽는 값과 digest는 같다", async () => {
  const { directory, store } = await legacyStore([feature("a")]);
  try {
    const before = digest({ scan: feature("a").scan });
    await store.init();
    const light = await readFile(path.join(directory, "state.json"), "utf8");
    assert.ok(!light.includes("base64"), "이미지는 상태 파일에 남지 않는다");
    assert.equal(JSON.parse(light).features[0].apiCatalog, undefined);
    const [loaded] = (await store.load()).features;
    assert.deepEqual(loaded.scan.nodes, feature("a").scan.nodes);
    assert.equal(digest({ scan: loaded.scan }), before, "승인 digest가 바뀌면 안 된다");
    assert.deepEqual(structuredClone(loaded.scan).images, [image]);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded)).history, [{ version: 1 }]);
    assert.ok(!Object.keys(structuredClone(loaded)).includes("notionDrafts"), "없던 필드를 만들지 않는다");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("변경 안에서 배열을 직접 고쳐도 저장되고 건드리지 않은 기능 파일은 다시 쓰지 않는다", async () => {
  const { directory, store } = await legacyStore([feature("a"), feature("b")]);
  try {
    await store.init();
    const untouched = store.detailFile("b"), before = (await stat(untouched)).mtimeMs;
    await store.mutate((s) => { s.features[0].history.push({ version: 2 }); s.features[0].status = "READY"; });
    const [a, b] = (await store.load()).features;
    assert.deepEqual(a.history, [{ version: 1 }, { version: 2 }]);
    assert.equal(a.status, "READY");
    assert.equal(publicFeature(a).historyCount, 2);
    assert.equal((await stat(untouched)).mtimeMs, before);
    assert.deepEqual(b.apiCatalog, { digest: "c" });
    await store.mutate((s) => { delete s.features[1].apiCatalog; });
    assert.equal((await store.load()).features[1].apiCatalog, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("화면 교체와 기능 삭제가 별도 파일에도 반영되고 목록은 무거운 파일을 읽지 않는다", async () => {
  const { directory, store } = await legacyStore([feature("a"), feature("b")]);
  try {
    await store.init();
    await store.mutate((s) => { s.features[0].scan = { id: "new", nodes: [{ id: "9", type: "FRAME" }] }; });
    const [a] = (await store.load()).features;
    assert.equal(a.scan.id, "new");
    assert.equal(a.scan.images, undefined);
    assert.equal(publicFeature(a).scan.nodeCount, 1);
    await store.mutate((s) => { s.features = s.features.filter((f) => f.id !== "b"); });
    assert.deepEqual(await readdir(path.join(directory, "feature-details")), [`${encodeURIComponent("a")}.json`]);
    await rm(store.detailFile("a"));
    store.recent.clear();
    const listed = publicFeature((await store.load()).features[0]);
    assert.equal(listed.scan.nodeCount, 1);
    assert.equal(listed.historyCount, 1);
    assert.equal(listed.detailKeys, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
