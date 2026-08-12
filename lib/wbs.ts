import type { WbsTask } from "./types";
import { normalize, parseCellDate, parseProgress } from "./text";

/**
 * WBS 읽기.
 *
 * 기관마다 서식이 제각각이라 열 이름을 후보군으로 자동 매핑하고,
 * 계획(%)과 진척(%)을 갈라 읽고, 코드 계층에서 상위/말단을 구분한다.
 */

type RawRow = Record<string, unknown>;

/** 헤더 자동 매핑용 후보. 앞쪽일수록 우선. */
type MappedField =
  | "code" | "title" | "owner" | "assignee" | "start" | "end"
  | "planned" | "progress" | "weight" | "status" | "predecessors"
  | "deliverable" | "milestone";

const HEADER_HINTS: Record<MappedField, string[]> = {
  code: ["wbs코드", "통합관리코드", "wbs", "코드", "과업번호", "번호", "id", "no"],
  // 실제 기관 WBS는 "담당 과제(세부 연구개발)"처럼 '과업'이 아니라 '과제'를 쓴다.
  title: ["담당과제세부연구개발", "세부과업", "과업명", "세부과제", "과제명", "과업", "과제", "업무명", "업무", "작업명", "작업", "활동명", "활동", "task", "항목"],
  owner: ["수행기관", "담당기관", "기관", "주관", "책임기관", "owner"],
  assignee: ["담당자", "책임자", "담당", "assignee"],
  start: ["시작일", "착수일", "시작", "착수", "start"],
  end: ["종료일", "완료일", "마감일", "종료", "완료", "마감", "end", "due"],
  // 계획(%)과 진척(%)은 반드시 갈라 읽어야 한다. 둘을 섞으면 편차가 사라진다.
  planned: ["계획", "계획률", "계획진척률", "계획공정률", "plan", "planned"],
  progress: ["진척", "진행률", "진척률", "실적", "진도", "달성률", "진행", "progress", "actual"],
  weight: ["가중치", "비중", "weight"],
  status: ["상태", "진행상태", "비고", "status"],
  predecessors: ["선·후행", "선후행", "선행과업", "선행작업", "선행", "predecessor", "선행조건", "의존"],
  deliverable: ["산출물", "성과물", "결과물", "deliverable"],
  milestone: ["m/s", "ms", "마일스톤", "milestone"],
};

/** 헤더 행의 셀 이름 → 표준 필드. 못 찾은 필드는 빈 값으로 남는다. */
export function mapHeaders(headers: string[]): Partial<Record<MappedField, string>> {
  const mapping: Partial<Record<MappedField, string>> = {};
  const used = new Set<string>();

  for (const [field, hints] of Object.entries(HEADER_HINTS) as [keyof typeof HEADER_HINTS, string[]][]) {
    let best: { header: string; rank: number } | null = null;
    for (const header of headers) {
      if (used.has(header)) continue;
      const flat = normalize(header);
      if (!flat) continue;
      const rank = hints.findIndex((hint) => flat === normalize(hint));
      const loose = rank >= 0 ? rank : hints.findIndex((hint) => flat.includes(normalize(hint)));
      if (loose < 0) continue;
      // 정확일치(rank>=0)를 부분일치보다 항상 먼저 집는다.
      const score = rank >= 0 ? rank : loose + hints.length;
      if (!best || score < best.rank) best = { header, rank: score };
    }
    if (best) {
      mapping[field] = best.header;
      used.add(best.header);
    }
  }
  return mapping;
}

/** 파싱된 시트 행 배열을 표준 WbsTask[]로. 제목이 없는 행은 버린다. */
export function toTasks(
  rows: RawRow[],
  year = new Date().getFullYear(),
  options: { sheet?: string; owner?: string } = {},
): WbsTask[] {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const map = mapHeaders(headers);
  const pick = (row: RawRow, field: MappedField) => {
    const header = map[field];
    return header ? row[header] : undefined;
  };

  const tasks: WbsTask[] = [];
  rows.forEach((row, index) => {
    const code = String(pick(row, "code") ?? "").trim();
    const title = String(pick(row, "title") ?? "").trim();
    // 제목이 비어도 코드가 있으면 계층 유지를 위해 남긴다(기관 WBS에 흔한 빈 상위 행).
    if (!title && !code) return;
    const milestoneCell = String(pick(row, "milestone") ?? "").trim();
    tasks.push({
      code,
      title: title || code,
      owner: String(pick(row, "owner") ?? options.owner ?? "").trim(),
      assignee: String(pick(row, "assignee") ?? "").trim(),
      start: parseCellDate(pick(row, "start"), year),
      end: parseCellDate(pick(row, "end"), year),
      planned: parseProgress(pick(row, "planned")),
      progress: parseProgress(pick(row, "progress")),
      weight: toNumber(pick(row, "weight")),
      status: String(pick(row, "status") ?? "").trim(),
      predecessors: splitCodes(pick(row, "predecessors")),
      deliverable: String(pick(row, "deliverable") ?? "").trim(),
      milestone: Boolean(milestoneCell) && !/^(x|없음|-|0)$/i.test(milestoneCell),
      depth: code ? code.split(".").length : 1,
      isLeaf: true, // 아래에서 코드 관계를 보고 다시 채운다
      sheet: options.sheet ?? "",
      row: index + 1,
    });
  });
  return markLeaves(tasks);
}

/** 자기 코드로 시작하는 하위 코드가 있으면 상위 항목이다. 집계는 말단만 센다. */
export function markLeaves(tasks: WbsTask[]): WbsTask[] {
  const codes = tasks.map((task) => task.code).filter(Boolean);
  return tasks.map((task) => ({
    ...task,
    isLeaf: !task.code || !codes.some((code) => code !== task.code && code.startsWith(`${task.code}.`)),
  }));
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 선행과업 칸을 코드 배열로.
 * 실제 파일에는 코드 대신 "선"/"후" 같은 표시만 적힌 칸도 있어서 코드 형태만 남긴다.
 */
function splitCodes(value: unknown): string[] {
  if (value == null || value === "") return [];
  return String(value)
    .split(/[,;·/\s]+/)
    .map((code) => code.trim())
    .filter((code) => /^[A-Za-z]*\d+(\.\d+)*$/.test(code));
}
