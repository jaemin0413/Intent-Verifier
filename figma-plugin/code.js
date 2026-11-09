figma.showUI(__html__, { width: 390, height: 650, themeColors: true });
// Local development plugins can read fileKey through the private-plugin API.
// A non-secret document ID covers files without a cloud key; never invent a URL.
let fileId = figma.fileKey;
if (!fileId) {
  fileId = figma.root.getPluginData("verification-document-id");
  if (!fileId) {
    fileId = "document-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    figma.root.setPluginData("verification-document-id", fileId);
  }
}
const fileUrl = figma.fileKey ? "https://www.figma.com/design/" + figma.fileKey : undefined;
const storageKey = "verification-connection-v2:" + fileId;
async function initialize() {
  figma.ui.postMessage({ type: "pages", currentPageId: figma.currentPage.id, pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })) });
  let settings, storageError;
  try { settings = await figma.clientStorage.getAsync(storageKey); }
  catch (error) { storageError = String(error.message || error); }
  figma.ui.postMessage({ type: "settings", settings: settings || {}, storageError, file: { fileId, fileName: figma.root.name, fileUrl } });
  notifySelection();
}
function notifySelection() {
  figma.ui.postMessage({
    type: "selection",
    count: figma.currentPage.selection.length,
    names: figma.currentPage.selection.map((n) => n.name),
  });
}
figma.on("selectionchange", notifySelection);
let syncActive = false, syncCancelled = false, transferSequence = 0;
const transfers = new Map();
function transfer(type, data) {
  if (syncCancelled) return Promise.reject(new Error("동기화를 중단했습니다. 이전 완료본은 유지됩니다."));
  return new Promise((resolve, reject) => {
    const requestId = String(++transferSequence);
    transfers.set(requestId, {resolve, reject});
    figma.ui.postMessage({type, requestId, ...data});
  });
}
figma.ui.onmessage = async (message) => {
  if (message.type === "sync-ack") {
    const pending = transfers.get(message.requestId);
    if (pending) { transfers.delete(message.requestId); pending.resolve(); }
    return;
  }
  if (message.type === "sync-cancel") {
    syncCancelled = true;
    for (const pending of transfers.values()) pending.reject(new Error("동기화를 중단했습니다. 이전 완료본은 유지됩니다."));
    transfers.clear();
    return;
  }
  if (message.type === "ready") { await initialize(); return; }
  if (message.type === "save") {
    try { await figma.clientStorage.setAsync(storageKey, message.settings); }
    catch (error) { figma.ui.postMessage({ type: "storage-error", message: String(error.message || error) }); }
    return;
  }
  if (message.type === "open") {
    figma.openExternal(message.url);
    return;
  }
  if (["sync-page", "sync-selection"].includes(message.type)) {
    if (syncActive) return;
    syncActive = true; syncCancelled = false;
    try {
      const captureStartedAt = new Date().toISOString();
      const selectedOnly = message.type === "sync-selection";
      const page = selectedOnly ? figma.currentPage : await figma.getNodeByIdAsync(message.pageId);
      const chosen = selectedOnly ? Array.from(page.selection) : null;
      if (selectedOnly && !chosen.length) throw new Error("Figma에서 보관할 화면설계서를 드래그로 선택해 주세요.");
      const selectionRoots = chosen?.filter(n=>{let p=n.parent;while(p){if(chosen.some(x=>x.id===p.id))return false;p=p.parent;}return true;});
      if (!page || page.type !== "PAGE") throw new Error("동기화할 페이지를 선택해 주세요.");
      await page.loadAsync();
      const roots = [], notes = [];
      let count = 0;
      function extract(node, depth = 0) {
        if (++count > 100000 || depth >= 100) throw new Error(`화면 ‘${node.name}’의 구조가 보관 가능한 범위를 넘었습니다.`);
        const value = { id: node.id, name: node.name, type: node.type, parentId: node.parent?.id };
        if ("characters" in node) value.text = node.characters;
        if ("absoluteBoundingBox" in node) value.bounds = node.absoluteBoundingBox;
        if ("reactions" in node) value.reactions = node.reactions;
        if ("children" in node) value.children = node.children.map((c) => extract(c, depth + 1));
        return value;
      }
      function discover(node) {
        if (["FRAME", "COMPONENT", "INSTANCE"].includes(node.type)) roots.push(node);
        else if (node.type === "TEXT") notes.push(node);
        else if (node.children) node.children.forEach(discover);
      }
      if (selectedOnly) {
        for (const n of selectionRoots) {
          if (typeof n.exportAsync !== "function") throw new Error(`‘${n.name}’은 이미지로 저장할 수 없어요. 화면설계서 프레임을 선택해 주세요.`);
          roots.push(n);
        }
      } else page.children.forEach(discover);
      if (roots.length > 2000) throw new Error(`이 페이지에는 ${roots.length}개 화면이 있습니다. 한 번에 2,000개까지 동기화할 수 있습니다.`);
      const initialIds = roots.map((n) => n.id).join(",");
      count = 0;
      const context = notes.map((n) => extract(n));
      await transfer("library-start", {library: {fileId, fileUrl, fileName: figma.root.name, captureStartedAt, scope:{kind:selectedOnly ? "selection" : "page",rootIds:roots.map(n=>n.id)}, pages:[{id:page.id,name:page.name}], contexts:[{pageId:page.id,nodes:context}], screenIds:roots.map(n=>n.id)}});
      let bytesTotal = 0;
      for (const [i, node] of roots.entries()) {
        if (syncCancelled) throw new Error("동기화를 중단했습니다. 이전 완료본은 유지됩니다.");
        figma.ui.postMessage({type:"sync-progress",message:`${i + 1} / ${roots.length}개 · ${node.name} 수집 중`});
        count = 0;
        const before = extract(node);
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: selectedOnly ? 2000 : 900 } });
        bytesTotal += bytes.length;
        if (bytesTotal > 1000000000) throw new Error("한 수집본의 이미지가 1GB를 넘었습니다. 더 작은 페이지를 선택해 주세요.");
        count = 0;
        if (JSON.stringify(before) !== JSON.stringify(extract(node))) throw new Error("수집 중 화면이 바뀌었습니다. 편집을 마친 뒤 다시 동기화해 주세요.");
        await transfer("library-screen", {screen: { id: node.id, name: node.name, pageId: page.id, node: before, image: { nodeId: node.id, dataUrl: "data:image/png;base64," + figma.base64Encode(bytes) } }});
        figma.ui.postMessage({ type: "sync-progress", message: `${i + 1} / ${roots.length}개 화면 수집 중` });
      }
      // Detect structural/context edits during collection; still disclose the time interval.
      roots.length = 0; notes.length = 0;
      if (selectedOnly) {
        for (const n of selectionRoots) { if(n.removed) throw new Error("수집 중 선택한 설계서가 삭제됐어요. 다시 선택해 주세요."); roots.push(n); }
      } else page.children.forEach(discover);
      count = 0;
      if (initialIds !== roots.map((n) => n.id).join(",") || JSON.stringify(context) !== JSON.stringify(notes.map((n) => extract(n)))) throw new Error("수집 중 페이지 구성이 바뀌었습니다. 다시 동기화해 주세요.");
      await transfer("library-complete", {captureFinishedAt:new Date().toISOString()});
    } catch (error) { figma.ui.postMessage({ type: "sync-error", message: error.message }); }
    finally { syncActive = false; }
    return;
  }
  if (message.type !== "scan") return;
  try {
    const selection = figma.currentPage.selection;
    if (!selection.length)
      throw new Error("먼저 함께 분석할 화면을 선택해 주세요.");
    if (selection.length > 30)
      throw new Error("한 번에 30개 이하의 화면을 선택해 주세요.");
    // Remove descendants when both a parent frame and a child are selected.
    const roots = selection.filter((n) => {
      let p = n.parent;
      while (p) {
        if (selection.some((x) => x.id === p.id)) return false;
        p = p.parent;
      }
      return true;
    });
    let count = 0,
      truncated = false;
    function extract(node, depth = 0) {
      if (++count > 4000 || depth >= 24) {
        truncated = true;
        return null;
      }
      const data = {
        id: node.id,
        name: node.name,
        type: node.type,
        parentId: node.parent ? node.parent.id : null,
      };
      if ("characters" in node) data.text = node.characters;
      if ("absoluteBoundingBox" in node) data.bounds = node.absoluteBoundingBox;
      if ("reactions" in node) data.reactions = node.reactions;
      if ("children" in node)
        data.children = node.children
          .map((n) => extract(n, depth + 1))
          .filter(Boolean);
      return data;
    }
    const nodes = roots.map((n) => extract(n)).filter(Boolean),
      images = [];
    for (const node of roots) {
      if ("exportAsync" in node) {
        const bytes = await node.exportAsync({
          format: "PNG",
          constraint: { type: "WIDTH", value: 900 },
        });
        images.push({
          nodeId: node.id,
          dataUrl: "data:image/png;base64," + figma.base64Encode(bytes),
        });
      }
    }
    if (truncated)
      throw new Error(
        "선택 범위가 너무 큽니다. 빠진 내용이 없도록 화면을 나누어 가져와 주세요.",
      );
    figma.ui.postMessage({
      type: "scan",
      scan: {
        schemaVersion: 1,
        source: "figma-plugin",
        fileId, fileUrl, fileName: figma.root.name,
        pageName: figma.currentPage.name,
        nodes,
        images,
      },
    });
  } catch (error) {
    figma.ui.postMessage({ type: "error", message: error.message });
  }
};
