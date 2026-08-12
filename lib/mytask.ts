import { daysBetween, formatKoreanDate } from "./text";
import type { CategoryId } from "./worktree";

/**
 * 사업담당자가 직접 처리하는 업무 한 건.
 *
 * 입력 폼을 여러 개 채우게 만들지 않는 것이 이 타입의 목적이다.
 * 자연어 한 줄에서 뽑아낸 값으로 전부 채워지고, 사용자는 틀린 것만 고친다.
 */
export type MyTask = {
  id: string;
  title: string;
  categoryId: CategoryId;
  /** 대상 기관·담당자. 없으면 빈 문자열 */
  org: string;
  /** ISO yyyy-mm-dd. 문장에서 못 찾으면 빈 문자열 */
  due: string;
  /** "다음 월간회의 이전"처럼 날짜로 못 바꾼 기한 표현 */
  dueNote: string;
  status: "확인 필요" | "요청 필요" | "회신 대기" | "작성 중" | "진행" | "완료";
  /** 사용자가 직접 올린 우선순위. 없으면 자동 계산을 따른다 */
  pinned?: boolean;
  /** 외부기관 회신을 기다리는 중 */
  awaiting?: boolean;
  /** 다음 공식 회의 전에 끝나야 하는 일 */
  beforeMeeting?: boolean;
  /** 지연된 연구개발 과업과 직접 연결된 일 */
  blocksRnd?: boolean;
  /** 미룬 횟수 */
  deferred?: number;
  /** 원문. 왜 이렇게 분류됐는지 확인하는 근거 */
  note: string;
  createdAt: string;
  doneAt?: string;
};

export type Urgency = "긴급" | "이번 주 중요" | "일반";

export const URGENCY_TAG: Record<Urgency, string> = {
  "긴급": "tag--danger",
  "이번 주 중요": "tag--warn",
  "일반": "",
};

export type Scored = MyTask & {
  urgency: Urgency;
  /** 왜 이 순위인지 — 화면에 그대로 띄운다 */
  reasons: string[];
  /** 마감까지 남은 일수. 기한이 없으면 null */
  dday: number | null;
  score: number;
  dueLabel: string;
};

/**
 * 업무 하나의 급함을 판단한다.
 *
 * 사용자가 매긴 우선순위만 믿으면 결국 전부 '높음'이 된다. 그래서 기한·회의·
 * 지연 연계·회신 대기 같은 사실에서 점수를 만들고, 그 근거를 함께 돌려준다.
 */
export function score(task: MyTask, today: string): Scored {
  const dday = task.due ? daysBetween(today, task.due) : null;
  const reasons: string[] = [];
  let points = 0;

  if (dday != null) {
    if (dday < 0) { points += 60 + Math.min(Math.abs(dday), 15); reasons.push(`기한 ${Math.abs(dday)}일 초과`); }
    else if (dday === 0) { points += 55; reasons.push("오늘 마감"); }
    else if (dday === 1) { points += 45; reasons.push("내일 마감"); }
    else if (dday <= 7) { points += 30; reasons.push(`D-${dday}`); }
    else if (dday <= 31) { points += 10; reasons.push(`D-${dday}`); }
  } else if (task.dueNote) {
    points += 20;
    reasons.push(task.dueNote);
  } else {
    points += 6;
    reasons.push("기한 미정 — 정해야 함");
  }

  if (task.beforeMeeting) { points += 25; reasons.push("다음 회의 전 확정 필요"); }
  if (task.blocksRnd) { points += 22; reasons.push("연구개발 지연에 직접 영향"); }
  if (task.awaiting) { points += 18; reasons.push(`${task.org || "상대 기관"} 회신 대기`); }
  if (task.categoryId === "budget" || task.categoryId === "report") { points += 12; reasons.push("보고·예산 대응"); }
  if ((task.deferred ?? 0) >= 2) { points += 15; reasons.push(`${task.deferred}회 미뤄짐`); }
  if (!task.org && task.categoryId !== "report") { reasons.push("담당기관 미지정"); }
  if (task.pinned) { points += 40; reasons.push("직접 올림"); }

  const urgency: Urgency =
    points >= 55 ? "긴급" :
    points >= 28 ? "이번 주 중요" : "일반";

  return {
    ...task,
    urgency,
    reasons,
    dday,
    score: points,
    dueLabel: task.due ? formatKoreanDate(task.due) : task.dueNote || "기한 미정",
  };
}

export type Buckets = {
  today: Scored[];
  week: Scored[];
  month: Scored[];
  /** 기한이 없어 어느 통에도 안 들어간 것 — 방치되기 쉬워 따로 센다 */
  undated: Scored[];
};

/**
 * 오늘 → 이번 주 → 이번 달 순으로 나눈다.
 * 기한이 지난 것은 '오늘'로 올린다. 지난 일은 오늘 처리해야 하기 때문이다.
 */
export function bucket(tasks: MyTask[], today: string): Buckets {
  const scored = tasks
    .filter((task) => task.status !== "완료")
    .map((task) => score(task, today))
    .sort((a, b) => b.score - a.score);

  const buckets: Buckets = { today: [], week: [], month: [], undated: [] };
  for (const task of scored) {
    if (task.dday == null) {
      // 회의 전·회신 대기처럼 이번 주에 움직여야 하는 건 이번 주로 올린다
      (task.urgency === "일반" ? buckets.undated : buckets.week).push(task);
      continue;
    }
    if (task.dday <= 0) buckets.today.push(task);
    else if (task.dday <= 7) buckets.week.push(task);
    else if (task.dday <= 31) buckets.month.push(task);
    else buckets.undated.push(task);
  }
  return buckets;
}

export function makeId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
