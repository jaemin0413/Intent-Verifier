import { ClaudeRuntime } from "./ai-runtime.mjs";
import { classifyCodexError } from "./codex.mjs";

// Runs on a teammate's own PC: their signed-in official Claude CLI answers only their own requests.
// Tools stay off inside ClaudeRuntime, so a request can only produce text.
export async function runMemberAi({ url, token, runtime = new ClaudeRuntime(), fetchImpl = fetch, log = console.log, retryMs = 3000, stop = () => false }) {
  const base = new URL(url || "http://invalid.invalid");
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname)) throw new Error("팀 서버의 HTTPS 주소만 연결할 수 있습니다.");
  if (!/^[a-f0-9]{64}$/.test(token || "")) throw new Error("연결 명령을 화면에서 다시 복사해 주세요.");
  const status = await runtime.status();
  if (status.status !== "CONNECTED") throw new Error("이 PC의 Claude Code에 먼저 로그인해 주세요: claude auth login");
  const post = (route, body, ms) => fetchImpl(new URL(route, base), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  const answer = async (job) => {
    let reply;
    try {
      reply = { id: job.id, ...(await runtime.analyze(job.input)) };
      log("요청을 처리했습니다.");
    } catch (e) {
      const { code, message } = classifyCodexError(e);
      reply = { id: job.id, error: { code, message } };
      log("요청을 처리하지 못했습니다: " + message);
    }
    await post("/api/member-ai/result", reply, 60000).catch((e) => log("결과를 보내지 못했습니다: " + e.message));
  };
  let connected = false;
  while (!stop()) {
    try {
      const response = await post("/api/member-ai/next", undefined, 40000);
      if (response.status === 401) throw Object.assign(new Error("연결이 해제됐습니다. 내 AI에서 명령을 다시 받아 주세요."), { fatal: true });
      if (!response.ok) throw new Error(`서버 응답 ${response.status}`);
      if (!connected) { connected = true; log("연결됐습니다. 팀 서버를 쓰는 동안 이 창을 켜 두세요."); }
      if (response.status !== 204) answer(await response.json());
    } catch (e) {
      if (e.fatal) throw e;
      connected = false;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
