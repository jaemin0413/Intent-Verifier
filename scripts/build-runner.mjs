// Runs target builds in a container that cannot see the tool's data volume, so project code cannot read its keys.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LOG = 4 * 1048576;

// A build can leave background processes behind. They must not outlive it and touch the shared folder.
export async function stopLeftovers(kill = process.kill.bind(process), list = () => readdir("/proc")) {
  for (const name of await list().catch(() => [])) {
    const pid = Number(name);
    if (pid > 1 && pid !== process.pid) try { kill(pid, "SIGKILL"); } catch {}
  }
}

export function createBuildRunner({ workspace = process.env.BUILD_WORKSPACE || "/workspace", spawnImpl = spawn, stop = stopLeftovers, env = process.env } = {}) {
  const base = path.resolve(workspace) + path.sep;
  let busy = false;
  const build = ({ cwd, args, gradleOpts, timeoutMs }) => new Promise((resolve) => {
    let log = "", timedOut = false;
    const append = (chunk) => { log = (log + chunk).slice(-MAX_LOG); };
    // Only what Gradle needs: this process has no secrets, and the build gets nothing else by accident.
    const { PATH, HOME, JAVA_HOME, GRADLE_USER_HOME } = env;
    const child = spawnImpl("sh", args, { cwd, env: Object.fromEntries(Object.entries({ PATH, HOME, JAVA_HOME, GRADLE_USER_HOME, GRADLE_OPTS: gradleOpts }).filter(([, value]) => value)) });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Number(timeoutMs) || 600000);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(error.stack));
    child.on("close", (exitCode) => { clearTimeout(timer); resolve({ exitCode, timedOut, log }); });
  });
  return http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/run") return reply(404, { error: "없는 경로입니다." });
    let text = "";
    for await (const chunk of req) { text += chunk; if (text.length > 100000) return reply(413, { error: "요청이 너무 큽니다." }); }
    let input;
    try { input = JSON.parse(text); } catch { return reply(400, { error: "요청을 읽지 못했습니다." }); }
    if (typeof input.cwd !== "string" || !path.resolve(input.cwd).startsWith(base) || !Array.isArray(input.args) || input.args[0] !== path.join(input.cwd, "gradlew") || !input.args.every((a) => typeof a === "string")) return reply(400, { error: "작업 폴더의 Gradle wrapper만 실행할 수 있습니다." });
    if (busy) return reply(409, { error: "다른 빌드가 실행 중입니다." });
    busy = true;
    try { const result = await build(input); await stop(); reply(200, result); }
    finally { busy = false; }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) createBuildRunner().listen(Number(process.env.PORT) || 4319, "0.0.0.0");
