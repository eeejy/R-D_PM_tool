import { daysBetween, formatKoreanDate } from "./text";
import type { WbsTask } from "./types";
import { byInstitution, overall, statusOf, varianceOf, type Rollup } from "./variance";
import type { ReportedRollup } from "./parseFile";

/**
 * WBS 현재 상태 요약.
 *
 * 회차 간 비교는 하지 않는다. 담당자가 알아야 하는 건 "지난주 대비 무엇이 바뀌었나"가
 * 아니라 **"지금 사업이 어떤 상태이고 내가 무엇을 확인해야 하나"** 이기 때문이다.
 * 그래서 지금 파일 하나만 보고 판단할 수 있는 것만 뽑는다.
 */

export type WbsItem = {
  code: string;
  title: string;
  org: string;
  assignee: string;
  due: string;
  dueLabel: string;
  /** 종료일까지 남은 일수. 음수면 경과 */
  dday: number | null;
  planned: number | null;
  progress: number;
  variance: number | null;
  deliverable: string;
};

export type WbsStatus = {
  overall: Rollup;
  institutions: Rollup[];
  /** 지금 굴러가고 있는 과업 — 종료가 가까운 순 */
  running: WbsItem[];
  /** 최근 100%가 된 과업 */
  completed: WbsItem[];
  /** 종료일이 지났거나 계획 대비 크게 미달 */
  delayed: WbsItem[];
  /** 아직 지연은 아니지만 이대로면 위험한 것 */
  watch: WbsItem[];
  /** 담당자가 기관에 물어봐야 하는 것들 */
  checks: { label: string; detail: string; count: number }[];
  /** 전체 항목 수(상위 집계 포함) */
  total: number;
  leaves: number;
};

function toItem(task: WbsTask, today: string): WbsItem {
  const dday = task.end ? daysBetween(today, task.end) : null;
  return {
    code: task.code,
    title: task.title,
    org: task.owner,
    assignee: task.assignee,
    due: task.end,
    dueLabel: task.end ? formatKoreanDate(task.end) : "기한 미정",
    dday,
    planned: task.planned,
    progress: task.progress ?? 0,
    variance: varianceOf(task.planned, task.progress),
    deliverable: task.deliverable,
  };
}

/** 계획 대비 미달 폭이 큰 순 → 종료 임박 순. */
function byRisk(a: WbsItem, b: WbsItem): number {
  const va = a.variance ?? 0;
  const vb = b.variance ?? 0;
  if (va !== vb) return va - vb;
  return (a.dday ?? 9999) - (b.dday ?? 9999);
}

export function summarize(
  tasks: WbsTask[],
  today: string,
  reported: ReportedRollup[] = [],
  limit = 6,
): WbsStatus {
  // 상위 행은 하위 합계라 목록에 넣으면 같은 내용이 두 번 보인다.
  const leaves = tasks.filter((task) => task.isLeaf);
  const items = leaves.map((task) => toItem(task, today));

  const completed = items
    .filter((item) => item.progress >= 100)
    .sort((a, b) => (b.due || "").localeCompare(a.due || ""))
    .slice(0, limit);

  const delayed = items
    .filter((item) => item.progress < 100 && ((item.dday != null && item.dday < 0) || (item.variance ?? 0) <= -5))
    .sort(byRisk)
    .slice(0, limit);

  const delayedCodes = new Set(delayed.map((item) => item.code));

  const watch = items
    .filter((item) =>
      item.progress < 100 &&
      !delayedCodes.has(item.code) &&
      (((item.variance ?? 0) < 0) || (item.dday != null && item.dday >= 0 && item.dday <= 14)))
    .sort(byRisk)
    .slice(0, limit);

  const running = items
    .filter((item) => item.progress > 0 && item.progress < 100)
    .sort((a, b) => (a.dday ?? 9999) - (b.dday ?? 9999))
    .slice(0, limit);

  const missingProgress = tasks.filter((task) => task.progress == null).length;
  const missingDue = leaves.filter((task) => !task.end).length;
  const notStarted = leaves.filter((task) => (task.progress ?? 0) === 0 && (task.planned ?? 0) > 10).length;
  const deliverablePending = leaves.filter((task) => task.deliverable && (task.progress ?? 0) < 100 && task.end && (daysBetween(today, task.end) ?? 99) <= 30).length;

  const checks = [
    { label: "실적 미입력", detail: "진척이 비어 있어 집계에서 빠진 항목", count: missingProgress },
    { label: "착수 지연", detail: "계획상 진행됐어야 하나 실적이 0", count: notStarted },
    { label: "산출물 임박", detail: "30일 내 종료 예정인 산출물 대상 과업", count: deliverablePending },
    { label: "일정 미기재", detail: "종료일이 비어 있는 말단 과업", count: missingDue },
  ].filter((check) => check.count > 0);

  return {
    overall: overall(tasks, reported),
    institutions: byInstitution(tasks, reported),
    running,
    completed,
    delayed,
    watch,
    checks,
    total: tasks.length,
    leaves: leaves.length,
  };
}

export { statusOf };
