import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AnalysisError, LocalAnalysisRuntime, classifyCodexError, redactDiagnostic, startDeviceLogin } from "./codex.mjs";
import { AI_WORK, WorkGate } from "./work-gate.mjs";

const exec = promisify(execFile);

// Every provider must honour what the schema promises: later steps trust this shape.
export function schemaErrors(value, schema, at = "$") {
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: 허용되지 않은 값`];
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && ![schema.type].flat().includes(type) && !(schema.type === "integer" && Number.isInteger(value))) return [`${at}: ${schema.type} 필요`];
  if (type === "array" && schema.items) return value.flatMap((item, i) => schemaErrors(item, schema.items, `${at}[${i}]`));
  if (type !== "object" || !schema.properties) return [];
  return [
    ...(schema.required || []).filter((k) => !(k in value)).map((k) => `${at}.${k}: 누락`),
    ...Object.keys(value).filter((k) => schema.additionalProperties === false && !(k in schema.properties)).map((k) => `${at}.${k}: 허용되지 않은 필드`),
    ...Object.entries(value).flatMap(([k, v]) => (schema.properties[k] ? schemaErrors(v, schema.properties[k], `${at}.${k}`) : [])),
  ];
}
function checked(result, schema) {
  const errors = schemaErrors(result, schema);
  if (errors.length) throw new Error("AI 응답 JSON schema 불일치: " + errors.slice(0, 5).join(", "));
  return result;
}

const payload = ({ nodes, images }) => JSON.stringify({ nodes, imageNodeIds: images.map((i) => i.nodeId) });
const pngData = (image) => image.dataUrl.replace(/^data:image\/png;base64,/, "");

export async function locateClaude(explicit, { env = process.env, platform = process.platform, run = exec, exists = stat } = {}) {
  const candidates = explicit ? [explicit] : platform === "win32"
    ? [path.join(env.APPDATA || "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"), path.join(env.USERPROFILE || "", ".local/bin/claude.exe"), "claude.exe"]
    : ["claude", path.join(env.HOME || "", ".local/bin/claude")];
  for (const binary of candidates) {
    try {
      if (path.isAbsolute(binary)) await exists(binary);
      return { binary, version: (await run(binary, ["--version"], { windowsHide: true, timeout: 10000 })).stdout.trim() };
    } catch {}
  }
  throw new AnalysisError("RUNTIME_MISSING", "Claude Code를 찾지 못했어요. 서버에 Claude Code를 설치하거나 CLAUDE_BINARY 경로를 설정해 주세요.");
}

// Anthropic's terms do not allow routing other users' requests through Free/Pro/Max/Ultra
// credentials, so a shared server's team AI only accepts an API key. A person may use their
// own login through the unmodified official binary for their own requests. They sign in inside
// that binary; this app only points it at their folder and never handles the code or the token.
export class ClaudeRuntime {
  images = true;
  constructor({ binary = process.env.CLAUDE_BINARY, shared = false, secrets = async () => ({}), env = process.env, timeout = 600000, spawnImpl = spawn, run = exec, configDir } = {}) {
    Object.assign(this, { binary, shared, secrets, env, timeout, spawnImpl, run, configDir });
  }
  async apiKey() {
    return (await this.secrets()).claudeApiKey || (this.shared ? this.env.ANTHROPIC_API_KEY : undefined);
  }
  // Typed by the person in a terminal on the server, so the prompt and the code stay inside the official binary.
  async loginCommand() {
    const { binary } = await locateClaude(this.binary, { env: this.env, run: this.run });
    if (this.env.CONTAINER_NAME) return `docker exec -it -e CLAUDE_CONFIG_DIR="${this.configDir}" ${this.env.CONTAINER_NAME} "${binary}" auth login`;
    return `sudo -u ${os.userInfo().username} env CLAUDE_CONFIG_DIR="${this.configDir}" "${binary}" auth login`;
  }
  async childEnv() {
    const env = { ...this.env }, key = await this.apiKey();
    // Never bill an inherited key by surprise, and do not inherit a surrounding Claude session.
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDECODE|CLAUDE_CODE_.*)$/i.test(k)) delete env[k];
    if (key) env.ANTHROPIC_API_KEY = key;
    if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;
    return env;
  }
  async status() {
    try {
      const key = await this.apiKey();
      if (this.shared && !key) return { status: "API_KEY_REQUIRED", message: "팀 서버에서는 Claude 구독으로 다른 사람의 요청을 처리할 수 없어요(Anthropic 약관). Anthropic Console의 API 키를 입력해 주세요." };
      const { binary, version } = await locateClaude(this.binary, { env: this.env, run: this.run });
      if (key) return { status: "CONNECTED", version, plan: "API 키" };
      const auth = JSON.parse((await this.run(binary, ["auth", "status"], { windowsHide: true, timeout: 20000, env: await this.childEnv() }).catch((e) => ({ stdout: e.stdout || "{}" }))).stdout || "{}");
      return auth.loggedIn ? { status: "CONNECTED", version, plan: auth.subscriptionType || auth.authMethod } : { status: "LOGIN_REQUIRED", version, message: "Claude Code에 로그인해 주세요.", loginCommand: "claude auth login" };
    } catch (e) {
      const error = classifyCodexError(e);
      return { status: error.code, message: error.message };
    }
  }
  async connect() { return this.status(); }
  async models() {
    return { models: [{ id: "sonnet", name: "Claude Sonnet" }, { id: "opus", name: "Claude Opus" }, { id: "haiku", name: "Claude Haiku" }], defaultModel: "sonnet" };
  }
  async analyze({ nodes, images = [], schema, instructions, model }) {
    const status = await this.status();
    if (status.status !== "CONNECTED") throw new AnalysisError(status.status === "API_KEY_REQUIRED" ? "LOGIN_REQUIRED" : status.status, status.message);
    const { binary, version } = await locateClaude(this.binary, { env: this.env, run: this.run });
    const selected = model || "sonnet";
    // Tools are off and the working directory is empty: design text and source are data only.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "figma-intent-claude-"));
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--model", selected, "--system-prompt", instructions, "--json-schema", JSON.stringify(schema)];
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text: payload({ nodes, images }) }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: pngData(i) } }))] } };
    try {
      const output = await new Promise(async (resolve, reject) => {
        const child = this.spawnImpl(binary, args, { cwd, env: await this.childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("Analysis timeout")); }, this.timeout);
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(message) + "\n");
      });
      const events = output.stdout.split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
      const result = events.findLast((e) => e.type === "result");
      if (!result || result.is_error) throw new Error(redactDiagnostic(result?.result || output.stderr || `Claude Code 종료 코드 ${output.code}`));
      const value = result.structured_output ?? JSON.parse(result.result);
      return { result: checked(value, schema), evidence: { provider: "claude", auth: (await this.apiKey()) ? "api-key" : "subscription", runtimeVersion: version, model: Object.entries(result.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0]?.[0] || selected, requestedModel: selected, completedAt: new Date().toISOString(), imageCount: images.length, usage: result.usage } };
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
  close() {}
}

// Google's FAQ does not support wrapping `agy` in other applications on consumer plans and
// Gemini CLI stopped serving AI Pro/Ultra, so this uses the API key route Google recommends.
export class GeminiRuntime {
  images = true;
  constructor({ secrets = async () => ({}), env = process.env, fetchImpl = fetch, timeout = 600000 } = {}) {
    Object.assign(this, { secrets, env, fetchImpl, timeout });
  }
  async apiKey() { return (await this.secrets()).geminiApiKey || this.env.GEMINI_API_KEY; }
  async call(route, key, body, attempt = 0) {
    const response = await this.fetchImpl("https://generativelanguage.googleapis.com/v1beta/" + route, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(this.timeout),
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    // Free-tier minute limits trip easily when two teammates click together; wait once before giving up.
    if ([429, 503].includes(response.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs ?? 15000 * (attempt + 1)));
      return this.call(route, key, body, attempt + 1);
    }
    if (!response.ok) throw new Error(redactDiagnostic(`Gemini API ${response.status}: ${data.error?.message || ""}`).replace(/\b(400|403)\b(?=.*(api key|permission))/i, "401"));
    return data;
  }
  async models() {
    const key = await this.apiKey();
    if (!key) return { models: [] };
    const listed = ((await this.call("models?pageSize=200", key)).models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /^models\/gemini-/.test(m.name))
      .map((m) => ({ id: m.name.slice(7), name: m.displayName || m.name.slice(7) }));
    return { models: listed, defaultModel: listed.find((m) => m.id === "gemini-flash-latest")?.id || listed[0]?.id };
  }
  async status() {
    const key = await this.apiKey();
    if (!key) return { status: "API_KEY_REQUIRED", message: "Google AI Studio의 API 키를 입력해 주세요. Google은 구독 계정(agy)을 다른 앱에 연결하는 방식을 지원하지 않습니다." };
    try {
      return (await this.models()).models.length ? { status: "CONNECTED", plan: "API 키" } : { status: "MODEL_UNAVAILABLE", message: "이 API 키로 쓸 수 있는 Gemini 모델이 없어요." };
    } catch (e) {
      const error = classifyCodexError(e);
      return { status: error.code === "LOGIN_REQUIRED" ? "API_KEY_REQUIRED" : error.code, message: error.code === "LOGIN_REQUIRED" ? "Gemini API 키를 확인해 주세요." : error.message };
    }
  }
  async connect() { return this.status(); }
  async analyze({ nodes, images = [], schema, instructions, model }) {
    const key = await this.apiKey();
    if (!key) throw new AnalysisError("LOGIN_REQUIRED", "Gemini API 키를 먼저 입력해 주세요.");
    const selected = model || (await this.models()).defaultModel;
    if (!selected) throw new AnalysisError("MODEL_UNAVAILABLE", "사용할 Gemini 모델을 찾지 못했어요.");
    const data = await this.call(`models/${encodeURIComponent(selected)}:generateContent`, key, {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: payload({ nodes, images }) }, ...images.map((i) => ({ inlineData: { mimeType: "image/png", data: pngData(i) } }))] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
    });
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (!text) throw new Error("Gemini 응답 JSON이 비어 있습니다: " + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "이유 없음"));
    return { result: checked(JSON.parse(text), schema), evidence: { provider: "gemini", auth: "api-key", model: data.modelVersion || selected, requestedModel: selected, completedAt: new Date().toISOString(), imageCount: images.length, usage: data.usageMetadata } };
  }
  close() {}
}

export const AI_PROVIDERS = {
  codex: { label: "Codex", auth: "ChatGPT 구독", key: null },
  claude: { label: "Claude", auth: "Claude 구독(이 PC) 또는 API 키", key: "claudeApiKey" },
  gemini: { label: "Gemini", auth: "Google AI Studio API 키", key: "geminiApiKey" },
};

// The server's default AI runs requests from members who did not connect their own.
// A member who logged their own Codex or Claude into this server uses that login for their own requests.
export class AiRouter {
  constructor({ shared = false, secrets, providers, memberHome = null, memberRuntime = (home) => new LocalAnalysisRuntime({ codexHome: home }), login = startDeviceLogin, memberClaudeHome = null, memberClaudeRuntime = (configDir) => new ClaudeRuntime({ configDir }), gate = new WorkGate(), bridge = null, hasDefault = async () => true } = {}) {
    this.shared = shared;
    this.providers = providers || { codex: new LocalAnalysisRuntime(), claude: new ClaudeRuntime({ shared, secrets }), gemini: new GeminiRuntime({ secrets }) };
    this.active = "codex";
    Object.assign(this, { memberHome, memberRuntime, login, memberClaudeHome, memberClaudeRuntime, gate, bridge, hasDefault, members: new Map(), logins: new Map() });
  }
  select(id) {
    if (!this.providers[id]) throw new AnalysisError("ANALYSIS_FAILED", "지원하지 않는 AI입니다.");
    this.active = id;
  }
  set logDirectory(directory) { this._logDirectory = directory; this.providers.codex.logDirectory = directory; for (const m of this.members.values()) m.logDirectory = directory; }
  get logDirectory() { return this._logDirectory; }
  async analyze(input) {
    if (this.shared && !(await this.hasDefault())) throw new AnalysisError("LOGIN_REQUIRED", "왼쪽 아래 내 AI에서 ChatGPT나 Claude를 연결한 뒤 다시 시도해 주세요.");
    return this.gate.run(AI_WORK, () => this.providers[this.active].analyze(input));
  }
  async memberConnected(id) {
    if (!id || !this.memberHome) return false;
    return Boolean(await stat(path.join(this.memberHome(id), "auth.json")).catch(() => null));
  }
  async memberClaudeConnected(id) {
    if (!id || !this.memberClaudeHome) return false;
    // Existence only: the file belongs to the official binary and this app never opens it.
    return Boolean(await stat(path.join(this.memberClaudeHome(id), ".credentials.json")).catch(() => null));
  }
  memberClaude(id) { return this.memberClaudeRuntime(this.memberClaudeHome(id)); }
  memberCodex(id) {
    if (!this.members.has(id)) { const runtime = this.memberRuntime(this.memberHome(id)); runtime.logDirectory = this._logDirectory; this.members.set(id, runtime); }
    return this.members.get(id);
  }
  // The runtime for one request: the member's own AI when they connected one, else the team's AI.
  async forMember(id) {
    // Someone who chose their own PC is never moved to the team's AI just because the window is closed.
    if (id && (await this.bridge?.registered(id))) return this.memberPc(id);
    const runtime = (await this.memberClaudeConnected(id)) ? this.memberClaude(id) : (await this.memberConnected(id)) ? this.memberCodex(id) : null;
    if (!runtime) return this;
    const router = this;
    return {
      logDirectory: this._logDirectory,
      models: () => runtime.models(),
      status: () => runtime.status(),
      // The saved model belongs to the default AI; another provider would reject its id.
      async analyze(input) { const out = await router.gate.run(AI_WORK, () => runtime.analyze({ ...input, model: undefined })); return { ...out, evidence: { ...out.evidence, account: "member", memberId: id } }; },
      forMember: () => router.forMember(id),
    };
  }
  memberPc(id) {
    const { bridge } = this, router = this, online = () => bridge.online(id);
    return {
      logDirectory: this._logDirectory,
      models: async () => ({ models: [] }),
      status: async () => (online() ? { status: "CONNECTED", plan: "내 PC" } : { status: "RUNTIME_MISSING", message: "내 PC의 연결 창이 꺼져 있어요." }),
      // No server memory is used while the PC works, so this does not wait for the server's work gate.
      async analyze({ nodes, images = [], schema, instructions }) {
        const out = await bridge.analyze(id, { nodes, images, schema, instructions });
        return { result: checked(out.result, schema), evidence: { ...out.evidence, account: "member", memberId: id, location: "member-pc" } };
      },
      forMember: () => router.forMember(id),
    };
  }
  async memberStatus(id) {
    if (!id) return { status: "NO_MEMBER", message: "내 이름과 개인 코드를 먼저 저장해 주세요." };
    if (await this.bridge?.registered(id)) return this.bridge.online(id) ? { status: "CONNECTED", provider: "claude", account: "member", plan: "내 PC" } : { status: "PC_WAITING" };
    const login = this.logins.get(id);
    if (login && login.status === "WAITING") return { status: "LOGIN_WAITING", url: login.url, code: login.code, startedAt: login.startedAt };
    if (await this.memberClaudeConnected(id)) return { ...(await this.memberClaude(id).status()), provider: "claude", account: "member" };
    if (!(await this.memberConnected(id))) {
      if (this.memberClaudeHome && (await stat(this.memberClaudeHome(id)).catch(() => null))) return { status: "CLAUDE_LOGIN", command: await this.memberClaude(id).loginCommand() };
      return { status: "NOT_CONNECTED", ...(login?.status === "FAILED" ? { message: "로그인이 완료되지 않았어요. 다시 시도해 주세요.", detail: login.detail } : {}) };
    }
    return { ...(await this.memberCodex(id).status()), provider: "codex", account: "member" };
  }
  async startMemberLogin(id) {
    if (!id || !this.memberHome) throw new AnalysisError("ANALYSIS_FAILED", "내 이름과 개인 코드를 먼저 저장해 주세요.");
    const current = this.logins.get(id);
    if (current?.status === "WAITING") return { status: "LOGIN_WAITING", url: current.url, code: current.code, startedAt: current.startedAt };
    const login = await this.login({ codexHome: this.memberHome(id) });
    this.logins.set(id, login);
    login.done.then(() => { this.members.get(id)?.close?.(); this.members.delete(id); });
    return { status: "LOGIN_WAITING", url: login.url, code: login.code, startedAt: login.startedAt };
  }
  async startMemberClaudeLogin(id) {
    if (!id || !this.memberClaudeHome) throw new AnalysisError("ANALYSIS_FAILED", "내 이름과 개인 코드를 먼저 저장해 주세요.");
    await this.bridge?.revoke(id);
    await mkdir(this.memberClaudeHome(id), { recursive: true });
    return this.memberStatus(id);
  }
  async disconnectMember(id) {
    this.logins.get(id)?.cancel?.(); this.logins.delete(id);
    this.members.get(id)?.close?.(); this.members.delete(id);
    await this.bridge?.revoke(id);
    if (id && this.memberHome) await rm(this.memberHome(id), { recursive: true, force: true });
    if (id && this.memberClaudeHome) await rm(this.memberClaudeHome(id), { recursive: true, force: true });
  }
  models(id = this.active) { return this.providers[id].models(); }
  status(id = this.active) { return this.providers[id].status(); }
  async connect(id = this.active) {
    const result = await this.providers[id].connect();
    // Codex's browser login calls back to the server's localhost, unreachable from a teammate's PC.
    if (this.shared && id === "codex" && result.status === "LOGIN_REQUIRED") return { status: result.status, loginCommand: "codex login --device-auth", message: "서버 관리자가 서버 터미널에서 로그인해 주세요." };
    return result;
  }
  async describe() {
    return Promise.all(Object.entries(this.providers).map(async ([id, provider]) => ({
      id, ...AI_PROVIDERS[id], active: id === this.active, shared: this.shared,
      ...(await provider.status().catch((e) => ({ status: "ANALYSIS_FAILED", message: e.message }))),
    })));
  }
  close() {
    for (const provider of Object.values(this.providers)) provider.close?.();
    for (const member of this.members.values()) member.close?.();
    for (const login of this.logins.values()) login.cancel?.();
  }
}
