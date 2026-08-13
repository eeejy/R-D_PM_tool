/**
 * 요청사항 리마인드 · 재촉 메일 초안.
 *
 * 새 파이프라인이 아니다. **입력이 다를 뿐 이메일 초안(`emailDraft.ts`)과 같은 길을
 * 간다** — 템플릿이 구조를 채우고 LLM은 본문 문장만 만든다.
 *
 * 다른 점은 두 가지다.
 *
 *   1) **단계가 있다.** 같은 재촉이라도 3차와 1차의 문장이 같으면 안 된다.
 *   2) **경위는 계산하지 않고 주입한다.** 당초 요청일·경과 영업일·기한은 전부 이벤트
 *      로그에서 나온다. 모델에게 날짜를 세게 하면 반드시 틀린다.
 *
 * 발송 버튼은 만들지 않는다. 대신 사용자가 "발송함"을 누르면 `reminded` 이벤트를
 * 남긴다 — **이 기록이 없으면 내일 같은 항목이 또 뜬다.**
 */

import {
  buildEmailSkeleton,
  renderEmail,
  validateEmailOutput,
  type EmailBodyParts,
  type EmailDraft,
  type EmailSender,
  type EmailSkeleton,
} from "./emailDraft";
import {
  deriveSignals,
  event,
  reminderStageOf,
  needsReminder,
  NO_HOLIDAYS,
  type Holidays,
  type TaskEvent,
  type TaskSignals,
} from "./history";
import { ORG_BY_ID, type Org, type OrgId } from "./org";
import { parseResponse, type LlmCall } from "./llm";
import type { MyTask } from "./mytask";
import { formatKoreanDate } from "./text";

export type ReminderStage = 1 | 2 | 3;

/** 재촉 대상 한 건. 판정 근거를 전부 들고 있어 화면에서 "왜 떴는지" 답할 수 있다. */
export type Reminder = {
  task: MyTask;
  org: Org;
  stage: ReminderStage;
  /** 마지막 요청·재촉 이후 경과 영업일 */
  waitingDays: number;
  /** 마지막으로 보낸 날 */
  sentAt: string;
  /** 기관별 회신 임계일(영업일) */
  replyDays: number;
  signals: TaskSignals;
};

/**
 * 재촉할 때가 된 것을 고른다.
 *
 * 임계일은 기관마다 다르다 — 주관연구기관은 짧게, 전문기관은 길게(`lib/org.ts`).
 * 회신이 왔으면 아무리 오래 걸렸어도 대상이 아니다.
 */
export function findReminders(
  tasks: MyTask[],
  events: TaskEvent[],
  today: string,
  holidays: Holidays = NO_HOLIDAYS,
): Reminder[] {
  return tasks
    .filter((task) => task.status !== "완료")
    .map((task) => {
      const signals = deriveSignals(events, task.id, today, holidays);
      const org = ORG_BY_ID.get(task.orgId ?? "etc")!;
      return { task, org, signals };
    })
    .filter(({ task, signals }) => needsReminder(signals, task.orgId))
    .map(({ task, org, signals }) => ({
      task,
      org,
      stage: reminderStageOf(signals),
      waitingDays: signals.daysSinceContact ?? 0,
      sentAt: signals.lastContact,
      replyDays: org.replyDays,
      signals,
    }))
    .sort((a, b) => b.waitingDays - a.waitingDays);
}

/* ── 경위 — 룰이 만든다 ──────────────────────────────────── */

/**
 * 단계별 마무리 문장.
 *
 * 1차는 확인만 묻고, 2차는 기한을 박고, 3차는 왜 급한지를 밝힌다. 이 문장은 날짜와
 * 일수를 담기 때문에 **LLM이 아니라 여기서 만든다.**
 */
export function closingLine(reminder: Reminder): string {
  const sent = reminder.sentAt ? formatKoreanDate(reminder.sentAt) : "";
  const due = reminder.task.due ? formatKoreanDate(reminder.task.due) : "";

  if (reminder.stage === 1) {
    return `${sent ? `${sent}에 요청드린 건입니다. ` : ""}진행 상황 확인 부탁드립니다.`;
  }
  if (reminder.stage === 2) {
    return due
      ? `${due}까지 회신 부탁드립니다.`
      : `회신 가능한 일정을 ${reminder.waitingDays}영업일 내 알려주시기 바랍니다.`;
  }
  return (
    `${sent ? `당초 ${sent}에 요청드린 건으로 ` : ""}` +
    `${reminder.waitingDays}영업일째 회신을 기다리고 있습니다. ` +
    `후속 일정에 영향이 있어 회신 요청드립니다.`
  );
}

/** 제목에 차수를 밝힌다. 받는 쪽도 몇 번째인지 알아야 한다. */
export function reminderSubject(skeleton: EmailSkeleton, stage: ReminderStage): string {
  return `${skeleton.subject} (${stage}차 재요청)`;
}

/**
 * 뼈대를 재촉용으로 바꾼다.
 *
 * 수신·인사·회신처는 그대로 두고 제목과 마무리 문장만 갈아끼운다. 경위 수치는
 * 여기서 전부 채워지므로 모델이 손댈 곳이 없다.
 */
export function toReminderSkeleton(skeleton: EmailSkeleton, reminder: Reminder): EmailSkeleton {
  return {
    ...skeleton,
    subject: reminderSubject(skeleton, reminder.stage),
    deadlineLine: closingLine(reminder),
  };
}

/* ── LLM 입출력 ──────────────────────────────────────────── */

const STAGE_TONE: Record<ReminderStage, string> = {
  1: "정중하게 진행 상황을 확인하는 정도입니다. 재촉하는 인상을 주지 않습니다.",
  2: "회신이 필요한 시점임을 분명히 밝히되 예의를 지킵니다.",
  3: "후속 일정에 영향이 있다는 사실을 밝힙니다. 다만 상대를 탓하는 표현은 쓰지 않습니다.",
};

export function reminderSystem(stage: ReminderStage): string {
  return [
    "당신은 공공 R&D 사업담당자가 기관에 보내는 회신 요청(재촉) 메일의 본문을 다듬는 보조자입니다.",
    `이번은 ${stage}차 요청입니다. ${STAGE_TONE[stage]}`,
    "다음을 반드시 지킵니다.",
    "- 주어진 사실 외의 내용을 만들지 않습니다.",
    "- 날짜·경과 일수·기한을 쓰지 않습니다. 그 문장은 이미 따로 채워집니다.",
    "- 기관을 탓하거나 평가하는 표현을 쓰지 않습니다. 사실만 적습니다.",
    "- background는 2문장 이내, requests는 요청 한 건당 한 문장입니다.",
    "- '~하여 주시기 바랍니다' 형태의 공문체 존댓말을 씁니다.",
    "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
  ].join("\n");
}

export function buildReminderPrompt(reminder: Reminder): string {
  return [
    `[요청 내용] ${(reminder.task.note || reminder.task.title).replace(/\s+/g, " ").trim()}`,
    `[상대] ${reminder.org.name} (${reminder.org.role}연구기관)`.replace("기타연구기관", "기타"),
    `[차수] ${reminder.stage}차`,
    "",
    "위 요청에 대한 회신 요청 메일의 background(배경)와 requests(요청사항)를 만드세요.",
    "날짜와 경과 일수는 쓰지 마세요 — 이미 따로 들어갑니다.",
    '출력 형식: {"background":"...","requests":["..."]}',
    "JSON만 출력하세요.",
  ].join("\n");
}

/** 규칙만으로 만드는 재촉 문장. 모델이 없거나 실패했을 때 쓴다. */
export function fallbackReminderParts(reminder: Reminder): EmailBodyParts {
  const what = (reminder.task.note || reminder.task.title).replace(/\s+/g, " ").trim();
  return {
    background: `앞서 요청드린 아래 사항에 대해 아직 회신을 받지 못하여 다시 연락드립니다.`,
    requests: [`${what} — 진행 상황을 회신하여 주시기 바랍니다.`],
  };
}

/** 재촉 메일 초안 한 통. 발송은 사람이 한다. */
export async function generateReminderEmail(
  reminder: Reminder,
  sender: EmailSender,
  today: string,
  call: LlmCall | null,
): Promise<EmailDraft> {
  const skeleton = toReminderSkeleton(buildEmailSkeleton([reminder.task], sender, today), reminder);
  if (!call) return renderEmail(skeleton, fallbackReminderParts(reminder));

  try {
    const raw = await call(buildReminderPrompt(reminder), reminderSystem(reminder.stage));
    return renderEmail(skeleton, parseResponse(raw, validateEmailOutput));
  } catch (cause) {
    return {
      ...renderEmail(skeleton, fallbackReminderParts(reminder)),
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

/**
 * 보냈다고 기록한다.
 *
 * **이 기록이 없으면 내일 같은 항목이 또 뜬다.** 화면에서 "발송함"을 누를 때만
 * 남기고, 초안을 만든 것만으로는 남기지 않는다 — 실제로 보냈는지는 사람만 안다.
 */
export function markReminded(reminder: Reminder, today: string, note?: string): TaskEvent {
  return event(reminder.task.id, "reminded", today, {
    orgId: reminder.task.orgId,
    to: `${reminder.stage}차`,
    note,
  });
}

/** 요청을 처음 보냈다고 기록한다. 이 기록이 있어야 회신 대기 판정이 시작된다. */
export function markSent(taskId: string, orgId: OrgId | undefined, today: string): TaskEvent {
  return event(taskId, "sent", today, { orgId });
}

/** 회신을 받았다고 기록한다. 이 기록이 있으면 재촉 대상에서 빠진다. */
export function markReplied(taskId: string, orgId: OrgId | undefined, today: string): TaskEvent {
  return event(taskId, "replied", today, { orgId });
}
