import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJsonLines } from "./json-lines.mjs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const exec = promisify(execFile);

export async function locateCodex(
  explicit,
  { env = process.env, platform = process.platform } = {},
) {
  const candidates = [
    explicit || (platform === "win32" ? "codex.exe" : "codex"),
  ];
  if (!explicit && platform === "win32") {
    // Desktop injects its bin directory into PATH; double-click launchers may not inherit it.
    const directory = path.join(
      env.LOCALAPPDATA || "",
      "OpenAI",
      "Codex",
      "bin",
    );
    try {
      const installed = await Promise.all(
        (await readdir(directory, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map(async (d) => {
            const binary = path.join(directory, d.name, "codex.exe");
            return {
              binary,
              modified: (await stat(binary).catch(() => ({ mtimeMs: 0 })))
                .mtimeMs,
            };
          }),
      );
      candidates.push(
        ...installed
          .filter((i) => i.modified)
          .sort((a, b) => b.modified - a.modified)
          .map((i) => i.binary),
      );
    } catch {}
    if (env.APPDATA)
      candidates.push(
        path.join(
          env.APPDATA,
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      );
  }
  for (const binary of candidates) {
    try {
      return {
        binary,
        version: (
          await exec(binary, ["--version"], {
            windowsHide: true,
            timeout: 5000,
          })
        ).stdout.trim(),
      };
    } catch {}
  }
  throw new AnalysisError(
    "RUNTIME_MISSING",
    "Codex 런타임을 찾지 못했어요. Codex를 설치하거나 CODEX_BINARY 경로를 설정해 주세요.",
  );
}

export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function classifyCodexError(error) {
  if (error instanceof AnalysisError) return error;
  const text = JSON.stringify(error?.message || error);
  if (/usage.?limit|rate.?limit|quota|429|usageLimitExceeded/i.test(text))
    return new AnalysisError(
      "USAGE_LIMIT",
      "AI 사용량 한도에 도달했어요. 사용량이 갱신된 뒤 다시 분석해 주세요.",
    );
  if (/unauthorized|401|login|authentication|token.*expired/i.test(text))
    return new AnalysisError(
      "LOGIN_REQUIRED",
      "AI 연결이 필요해요. 로그인이나 API 키를 확인해 주세요.",
    );
  const cases = [
    [/timeout|timed out/i, "TIMEOUT", "화면을 읽는 데 시간이 오래 걸려 분석을 중단했어요. 화면을 적게 선택하거나 다른 모델로 다시 분석해 주세요."],
    [/context.{0,20}(length|window)|too many tokens|input.{0,20}(large|long)/i, "INPUT_TOO_LARGE", "선택한 설계서의 내용이 모델이 한 번에 읽을 수 있는 양을 넘었어요. 설계서를 나누어 분석해 주세요."],
    [/model.*(not found|not supported|unavailable|access|does not exist)|unsupported.*model/i, "MODEL_UNAVAILABLE", "선택한 모델을 현재 AI 계정에서 사용할 수 없어요. 분석 모델을 다시 선택해 주세요."],
    [/network|fetch failed|connection|stream.*(disconnect|closed)|502|503/i, "NETWORK_ERROR", "AI와 통신이 끊겨 분석을 마치지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."],
    [/JSON|형식|schema/i, "INVALID_OUTPUT", "AI 응답을 분석 결과로 읽을 수 없었어요. 원문은 보관되어 있으니 다시 분석해 주세요."],
    [/runtime exited/i, "RUNTIME_EXITED", "분석 중 AI 실행이 종료됐어요. 다시 분석해 주세요."],
  ];
  for (const [pattern, code, message] of cases) if (pattern.test(text)) return new AnalysisError(code, message);
  return new AnalysisError(
    "ANALYSIS_FAILED",
    "AI가 분석을 끝내기 전에 응답을 중단했어요. 원문은 보관되어 있습니다. 다시 분석하거나 오류 상세를 확인해 주세요.",
  );
}

// Authentication is owned exclusively by the official runtime. Never read auth files.
// Removes inherited API keys so a run is billed only to the login in this Codex home.
function codexEnv(codexHome) {
  const env = { ...process.env };
  for (const k of Object.keys(env))
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL)$/i.test(k))
      delete env[k];
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}
// `codex login --device-auth` prints a URL and a one-time code, then waits for the approval.
export async function startDeviceLogin({ codexHome, binary = process.env.CODEX_BINARY, spawnImpl = spawn, timeoutMs = 15 * 60000 } = {}) {
  await mkdir(codexHome, { recursive: true });
  const located = await locateCodex(binary);
  const child = spawnImpl(located.binary, ["login", "--device-auth"], { env: codexEnv(codexHome), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const login = { startedAt: new Date().toISOString(), status: "WAITING", url: null, code: null };
  const prompt = new Promise((resolve, reject) => {
    const check = () => {
      const url = output.match(/https:\/\/\S+/)?.[0], code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0];
      if (url && code) { Object.assign(login, { url, code }); resolve(login); }
    };
    child.stdout.on("data", (d) => { output = (output + String(d).replace(/\x1b\[[0-9;]*m/g, "")).slice(-4000); check(); });
    child.stderr.on("data", (d) => { output = (output + String(d).replace(/\x1b\[[0-9;]*m/g, "")).slice(-4000); check(); });
    child.on("error", reject);
    child.on("close", (code) => { if (!login.url) reject(new Error(redactDiagnostic(output) || `Codex 로그인 종료 코드 ${code}`)); });
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  login.done = new Promise((resolve) => child.on("close", (code) => { clearTimeout(timer); login.status = code === 0 ? "DONE" : "FAILED"; login.detail = code === 0 ? undefined : redactDiagnostic(output).slice(-600); resolve(login.status); }));
  child.on("error", () => { login.status = "FAILED"; });
  login.cancel = () => child.kill();
  await prompt;
  return login;
}
export class CodexRuntime {
  constructor({ binary = process.env.CODEX_BINARY, timeout = 600000, codexHome } = {}) {
    this.binary = binary;
    this.timeout = timeout;
    this.codexHome = codexHome;
    this.pending = new Map();
    this.listeners = new Set();
    this.seq = 0;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.boot().catch((e) => {
      this.proc?.kill();
      this.starting = null;
      throw e;
    });
    return this.starting;
  }
  async boot() {
    const cwd = path.join(os.tmpdir(), "figma-intent-codex");
    await mkdir(cwd, { recursive: true });
    this.cwd = cwd;
    const { binary, version } = await locateCodex(this.binary);
    this.version = version;
    const env = codexEnv(this.codexHome);
    this.proc = spawn(
      binary,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'model_provider="openai"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        'web_search="disabled"',
      ],
      { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.stderr = [];
    this.proc.stderr.on("data", (data) => { this.stderr.push(redactDiagnostic(String(data))); if (this.stderr.length > 40) this.stderr.shift(); });
    this.protocol = [];
    this.proc.on("error", (e) => this.fail(e));
    this.proc.on("exit", () => {
      this.starting = null;
      this.fail(new Error("Codex runtime exited"));
    });
    readJsonLines(this.proc.stdout, (message) => {
      this.protocol.push({at:new Date().toISOString(),method:message.method,id:message.id,threadId:message.params?.threadId,status:message.params?.status,itemType:message.params?.item?.type,keys:Object.keys(message.params || {}),error:message.error ? redactDiagnostic(JSON.stringify(message.error)) : undefined});
      if (this.protocol.length > 100) this.protocol.shift();
      if (message.id !== undefined && message.method) {
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "This analysis client does not allow tool execution or external token access.",
          },
        });
        return;
      }
      if (message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        message.error
          ? p.reject(new Error(JSON.stringify(message.error)))
          : p.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    }, (error) => this.fail(classifyCodexError(new Error("Codex JSON transport: " + error.message))));
    await this.request("initialize", {
      clientInfo: { name: "figma_verification_local", version: "0.2.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
  }
  send(message) {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex runtime timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const l of this.listeners)
      l({ method: "runtime/error", params: { error } });
  }
  close() {
    this.proc?.kill();
    this.starting = null;
  }
  async status({refreshToken=false}={}) {
    try {
      await this.start();
      const { account } = await this.request("account/read", {
        refreshToken,
      });
      if (account?.type !== "chatgpt")
        return {
          status: "LOGIN_REQUIRED",
          version: this.version,
          message: "ChatGPT 계정으로 Codex에 로그인해 주세요.",
        };
      let limits = null;
      try {
        limits = await this.request("account/rateLimits/read");
      } catch (e) {
        if(classifyCodexError(e).code === "LOGIN_REQUIRED") throw e;
      }
      return {
        status:
          limits?.ordinaryUsageAllowed === false ? "USAGE_LIMIT" : "CONNECTED",
        message:
          limits?.ordinaryUsageAllowed === false
            ? "Codex 사용량 한도에 도달했어요. 사용량이 갱신된 뒤 다시 시도해 주세요."
            : undefined,
        version: this.version,
        plan: account.planType,
        limits: limits?.rateLimits
          ? {
              primary: limits.rateLimits.primary,
              secondary: limits.rateLimits.secondary,
            }
          : null,
      };
    } catch (e) {
      const error = classifyCodexError(e);
      return { status: error.code, message: error.message };
    }
  }
  async connect() {
    const state = await this.status({refreshToken:true});
    if (state.status !== "LOGIN_REQUIRED") return state;
    const login = await this.request("account/login/start", {
      type: "chatgpt",
    });
    return {
      status: "LOGIN_REQUIRED",
      authUrl: login.authUrl,
      loginId: login.loginId,
    };
  }
  async models() {
    await this.start();
    const data = []; let cursor;
    do {
      const page = await this.request("model/list", {limit:100,includeHidden:false,...(cursor ? {cursor} : {})});
      data.push(...page.data.filter(m=>!m.hidden && m.inputModalities?.includes("image")));
      cursor = page.nextCursor;
    } while (cursor);
    let configured;
    try { configured = (await this.request("config/read", {includeLayers:false})).config?.model; } catch {}
    return {models:data.map(m=>({id:m.model,name:m.displayName,effort:m.defaultReasoningEffort})),defaultModel:data.find(m=>m.model===configured)?.model || data.find(m=>m.isDefault)?.model || data[0]?.model};
  }
  async analyze({ nodes, images, schema, instructions, model }) {
    const diagnostic = {id:crypto.randomUUID(),startedAt:new Date().toISOString(),requestedModel:model || null,events:[]};
    let selectedModel, selectedEffort;
    const record = (event) => diagnostic.events.push({at:new Date().toISOString(),...event});
    let logWrites = Promise.resolve();
    const flush = () => {
      if (!this.logDirectory) return logWrites;
      const snapshot = JSON.stringify({...diagnostic,runtimeStderr:this.stderr || [],protocol:this.protocol || []},null,2);
      logWrites = logWrites.then(async()=>{await mkdir(this.logDirectory,{recursive:true}); await writeFile(path.join(this.logDirectory,diagnostic.id + ".json"),snapshot);}).catch(()=>{});
      return logWrites;
    };
    const progressTimer = setInterval(flush,2000);
    progressTimer.unref();
    let threadId;
    try {
      const status = await this.status({refreshToken:true});
      if (status.status !== "CONNECTED") throw new AnalysisError(status.status, status.message);
      const catalog = await this.models();
      selectedModel = model || catalog.defaultModel;
      const selected = catalog.models.find(m=>m.id===selectedModel);
      if (!selected) throw new AnalysisError("MODEL_UNAVAILABLE", "선택한 모델을 사용할 수 없어요. 프로젝트 설정에서 다른 모델을 선택해 주세요.");
      selectedEffort = selected.effort;
      record({stage:"model",model:selectedModel,effort:selectedEffort,runtimeVersion:this.version});
      const started = await this.request("thread/start", {
        cwd: this.cwd,
        ephemeral: true,
        model: selectedModel,
        modelProvider: "openai",
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        baseInstructions: instructions,
        config: {
          web_search: "disabled",
          "features.shell_tool": false,
          "features.apps": false,
          "features.plugins": false,
        },
      });
      threadId = started.thread.id;
      diagnostic.threadId = threadId; diagnostic.model = started.model;
      let resolveTurn, rejectTurn;
      const done = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      // Install before turn/start: fast responses can precede the RPC response.
      let finalText = "",
        turnError,
        usage,
        toolUsed = false,
        activeTurn;
      const listener = ({ method, params: p }) => {
        if (method === "runtime/error") return rejectTurn(p.error);
        if (p?.threadId !== threadId) return;
        if (method === "item/completed" && p.item?.type === "agentMessage")
          finalText = p.item.text;
        if (
          method === "item/started" &&
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "webSearch",
            "collabAgentToolCall",
          ].includes(p.item?.type)
        ) {
          toolUsed = true;
          record({stage:"tool-blocked",tool:p.item.type});
          this.request("turn/interrupt", { threadId, turnId: p.turnId }).catch(
            () => {},
          );
        }
        if (method === "thread/tokenUsage/updated") usage = p.tokenUsage;
        if (method === "error") { turnError = p.error; record({stage:"runtime-error",error:redactDiagnostic(JSON.stringify(p.error))}); }
        if (method === "turn/completed") record({stage:"turn-completed",status:p.turn.status,error:p.turn.error ? redactDiagnostic(JSON.stringify(p.turn.error)) : undefined});
        if (method === "turn/completed")
          p.turn.status === "completed" && !toolUsed
            ? resolveTurn()
            : rejectTurn(
                new Error(
                  JSON.stringify(
                    p.turn.error || turnError || "Analysis interrupted",
                  ),
                ),
              );
      };
      this.listeners.add(listener);
      const timer = setTimeout(() => {
        this.request("turn/interrupt", { threadId, turnId: activeTurn }).catch(
          () => {},
        );
        rejectTurn(new Error("Analysis timeout"));
      }, this.timeout);
      // Keep rejection observed while the start request is in flight.
      done.catch(() => {});
      try {
        const turn = await this.request("turn/start", {
          threadId,
          model: selectedModel,
          effort: selectedEffort,
          input: [
            {
              type: "text",
              text: JSON.stringify({
                nodes,
                imageNodeIds: images.map((i) => i.nodeId),
              }),
            },
            ...images.map((i) => ({ type: "image", url: i.dataUrl })),
          ],
          outputSchema: schema,
        });
        activeTurn = turn.turn.id;
        diagnostic.turnId = activeTurn;
        await done;
        return {
          result: JSON.parse(finalText),
          evidence: {
            provider: "codex",
            auth: "chatgpt",
            runtimeVersion: this.version,
            threadId,
            turnId: turn.turn.id,
            model: started.model,
            requestedModel:selectedModel,
            reasoningEffort:selectedEffort,
            diagnosticId:diagnostic.id,
            completedAt: new Date().toISOString(),
            imageCount: images.length,
            usage,
          },
        };
      } finally {
        clearTimeout(timer);
        this.listeners.delete(listener);
      }
    } catch (e) {
      const error = classifyCodexError(e);
      record({stage:"failed",code:error.code,error:redactDiagnostic(e.message)});
      error.diagnosticId = diagnostic.id;
      throw error;
    } finally {
      clearInterval(progressTimer);
      diagnostic.finishedAt = new Date().toISOString();
      diagnostic.runtimeStderr = this.stderr || [];
      diagnostic.protocol = this.protocol || [];
      await flush();
      if (threadId)
        await this.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }
}

// Each analysis starts an official runtime with the current managed login.
// Long-lived status/model processes must not retain an account switched in Codex.
export class LocalAnalysisRuntime extends CodexRuntime {
  constructor({sessionFactory,...options}={}) {
    super(options);this.sessions=new Set();
    this.sessionFactory=sessionFactory || (()=>new CodexRuntime({binary:this.binary,timeout:this.timeout,codexHome:this.codexHome}));
  }
  async analyze(input) {
    const session=this.sessionFactory();session.logDirectory=this.logDirectory;this.sessions.add(session);
    try{return await session.analyze(input);}finally{session.close();this.sessions.delete(session);}
  }
  close(){for(const session of this.sessions)session.close();this.sessions.clear();super.close();}
}

export function redactDiagnostic(text) {
  return String(text).replace(/Bearer\s+[^\s"\\]+/gi,"Bearer [redacted]")
    .replace(/\b(?:sk-|sk-proj-)[A-Za-z0-9_-]+/g,"[redacted]")
    .replace(/(access_token|refresh_token|id_token)(["\s:=]+)[^\s",}]+/gi,"$1$2[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,"[redacted]").slice(0,6000);
}
