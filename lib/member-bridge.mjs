import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalysisError } from "./codex.mjs";
import { ensure } from "./domain.mjs";

const sha = (text) => createHash("sha256").update(String(text)).digest("hex");
const OFFLINE = "내 PC의 연결 창이 꺼져 있어요. 내 AI에서 명령을 다시 받아 실행해 주세요.";

// A teammate's own Claude runs on their own PC, so no Claude login ever reaches this server.
// The server only queues that teammate's requests. Connection tokens are this app's own and stored as hashes.
export class MemberBridge {
  constructor({ file, pollMs = 25000, jobMs = 660000, offlineMs = 45000, sweepMs = 5000, now = () => Date.now() }) {
    Object.assign(this, { file, pollMs, jobMs, offlineMs, sweepMs, now, members: new Map(), jobs: new Map() });
  }
  tokens() { return (this.loaded ??= readFile(this.file, "utf8").then(JSON.parse).catch(() => ({}))); }
  async remove(id) {
    const tokens = await this.tokens();
    for (const [hash, member] of Object.entries(tokens)) if (member === id) delete tokens[hash];
    return tokens;
  }
  async save(tokens) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(tokens), { mode: 0o600 });
  }
  // A new command replaces the old one, so a command left in someone's scrollback stops working.
  async issue(id) {
    const tokens = await this.remove(id), token = randomBytes(32).toString("hex");
    tokens[sha(token)] = id;
    await this.save(tokens);
    return token;
  }
  async revoke(id) {
    await this.save(await this.remove(id));
    this.members.delete(id);
  }
  async memberOf(token) { return (await this.tokens())[sha(token)] || null; }
  async registered(id) { return Object.values(await this.tokens()).includes(id); }
  state(id) {
    if (!this.members.has(id)) this.members.set(id, { seen: 0, waiters: [], queue: [] });
    return this.members.get(id);
  }
  online(id) {
    const member = this.members.get(id);
    return Boolean(member && (member.waiters.length || this.now() - member.seen < this.offlineMs));
  }
  // Long poll from the teammate's PC. `res` closing means that PC went away, so no job is handed to it.
  next(id, res) {
    const member = this.state(id);
    member.seen = this.now();
    const queued = member.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter = {
        give: (job) => {
          if (!member.waiters.includes(waiter)) return;
          member.waiters.splice(member.waiters.indexOf(waiter), 1);
          clearTimeout(timer);
          member.seen = this.now();
          resolve(job);
        },
      };
      const timer = setTimeout(() => waiter.give(null), this.pollMs);
      member.waiters.push(waiter);
      res?.on("close", () => waiter.give(null));
    });
  }
  finish(id, { id: jobId, result, evidence, error }) {
    const job = this.jobs.get(jobId);
    ensure(job?.member === id, "처리할 요청을 찾지 못했습니다.");
    if (error) job.reject(new AnalysisError(String(error.code || "ANALYSIS_FAILED"), String(error.message || "내 PC의 Claude가 요청을 처리하지 못했어요.")));
    else job.resolve({ result, evidence });
  }
  analyze(id, input) {
    if (!this.online(id)) return Promise.reject(new AnalysisError("RUNTIME_MISSING", OFFLINE));
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), input }, started = this.now(), member = this.state(id);
      const settle = (done, value) => { clearInterval(watch); this.jobs.delete(job.id); done(value); };
      const watch = setInterval(() => {
        if (!this.online(id)) settle(reject, new AnalysisError("RUNTIME_MISSING", OFFLINE));
        else if (this.now() - started > this.jobMs) settle(reject, new AnalysisError("ANALYSIS_FAILED", "내 PC의 Claude가 제한 시간 안에 답하지 못했어요."));
      }, this.sweepMs);
      watch.unref?.();
      this.jobs.set(job.id, { member: id, resolve: (value) => settle(resolve, value), reject: (e) => settle(reject, e) });
      if (member.waiters.length) member.waiters[0].give(job);
      else member.queue.push(job);
    });
  }
}
