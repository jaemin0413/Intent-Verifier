import {versionDraft} from './spec-versions.mjs';
import { readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../scripts/setup.mjs";
import {replaceFile} from "./atomic-file.mjs";
import {backendQuestions} from "../web/intent-questions.mjs";
import { approve, ensure, isApproved, planInputDigest } from "./domain.mjs";
import { readJson } from "./json-files.mjs";

import { DEFAULT_NOTION_TEMPLATE } from "./notion-template.mjs";

// Screens, API catalogs and history are bulky and rarely needed together. They live one file per
// feature beside state.json and load when a field is touched, so a status change no longer
// parses and rewrites every screen image.
const DETAIL_KEYS = ["history", "notionDrafts", "notionDocumentation", "publications", "apiCatalog", "apiCandidates", "scan.nodes", "scan.images"];
const TOP_LEVEL_DETAILS = DETAIL_KEYS.filter((key) => !key.startsWith("scan."));
const slot = (feature, key) => (key.startsWith("scan.") ? [feature.scan, key.slice(5)] : [feature, key]);
const descriptor = (owner, name) => (owner ? Object.getOwnPropertyDescriptor(owner, name) : undefined);

// Copies only the small fields: touching a bulky one would load it from disk.
function without(object, hidden) {
  const out = {};
  for (const key of Object.keys(object)) if (!hidden.includes(key)) out[key] = object[key];
  return out;
}
function lightFeature(feature) {
  return { ...without(feature, TOP_LEVEL_DETAILS), ...(feature.scan ? { scan: without(feature.scan, ["nodes", "images"]) } : {}) };
}

// Inside mutate() a feature's details are parsed once, so in-place edits can be detected and saved.
class EditableDetail {
  constructor(store, id) { Object.assign(this, { store, id, loaded: false }); }
  get data() {
    if (!this.loaded) { this.text = this.store.readDetail(this.id); this.value = JSON.parse(this.text || "{}"); this.loaded = true; }
    return this.value;
  }
}

export class Store {
  constructor(directory = path.join(root, ".local")) {
    this.directory = directory;
    this.tail = Promise.resolve();
    this.recent = new Map();
  }
  detailFile(id) { return path.join(this.directory, "feature-details", `${encodeURIComponent(id)}.json`); }
  readDetail(id) {
    try { return readFileSync(this.detailFile(id), "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; return null; }
  }
  // Only a few features stay parsed for read-only use, so a sweep over all of them cannot pile up.
  sharedDetail(id) {
    const value = this.recent.get(id) || JSON.parse(this.readDetail(id) || "{}");
    this.recent.delete(id);
    this.recent.set(id, value);
    if (this.recent.size > 4) this.recent.delete(this.recent.keys().next().value);
    return value;
  }
  attachDetails(state, holders) {
    for (const feature of state.features || []) {
      const holder = holders && new EditableDetail(this, feature.id);
      holders?.set(feature, holder);
      const read = holder ? () => holder.data : () => this.sharedDetail(feature.id);
      for (const key of feature.detailKeys || []) {
        const [owner, name] = slot(feature, key);
        if (!owner || Object.hasOwn(owner, name)) continue;
        Object.defineProperty(owner, name, {
          enumerable: true, configurable: true, get: () => read()[key],
          set: (value) => Object.defineProperty(owner, name, { value, enumerable: true, writable: true, configurable: true }),
        });
      }
    }
    return state;
  }
  // Details go first: a crash before state.json is replaced leaves the older state still readable.
  async saveDetails(state, holders) {
    await mkdir(path.join(this.directory, "feature-details"), { recursive: true });
    const alive = new Set(state.features.map((f) => f.id));
    for (const feature of holders.keys()) if (!alive.has(feature.id)) { await rm(this.detailFile(feature.id), { force: true }); this.recent.delete(feature.id); }
    for (const feature of state.features) {
      const holder = holders.get(feature) || new EditableDetail(this, feature.id);
      const inline = DETAIL_KEYS.filter((key) => { const found = descriptor(...slot(feature, key)); return found && !found.get; });
      const removed = (feature.detailKeys || []).filter((key) => !descriptor(...slot(feature, key)));
      if (!holder.loaded && !inline.length && !removed.length) continue;
      const data = holder.data;
      for (const key of removed) delete data[key];
      for (const key of inline) { const [owner, name] = slot(feature, key); if (owner[name] === undefined) delete data[key]; else data[key] = owner[name]; }
      feature.detailKeys = Object.keys(data);
      feature.historyCount = data.history?.length || 0;
      feature.scanNodeCount = data["scan.nodes"]?.filter((n) => n.type !== "DOCUMENT").length || 0;
      const text = JSON.stringify(data);
      if (text === holder.text) continue;
      const temp = path.join(this.directory, "feature-details", `${crypto.randomUUID()}.tmp`);
      await writeFile(temp, text);
      await replaceFile(temp, this.detailFile(feature.id));
      this.recent.delete(feature.id);
    }
  }
  // Read-only snapshot shared between requests: change state only through mutate().
  async load() {
    // Avoid repeatedly opening state.json while Windows is replacing it.
    await this.tail;
    const info = await stat(path.join(this.directory, "state.json")).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
    if (info && this.cached?.mtimeMs === info.mtimeMs && this.cached.size === info.size) return this.cached.state;
    const state = await this.readState();
    this.cached = info ? { mtimeMs: info.mtimeMs, size: info.size, state } : null;
    return state;
  }
  async readState(holders) {
    try {
      const state = await readJson(path.join(this.directory, "state.json"));
      state.settings = { ...state.settings, notionTemplate: DEFAULT_NOTION_TEMPLATE };
      delete state.settings.template;
      delete state.pluginToken;
      if (state.settings.parentId || state.settings.notionPageUrl) {
        state.settings.legacyNotionDestination = { parentId: state.settings.parentId, notionPageUrl: state.settings.notionPageUrl };
      }
      delete state.settings.parentId;
      delete state.settings.notionPageUrl;
      return this.attachDetails(state, holders);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return {
        projects: [{ id: "local", name: "내 프로젝트" }],
        features: [],
        runs: [],
        settings: { model: "", notionTemplate: DEFAULT_NOTION_TEMPLATE },
      };
    }
  }
  async init() {
    return this.mutate((s) => s);
  }
  mutate(fn) {
    const task = this.tail.then(async () => {
      const holders = new Map();
      const state = await this.readState(holders);
      const result = await fn(state);
      await mkdir(this.directory, { recursive: true });
      await this.saveDetails(state, holders);
      const temp = path.join(
        this.directory,
        `state-${crypto.randomUUID()}.tmp`,
      );
      await writeFile(temp, JSON.stringify({ ...state, features: state.features.map(lightFeature) }));
      await replaceFile(temp, path.join(this.directory, "state.json"));
      this.cached = null;
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async secrets() {
    try {
      return await readJson(path.join(this.directory, "secrets.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return {};
    }
  }
  async saveSecrets(patch) {
    const current = await this.secrets();
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined && v !== "") current[k] = v;
    await mkdir(this.directory, { recursive: true });
    const temp = path.join(this.directory, `secrets-${crypto.randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(current), { mode: 0o600 });
    await replaceFile(temp, path.join(this.directory, "secrets.json"));
  }
}

export function replaceDraft(feature, draft) {
  const previous = feature.spec;
  if (previous)
    feature.history = [...(feature.history || []), structuredClone(previous)];
  versionDraft(draft, previous);
  delete draft.approval;
  feature.spec = draft;
  feature.status = "DRAFT";
  return feature;
}
// Answers recorded before any API plan exists: the policy is kept, nothing is verifiable yet.
export function buildIntent(feature, answers) {
  const questions=backendQuestions(feature.analysis);
  return {feature:{id:feature.id,name:feature.name,description:feature.analysis.summary},version:1,
    requirements:[{id:"backend-intent",version:1,description:"확인한 서버 동작과 정책",origin:"user_answer",evidenceStatus:"INFERRED",
      evidence:{scanId:feature.scan?.id,nodeIds:[],excerpt:"AI 질문과 사용자 답변; API 계약은 아직 미확정"},
      conditions:questions.length ? questions.map(({index,text})=>({id:`open-question-${index+1}`,description:answers.extraAnswers?.[index]?.trim() ? `${text} → ${answers.extraAnswers[index].trim()}` : `추가 확인 필요: ${text}`,requiredScenarios:[]})) : [{id:"backend-unverified",description:"현재 실행기가 지원하지 않는 서버 동작; 아직 검증하지 않았습니다.",requiredScenarios:[]}]}],
    contract:{id:"unresolved-api",version:1,status:"UNRESOLVED"},scenarios:[]};
}
export function approveFeature(feature, expectedVersion) {
  ensure(feature.planStatus==="DONE" && feature.spec?.contract?.kind==="controller-api-v1" && feature.planInputDigest===planInputDigest(feature,feature.answers),"실행 검증 기준을 먼저 작성하고 확인해 주세요.");
  ensure(
    feature.answers && !["RUNNING", "ERROR"].includes(feature.analysisStatus),
    "새로 가져온 기획의 답변과 기준을 다시 확인해 주세요.",
  );
  ensure(
    feature.spec?.version === expectedVersion,
    "검토 중 기획이 변경되었습니다. 최신 내용을 다시 확인해 주세요.",
  );
  feature.spec = approve(feature.spec);
  feature.status = "READY";
  return feature;
}
export function rejectRequirement(feature, requirementId, expectedVersion) {
  ensure(feature.spec?.version===expectedVersion && feature.status==='DRAFT','승인 전 최신 기준에서만 해석을 제외할 수 있습니다.');
  const draft=structuredClone(feature.spec),requirement=draft.requirements.find(r=>r.id===requirementId);
  ensure(requirement,'요구사항을 찾지 못했습니다.');
  const ids=new Set(requirement.conditions.flatMap(c=>c.requiredScenarios));
  requirement.approvalStatus='REJECTED';
  requirement.conditions.forEach(c=>{c.requiredScenarios=[];});
  draft.scenarios=draft.scenarios.filter(s=>!ids.has(s.id));
  return replaceDraft(feature,draft);
}
export function reopenFeature(feature) {
  ensure(
    feature && (feature.spec || feature.answers),
    "수정할 사용자 기획이 없습니다.",
  );
  if (isApproved(feature.spec))
    feature.history.push(structuredClone(feature.spec));
  if(feature.spec) {feature.spec = { ...feature.spec };delete feature.spec.approval;}
  delete feature.planRequestId; delete feature.planStatus;
  feature.previousAnswers = feature.answers;
  feature.answers = null;
  feature.status = "DRAFT";
  return feature;
}
// The list polled by every open tab must stay small: screens and history load on demand.
export function publicFeature(feature) {
  const rest = without(feature, [...TOP_LEVEL_DETAILS, "apiMissing", "planExecution", "detailKeys", "scanNodeCount"]);
  return {
    ...rest,
    historyCount: feature.historyCount ?? feature.history?.length ?? 0,
    ...(feature.scan ? { scan: { id: feature.scan.id, source: feature.scan.source, createdAt: feature.scan.createdAt, scope: feature.scan.scope, library: feature.scan.library, documents: feature.scan.documents, nodeCount: feature.scanNodeCount ?? feature.scan.nodes?.filter((n) => n.type !== "DOCUMENT").length ?? 0 } } : {}),
    status:
      feature.status === "READY" && !isApproved(feature.spec)
        ? "DRAFT"
        : feature.status,
  };
}
