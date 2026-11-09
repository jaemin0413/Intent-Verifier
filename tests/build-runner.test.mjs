import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createBuildRunner, stopLeftovers } from "../scripts/build-runner.mjs";

const workspace = path.resolve("workspace-for-test"), cwd = path.join(workspace, "p"), wrapper = path.join(cwd, "gradlew");

async function started(options) {
  const server = createBuildRunner({ workspace, stop: async () => {}, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = async (body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/run`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  return { server, post, close: () => new Promise((resolve) => server.close(resolve)) };
}
function fakeChild(finish) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  setImmediate(() => finish(child));
  return child;
}

test("빌드 실행기는 작업 폴더의 Gradle wrapper만 실행하고 비밀값을 넘기지 않는다", async () => {
  const seen = [];
  let stopped = 0;
  const env = { PATH: "p", HOME: "/gradle", GRADLE_USER_HOME: "/gradle", ADMIN_KEY: "secret", ANTHROPIC_API_KEY: "secret" };
  const spawnImpl = (command, args, options) => { seen.push({ command, args, options }); return fakeChild((child) => { child.stdout.emit("data", "BUILD OK"); child.emit("close", 0); }); };
  const h = await started({ spawnImpl, env, stop: async () => { stopped++; } });
  try {
    assert.equal((await h.post({ cwd: path.resolve("elsewhere"), args: [path.resolve("elsewhere/gradlew")] })).status, 400);
    assert.equal((await h.post({ cwd, args: ["/bin/evil"] })).status, 400);
    const done = await h.post({ cwd, args: [wrapper, "test"], gradleOpts: "-XX:+UseSerialGC" });
    assert.deepEqual(done, { status: 200, data: { exitCode: 0, timedOut: false, log: "BUILD OK" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].command, "sh");
    assert.deepEqual(seen[0].options.env, { PATH: "p", HOME: "/gradle", GRADLE_USER_HOME: "/gradle", GRADLE_OPTS: "-XX:+UseSerialGC" });
    assert.equal(stopped, 1, "끝나면 남은 프로세스를 정리한다");
  } finally { await h.close(); }
});

test("빌드는 한 번에 하나만 받고 시간을 넘기면 멈춘다", async () => {
  let finish;
  const killed = [];
  const spawnImpl = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = (signal) => { killed.push(signal); child.emit("close", null); }; finish = child; return child; };
  const h = await started({ spawnImpl });
  try {
    const first = h.post({ cwd, args: [wrapper] });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h.post({ cwd, args: [wrapper] })).status, 409);
    finish.emit("close", 0);
    assert.equal((await first).data.exitCode, 0);
    const timed = await h.post({ cwd, args: [wrapper], timeoutMs: 5 });
    assert.equal(timed.data.timedOut, true);
    assert.deepEqual(killed, ["SIGKILL"]);
  } finally { await h.close(); }
});

test("남은 프로세스를 정리할 때 init과 자기 자신은 건드리지 않는다", async () => {
  const killed = [];
  await stopLeftovers((pid) => { killed.push(pid); if (pid === 30) throw new Error("already gone"); }, async () => ["1", String(process.pid), "20", "30", "self", "cpuinfo"]);
  assert.deepEqual(killed, [20, 30]);
});
