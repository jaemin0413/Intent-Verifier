import { STATUS_CODES } from "node:http";
import { digest, ensure, isApproved } from "./domain.mjs";

// Structure read from the user's template, 2026-09-17. No source-page mutation.
export const DEFAULT_NOTION_TEMPLATE = Object.freeze({
  id: "api-spec-default",
  name: "기본 API 명세 양식",
  revision: 2,
});
const unknown = "미확정 — 승인된 API 계약에 내용이 없습니다.";
const has = (o, key) => Object.hasOwn(o, key);
const json = (value) => JSON.stringify(value, null, 2);

export function publicationKey(spec, { parentId = "" } = {}) {
  return digest({ approval: spec.approval?.digest, parentId, layout: DEFAULT_NOTION_TEMPLATE });
}

// AI drafts pass through approval before reaching this renderer. It cannot read
// the backend, reinterpret expectations, or invent examples/schema information.
export function specificationDocument(spec) {
  ensure(isApproved(spec), "승인된 명세만 내보낼 수 있습니다.");
  if(["resource-http-v1","controller-api-v1"].includes(spec.contract.kind)) {
    const sections=[{kind:"heading",level:1,text:spec.feature.name},{kind:"paragraph",text:`승인 버전: v${spec.version} / ${spec.approval.digest}\nAPI 초안은 AI 제안이며 승인된 기준으로 검사합니다.`}];
    for(const s of spec.scenarios) {
      sections.push({kind:"heading",level:2,text:s.name},{kind:"paragraph",text:`${s.action.method} ${s.action.path}\n인증: ${spec.contract.kind==="controller-api-v1"?s.actor.mode:"Spring Security ROLE_USER 테스트 인증"}`});
      if(s.action.pathValues?.length)sections.push({kind:"heading",level:3,text:"Path Variable"},{kind:"code",text:json(s.action.pathValues)});
      if(s.action.query?.length)sections.push({kind:"heading",level:3,text:"Query Parameter"},{kind:"code",text:json(s.action.query)});
      if(s.target && s.action.path.includes("{targetId}")) sections.push({kind:"heading",level:3,text:"Path Variable"},{kind:"paragraph",text:`targetId: integer (${s.target.id})`});
      if(s.action.body!==null) sections.push({kind:"heading",level:3,text:"Request Body"},{kind:"code",text:json(s.action.body)});
      sections.push({kind:"heading",level:3,text:`Response ${s.expected.status}`},{kind:"code",text:json(s.expected.checks || {jsonChecks:s.expected.json,targetExists:s.expected.targetExists,targetState:s.expected.targetState})});
    }
    sections.push({kind:"heading",level:2,text:"기획 근거와 검증 범위"});
    for(const r of spec.requirements) {
      sections.push({kind:"paragraph",text:`${r.description}\nScan: ${r.evidence?.scanId || "없음"}, Node: ${r.evidence?.nodeIds?.join(", ") || "없음"}\n${r.evidence?.excerpt || ""}`});
      for(const c of r.conditions) sections.push({kind:"paragraph",text:`${c.description}${c.requiredScenarios.length ? "" : " — UNVERIFIED: 실행 근거 없음"}`});
    }
    sections.push({kind:"paragraph",text:"승인된 기준의 출력입니다. 테스트 생성·명세 승인은 PASS를 의미하지 않습니다."});
    return sections;
  }
  const c = spec.contract;
  const request = c.request || {};
  const sections = [];
  const heading = (text, level = 2) => sections.push({ kind: "heading", text, level });
  const paragraph = (text) => sections.push({ kind: "paragraph", text: String(text) });
  const code = (value) => sections.push({ kind: "code", text: json(value) });
  const table = (fields) => {
    ensure(Array.isArray(fields), "명세 표의 필드는 배열이어야 합니다.");
    if (!fields.length) return;
    sections.push({ kind: "table", rows: [["key", "type", "description"], ...fields.map((f) => {
      ensure(f && typeof f.key === "string" && f.key.trim(), "명세 필드의 key가 필요합니다.");
      return [f.key, f.type || "미확정", f.description || "미확정"];
    })] });
  };
  const fieldSection = (title, fields) => {
    if (Array.isArray(fields) && fields.length === 0) return;
    heading(title);
    if (fields === undefined) paragraph(unknown);
    else table(fields);
  };
  heading(spec.feature.name, 1);
  paragraph(`승인 버전: v${spec.version} / ${spec.approval.digest}`);
  heading("Request URL", 1);
  paragraph(c.path);
  heading("HTTP Method", 1);
  paragraph(c.method);
  paragraph(`인증: ${c.authentication || "미확정"}`);
  fieldSection("Header", request.headers);
  const pathKeys = [...new Set([...c.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]))];
  const pathFields = request.pathParameters;
  if (pathFields !== undefined) {
    ensure(Array.isArray(pathFields) && pathFields.length === pathKeys.length &&
      pathKeys.every((key) => pathFields.filter((f) => f.key === key).length === 1),
    "Path Variable과 승인된 URL의 변수가 일치하지 않습니다.");
  }
  fieldSection("Path Variable", pathFields ?? pathKeys.map((key) => ({ key })));
  fieldSection("Query Param", request.queryParameters);
  if (request.body !== null) {
    heading("Request Body");
    if (request.body === undefined) paragraph(unknown);
    else {
      ensure(typeof request.body === "object" && !Array.isArray(request.body), "Request Body 형식을 확인해 주세요.");
      if (request.body.contentType) paragraph(request.body.contentType);
      if (request.body.fields?.length) table(request.body.fields);
      else if (request.body.schema) code(request.body.schema);
      else paragraph("본문을 사용합니다. 필드 구조는 미확정입니다.");
    }
  }
  if (has(request, "example")) {
    ensure(request.body !== null, "본문 미사용 계약에 Request Example이 있습니다.");
    heading("Request Example");
    code(request.example);
  }
  // Template's 200/400 are placeholders, never expected behavior.
  const statuses = [...new Set([c.success, c.forbidden, ...spec.scenarios.map((s) => s.expected.status)])];
  if (c.responses !== undefined) {
    ensure(Array.isArray(c.responses) && c.responses.every((r) => Number.isInteger(r.status) && r.status >= 100 && r.status <= 599), "응답 형식을 확인해 주세요.");
    ensure(new Set(c.responses.map((r) => r.status)).size === c.responses.length, "응답 코드가 중복되었습니다.");
    for (const r of c.responses) if (!statuses.includes(r.status)) statuses.push(r.status);
  }
  for (const status of statuses) {
    const response = c.responses?.find((r) => r.status === status);
    heading(`${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ""}`);
    if (response?.description) paragraph(response.description);
    if (status === 204 || status === 304 || c.method === "HEAD") {
      ensure(!response || (!response.fields?.length && !has(response, "example")), "본문 없는 응답에 필드 또는 예시가 있습니다.");
      paragraph("응답 본문 없음");
      continue;
    }
    if (response?.body === null) {
      ensure(!response.fields?.length && !has(response, "example"), "본문 미사용 응답에 필드 또는 예시가 있습니다.");
      paragraph("응답 본문 없음");
      continue;
    }
    heading("Response", 3);
    if (response?.fields?.length) table(response.fields);
    else paragraph(unknown);
    if (response && has(response, "example")) code(response.example);
  }
  heading("승인된 동작과 검증 조건");
  for (const r of spec.requirements) {
    paragraph(r.description);
    for (const condition of r.conditions) {
      paragraph(`${condition.description}${condition.requiredScenarios.length ? "" : " — UNVERIFIED: 실행 가능한 Scenario 없음"}`);
    }
  }
  for (const s of spec.scenarios) paragraph(`${s.name}: ${s.actor.id} → ${s.action.method} ${s.action.path} → ${s.expected.status}, 대상 ${s.expected.targetExists ? "유지" : "삭제"}`);
  heading("원문 근거");
  for (const r of spec.requirements) paragraph(`Scan: ${r.evidence?.scanId || "직접 입력"}, Node: ${r.evidence?.nodeIds?.join(", ") || "없음"}\n${r.evidence?.excerpt || r.origin}`);

  paragraph("승인된 기준의 단방향 출력입니다. Notion 수정은 검증 기준에 자동 반영되지 않습니다. 이 문서는 검사 PASS를 의미하지 않습니다.");
  return sections;
}

const cell = (s) => String(s).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
export function specMarkdown(spec) {
  return specificationDocument(spec).map((s) => {
    if (s.kind === "heading") return `${"#".repeat(s.level)} ${s.text}`;
    if (s.kind === "code") {
      const fence = "`".repeat(Math.max(3, ...[...s.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `${fence}json\n${s.text}\n${fence}`;
    }
    if (s.kind === "table") return [s.rows[0], ["---", "---", "---"], ...s.rows.slice(1)].map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
    return s.text;
  }).join("\n\n") + "\n";
}

const richText = (value) => (String(value).match(/[\s\S]{1,1800}/gu) || []).map((content) => ({ type: "text", text: { content } }));
export function specNotionBlocks(spec) {
  return specificationDocument(spec).map((s) => {
    if (s.kind === "table") return { object: "block", type: "table", table: {
      table_width: 3, has_column_header: true, has_row_header: false,
      children: s.rows.map((r) => ({ object: "block", type: "table_row", table_row: { cells: r.map(richText) } })),
    } };
    const type = s.kind === "heading" ? `heading_${s.level}` : s.kind === "code" ? "code" : "paragraph";
    return { object: "block", type, [type]: { rich_text: richText(s.text), ...(type === "code" ? { language: "json" } : {}) } };
  });
}
