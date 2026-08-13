/**
 * 기관별 원페이지.
 *
 * 용도가 분명한 화면이다 — **해당 기관과 회의하거나 전화하기 직전에 여는 화면.**
 * 그래서 스크롤 없이 한 화면에 끝나야 하고, 담을 것을 고르는 기준도 "지금 통화에서
 * 꺼낼 말인가" 하나다.
 *
 * **WBS 축과 내 업무 축을 한 화면에서 붙이는 첫 기능이다.** 연결 키는 `orgId`
 * 하나뿐이고, 과업 단위 자동 연결은 여기서 하지 않는다 — 지금 붙이면 틀린 연결이
 * 조용히 쌓인다.
 *
 * 요약 문단을 빼도 기능한다. 룰이 먼저고 문장은 나중이다.
 */

import { deriveSignals, eventsOf, type TaskEvent, type TaskSignals, type Holidays, NO_HOLIDAYS } from "./history";
import { matchOrg, ORGS, type Org, type OrgId } from "./org";
import { asTextList, isRecord, oneLine, parseResponse, type LlmCall } from "./llm";
import type { MyTask } from "./mytask";
import { formatKoreanDate, daysBetween } from "./text";
import type { WbsItem, WbsStatus } from "./wbsStatus";
import type { Rollup } from "./variance";
import type { WbsTask } from "./types";

/** 아직 회신을 못 받은 요청 한 건. 통화에서 가장 먼저 꺼낼 것들이다. */
export type OpenRequest = {
  id: string;
  text: string;
  /** 마지막으로 요청한 날. 없으면 등록만 되고 아직 보내지 않은 것 */
  sentAt: string;
  waitingDays: number | null;
  dueLabel: string;
  /** 기관별 임계일을 넘겼는가 */
  overdue: boolean;
  /** 오래 방치된 건. 임계일과 별개로 화면에서 붉게 표시한다. */
  stale: boolean;
};

/** 이 영업일을 넘기면 기관 임계일과 무관하게 붉게 띄운다. */
export const STALE_DAYS = 8;

/** 최근에 일어난 일 한 줄. 사실만 적는다 — 기관 평가는 넣지 않는다. */
export type RecentEntry = {
  at: string;
  type: TaskEvent["type"];
  label: string;
  note: string;
};

export type OrgPage = {
  org: Org;
  asOf: string;
  /** WBS 시트가 있는 기관만. KIMST·기타는 null이고 화면에서 진척 블록을 감춘다. */
  progress: Rollup | null;
  delayedTasks: WbsItem[];
  /** 앞으로 올 마일스톤·산출물. WBS의 마일스톤 표시와 산출물 항목에서 뽑는다. */
  nextMilestones: WbsItem[];
  openRequests: OpenRequest[];
  /** 종결되지 않은 내 업무 수 */
  openCount: number;
  /** 회신 대기 중인 건수 */
  awaitingCount: number;
  /** 마지막 접촉일. 없으면 빈 문자열 */
  lastContact: string;
  recent: RecentEntry[];
};

const EVENT_LABEL: Record<TaskEvent["type"], string> = {
  created: "등록",
  due_changed: "기한 변경",
  status_changed: "상태 변경",
  sent: "요청 발송",
  replied: "회신 수신",
  reminded: "재촉 발송",
  closed: "종결",
};

/** WBS 항목이 어느 기관 것인지. 시트명 표기가 흔들려도 마스터로 모은다. */
function ownerId(name: string): OrgId {
  return matchOrg(name).org.id;
}

/** 최근 이력 몇 건까지 보여줄지. 한 화면에 끝내야 하므로 짧게 둔다. */
const RECENT_LIMIT = 5;

export function buildOrgPage(
  orgId: OrgId,
  input: {
    tasks: MyTask[];
    events: TaskEvent[];
    /** WBS를 안 넣었으면 null. 진척 블록만 비고 나머지는 그대로 나온다. */
    status: WbsStatus | null;
    /** 마일스톤을 뽑기 위한 원본 항목. 없으면 빈 배열 */
    wbsTasks?: WbsTask[];
    today: string;
    holidays?: Holidays;
  },
): OrgPage {
  const { tasks, events, status, wbsTasks = [], today, holidays = NO_HOLIDAYS } = input;
  const org = ORGS.find((item) => item.id === orgId) ?? ORGS[ORGS.length - 1];

  const mine = tasks.filter((task) => (task.orgId ?? "etc") === orgId);
  const open = mine.filter((task) => task.status !== "완료");

  const signals = new Map<string, TaskSignals>(
    mine.map((task) => [task.id, deriveSignals(events, task.id, today, holidays)]),
  );

  const openRequests: OpenRequest[] = open
    .map((task) => ({ task, signal: signals.get(task.id)! }))
    .filter(({ signal }) => signal.awaitingReply)
    .map(({ task, signal }) => ({
      id: task.id,
      text: (task.note || task.title).replace(/\s+/g, " ").trim(),
      sentAt: signal.lastContact,
      waitingDays: signal.daysSinceContact,
      dueLabel: task.due ? formatKoreanDate(task.due) : task.dueNote || "기한 미정",
      overdue: signal.daysSinceContact != null && signal.daysSinceContact > org.replyDays,
      stale: (signal.daysSinceContact ?? 0) > STALE_DAYS,
    }))
    // 기한이 아니라 **경과일** 내림차순이다. 오래 방치된 것이 위로 와야 한다.
    .sort((a, b) => (b.waitingDays ?? 0) - (a.waitingDays ?? 0));

  const lastContact = [...signals.values()]
    .map((signal) => signal.lastContact)
    .filter(Boolean)
    .sort()
    .pop() ?? "";

  const ids = new Set(mine.map((task) => task.id));
  const recent: RecentEntry[] = events
    .filter((item) => ids.has(item.taskId) || item.orgId === orgId)
    .slice()
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
    .slice(0, RECENT_LIMIT)
    .map((item) => ({
      at: item.at,
      type: item.type,
      label: EVENT_LABEL[item.type],
      // 사유는 기록된 것만 쓴다. 없으면 비워 두고 지어내지 않는다.
      note: item.note ?? (item.from && item.to ? `${item.from} → ${item.to}` : item.to ?? ""),
    }));

  return {
    org,
    asOf: today,
    // KIMST와 기타는 WBS에 시트가 없다. 억지로 0%를 보여주면 지연으로 오해된다.
    progress: status?.institutions.find((rollup) => ownerId(rollup.name) === orgId) ?? null,
    delayedTasks: (status?.delayed ?? []).filter((item) => ownerId(item.org) === orgId),
    nextMilestones: pickMilestones(wbsTasks, orgId, today),
    openRequests,
    openCount: open.length,
    awaitingCount: openRequests.length,
    lastContact,
    recent,
  };
}

/**
 * 앞으로 올 마일스톤.
 *
 * 전용 마일스톤 시트 파서는 아직 없다(일정이 `1~3월` 형태라 별도 파서가 필요하다).
 * 그래서 과업 시트에서 **마일스톤 표시가 있거나 산출물이 걸린 항목** 중 아직 안 지난
 * 것을 뽑는다. 정확히 같지는 않지만 통화 직전에 "다음에 뭐가 걸려 있죠"에는 답이 된다.
 */
function pickMilestones(wbsTasks: WbsTask[], orgId: OrgId, today: string): WbsItem[] {
  return wbsTasks
    .filter((task) => ownerId(task.owner) === orgId)
    .filter((task) => task.milestone || task.deliverable)
    .filter((task) => task.end && (daysBetween(today, task.end) ?? -1) >= 0)
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(0, 5)
    .map((task) => ({
      code: task.code,
      title: task.title,
      org: task.owner,
      assignee: task.assignee,
      due: task.end,
      dueLabel: formatKoreanDate(task.end),
      dday: daysBetween(today, task.end),
      planned: task.planned,
      progress: task.progress ?? 0,
      variance: null,
      deliverable: task.deliverable,
    }));
}

/**
 * 처음 열 기관.
 *
 * 미회신이 가장 많은 곳을 고른다 — 원페이저를 여는 이유가 대개 그것이다.
 * 미회신이 없으면 진행 중 업무가 가장 많은 곳, 그것도 없으면 주관연구기관.
 */
export function defaultOrgId(input: Parameters<typeof buildOrgPage>[1]): OrgId {
  const rows = orgSummaries(input);
  const best = [...rows].sort(
    (a, b) => b.awaitingCount - a.awaitingCount || b.openCount - a.openCount,
  )[0];
  return best && (best.awaitingCount > 0 || best.openCount > 0) ? best.org.id : "gmt";
}

/** 11개 기관 전부의 요약. 어느 기관을 먼저 열지 고를 때 쓴다. */
export function orgSummaries(
  input: Parameters<typeof buildOrgPage>[1],
): { org: Org; openCount: number; awaitingCount: number; lastContact: string }[] {
  return ORGS.map((org) => {
    const page = buildOrgPage(org.id, input);
    return {
      org,
      openCount: page.openCount,
      awaitingCount: page.awaitingCount,
      lastContact: page.lastContact,
    };
  });
}

/* ── 요약 문단 ───────────────────────────────────────────── */

export const ORG_SUMMARY_SYSTEM = [
  "당신은 공공 R&D 사업담당자가 기관과 통화하기 직전에 읽을 요약을 쓰는 보조자입니다.",
  "주어진 집계값만으로 3문장 이내의 한국어 문단을 만듭니다.",
  "다음을 반드시 지킵니다.",
  "- 주어진 수치를 그대로 인용합니다. 다시 계산하거나 반올림하지 않습니다.",
  "- 주어진 값에 없는 사실을 만들지 않습니다.",
  "- 기관을 평가하는 표현을 쓰지 않습니다. 사실만 적습니다.",
  "- 진척·지연·요청을 각각 한 문장으로 씁니다. 해당 값이 없으면 그 문장을 뺍니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

/** 모델에 넘기는 값. **집계값뿐이다** — 원자료를 통째로 넣지 않는다. */
export function buildOrgSummaryInput(page: OrgPage) {
  return {
    org: page.org.name,
    role: page.org.role,
    asOf: page.asOf,
    progress: page.progress
      ? { planned: page.progress.planned, actual: page.progress.progress, variance: page.progress.variance }
      : null,
    delayedCount: page.delayedTasks.length,
    openCount: page.openCount,
    awaitingCount: page.awaitingCount,
    lastContact: page.lastContact,
    nextMilestone: page.nextMilestones[0]
      ? { title: page.nextMilestones[0].title, due: page.nextMilestones[0].due }
      : null,
  };
}

export function buildOrgSummaryPrompt(page: OrgPage): string {
  return [
    "아래 집계값으로 통화 직전에 읽을 요약을 3문장 이내로 쓰세요.",
    "",
    JSON.stringify(buildOrgSummaryInput(page), null, 2),
    "",
    '출력 형식: {"summary":["문장1","문장2"]}',
    "JSON만 출력하세요.",
  ].join("\n");
}

export function validateOrgSummary(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const lines = asTextList(value.summary ?? value.lines ?? value.text).map(oneLine).filter(Boolean);
  return lines.length ? lines.slice(0, 3) : null;
}

/** 규칙만으로 만드는 요약. 모델이 없어도 화면이 비지 않는다. */
export function fallbackSummary(page: OrgPage): string[] {
  const lines: string[] = [];
  if (page.progress) {
    lines.push(
      `계획 ${page.progress.planned}% 대비 실적 ${page.progress.progress}%로 ` +
      `차이는 ${page.progress.variance > 0 ? "+" : ""}${page.progress.variance}%p입니다.`,
    );
  }
  if (page.delayedTasks.length) lines.push(`지연·확인이 필요한 과업이 ${page.delayedTasks.length}건입니다.`);
  if (page.awaitingCount) lines.push(`회신을 기다리는 요청이 ${page.awaitingCount}건입니다.`);
  if (!lines.length) lines.push("현재 확인이 필요한 항목이 없습니다.");
  return lines;
}

export type OrgSummary = { lines: string[]; fromLlm: boolean; note?: string };

export async function generateOrgSummary(page: OrgPage, call: LlmCall | null): Promise<OrgSummary> {
  if (!call) return { lines: fallbackSummary(page), fromLlm: false };
  try {
    const raw = await call(buildOrgSummaryPrompt(page), ORG_SUMMARY_SYSTEM);
    return { lines: parseResponse(raw, validateOrgSummary), fromLlm: true };
  } catch (cause) {
    return {
      lines: fallbackSummary(page),
      fromLlm: false,
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

/** 복사해서 회의 메모로 쓰는 텍스트. */
export function renderOrgPageText(page: OrgPage, summary: string[]): string {
  const block = (title: string, rows: string[]) =>
    [`□ ${title}`, ...(rows.length ? rows : ["  - 해당 없음"])].join("\n");

  return [
    `${page.org.name} (${page.org.role}연구기관 기준일 ${page.asOf})`.replace("기타연구기관", "기타"),
    "",
    page.progress
      ? `□ 진척: 계획 ${page.progress.planned}% / 실적 ${page.progress.progress}% (${page.progress.variance > 0 ? "+" : ""}${page.progress.variance}%p)`
      : "□ 진척: WBS 시트 없음",
    `□ 현황: 미결 요청 ${page.awaitingCount}건 · 진행 중 업무 ${page.openCount}건 · 최종 접촉 ${page.lastContact || "기록 없음"}`,
    "",
    block("지연 과업", page.delayedTasks.map((item) => `  - ${item.code} ${item.title} (${item.dueLabel})`)),
    "",
    block("미결 요청", page.openRequests.map((item) =>
      `  - ${item.text} — ${item.sentAt || "발송 기록 없음"} 요청, ${item.waitingDays ?? 0}영업일 대기`)),
    "",
    block("다음 마일스톤", page.nextMilestones.map((item) => `  - ${item.dueLabel} ${item.title}`)),
    "",
    block("요약", summary.map((line) => `  ${line}`)),
  ].join("\n");
}

/** 화면이 이벤트 목록을 다시 훑지 않도록 여기서 한 번만 뽑는다. */
export function orgEvents(events: TaskEvent[], tasks: MyTask[], orgId: OrgId): TaskEvent[] {
  const ids = tasks.filter((task) => (task.orgId ?? "etc") === orgId).map((task) => task.id);
  return ids.flatMap((id) => eventsOf(events, id));
}
