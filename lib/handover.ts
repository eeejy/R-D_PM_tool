/**
 * 인수인계서 — 6개 절, 조립이 주(主)고 LLM은 한 단락뿐.
 *
 * 앞선 판(`handover.ts`)은 세 절을 전부 LLM으로 문장화했다. 그 결과 **모델이 죽으면
 * 문서의 대부분이 규칙 문장으로 떨어졌다.** 인수인계서는 그러면 안 된다 — 담당자가
 * 바뀌는 날 열어보는 문서인데 모델 사정에 품질이 좌우되면 곤란하다.
 *
 * 그래서 이 판은 뒤집었다. **LLM은 `사업 개요` 한 단락만 만들고, 나머지 다섯 절은
 * 전부 기존 데이터로 조립한다.** 모델이 실패해도 문서의 대부분은 그대로 나온다.
 *
 * 출력은 플레인 텍스트다. HWP·PDF 렌더링은 하지 않는다 — 받는 사람이 어디에든
 * 붙여 넣을 수 있어야 한다.
 *
 * React를 import하지 않는다.
 */

import { deriveSignals, type Holidays, NO_HOLIDAYS, type TaskEvent, type TaskSignals } from "./history";
import { asTextList, isRecord, oneLine, parseResponse, type LlmCall, type LlmConfig } from "./llm";
import type { MyTask } from "./mytask";
import { ORGS, orgName, replyDaysOf, type OrgId } from "./org";
import { daysBetween, formatKoreanDate } from "./text";
import { categoryTitle } from "./worktree";
import type { WbsStatus } from "./wbsStatus";
import type { WbsTask } from "./types";

/** 절 순서 고정. 추가하거나 이름을 바꾸지 않는다. */
export const SECTIONS = ["overview", "ongoing", "awaiting", "orgNotes", "upcoming", "issues"] as const;
export type SectionId = (typeof SECTIONS)[number];

export const SECTION_TITLE: Record<SectionId, string> = {
  overview: "사업 개요",
  ongoing: "진행 중 과업",
  awaiting: "미결 요청사항",
  orgNotes: "기관별 특이사항",
  upcoming: "다가오는 일정",
  issues: "주요 쟁점",
};

/** 이 절만 모델이 만든다. 나머지는 전부 조립이다. */
export const LLM_SECTION: SectionId = "overview";

export const EMPTY_LINE = "해당 없음";
export const FAILED_LINE = "(생성 실패 — 직접 작성)";

/** 반복 지연으로 볼 기준. 두 번 밀린 건 우연일 수 있지만 그 이상은 패턴이다. */
export const REPEAT_DELAY = 2;

export type HandoverInput = {
  projectName: string;
  today: string;
  tasks: MyTask[];
  events?: TaskEvent[];
  status?: WbsStatus | null;
  wbsTasks?: WbsTask[];
  issues?: { text: string; org?: string; at?: string }[];
  holidays?: Holidays;
};

export type OrgContact = {
  orgId: OrgId;
  name: string;
  openCount: number;
  awaitingCount: number;
  lastContact: string;
};

export type HandoverDoc = {
  projectName: string;
  asOf: string;
  /** 절 이름 → 그 절의 줄들. 비어 있어도 키는 남는다. */
  sections: Record<SectionId, string[]>;
  byOrg: OrgContact[];
  /** 개요가 모델에서 왔는지 */
  fromLlm: boolean;
  text: string;
  note?: string;
};

/* ── 조립 — 다섯 절 ─────────────────────────────────────── */

function signalsOf(input: HandoverInput): Map<string, TaskSignals> {
  const { tasks, events = [], today, holidays = NO_HOLIDAYS } = input;
  return new Map(tasks.map((task) => [task.id, deriveSignals(events, task.id, today, holidays)]));
}

/** 진행 중 과업 — WBS 지연·주의 항목과 내 업무를 함께 싣는다. */
export function buildOngoing(input: HandoverInput, signals: Map<string, TaskSignals>): string[] {
  const rows: string[] = [];
  const status = input.status;

  if (status) {
    rows.push(`전체 진척 계획 ${status.overall.planned}% / 실적 ${status.overall.progress}% (${signed(status.overall.variance)}%p)`);
    for (const item of status.delayed.slice(0, 10)) {
      rows.push(`[지연] ${item.code} ${item.title} · ${item.org} · ${item.variance ?? "-"}%p · ${item.dueLabel}`);
    }
    for (const item of status.watch.slice(0, 5)) {
      rows.push(`[주의] ${item.code} ${item.title} · ${item.org} · ${item.variance ?? "-"}%p`);
    }
  }

  for (const task of input.tasks.filter((item) => item.status !== "완료")) {
    const signal = signals.get(task.id);
    const extra = signal && signal.postponeCount > 0 ? ` · ${signal.postponeCount}회 연기` : "";
    rows.push(`[내 업무] ${task.title} · ${orgLabel(task)} · ${categoryTitle(task.categoryId)} · ${dueLabel(task)}${extra}`);
  }

  return rows;
}

/** 미결 요청사항 — 기관별 미회신. 오래 기다린 것부터. */
export function buildAwaiting(input: HandoverInput, signals: Map<string, TaskSignals>): string[] {
  return input.tasks
    .filter((task) => task.status !== "완료" && signals.get(task.id)?.awaitingReply)
    .map((task) => ({ task, signal: signals.get(task.id)! }))
    .sort((a, b) => (b.signal.daysSinceContact ?? 0) - (a.signal.daysSinceContact ?? 0))
    .map(({ task, signal }) => {
      const over = signal.daysSinceContact != null && signal.daysSinceContact > replyDaysOf(task.orgId);
      return `${orgLabel(task)} · ${task.title} · ${signal.lastContact || "발송 기록 없음"} 요청` +
        `${signal.daysSinceContact != null ? ` · ${signal.daysSinceContact}영업일 대기` : ""}` +
        `${over ? " · 임계일 초과" : ""}` +
        `${signal.reminderStage > 0 ? ` · 재촉 ${signal.reminderStage}회` : ""}`;
    });
}

/**
 * 기관별 특이사항 — 반복해서 밀린 항목만.
 *
 * **기관을 평가하지 않는다.** "대응이 느림" 같은 문장이 문서로 남으면 곤란해진다.
 * 사실만 적는다 — "3회 연기, 당초 6월 30일 → 현재 9월 30일, 사유 미기재".
 */
export function buildOrgNotes(input: HandoverInput, signals: Map<string, TaskSignals>): string[] {
  const rows: string[] = [];
  for (const org of ORGS) {
    const mine = input.tasks.filter((task) => (task.orgId ?? "etc") === org.id && task.status !== "완료");
    const repeated = mine.filter((task) => (signals.get(task.id)?.postponeCount ?? 0) >= REPEAT_DELAY);
    if (!repeated.length) continue;

    rows.push(`[${org.name}]`);
    for (const task of repeated) {
      const signal = signals.get(task.id)!;
      const span = signal.originalDue && signal.currentDue && signal.originalDue !== signal.currentDue
        ? ` · 당초 ${formatKoreanDate(signal.originalDue)} → 현재 ${formatKoreanDate(signal.currentDue)}`
        : "";
      const reason = signal.postponeNotes.length ? ` · 사유: ${signal.postponeNotes.join(" / ")}` : " · 사유 미기재";
      rows.push(`  ${task.title} · ${signal.postponeCount}회 연기${span}${reason}`);
    }
  }
  return rows;
}

/** 다가오는 일정 — WBS의 마일스톤·산출물 중 아직 안 지난 것. */
export function buildUpcoming(input: HandoverInput): string[] {
  const { wbsTasks = [], today } = input;
  return wbsTasks
    .filter((task) => (task.milestone || task.deliverable) && task.end && (daysBetween(today, task.end) ?? -1) >= 0)
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(0, 10)
    .map((task) => `${formatKoreanDate(task.end)} · ${task.title} · ${task.owner}${task.deliverable ? ` · ${task.deliverable}` : ""}`);
}

/** 주요 쟁점 — 미해결로 남은 것. 회의록에서 들어온다. */
export function buildIssues(input: HandoverInput): string[] {
  return (input.issues ?? []).map(
    (issue) => `${issue.text}${issue.org ? ` · ${issue.org}` : ""}${issue.at ? ` · ${issue.at}` : ""}`,
  );
}

function contactsByOrg(input: HandoverInput, signals: Map<string, TaskSignals>): OrgContact[] {
  return ORGS.map((org) => {
    const mine = input.tasks.filter((task) => (task.orgId ?? "etc") === org.id && task.status !== "완료");
    const contacts = mine.map((task) => signals.get(task.id)?.lastContact ?? "").filter(Boolean).sort();
    return {
      orgId: org.id,
      name: org.name,
      openCount: mine.length,
      awaitingCount: mine.filter((task) => signals.get(task.id)?.awaitingReply).length,
      lastContact: contacts.pop() ?? "",
    };
  });
}

/* ── 개요 — 유일하게 모델이 만드는 절 ──────────────────── */

export const OVERVIEW_SYSTEM = [
  "당신은 공공 R&D 사업 인수인계서의 '사업 개요' 단락을 쓰는 보조자입니다.",
  "후임 담당자가 처음 읽는 세 문단을 만듭니다.",
  "다음을 반드시 지킵니다.",
  "- 주어진 집계값만 씁니다. 새 숫자를 만들거나 계산하지 않습니다.",
  "- 기관을 평가하거나 탓하는 표현을 쓰지 않습니다. 사실만 적습니다.",
  "- 기록되지 않은 지연 사유를 추측하지 않습니다.",
  "- 세 문단은 각각 사업 현황 / 지금 걸려 있는 것 / 인계받아 먼저 볼 것 순입니다.",
  "- 문단마다 2문장 이내, 문어체 존댓말로 씁니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

/** 개요에 넘기는 값. **집계값뿐이다** — 업무 원문을 통째로 넣지 않는다. */
export function buildOverviewInput(input: HandoverInput, signals: Map<string, TaskSignals>) {
  const open = input.tasks.filter((task) => task.status !== "완료");
  return {
    projectName: input.projectName,
    asOf: input.today,
    progress: input.status
      ? { planned: input.status.overall.planned, actual: input.status.overall.progress, variance: input.status.overall.variance }
      : null,
    delayedCount: input.status?.delayed.length ?? 0,
    openCount: open.length,
    awaitingCount: open.filter((task) => signals.get(task.id)?.awaitingReply).length,
    repeatDelayCount: open.filter((task) => (signals.get(task.id)?.postponeCount ?? 0) >= REPEAT_DELAY).length,
    issueCount: (input.issues ?? []).length,
    upcomingCount: buildUpcoming(input).length,
  };
}

export function buildOverviewPrompt(input: HandoverInput, signals: Map<string, TaskSignals>): string {
  return [
    "아래 집계값으로 인수인계서의 '사업 개요' 세 문단을 쓰세요.",
    "",
    JSON.stringify(buildOverviewInput(input, signals), null, 2),
    "",
    '출력 형식: {"overview":["문단1","문단2","문단3"]}',
    "JSON만 출력하세요.",
  ].join("\n");
}

export function validateOverview(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const lines = asTextList(value.overview ?? value.summary ?? value.lines).map(oneLine).filter(Boolean);
  return lines.length ? lines.slice(0, 3) : null;
}

/* ── 조립 ───────────────────────────────────────────────── */

/** 개요를 빼고 다섯 절을 먼저 만든다. 모델과 무관하게 항상 나온다. */
export function assembleSections(input: HandoverInput): {
  sections: Record<SectionId, string[]>;
  byOrg: OrgContact[];
  signals: Map<string, TaskSignals>;
} {
  const signals = signalsOf(input);
  return {
    signals,
    byOrg: contactsByOrg(input, signals),
    sections: {
      overview: [],
      ongoing: buildOngoing(input, signals),
      awaiting: buildAwaiting(input, signals),
      orgNotes: buildOrgNotes(input, signals),
      upcoming: buildUpcoming(input),
      issues: buildIssues(input),
    },
  };
}

/** 플레인 텍스트로 찍는다. HWP·PDF 렌더링은 하지 않는다. */
export function renderHandoverDoc(doc: HandoverDoc): string {
  const lines: string[] = [`${doc.projectName || "사업"} 업무 인수인계서`, `기준일 ${doc.asOf}`, ""];

  for (const id of SECTIONS) {
    lines.push(`□ ${SECTION_TITLE[id]}`);
    const rows = doc.sections[id];
    if (!rows.length) lines.push(`  ○ ${EMPTY_LINE}`);
    else for (const row of rows) lines.push(row.startsWith("[") || row.startsWith("  ") ? `  ${row}` : `  ○ ${row}`);
    lines.push("");
  }

  lines.push("□ 기관별 접촉 이력");
  lines.push("  기관 / 진행 중 / 미결 / 최종 접촉");
  for (const contact of doc.byOrg) {
    lines.push(`  ${contact.name} / ${contact.openCount}건 / ${contact.awaitingCount}건 / ${contact.lastContact || "기록 없음"}`);
  }

  if (doc.note) lines.push("", `※ 사업 개요는 자동 생성하지 못했습니다 (${doc.note}). 직접 작성해 주세요.`);

  return lines.join("\n").trimEnd();
}

/**
 * 인수인계서를 만든다.
 *
 * **모델이 실패해도 다섯 절은 그대로 나온다.** 개요만 "생성 실패 — 직접 작성"으로
 * 남는다. 이게 이 기능의 조건이다.
 */
export async function generateHandoverDoc(input: HandoverInput, call: LlmCall | null): Promise<HandoverDoc> {
  const { sections, byOrg, signals } = assembleSections(input);
  const base: HandoverDoc = {
    projectName: input.projectName,
    asOf: input.today,
    sections,
    byOrg,
    fromLlm: false,
    text: "",
  };

  if (!call) {
    const doc = { ...base, sections: { ...sections, overview: [FAILED_LINE] }, note: "모델에 연결되지 않았습니다." };
    return { ...doc, text: renderHandoverDoc(doc) };
  }

  try {
    const raw = await call(buildOverviewPrompt(input, signals), OVERVIEW_SYSTEM);
    const overview = parseResponse(raw, validateOverview);
    const doc = { ...base, sections: { ...sections, overview }, fromLlm: true };
    return { ...doc, text: renderHandoverDoc(doc) };
  } catch (cause) {
    const doc = {
      ...base,
      sections: { ...sections, overview: [FAILED_LINE] },
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
    return { ...doc, text: renderHandoverDoc(doc) };
  }
}

/** 개요 한 단락짜리라 출력 상한을 짧게 둔다. */
export const HANDOVER_LLM_OPTIONS: Partial<LlmConfig> = { temperature: 0.3, numPredict: 800 };

function orgLabel(task: MyTask): string {
  return task.org || (task.orgId ? orgName(task.orgId) : "기관 미지정");
}

function dueLabel(task: MyTask): string {
  return task.due ? formatKoreanDate(task.due) : task.dueNote || "기한 미정";
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
