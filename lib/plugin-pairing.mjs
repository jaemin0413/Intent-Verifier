import { randomBytes } from "node:crypto";
import { ensure } from "./domain.mjs";

// Only the local app may approve; knowing the browser link cannot claim a token.
export class PluginPairing {
  constructor(store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
    this.pending = new Map();
  }
  start({ fileId, fileName, fileUrl }) {
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id);
    ensure(this.pending.size < 20, "연결 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    ensure(typeof fileId === "string" && /^[\w-]{1,160}$/.test(fileId), "Figma 파일을 식별하지 못했습니다.");
    ensure(typeof fileName === "string" && fileName.length <= 300, "파일 이름을 확인해 주세요.");
    const canonicalUrl = fileUrl && /^https:\/\/www\.figma\.com\/design\/[A-Za-z0-9]+$/.test(fileUrl) ? fileUrl : undefined;
    const item = { id: randomBytes(24).toString("hex"), claim: randomBytes(32).toString("hex"), fileId, fileName, fileUrl: canonicalUrl, expiresAt: this.now() + 180000 };
    this.pending.set(item.id, item);
    return { id: item.id, claim: item.claim, expiresAt: item.expiresAt };
  }
  get(id) {
    const item = this.pending.get(id);
    ensure(item && item.expiresAt > this.now(), "연결 요청이 만료됐습니다. 플러그인에서 다시 연결해 주세요.");
    return item;
  }
  describe(id) {
    const { fileId, fileName, fileUrl, expiresAt, projectId } = this.get(id);
    return { fileId, fileName, fileUrl, expiresAt, projectId };
  }
  // switchFile moves the project to another Figma file (a copy to the original, say); features and
  // approvals stay, and plugins of the old file lose their tokens.
  async approve(id, projectId, { switchFile = false } = {}) {
    const item = this.get(id);
    // Store serializes simultaneous confirmations; a second click cannot rebind.
    return this.store.mutate((state) => {
      ensure(item.expiresAt > this.now(), "연결 요청이 만료됐습니다.");
      if (item.projectId) {
        ensure(item.projectId === projectId, "이미 다른 프로젝트에 연결된 요청입니다.");
        return { projectId };
      }
      const project = state.projects.find((p) => p.id === projectId);
      ensure(project, "연결할 프로젝트를 선택해 주세요.");
      const previous = project.figma?.fileId && project.figma.fileId !== item.fileId ? project.figma : null;
      if (previous && !switchFile) throw Object.assign(new Error(`이 프로젝트에는 다른 Figma 파일 ‘${previous.fileName || previous.fileId}’이 연결되어 있습니다. 이 파일로 바꾸거나 다른 프로젝트를 선택해 주세요.`), { code: "FIGMA_FILE_MISMATCH" });
      const token = randomBytes(32).toString("hex");
      state.pluginConnections = (state.pluginConnections || []).filter((c) => !(previous && c.projectId === projectId));
      state.pluginConnections.push({ token, projectId, fileId: item.fileId });
      project.figma = { fileId: item.fileId, fileName: item.fileName, ...(item.fileUrl ? { fileUrl: item.fileUrl } : {}), ...(previous ? { previousFiles: [...(previous.previousFiles || []), { fileId: previous.fileId, fileName: previous.fileName, replacedAt: new Date().toISOString() }] } : {}) };
      Object.assign(item, { token, projectId });
      return { projectId };
    });
  }
  claim({ id, claim }) {
    const item = this.get(id);
    ensure(item.claim === claim, "이 플러그인의 연결 요청이 아닙니다.");
    return item.token ? { status: "CONNECTED", token: item.token, projectId: item.projectId } : { status: "WAITING" };
  }
}
