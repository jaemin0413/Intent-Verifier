import { ensure } from "./domain.mjs";

export function notionDestination(value) {
  const text = String(value ?? "").trim();
  if (!text) return { notionPageUrl: "", parentId: "" };
  let url;
  try { url = new URL(text); } catch { throw new Error("노션에서 복사한 페이지 링크를 붙여 넣어 주세요."); }
  const host = url.hostname;
  ensure(url.protocol === "https:" && !url.username && !url.password && !url.port &&
    (["notion.so", "www.notion.so", "notion.com", "www.notion.com", "app.notion.com"].includes(host) || host.endsWith(".notion.site")),
  "https://로 시작하는 노션 페이지 링크를 붙여 넣어 주세요.");
  // A database-view link may contain a selected page in ?p=. Never use ?v= (view ID).
  const selected = url.searchParams.get("p");
  const leaf = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");
  const candidate = selected || leaf;
  const match = candidate.match(/(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  ensure(match, "페이지를 열고 ‘링크 복사’로 복사한 주소를 넣어 주세요. 페이지 ID를 찾을 수 없습니다.");
  const parentId = match[1].replaceAll("-", "").toLowerCase();
  return { parentId, notionPageUrl: `https://www.notion.so/${parentId}` };
}
