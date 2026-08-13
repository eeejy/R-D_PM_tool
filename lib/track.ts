/**
 * 쟁점·결정 트랙.
 *
 * 회의록에서 나오는 것이 전부 내 업무는 아니다. 세 가지가 섞여 있다.
 *
 *   - **요청(request)** — 내가 처리할 일. 업무로 등록한다.
 *   - **쟁점(issue)** — 아직 결론이 안 난 사안. **업무 목록과 섞지 않는다.**
 *   - **결정(decision)** — 이미 확정된 것. 업무가 아니라 기록이다.
 *
 * 쟁점을 업무 목록에 넣으면 "오늘 할 일"이 결론 안 난 논의로 채워진다. 담당자가
 * 체크할 수 없는 항목이 목록에 쌓이면 목록 자체를 안 보게 된다. 그래서 트랙을 나눈다.
 *
 * 저장 구조는 `project_id`를 나중에 필드로만 붙일 수 있게 평평하게 둔다.
 *
 * React를 import하지 않는다.
 */

import { isRecord, asText, oneLine } from "./llm";
import { isOrgId, orgName, type OrgId } from "./org";
import { parseCellDate } from "./text";

export type TrackKind = "issue" | "decision";

/** 쟁점·결정 공통 항목. 둘은 상태만 다르다. */
export interface TrackItem {
  id: string;
  kind: TrackKind;
  /** 한 줄 요약. 화면에 보이는 값 */
  summary: string;
  /** 원문 근거 문장. 되짚을 수 있어야 한다. */
  source: string;
  orgId?: OrgId;
  /** 회의 제목·안건 번호 등 출처 표기 */
  origin: string;
  at: string;
  /** 쟁점만 쓴다. 결정은 항상 closed. */
  status: "open" | "closed";
  closedAt?: string;
  /** 나중에 사업별로 나눌 때 필드만 붙이면 된다 */
  projectId?: string;
}

export function makeTrackId(kind: TrackKind): string {
  return `${kind[0]}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 미해결 쟁점만. 개요의 배지와 인수인계서가 이 값을 쓴다. */
export function openIssues(items: TrackItem[]): TrackItem[] {
  return items.filter((item) => item.kind === "issue" && item.status === "open");
}

export function decisions(items: TrackItem[]): TrackItem[] {
  return items.filter((item) => item.kind === "decision");
}

/** 쟁점을 닫는다. 지우지 않는다 — 닫힌 쟁점도 인수인계의 재료다. */
export function closeIssue(items: TrackItem[], id: string, today: string): TrackItem[] {
  return items.map((item) => (item.id === id ? { ...item, status: "closed" as const, closedAt: today } : item));
}

export function reopenIssue(items: TrackItem[], id: string): TrackItem[] {
  return items.map((item) => (item.id === id ? { ...item, status: "open" as const, closedAt: undefined } : item));
}

/** 인수인계서·주간보고 컨텍스트가 쓰는 형태로. */
export function toContextIssues(items: TrackItem[]): { text: string; org?: string; at?: string }[] {
  return openIssues(items).map((item) => ({
    text: item.summary,
    org: item.orgId ? orgName(item.orgId) : undefined,
    at: item.at,
  }));
}

/* ── 회의록 추출 결과 → 검토 항목 ───────────────────────── */

/**
 * 모델이 돌려주는 한 건.
 *
 * 자유 텍스트 파싱을 하지 않는다. JSON으로만 받고, 파싱에 실패하면 호출부가
 * 규칙 결과로 떨어진다.
 */
export type ExtractedItem = {
  type: "request" | "issue" | "decision";
  /** 원문 그대로의 근거 문장 */
  text: string;
  summary: string;
  orgId: OrgId;
  /** 원문 표현 (예: 다음 월간회의 전). 날짜로 못 바꾸면 여기만 남는다. */
  dueRaw: string;
  /** yyyy-mm-dd. 원문에 근거가 없으면 빈 문자열 */
  dueDate: string;
  owner: "나" | "기관" | "불명";
  sourceSegment: number;
};

const OWNERS = ["나", "기관", "불명"] as const;

/**
 * 추출 항목 하나를 다듬는다.
 *
 * **유형과 문장만 모델이 정한다.** 기관은 별칭 매칭이, 날짜는 원문 근거 검사가
 * 정한다 — 다른 기능과 같은 선이다.
 */
export function toExtracted(
  entry: unknown,
  context: { segment: number; source: string; orgOf: (text: string) => OrgId; dateOk: (iso: string, source: string) => boolean },
): ExtractedItem | null {
  if (!isRecord(entry)) return null;
  const text = oneLine(entry.text ?? entry.quote);
  const summary = oneLine(entry.summary ?? entry.text) || text;
  if (!summary) return null;

  const rawType = asText(entry.type).toLowerCase();
  const type: ExtractedItem["type"] =
    rawType === "issue" ? "issue" : rawType === "decision" ? "decision" : "request";

  const claimed = asText(entry.orgId);
  const named = oneLine(entry.org);
  const byRule = context.orgOf(`${named} ${summary} ${text}`);
  const orgId = byRule !== "etc" ? byRule : isOrgId(claimed) ? claimed : "etc";

  const parsed = parseCellDate(asText(entry.dueDate ?? entry.due));
  const dueDate = parsed && context.dateOk(parsed, context.source) ? parsed : "";
  // 날짜로 못 바꿨으면 원문 표현을 그대로 남긴다. 지어내지 않는다.
  const dueRaw = oneLine(entry.dueRaw ?? entry.dueText) || (dueDate ? "" : oneLine(entry.due));

  const owner = OWNERS.find((item) => item === oneLine(entry.owner)) ?? "불명";

  return { type, text: text || summary, summary, orgId, dueRaw, dueDate, owner, sourceSegment: context.segment };
}

/** 검토 화면에서 고른 것을 트랙 항목으로. 요청은 여기 오지 않는다(업무로 간다). */
export function toTrackItem(item: ExtractedItem, origin: string, today: string): TrackItem {
  const kind: TrackKind = item.type === "decision" ? "decision" : "issue";
  return {
    id: makeTrackId(kind),
    kind,
    summary: item.summary,
    source: item.text,
    orgId: item.orgId === "etc" ? undefined : item.orgId,
    origin: `${origin}${item.sourceSegment ? ` 안건 ${item.sourceSegment}` : ""}`,
    at: today,
    // 결정은 이미 확정된 것이라 열어 둘 이유가 없다
    status: kind === "decision" ? "closed" : "open",
    ...(kind === "decision" ? { closedAt: today } : {}),
  };
}
