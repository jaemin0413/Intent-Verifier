import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BackendCheckouts, parseGithubRepository, validBranch } from "../lib/backend-checkout.mjs";
import { createServer } from "../server.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
const remove = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const project = { id: "p", backend: { source: "github", repo: "team/be", branch: "dev" } };

// A real git remote on disk stands in for GitHub; only the address differs.
async function remoteRepository(prepare = async () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "backend-checkout-"));
  const bare = path.join(dir, "remote.git"), work = path.join(dir, "work");
  await mkdir(bare); await mkdir(work);
  git(bare, "init", "-q", "--bare");
  git(work, "init", "-q", "-b", "dev");
  await writeFile(path.join(work, ".gitignore"), "src/test/java/\nbuild/\n");
  await writeFile(path.join(work, "app.txt"), "first");
  await prepare(work);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "first");
  git(work, "push", "-q", bare, "dev");
  return { dir, bare, work, checkouts: new BackendCheckouts({ directory: path.join(dir, "data"), remote: () => bare }) };
}

test("GitHub 주소와 브랜치 이름은 형식이 맞는 것만 받는다", () => {
  for (const url of ["https://github.com/team/be", "https://github.com/team/be.git", "git@github.com:team/be.git"]) assert.equal(parseGithubRepository(url), "team/be");
  for (const url of ["https://evil.test/team/be", "https://github.com/team/be;rm", "--upload-pack=x", "https://github.com/team"]) assert.throws(() => parseGithubRepository(url));
  assert.equal(validBranch("feat/#17_login-extend"), "feat/#17_login-extend");
  for (const name of ["--upload-pack=x", "a..b", "a b", "dev/", "x.lock", ""]) assert.throws(() => validBranch(name));
});

test("검사 전 최신 커밋을 받고 이전 검사의 흔적을 지우며 빌드 캐시는 남긴다", async () => {
  const { dir, bare, work, checkouts } = await remoteRepository();
  try {
    const first = await checkouts.sync(project, undefined, "verify");
    assert.equal(first.commit, git(work, "rev-parse", "HEAD"));
    assert.equal(first.branch, "dev");
    assert.equal(first.subject, "first");
    await mkdir(path.join(first.repository, "src/test/java/intent"), { recursive: true });
    await writeFile(path.join(first.repository, "src/test/java/intent/Old.java"), "old");
    await mkdir(path.join(first.repository, "build"));
    await writeFile(path.join(first.repository, "build/cache"), "keep");
    await writeFile(path.join(first.repository, "app.txt"), "edited on the server");

    await writeFile(path.join(work, "app.txt"), "second");
    git(work, "commit", "-q", "-am", "second");
    git(work, "push", "-q", bare, "dev");
    const second = await checkouts.sync(project, "dev", "verify");
    assert.notEqual(second.commit, first.commit);
    assert.equal(await readFile(path.join(second.repository, "app.txt"), "utf8"), "second");
    assert.equal(await stat(path.join(second.repository, "src/test/java/intent/Old.java")).catch(() => null), null);
    assert.equal(await readFile(path.join(second.repository, "build/cache"), "utf8"), "keep");

    git(work, "checkout", "-q", "-b", "feat/#1_x");
    await writeFile(path.join(work, "only.txt"), "branch");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "branch");
    git(work, "push", "-q", bare, "feat/#1_x");
    const branch = await checkouts.sync(project, "feat/#1_x", "read");
    assert.equal(await readFile(path.join(branch.repository, "only.txt"), "utf8"), "branch");
    assert.equal(await stat(path.join(second.repository, "only.txt")).catch(() => null), null, "읽기용과 검사용 사본은 서로 영향이 없다");
    assert.deepEqual(await checkouts.branches(project), ["dev", "feat/#1_x"]);
    await assert.rejects(checkouts.sync(project, "missing", "read"), /브랜치를 GitHub에서 찾지 못했습니다/);
  } finally { await remove(dir); }
});

test("빌드 공간에는 git 정보를 두지 않고 저장소의 링크는 일반 파일로 받는다", async () => {
  const { dir, bare, work } = await remoteRepository();
  try {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, input: "/data/secrets.json" }).toString().trim();
    git(work, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    git(work, "commit", "-q", "-m", "link");
    git(work, "push", "-q", bare, "dev");
    const workspace = path.join(dir, "workspace"), checkouts = new BackendCheckouts({ directory: path.join(dir, "data"), remote: () => bare, workspace });
    const code = await checkouts.sync(project, "dev", "verify");
    assert.ok(code.repository.startsWith(workspace));
    assert.equal(await stat(path.join(code.repository, ".git")).catch(() => null), null, "빌드가 고칠 수 있는 곳에 git 설정을 두지 않는다");
    assert.ok(await stat(path.join(dir, "data/backends/p/verify.git/HEAD")));
    assert.equal((await lstat(path.join(code.repository, "link"))).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(code.repository, "link"), "utf8"), "/data/secrets.json");
    await writeFile(path.join(code.repository, "planted.txt"), "x");
    const again = await checkouts.sync(project, "dev", "verify");
    assert.equal(again.commit, code.commit);
    assert.equal(await stat(path.join(code.repository, "planted.txt")).catch(() => null), null);
    assert.ok(!(await checkouts.sync(project, "dev", "read")).repository.startsWith(workspace), "읽기용 사본은 빌드 공간 밖에 둔다");
  } finally { await remove(dir); }
});

test("같은 사본은 한 번에 한 요청만 읽고 폴더 연결은 그대로 쓴다", async () => {
  const { dir, checkouts } = await remoteRepository();
  try {
    const order = [];
    let release;
    const first = checkouts.withCode(project, "dev", async () => { order.push("first"); await new Promise((r) => { release = r; }); order.push("first done"); });
    const second = checkouts.withCode(project, "dev", async () => { order.push("second"); });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(order, ["first"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first", "first done", "second"]);
    assert.equal(await checkouts.withCode({ id: "f", backend: { repository: "/folder" } }, "dev", async (code) => code), "/folder");
    assert.equal(checkouts.forVerification({ id: "f", backend: { repository: "/folder" } }, "dev"), null);
  } finally { await remove(dir); }
});

test("저장소 연결은 관리자만, 키는 공개키만 나가고 API 찾기는 고른 브랜치의 코드를 읽는다", async () => {
  const { dir, bare, work, checkouts } = await remoteRepository(async (w) => { await cp("fixtures/controller-api", w, { recursive: true }); await writeFile(path.join(w, ".gitignore"), "build/\n"); });
  git(work, "checkout", "-q", "-b", "feat/new");
  const controller = path.join(work, "src/test/java/NewOnBranchController.java");
  await writeFile(controller, '@RestController public class NewOnBranchController { @GetMapping("/only-on-branch") public String a() { return ""; } }');
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "branch api");
  git(work, "push", "-q", bare, "feat/new");
  const key = "c".repeat(64), runtime = { close() {}, analyze: async () => ({ result: { recommendations: [], missing: [] }, evidence: { model: "test-double" } }) };
  const { server, store } = await createServer({ directory: path.join(dir, "data"), runDirectory: path.join(dir, "runs"), runtime, publicUrl: "https://tool.example.test", linkKey: key, adminKey: "op-secret", checkouts });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = (route, method, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: route, method, headers: { Host: "tool.example.test", "Content-Type": "application/json", ...headers } }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text), text })); });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const { token } = (await request("/api/session", "GET", { "X-App-Key": key })).data;
    const local = { "X-Local-Token": token }, input = { projectId: "local", repository: "https://github.com/team/be", branch: "dev", controllerFolder: "src/test/java" };
    assert.equal((await request("/api/connect/github", "POST", local, input)).status, 403);
    const connected = await request("/api/connect/github", "POST", { ...local, "X-Operator-Key": "op-secret" }, input);
    assert.equal(connected.status, 200);
    assert.match(connected.data.publicKey, /^ssh-ed25519 /);
    const listed = await request("/api/state", "GET", local);
    assert.doesNotMatch(listed.text, /PRIVATE KEY/);
    assert.equal(listed.data.projects[0].backend.repo, "team/be");
    assert.deepEqual((await request("/api/branches?projectId=local", "GET", local)).data, { branches: ["dev", "feat/new"], default: "dev" });
    await store.mutate((s) => { s.features.push({ id: "api", name: "태그", projectId: "local", status: "DRAFT", history: [], analysisStatus: "DONE", scan: { id: "s", nodes: [] }, analysis: { findings: [], questions: [], questionScopes: [] } }); });
    const started = await request("/api/features/api/apis", "POST", local, { answers: { extraAnswers: [] }, branch: "feat/new" });
    assert.equal(started.status, 202);
    let feature;
    for (let i = 0; i < 500; i++) { feature = (await store.load()).features[0]; if (feature.apiStatus !== "RUNNING") break; await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(feature.apiStatus, "DONE", feature.apiStatusError + " / " + feature.apiStatusErrorDetail);
    assert.equal(feature.backendBranch, "feat/new");
    assert.ok(feature.apiCatalog.endpoints.some((e) => e.path === "/only-on-branch"));
    assert.equal((await request("/api/features/api/apis", "POST", local, { branch: "--upload-pack=x" })).status, 400);
  } finally { await new Promise((r) => server.close(r)); await remove(dir); }
});
