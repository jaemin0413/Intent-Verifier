import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, ensure } from "./domain.mjs";
import { validateScan } from "./integrations.mjs";
import {replaceFile} from "./atomic-file.mjs";
import {planningText,sameText} from './planning-text.mjs';

// Independent of AI/test execution. Only complete manifests become visible.
export class ScreenLibrary {
  constructor(directory) {
    this.directory = path.join(directory, "screen-library");
    this.tail = Promise.resolve();
  }
  locked(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async read(name, fallback) {
    try { return JSON.parse(await readFile(path.join(this.directory, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async write(name, value) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, name), temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await replaceFile(temp, target);
  }
  async index() { return this.read("index.json", { projects: {}, sessions: {} }); }
  async begin(projectId, input) {
    return this.locked(async () => {
      ensure(typeof input.fileId === "string" && input.fileId.length > 0 && input.fileId.length < 250, "Figma 파일 식별자가 필요합니다.");
      ensure(Array.isArray(input.pages) && input.pages.length > 0 && input.pages.length <= 20, "1~20개의 동기화 페이지를 지정해 주세요.");
      const pageIds = input.pages.map((p) => p.id);
      ensure(new Set(pageIds).size === pageIds.length && input.pages.every((p) => typeof p.id === "string" && typeof p.name === "string"), "페이지 목록이 올바르지 않습니다.");
      ensure(Array.isArray(input.screenIds) && input.screenIds.length <= 2000 && input.screenIds.every((s) => typeof s === "string") && new Set(input.screenIds).size === input.screenIds.length, "한 번에 최대 2,000개의 화면을 동기화할 수 있습니다.");
      ensure(Array.isArray(input.contexts) && input.contexts.length === pageIds.length, "각 페이지의 주변 설명이 필요합니다.");
      ensure(new Set(input.contexts.map((p) => p.pageId)).size === pageIds.length, "페이지 설명이 중복되었습니다.");
      for (const c of input.contexts) {
        ensure(pageIds.includes(c.pageId) && Array.isArray(c.nodes), "주변 설명의 페이지가 일치하지 않습니다.");
        validateScan({ nodes: [{ id: c.pageId, name: "페이지 주변 설명", type: "SECTION", children: c.nodes }] }, {maxNodes:100000,maxDepth:101});
      }
      const state = await this.index(), previous = state.projects[projectId];
      ensure(!previous || previous.fileId === input.fileId, "이 프로젝트에는 다른 Figma 파일이 연결되어 있습니다. 파일별로 프로젝트를 만들어 주세요.");
      const scope = input.scope?.kind === "selection" ? {kind:"selection",rootIds:[...input.screenIds]} : {kind:"page"};
      const id = crypto.randomUUID();
      for (const key of ["captureStartedAt", "captureFinishedAt"]) if (input[key] !== undefined) ensure(Number.isFinite(Date.parse(input[key])), "수집 시간이 올바르지 않습니다.");
      state.sessions[id] = { id, scope, projectId, fileId: input.fileId, fileName: String(input.fileName || "Figma"), pages: input.pages, contexts: input.contexts, screenIds: input.screenIds, assets: {}, captureStartedAt: input.captureStartedAt, captureFinishedAt: input.captureFinishedAt, baseRevision: previous?.revision || 0, startedAt: new Date().toISOString() };
      // Incomplete sessions may be retried for 24h; they never replace the public manifest.
      for (const [key, session] of Object.entries(state.sessions)) if (Date.now() - Date.parse(session.startedAt) > 86400000) delete state.sessions[key];
      ensure(Object.keys(state.sessions).length <= 30, "진행 중인 동기화가 너무 많습니다. 이전 동기화를 먼저 완료해 주세요.");
      await this.write("index.json", state);
      return { id, expected: input.screenIds.length };
    });
  }
  async put(projectId, sessionId, screen) {
    return this.locked(async () => {
      const state = await this.index(), session = state.sessions[sessionId];
      ensure(session?.projectId === projectId, "동기화 작업을 찾을 수 없습니다.");
      ensure(session.screenIds.includes(screen?.id) && session.pages.some((p) => p.id === screen.pageId) && screen.node?.id === screen.id, "수집 범위를 벗어난 화면입니다.");
      ensure(typeof screen.name === "string", "화면 이름이 필요합니다.");
      validateScan({ nodes: [screen.node], images: screen.image ? [screen.image] : [] }, {maxNodes:100000,maxDepth:101});
      ensure(!screen.image || screen.image.nodeId === screen.id, "이미지와 화면 ID가 다릅니다.");
      const hash = digest(screen);
      if (!(await this.read(`${hash}.json`, null))) await this.write(`${hash}.json`, screen);
      session.assets[screen.id] = { id: screen.id, name: screen.name, pageId: screen.pageId, hash };
      await this.write("index.json", state);
      return { received: Object.keys(session.assets).length, expected: session.screenIds.length };
    });
  }
  async complete(projectId, sessionId, captureFinishedAt) {
    return this.locked(async () => {
      const state = await this.index(), session = state.sessions[sessionId], previous = state.projects[projectId];
      if (!session && previous?.syncId === sessionId) return previous;
      ensure(session?.projectId === projectId, "동기화 작업을 찾을 수 없습니다.");
      ensure(session.screenIds.every((id) => session.assets[id]), "아직 전송되지 않은 화면이 있습니다. 기존 완료본을 유지합니다.");
      ensure((previous?.revision || 0) === session.baseRevision, "다른 동기화가 먼저 완료되었습니다. 최신 범위를 다시 수집해 주세요.");
      if (captureFinishedAt !== undefined) {
        ensure(Number.isFinite(Date.parse(captureFinishedAt)), "수집 시간이 올바르지 않습니다.");
        session.captureFinishedAt = captureFinishedAt;
      }
      const screens = session.screenIds.map((id) => session.assets[id]);
      const deleted = (previous?.screens || []).filter((s) => !session.screenIds.includes(s.id));
      const result = { scope:session.scope, syncId: sessionId, fileId: session.fileId, fileName: session.fileName, revision: session.baseRevision + 1, pages: session.pages, contexts: session.contexts, screens, deleted, startedAt: session.startedAt, captureStartedAt: session.captureStartedAt, captureFinishedAt: session.captureFinishedAt, completedAt: new Date().toISOString(), previousRevision: previous?.revision || null };
      result.removedIds=previous?.removedIds || [];
      await this.write(`${digest(projectId)}-v${result.revision}.json`, result);
      state.projects[projectId] = result;
      delete state.sessions[sessionId];
      await this.write("index.json", state);
      return result;
    });
  }
  // The next sync from the new file replaces the screen list; old screens and the features built on them stay readable.
  async setFileId(projectId, fileId, fileName) {
    return this.locked(async () => {
      const state = await this.index(), snapshot = state.projects[projectId];
      if (!snapshot || snapshot.fileId === fileId) return snapshot || null;
      const next = { ...snapshot, fileId, fileName: String(fileName || snapshot.fileName), previousFileId: snapshot.fileId, fileChangedAt: new Date().toISOString(), revision: snapshot.revision + 1, previousRevision: snapshot.revision };
      await this.write(`${digest(projectId)}-v${next.revision}.json`, next);
      state.projects[projectId] = next;
      for (const session of Object.values(state.sessions)) if (session.projectId === projectId) delete state.sessions[session.id];
      await this.write("index.json", state);
      return next;
    });
  }
  async listing(projectId) {
    const state = await this.index(), snapshot = state.projects[projectId];
    return { ...(snapshot || { revision: 0, screens: [], pages: [], deleted: [] }),
      screens:(snapshot?.screens || []).filter(s=>!snapshot.removedIds?.includes(s.id)),
      removed:(snapshot?.screens || []).filter(s=>snapshot.removedIds?.includes(s.id)),
      contexts: undefined,
      syncing: Object.values(state.sessions).filter((s) => s.projectId === projectId).map((s) => ({ id: s.id, received: Object.keys(s.assets).length, expected: s.screenIds.length, startedAt: s.startedAt })) };
  }
  async setRemoved(projectId,ids,revision,removed) {
    return this.locked(async()=>{
      const state=await this.index(),snapshot=state.projects[projectId];
      ensure(snapshot && snapshot.revision===revision,"보관함이 바뀌었습니다. 목록을 새로고침해 주세요.");
      ensure(Array.isArray(ids)&&ids.length>0&&ids.length<=2000&&new Set(ids).size===ids.length,"삭제하거나 복구할 화면을 선택해 주세요.");
      const hidden=new Set(snapshot.removedIds || []);
      ensure(ids.every(id=>snapshot.screens.some(s=>s.id===id)&&hidden.has(id)!==removed),"선택한 화면이 현재 목록에 없습니다.");
      for(const id of ids)removed ? hidden.add(id) : hidden.delete(id);
      const next={...snapshot,removedIds:[...hidden],revision:snapshot.revision+1,previousRevision:snapshot.revision,editedAt:new Date().toISOString()};
      await this.write(`${digest(projectId)}-v${next.revision}.json`,next);
      state.projects[projectId]=next;
      await this.write("index.json",state);
      return {revision:next.revision,count:ids.length};
    });
  }
  async asset(projectId, id) {
    const entry = (await this.index()).projects[projectId]?.screens.find((s) => s.id === id);
    ensure(entry, "화면을 찾을 수 없습니다.");
    return this.read(`${entry.hash}.json`);
  }
  async scan(projectId, screenIds, revision) {
    const snapshot = (await this.index()).projects[projectId];
    ensure(snapshot && snapshot.revision === revision, "보관함이 갱신되었습니다. 화면 목록을 다시 확인해 주세요.");
    ensure(Array.isArray(screenIds) && screenIds.length > 0 && screenIds.length <= 6 && new Set(screenIds).size === screenIds.length, "함께 확인할 화면을 1~6개 선택해 주세요.");
    const entries = screenIds.map((id) => snapshot.screens.find((s) => s.id === id));
    ensure(entries.every(Boolean), "선택한 화면이 현재 보관함에 없습니다.");
    ensure(screenIds.every(id=>!snapshot.removedIds?.includes(id)),"삭제한 화면은 복구한 뒤 분석할 수 있습니다.");
    const screens = await Promise.all(entries.map((entry) => this.read(`${entry.hash}.json`)));
    const pageIds = [...new Set(entries.map((s) => s.pageId))];
    const contexts = snapshot.contexts.filter((c) => pageIds.includes(c.pageId));
    const reference = { revision: snapshot.revision, fileId: snapshot.fileId, scope: snapshot.scope, screens: entries, contexts: contexts.map((c) => ({ pageId: c.pageId, hash: digest(c.nodes) })) };
    const scan = { id: crypto.randomUUID(), source: "screen-library", createdAt: new Date().toISOString(), fileName: snapshot.fileName,
      library: reference,
      nodes: [{ id: "library-selection", name: snapshot.scope?.kind === "selection" ? "선택한 화면설계서 전체 (선택 밖 내용 제외)" : "선택한 화면과 같은 페이지의 주변 설명 (자동 연관 확정 아님)", type: "SECTION", children: [...screens.map((s) => s.node), ...contexts.flatMap((c) => c.nodes)] }],
      images: screens.flatMap((s) => s.image ? [s.image] : []),
      scope: { screenIds, pageIds, context: snapshot.scope?.kind === "selection" ? "선택한 설계서 내부의 설명 전체 (선택 밖 내용 제외)" : "선택한 화면이 속한 페이지의 프레임 밖 설명 전체", collectedFrom: snapshot.captureStartedAt || snapshot.startedAt, collectedTo: snapshot.captureFinishedAt || snapshot.completedAt } };
    validateScan(scan);
    return scan;
  }
  async changed(projectId, reference) {
    const latest = (await this.index()).projects[projectId];
    if (!reference || !latest) return false;
    // Missing screens or narrower collection scope do not prove edited design text.
    for(const old of reference.screens) {
      const current=latest.screens.find(s=>s.id===old.id);
      if(!current || current.hash===old.hash)continue;
      const [before,after]=await Promise.all([this.read(`${old.hash}.json`,null),this.read(`${current.hash}.json`,null)]);
      if(before && after && !sameText([before.node],[after.node]) && digest(planningText([before.node]))!==digest(planningText([after.node])))return true;
    }
    const previous=await this.read(`${digest(projectId)}-v${reference.revision}.json`,null);
    const oldScope=reference.scope?.kind || previous?.scope?.kind || 'page';
    if(oldScope==='page' && (latest.scope?.kind || 'page')==='page') {
      for(const ref of reference.contexts || []) {
        const before=previous?.contexts.find(c=>c.pageId===ref.pageId),after=latest.contexts.find(c=>c.pageId===ref.pageId);
        if(before && after && !sameText(before.nodes,after.nodes) && digest(planningText(before.nodes))!==digest(planningText(after.nodes)))return true;
      }
    }
    return false;
  }
}
