/**
 * 모델에 넘길 요약 컨텍스트.
 *
 * **원본을 통째로 넣지 않는다.** WBS 226행이나 RFP 원문을 그대로 밀어 넣으면
 * 지연되고 품질도 떨어진다 — 소형 모델은 긴 입력의 뒷부분을 조용히 흘린다.
 *
 * 그래서 **숫자와 상위 몇 건만** 남긴다. 무엇을 뺐는지도 코드에 적어 둔다:
 * WBS 전체 행 · RFP 원문 · 완료 과업 · 지난 달 업무.
 *
 * React를 import하지 않는다.
 */

import { bucket, score, type MyTask } from "./mytask";
import { deriveSignals, type Holidays, NO_HOLIDAYS, type TaskEvent } from "./history";
import { ORGS, orgName } from "./org";
import { daysBetween, formatKoreanDate, toISODate } from "./text";
import { categoryTitle } from "./worktree";
import type { WbsStatus } from "./wbsStatus";
import type { WbsTask } from "./types";

/** 목표 상한. 실제 토큰은 모델마다 다르므로 넉넉히 잡되 넘지 않게 자른다. */
export const CONTEXT_TOKEN_LIMIT = 3000;

/**
 * 대략적인 토큰 수.
 *
 * 정확한 값은 모델 토크나이저마다 다르다. 한국어는 글자당 대략 1토큰에 가깝고
 * 공백·숫자는 더 싸므로, **한글 1 / 그 외 0.4**로 보수적으로 센다. 상한을 지키기
 * 위한 값이지 정확도가 목적이 아니다.
 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const char of String(text ?? "")) {
    total += /[가-힣ㄱ-ㅎㅏ-ㅣ一-鿿]/.test(char) ? 1 : 0.4;
  }
  return Math.ceil(total);
}

/** 상위 몇 건만 담을지. 지연은 10건, 주의는 5건, 마일스톤은 3건. */
export const CAPS = { delayed: 10, watch: 5, milestone: 3, tasks: 12, issues: 8 } as const;

export type ContextInput = {
  projectName: string;
  /** 사업 차수·단계 표기. 없으면 생략 */
  phase?: string;
  today: string;
  tasks: MyTask[];
  events?: TaskEvent[];
  status: WbsStatus | null;
  wbsTasks?: WbsTask[];
  /** 미해결 쟁점(회의록에서 나온 것). 없으면 빈 배열 */
  issues?: { text: string; org?: string; at?: string }[];
  holidays?: Holidays;
};

/** 이번 주 월요일~일요일. 주간보고의 기간 표기에 쓴다. */
export function weekRange(today: string): { start: string; end: string } {
  const base = new Date(`${today}T00:00:00`);
  if (Number.isNaN(base.getTime())) return { start: today, end: today };
  // 일요일(0)은 그 주의 마지막으로 본다 — 월요일 시작이 공공기관 관행이다
  const offset = (base.getDay() + 6) % 7;
  const start = new Date(base);
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: toISODate(start), end: toISODate(end) };
}

/** "2026.08.10 ~ 08.16" 형태. 보고서 제목에 그대로 들어간다. */
export function weekLabel(today: string): string {
  const { start, end } = weekRange(today);
  return `${start.replace(/-/g, ".")} ~ ${end.slice(5).replace("-", ".")}`;
}

/**
 * 주간 컨텍스트 한 덩어리.
 *
 * 사람이 읽을 수 있는 형태로 둔다 — 화면의 "모델에 보낼 원문 보기"에 그대로 뜨고,
 * 무엇이 들어갔는지 담당자가 확인할 수 있어야 하기 때문이다.
 */
export function buildWeeklyContext(input: ContextInput): string {
  const { today, tasks, events = [], status, wbsTasks = [], issues = [], holidays = NO_HOLIDAYS } = input;
  const { start, end } = weekRange(today);
  const lines: string[] = [];

  lines.push("[사업 기본정보]");
  lines.push(`사업명 ${input.projectName || "(미설정)"}`);
  if (input.phase) lines.push(`단계 ${input.phase}`);
  lines.push(`기준일 ${today}`);
  lines.push(`주간 범위 ${start} ~ ${end}`);

  // ── WBS 집계. 숫자만 넣는다. 전체 행은 넣지 않는다.
  lines.push("", "[연구개발 진척]");
  if (status) {
    lines.push(`전체 계획 ${status.overall.planned}% / 실적 ${status.overall.progress}% (${signed(status.overall.variance)}%p)`);
    for (const org of status.institutions) {
      lines.push(`${org.name} 계획 ${org.planned}% / 실적 ${org.progress}% (${signed(org.variance)}%p) ${org.status}`);
    }
  } else {
    lines.push("WBS 미등록");
  }

  lines.push("", `[지연 항목 상위 ${CAPS.delayed}]`);
  const delayed = (status?.delayed ?? []).slice(0, CAPS.delayed);
  push(lines, delayed.map((item) => `${item.code} ${item.title} · ${item.org} · ${item.variance ?? "-"}%p · ${item.dueLabel}`));

  lines.push("", `[주의 항목 상위 ${CAPS.watch}]`);
  push(lines, (status?.watch ?? []).slice(0, CAPS.watch).map((item) => `${item.code} ${item.title} · ${item.org} · ${item.variance ?? "-"}%p`));

  // ── 내 업무. 완료 항목과 한 달 밖은 넣지 않는다.
  const buckets = bucket(tasks, today);
  lines.push("", "[이번 주 업무]");
  push(lines, [...buckets.today, ...buckets.week].slice(0, CAPS.tasks).map((task) => taskLine(task, events, today, holidays)));

  lines.push("", "[다음 주 이후 예정]");
  push(lines, buckets.month.slice(0, CAPS.tasks).map((task) => taskLine(task, events, today, holidays)));

  lines.push("", "[미해결 쟁점]");
  push(lines, issues.slice(0, CAPS.issues).map((issue) => `${issue.text}${issue.org ? ` · ${issue.org}` : ""}${issue.at ? ` · ${issue.at}` : ""}`));

  lines.push("", `[다가오는 마일스톤 ${CAPS.milestone}]`);
  push(lines, nextMilestones(wbsTasks, today).map((item) => `${item.due} ${item.title} · ${item.owner}`));

  return cap(lines.join("\n"));
}

function taskLine(task: ReturnType<typeof score>, events: TaskEvent[], today: string, holidays: Holidays): string {
  const signals = deriveSignals(events, task.id, today, holidays);
  const parts = [
    task.title,
    task.org || (task.orgId ? orgName(task.orgId) : ""),
    categoryTitle(task.categoryId),
    task.dueLabel,
    task.status,
  ].filter(Boolean);
  // 경위는 이력에 있을 때만. 없는 사유를 지어내지 않는다.
  if (signals.postponeCount > 0) parts.push(`${signals.postponeCount}회 연기`);
  if (signals.awaitingReply && signals.daysSinceContact != null) parts.push(`회신대기 ${signals.daysSinceContact}영업일`);
  return parts.join(" · ");
}

function nextMilestones(wbsTasks: WbsTask[], today: string) {
  return wbsTasks
    .filter((task) => (task.milestone || task.deliverable) && task.end && (daysBetween(today, task.end) ?? -1) >= 0)
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(0, CAPS.milestone)
    .map((task) => ({ due: formatKoreanDate(task.end), title: task.title, owner: task.owner }));
}

function push(lines: string[], rows: string[]): void {
  // 빈 절도 남긴다 — 모델이 "이 항목은 없다"를 알아야 지어내지 않는다
  if (!rows.length) lines.push("해당 없음");
  else lines.push(...rows.map((row) => `- ${row}`));
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * 상한을 넘으면 자른다.
 *
 * 자를 때는 **줄 단위로** 자르고 잘렸다는 사실을 남긴다. 문장 중간에서 끊으면
 * 모델이 잘린 조각을 사실로 읽는다.
 */
export function cap(text: string, limit = CONTEXT_TOKEN_LIMIT): string {
  if (estimateTokens(text) <= limit) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > limit - 20) break;
    kept.push(line);
    used += cost;
  }
  kept.push("", "※ 분량이 많아 뒷부분을 생략했습니다.");
  return kept.join("\n");
}

/** 화면에 "무엇을 넣고 무엇을 뺐는지" 보여줄 때 쓴다. */
export const CONTEXT_EXCLUDED = [
  "WBS 전체 행 (집계와 상위 항목만)",
  "RFP 원문",
  "완료된 과업·업무",
  "한 달 밖 일정",
] as const;

/** 기관 목록은 고정이라 컨텍스트에 반복해 넣지 않는다. 필요할 때만 쓴다. */
export function orgRoster(): string {
  return ORGS.filter((org) => org.id !== "etc").map((org) => `${org.name}(${org.role})`).join(", ");
}
