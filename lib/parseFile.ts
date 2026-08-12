import * as XLSX from "xlsx";
import type { WbsTask } from "./types";
import { mapHeaders, markLeaves, toTasks } from "./wbs";

/**
 * 엑셀 WBS를 읽어 WbsTask[]로 바꾼다. 서버로 파일을 보내지 않는다.
 *
 * 실제 기관 WBS는 한 파일에 기관별로 시트가 나뉘어 있고, 위쪽에 제목·안내 행이
 * 몇 줄 붙어 있으며, 총괄·매핑처럼 구조가 다른 시트가 섞여 있다.
 * 그래서 "시트 하나를 고르는" 대신 **과업 시트를 전부 찾아 합친다.**
 */

export type SheetReport = { name: string; rows: number; skipped?: string };

/** 총괄시트가 직접 집계해 둔 기관별 수치. 있으면 이 값이 기관 공식 보고값이다. */
export type ReportedRollup = { name: string; planned: number; progress: number; basis: string };

export type WbsFile = {
  tasks: WbsTask[];
  sheets: SheetReport[];
  /** 구 코드 → 신 코드 변환표(매핑 시트가 있을 때). 선·후행 해석에 쓴다. */
  codeAliases: Record<string, string>;
  /** 총괄시트의 기관별 표. 기관마다 산정 기준이 달라 우리가 다시 계산하면 어긋난다. */
  reported: ReportedRollup[];
};

export async function readWbsFile(file: File): Promise<WbsFile> {
  return parseWbsBuffer(await file.arrayBuffer(), file.name);
}

/** 파일 없이도 같은 경로를 탈 수 있게 분리했다 — 테스트와 샘플이 이 함수를 쓴다. */
export function parseWbsBuffer(buffer: ArrayBuffer | Uint8Array, fileName: string): WbsFile {
  const book = XLSX.read(buffer, { type: "array", cellDates: true });
  return parseGrids(
    book.SheetNames.map((name) => ({
      name,
      grid: XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1, blankrows: false, raw: true }),
    })),
    fileName,
  );
}

export type NamedGrid = { name: string; grid: unknown[][] };

/**
 * 시트 이름 + 2차원 배열에서 곧바로 읽는다.
 * 엑셀 파일과 구글 시트가 같은 파서를 타도록 여기서 갈래를 합친다.
 */
export function parseGrids(sheetsIn: NamedGrid[], fileName: string): WbsFile {
  const year = guessYear(fileName) ?? new Date().getFullYear();

  const tasks: WbsTask[] = [];
  const sheets: SheetReport[] = [];
  let codeAliases: Record<string, string> = {};
  let reported: ReportedRollup[] = [];

  for (const { name, grid } of sheetsIn) {
    const summary = readSummary(grid);
    if (summary) {
      reported = summary;
      sheets.push({ name, rows: 0, skipped: `총괄 집계 ${summary.length}개 기관` });
      continue;
    }

    const aliases = readCodeMap(grid);
    if (aliases) {
      codeAliases = { ...codeAliases, ...aliases };
      sheets.push({ name, rows: 0, skipped: "코드 매핑표" });
      continue;
    }

    const headerIndex = findHeaderRow(grid);
    if (headerIndex < 0) {
      sheets.push({ name, rows: 0, skipped: "과업 열 없음" });
      continue;
    }

    const headers = (grid[headerIndex] ?? []).map((cell, index) =>
      String(cell ?? `열${index + 1}`).trim() || `열${index + 1}`,
    );
    const rows = grid.slice(headerIndex + 1).map((row) => {
      const record: Record<string, unknown> = {};
      headers.forEach((header, index) => { record[header] = row?.[index]; });
      return record;
    });

    // 기관별 시트는 기관명이 열이 아니라 시트명에 있다.
    const parsed = toTasks(rows, year, { sheet: name, owner: name });
    if (!parsed.length) {
      sheets.push({ name, rows: 0, skipped: "과업 행 없음" });
      continue;
    }

    // 일정 시트인지 데이터로 확인한다. 마일스톤 시트처럼 기간이 "1~3월" 식으로
    // 적힌 표는 헤더만 보면 과업 시트와 구분되지 않는다.
    const dated = parsed.filter((task) => task.end || task.start).length;
    if (dated / parsed.length < 0.3) {
      sheets.push({ name, rows: 0, skipped: "일정 열 없음" });
      continue;
    }

    tasks.push(...parsed);
    sheets.push({ name, rows: parsed.length });
  }

  if (!tasks.length) {
    throw new Error("과업 시트를 찾지 못했습니다. WBS 코드와 과업명 열이 있는 시트인지 확인해 주세요.");
  }

  // 시트별로 코드가 1부터 다시 시작하므로 기관명을 앞에 붙여 전역 고유 코드로 만든다.
  const scoped = tasks.map((task) => ({ ...task, code: task.code ? `${task.sheet}-${task.code}` : "" }));
  return { tasks: markLeaves(scoped), sheets, codeAliases, reported };
}

/**
 * 총괄시트의 "기관별 진척 총괄" 표를 읽는다.
 *
 * 기관마다 산정 기준이 다르다("W3 전체 계층 자동집계", "W3.2 가중 자동집계"…).
 * 우리가 말단 평균으로 다시 계산하면 기관이 보고한 수치와 어긋나므로,
 * 표가 있으면 그 값을 그대로 쓴다.
 */
function readSummary(grid: unknown[][]): ReportedRollup[] | null {
  const limit = Math.min(grid.length, 30);
  for (let index = 0; index < limit; index += 1) {
    const cells = (grid[index] ?? []).map((cell) => String(cell ?? "").replace(/\s/g, ""));
    const orgCol = cells.findIndex((cell) => /^기관$/.test(cell));
    const planCol = cells.findIndex((cell) => /^계획\(%\)$/.test(cell));
    const actualCol = cells.findIndex((cell) => /^(실적|진척)\(%\)$/.test(cell));
    if (orgCol < 0 || planCol < 0 || actualCol < 0) continue;
    const basisCol = cells.findIndex((cell) => /산정기준/.test(cell));

    const rows: ReportedRollup[] = [];
    for (const row of grid.slice(index + 1)) {
      const name = String(row?.[orgCol] ?? "").trim();
      const planned = toPercent(row?.[planCol]);
      const progress = toPercent(row?.[actualCol]);
      if (!name || planned == null || progress == null) continue;
      // "전체(기관 동일가중)" 행은 합계라 기관 목록에 넣지 않는다.
      if (/^전체/.test(name)) continue;
      rows.push({ name, planned, progress, basis: basisCol >= 0 ? String(row?.[basisCol] ?? "").trim() : "" });
    }
    return rows.length ? rows : null;
  }
  return null;
}

function toPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value > 1 ? value : value * 100) * 10) / 10;
}

/**
 * 과업 시트의 헤더 행을 찾는다.
 * 위쪽 제목·안내 행을 건너뛰어야 하므로 20행까지 훑는다.
 */
function findHeaderRow(grid: unknown[][]): number {
  const limit = Math.min(grid.length, 20);
  for (let index = 0; index < limit; index += 1) {
    const cells = (grid[index] ?? []).map((cell) => String(cell ?? "").trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const map = mapHeaders(cells);
    // 과업명과 (코드 또는 일정)이 함께 있어야 과업 시트로 본다.
    if (map.title && (map.code || map.end || map.start)) return index;
  }
  return -1;
}

/**
 * "기존 WBS코드 → 신규/통합 코드" 매핑 시트를 읽는다.
 * 선·후행 칸이 구 코드로 적혀 있어 이게 없으면 의존관계를 이을 수 없다.
 */
function readCodeMap(grid: unknown[][]): Record<string, string> | null {
  const limit = Math.min(grid.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const raw = (grid[index] ?? []).map((cell) => String(cell ?? "").trim());
    // 헤더 행만 본다. 안내 문장 한 칸짜리 행에도 "기존코드"와 "통합관리코드"가
    // 함께 등장해서, 길이 제한을 두지 않으면 그 문장을 헤더로 오인한다.
    const isHeaderRow = raw.filter(Boolean).length >= 3 && raw.every((cell) => cell.length <= 30);
    if (!isHeaderRow) continue;

    const cells = raw.map((cell) => cell.replace(/\s/g, ""));
    const oldCol = cells.findIndex((cell) => /기존.*코드/.test(cell));
    const newCol = cells.findIndex((cell) => /신규.*코드/.test(cell));
    const orgCol = cells.findIndex((cell) => /^기관$/.test(cell));
    if (oldCol < 0 || newCol < 0 || oldCol === newCol) continue;

    const aliases: Record<string, string> = {};
    for (const row of grid.slice(index + 1)) {
      const from = String(row?.[oldCol] ?? "").trim();
      const to = String(row?.[newCol] ?? "").trim();
      const org = orgCol >= 0 ? String(row?.[orgCol] ?? "").trim() : "";
      // 코드는 시트별로 1부터 다시 시작하므로 기관명을 붙여야 전역에서 유일해진다.
      if (from && to) aliases[from] = org ? `${org}-${to}` : to;
    }
    return Object.keys(aliases).length ? aliases : null;
  }
  return null;
}

/** 파일명의 연도를 쓰면 "8/12" 같은 축약 날짜를 정확히 해석할 수 있다. */
function guessYear(fileName: string): number | null {
  const match = fileName.match(/(20\d{2})/);
  return match ? Number(match[1]) : null;
}
