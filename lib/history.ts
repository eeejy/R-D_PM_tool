/**
 * 업무 이벤트 로그.
 *
 * 지금까지는 "몇 번 미뤘나"를 숫자 하나(`deferred`)로만 들고 있었다. 그 숫자로는
 * **왜 이렇게까지 밀렸는지**를 답할 수 없다. 담당자가 바뀌는 시점에 가장 크게
 * 유실되는 것이 바로 그 경위다.
 *
 * 그래서 사건을 그대로 쌓고, 화면에 쓰는 값은 전부 **파생값으로 계산한다.**
 * 저장하지 않는다 — 저장하는 순간 사건과 요약이 어긋나기 시작한다.
 *
 * **append-only.** 이벤트는 수정하지도 지우지도 않는다. 업무를 지워도 이벤트는
 * `closed`로 남긴다. 인수인계의 값어치가 여기서 나온다.
 *
 * React를 import하지 않는다.
 */

import { daysBetween, toISODate } from "./text";
import { replyDaysOf, type OrgId } from "./org";

export type EventType =
  /** 등록 */
  | "created"
  /** 기한 변경 (연기 또는 당김) */
  | "due_changed"
  /** 상태 변경 */
  | "status_changed"
  /** 우리가 요청·발송 */
  | "sent"
  /** 상대 기관 회신 */
  | "replied"
  /** 재촉 발송 */
  | "reminded"
  /** 종결 */
  | "closed";

export interface TaskEvent {
  taskId: string;
  /** ISO yyyy-mm-dd */
  at: string;
  type: EventType;
  /** 변경 전 값 */
  from?: string;
  /** 변경 후 값 */
  to?: string;
  orgId?: OrgId;
  /** 사유. 사용자가 적었을 때만 채운다 — 없는 사유를 지어내지 않는다. */
  note?: string;
}

/** 이벤트 한 건을 만든다. 저장은 호출부가 한다. */
export function event(
  taskId: string,
  type: EventType,
  at: string,
  extra: Partial<Pick<TaskEvent, "from" | "to" | "orgId" | "note">> = {},
): TaskEvent {
  const made: TaskEvent = { taskId, at, type };
  if (extra.from) made.from = extra.from;
  if (extra.to) made.to = extra.to;
  if (extra.orgId) made.orgId = extra.orgId;
  if (extra.note) made.note = extra.note;
  return made;
}

/** 한 업무의 이벤트만 시간순으로. 같은 날짜는 기록된 순서를 지킨다. */
export function eventsOf(events: TaskEvent[], taskId: string): TaskEvent[] {
  return events
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => item.taskId === taskId)
    .sort((a, b) => (a.item.at === b.item.at ? a.order - b.order : a.item.at < b.item.at ? -1 : 1))
    .map(({ item }) => item);
}

/* ── 영업일 ──────────────────────────────────────────────
 * 임계일 판정이 전부 여기에 걸려 있다. 주말 처리는 조용히 틀리기 쉬워
 * 따로 시험한다.
 */

/**
 * 휴일 집합. **공휴일은 아직 넣지 않았다.**
 *
 * 음력 명절처럼 해마다 바뀌는 날짜를 코드에 박아 두면 이듬해에 조용히 틀린다.
 * 지금은 주말만 세고, 필요하면 호출부가 날짜 목록을 넘긴다.
 */
export type Holidays = ReadonlySet<string>;

export const NO_HOLIDAYS: Holidays = new Set<string>();

export function isBusinessDay(iso: string, holidays: Holidays = NO_HOLIDAYS): boolean {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getDay();
  return day !== 0 && day !== 6 && !holidays.has(iso);
}

/**
 * `from` 다음 날부터 `to`까지의 영업일 수.
 *
 * 월요일에 보내고 화요일이면 1영업일 경과다. 보낸 날 당일은 세지 않는다 —
 * 아침에 보낸 요청을 그날 오후에 "1일 지났다"고 재촉할 수는 없다.
 */
export function businessDaysBetween(fromISO: string, toISO: string, holidays: Holidays = NO_HOLIDAYS): number {
  const span = daysBetween(fromISO, toISO);
  if (span == null || span <= 0) return 0;

  const cursor = new Date(`${fromISO}T00:00:00`);
  let count = 0;
  for (let step = 0; step < span; step += 1) {
    cursor.setDate(cursor.getDate() + 1);
    if (isBusinessDay(toISODate(cursor), holidays)) count += 1;
  }
  return count;
}

/* ── 파생 지표 ───────────────────────────────────────────── */

export type TaskSignals = {
  /** 기한이 뒤로 밀린 횟수 */
  postponeCount: number;
  /** 최초 기한 → 현재 기한 누적 일수(달력일). 당겨졌으면 음수. */
  totalSlipDays: number;
  /** 최초로 잡혔던 기한. 없으면 빈 문자열 */
  originalDue: string;
  /** 현재 기한. 없으면 빈 문자열 */
  currentDue: string;
  /** 마지막 요청·재촉 이후 경과 영업일. 보낸 적이 없으면 null */
  daysSinceContact: number | null;
  /** 마지막 요청 이후 회신이 없는 상태 */
  awaitingReply: boolean;
  /** 재촉을 몇 번 보냈나. 문체 강도에 쓴다. */
  reminderStage: number;
  /** 마지막 접촉일(요청·재촉·회신 중 가장 최근). 없으면 빈 문자열 */
  lastContact: string;
  /** 연기 사유로 기록된 메모들. 없으면 빈 배열 — 없는 사유를 지어내지 않는다. */
  postponeNotes: string[];
};

export const EMPTY_SIGNALS: TaskSignals = {
  postponeCount: 0,
  totalSlipDays: 0,
  originalDue: "",
  currentDue: "",
  daysSinceContact: null,
  awaitingReply: false,
  reminderStage: 0,
  lastContact: "",
  postponeNotes: [],
};

/** 한 업무의 이벤트에서 화면·판정에 쓰는 값을 뽑는다. */
export function deriveSignals(
  events: TaskEvent[],
  taskId: string,
  today: string,
  holidays: Holidays = NO_HOLIDAYS,
): TaskSignals {
  const log = eventsOf(events, taskId);
  if (!log.length) return EMPTY_SIGNALS;

  const signals: TaskSignals = { ...EMPTY_SIGNALS, postponeNotes: [] };
  let lastSent = "";
  let lastReplied = "";

  for (const item of log) {
    switch (item.type) {
      case "created":
        if (item.to) signals.originalDue = signals.originalDue || item.to;
        if (item.to) signals.currentDue = item.to;
        break;

      case "due_changed": {
        // 최초 기한은 첫 변경의 '변경 전' 값이 가장 정확하다.
        // 등록 시점에 기한이 없었다면 첫 변경의 '변경 후'가 최초 기한이 된다.
        if (!signals.originalDue) signals.originalDue = item.from || item.to || "";
        if (item.to) signals.currentDue = item.to;
        const moved = item.from && item.to ? daysBetween(item.from, item.to) : null;
        if (moved != null && moved > 0) {
          signals.postponeCount += 1;
          if (item.note) signals.postponeNotes.push(item.note);
        }
        break;
      }

      case "sent":
        lastSent = item.at;
        break;

      case "reminded":
        lastSent = item.at;
        signals.reminderStage += 1;
        break;

      case "replied":
        lastReplied = item.at;
        break;

      default:
        break;
    }
  }

  signals.totalSlipDays =
    signals.originalDue && signals.currentDue
      ? daysBetween(signals.originalDue, signals.currentDue) ?? 0
      : 0;

  signals.daysSinceContact = lastSent ? businessDaysBetween(lastSent, today, holidays) : null;
  signals.awaitingReply = Boolean(lastSent) && (!lastReplied || lastReplied < lastSent);
  signals.lastContact = [lastSent, lastReplied].filter(Boolean).sort().pop() ?? "";

  return signals;
}

/** 업무 여러 건을 한 번에. 화면은 대부분 이 형태로 쓴다. */
export function deriveAll(
  events: TaskEvent[],
  taskIds: string[],
  today: string,
  holidays: Holidays = NO_HOLIDAYS,
): Map<string, TaskSignals> {
  return new Map(taskIds.map((id) => [id, deriveSignals(events, id, today, holidays)]));
}

/**
 * 재촉할 때가 됐는가.
 *
 * 임계일은 기관마다 다르다 — 주관연구기관은 짧게, 전문기관은 길게(`lib/org.ts`).
 * 회신이 왔으면 아무리 오래 걸렸어도 대상이 아니다.
 */
export function needsReminder(signals: TaskSignals, orgId: OrgId | undefined): boolean {
  if (!signals.awaitingReply || signals.daysSinceContact == null) return false;
  return signals.daysSinceContact > replyDaysOf(orgId);
}

/**
 * 재촉 단계. 같은 재촉이라도 3차와 1차의 문장이 같으면 안 된다.
 *
 * 1차 확인 요청 → 2차 기한 명시 → 3차 경위 명시로 강도를 올린다.
 */
export function reminderStageOf(signals: TaskSignals): 1 | 2 | 3 {
  return Math.min(3, Math.max(1, signals.reminderStage + 1)) as 1 | 2 | 3;
}
