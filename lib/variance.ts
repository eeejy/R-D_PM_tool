import type { ReportedRollup } from "./parseFile";
import type { Variance, WbsTask } from "./types";

/**
 * 계획 대비 실적 판정.
 *
 * 기관 WBS 총괄시트가 쓰는 기준을 그대로 따른다.
 * 계획(%)은 기준일과 시작·종료일로 선형 계산된 값이고, 진척(%)은 실제 입력값이며,
 * 그 차이(%p)가 이 사업의 핵심 관리지표다. (전체 46.5% vs 계획 49.4% → -2.9%p)
 */

/** 이 폭을 넘어 뒤처지면 지연으로 본다. 실제 총괄시트 판정과 일치하는 값. */
export const DELAY_THRESHOLD = -5;

export function varianceOf(planned: number | null, progress: number | null): number | null {
  if (planned == null || progress == null) return null;
  return Math.round((progress - planned) * 10) / 10;
}

export function statusOf(variance: number | null): Variance {
  if (variance == null) return "정상";
  if (variance <= DELAY_THRESHOLD) return "지연";
  if (variance < 0) return "주의";
  return "정상";
}

export const VARIANCE_TONE: Record<Variance, "danger" | "warn" | "ok"> = {
  "지연": "danger", "주의": "warn", "정상": "ok",
};

export type Rollup = {
  name: string;
  planned: number;
  progress: number;
  variance: number;
  status: Variance;
  /** 이 묶음의 WBS 항목 수 */
  count: number;
  /** 진척이 입력되지 않은 항목 수 — 숫자를 믿기 전에 확인해야 한다 */
  missing: number;
  /** 총괄시트가 밝힌 산정 기준(있을 때) */
  basis?: string;
};

/**
 * 기관별 집계.
 *
 * 기관 시트의 최상위(depth 1) 행에 이미 기관 전체값이 자동집계돼 있으므로 그 값을 쓴다.
 * 말단만 평균내면 가중치를 무시하게 되어 기관이 보고하는 수치와 어긋난다.
 */
export function byInstitution(tasks: WbsTask[], reported: ReportedRollup[] = []): Rollup[] {
  // 총괄시트가 집계해 둔 값이 있으면 그것이 기관 공식 보고값이다.
  // 기관마다 산정 기준(가중/계층)이 달라 우리가 다시 계산하면 어긋난다.
  if (reported.length) {
    const counts = new Map<string, WbsTask[]>();
    for (const task of tasks) counts.set(task.owner, [...(counts.get(task.owner) ?? []), task]);
    return reported
      .map((row) => {
        const items = counts.get(row.name) ?? [];
        const variance = varianceOf(row.planned, row.progress) ?? 0;
        return {
          name: row.name,
          planned: Math.round(row.planned),
          progress: Math.round(row.progress),
          variance,
          status: statusOf(variance),
          count: items.length,
          missing: items.filter((task) => task.progress == null).length,
          basis: row.basis,
        };
      })
      .sort((a, b) => a.variance - b.variance);
  }
  return computeByInstitution(tasks);
}

function computeByInstitution(tasks: WbsTask[]): Rollup[] {
  const groups = new Map<string, WbsTask[]>();
  for (const task of tasks) {
    groups.set(task.owner, [...(groups.get(task.owner) ?? []), task]);
  }

  return [...groups.entries()]
    .map(([name, items]) => {
      const root = items.find((task) => task.depth === 1) ?? null;
      const leaves = items.filter((task) => task.isLeaf);
      const planned = root?.planned ?? average(leaves.map((task) => task.planned));
      const progress = root?.progress ?? average(leaves.map((task) => task.progress));
      const variance = varianceOf(planned, progress) ?? 0;
      return {
        name,
        planned: Math.round(planned),
        progress: Math.round(progress),
        variance,
        status: statusOf(variance),
        count: items.length,
        missing: items.filter((task) => task.progress == null).length,
      };
    })
    .sort((a, b) => a.variance - b.variance);
}

/** 전체 집계. 기관 단순평균 — 총괄시트의 "기관 동일가중"과 같은 방식. */
export function overall(tasks: WbsTask[], reported: ReportedRollup[] = []): Rollup {
  const institutions = byInstitution(tasks, reported);
  const planned = average(institutions.map((item) => item.planned));
  const progress = average(institutions.map((item) => item.progress));
  const variance = varianceOf(planned, progress) ?? 0;
  return {
    name: "전체",
    planned: Math.round(planned),
    progress: Math.round(progress),
    variance,
    status: statusOf(variance),
    count: tasks.length,
    missing: tasks.filter((task) => task.progress == null).length,
  };
}

function average(values: (number | null)[]): number {
  const filled = values.filter((value): value is number => value != null);
  if (!filled.length) return 0;
  return filled.reduce((sum, value) => sum + value, 0) / filled.length;
}
