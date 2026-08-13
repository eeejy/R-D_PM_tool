/**
 * 인수인계서.
 *
 * **전제가 하나 있다.** 담당자가 바뀔 때 크게 유실되는 것은 진행 중 과업 목록이 아니다.
 * 그건 업무트리를 열면 보인다. 유실되는 것은 **"왜 이 상태인지"** — 당초 6월이던 기한이
 * 왜 9월이 됐는지, 그 3번의 연기에 무슨 사정이 있었는지다.
 *
 * 그래서 이 문서는 현재 상태가 아니라 **경위**를 중심으로 뽑는다.
 *
 * 지켜야 할 선이 둘 있다.
 *
 *   1) **기록되지 않은 사유를 지어내지 않는다.** 사유가 없는 연기는 "사유 미기재"로
 *      그대로 둔다. 인수인계서는 나중에 근거 문서가 된다.
 *   2) **기관을 평가하지 않는다.** "A기관 대응이 느림" 같은 문장이 문서로 남으면
 *      곤란해진다. 사실만 적는다 — "3회 연기, 최종 회신 6월 20일".
 */

import { deriveSignals, type Holidays, NO_HOLIDAYS, type TaskEvent, type TaskSignals } from "./history";
import { asText, isRecord, oneLine, parseResponse, type LlmCall } from "./llm";
import type { MyTask } from "./mytask";
import { ORGS, orgName, type Org, type OrgId } from "./org";
import { daysBetween, formatKoreanDate } from "./text";
import { categoryTitle } from "./worktree";

/** 섹션 하나에 들어가는 항목. `line`은 나중에 채워진다. */
export type HandoverItem = {
  id: string;
  orgId: OrgId;
  orgLabel: string;
  category: string;
  /** 등록 원문. 문장의 유일한 재료다. */
  text: string;
  /** 화면·문서에 함께 띄우는 사실들 */
  facts: string[];
};

/** 기관별 접촉 이력 한 줄. 숫자와 날짜뿐이라 LLM을 태우지 않는다. */
export type OrgContact = {
  orgId: OrgId;
  name: string;
  role: Org["role"];
  openCount: number;
  awaitingCount: number;
  lastContact: string;
};

export type HandoverFacts = {
  asOf: string;
  ongoing: HandoverItem[];
  awaiting: HandoverItem[];
  delayed: HandoverItem[];
  byOrg: OrgContact[];
};

export type SectionId = "ongoing" | "awaiting" | "delayed";

export const SECTION_TITLE: Record<SectionId, string> = {
  ongoing: "진행 중 과업",
  awaiting: "미결 요청",
  delayed: "지연 이력",
};

/* ── 선별 — 전부 룰 ─────────────────────────────────────── */

/**
 * 인수인계 대상을 고른다.
 *
 * 한 업무가 여러 섹션에 나와도 괜찮다. 진행 중이면서 3회 연기된 건은 목록에도 있고
 * 경위에도 있어야 한다 — 인계받는 사람은 두 곳에서 다른 것을 읽는다.
 */
export function selectHandover(
  tasks: MyTask[],
  events: TaskEvent[],
  today: string,
  holidays: Holidays = NO_HOLIDAYS,
): HandoverFacts {
  const open = tasks.filter((task) => task.status !== "완료");
  const signals = new Map<string, TaskSignals>(
    tasks.map((task) => [task.id, deriveSignals(events, task.id, today, holidays)]),
  );

  const ongoing = open.map((task) => toItem(task, signals.get(task.id)!, "ongoing", today));

  const awaiting = open
    .filter((task) => signals.get(task.id)!.awaitingReply)
    .map((task) => toItem(task, signals.get(task.id)!, "awaiting", today));

  const delayed = open
    .filter((task) => {
      const signal = signals.get(task.id)!;
      const overdue = task.due ? (daysBetween(today, task.due) ?? 0) < 0 : false;
      return signal.postponeCount >= 1 || overdue;
    })
    .map((task) => toItem(task, signals.get(task.id)!, "delayed", today));

  return { asOf: today, ongoing, awaiting, delayed, byOrg: contactsByOrg(open, signals) };
}

function toItem(task: MyTask, signal: TaskSignals, section: SectionId, today: string): HandoverItem {
  const orgId = task.orgId ?? "etc";
  return {
    id: task.id,
    orgId,
    orgLabel: task.org || orgName(orgId),
    category: categoryTitle(task.categoryId),
    text: (task.note || task.title).replace(/\s+/g, " ").trim(),
    facts: factsFor(task, signal, section, today),
  };
}

/** 섹션마다 필요한 사실이 다르다. 여기서 조립한 값만 모델에 넘어간다. */
function factsFor(task: MyTask, signal: TaskSignals, section: SectionId, today: string): string[] {
  const facts: string[] = [];

  if (section === "ongoing") {
    facts.push(`상태 ${task.status}`);
    facts.push(task.due ? `기한 ${formatKoreanDate(task.due)}` : task.dueNote || "기한 미정");
  }

  if (section === "awaiting") {
    if (signal.lastContact) facts.push(`${formatKoreanDate(signal.lastContact)} 요청`);
    if (signal.daysSinceContact != null) facts.push(`${signal.daysSinceContact}영업일 대기`);
    if (signal.reminderStage > 0) facts.push(`재촉 ${signal.reminderStage}회`);
  }

  if (section === "delayed") {
    if (signal.originalDue && signal.currentDue && signal.originalDue !== signal.currentDue) {
      facts.push(`당초 ${formatKoreanDate(signal.originalDue)} → 현재 ${formatKoreanDate(signal.currentDue)}`);
    }
    if (signal.totalSlipDays > 0) facts.push(`누적 ${signal.totalSlipDays}일 연기`);
    if (signal.postponeCount > 0) facts.push(`${signal.postponeCount}회 연기`);

    const overdueDays = task.due ? daysBetween(today, task.due) : null;
    if (overdueDays != null && overdueDays < 0) facts.push(`기한 ${Math.abs(overdueDays)}일 초과`);

    // 기록되지 않은 사유를 지어내지 않는다. 없으면 없다고 적는다.
    facts.push(signal.postponeNotes.length ? `사유: ${signal.postponeNotes.join(" / ")}` : "사유 미기재");
  }

  return facts;
}

/** 기관 11개 전부. 한 건도 없는 기관도 남긴다 — 없다는 사실도 인계 내용이다. */
function contactsByOrg(open: MyTask[], signals: Map<string, TaskSignals>): OrgContact[] {
  return ORGS.map((org) => {
    const mine = open.filter((task) => (task.orgId ?? "etc") === org.id);
    const contacts = mine
      .map((task) => signals.get(task.id)?.lastContact ?? "")
      .filter(Boolean)
      .sort();
    return {
      orgId: org.id,
      name: org.name,
      role: org.role,
      openCount: mine.length,
      awaitingCount: mine.filter((task) => signals.get(task.id)?.awaitingReply).length,
      lastContact: contacts.pop() ?? "",
    };
  });
}

/* ── LLM 입출력 ──────────────────────────────────────────── */

const SECTION_INSTRUCTION: Record<SectionId, string> = {
  ongoing: "각 과업이 지금 어떤 상태인지 한 문장으로 정리합니다.",
  awaiting: "어떤 요청을 언제 보냈고 얼마나 기다리고 있는지 한 문장으로 정리합니다.",
  delayed: "당초 기한과 현재 기한, 연기 횟수와 기록된 사유를 한두 문장의 경위로 정리합니다.",
};

export function handoverSystem(section: SectionId): string {
  return [
    "당신은 공공 R&D 사업담당자의 인수인계서 문장을 정리하는 보조자입니다.",
    SECTION_INSTRUCTION[section],
    "다음을 반드시 지킵니다.",
    "- 주어진 사실 외의 내용을 만들지 않습니다. 특히 기록되지 않은 지연 사유를 추측하지 않습니다.",
    "- 사유가 '사유 미기재'이면 그대로 '사유는 기록되지 않았습니다'로 씁니다.",
    "- 기관을 평가하거나 탓하는 표현을 쓰지 않습니다. 사실만 적습니다.",
    "- 항목을 합치거나 빼지 않습니다. id는 입력에 있던 값을 그대로 씁니다.",
    "- 문어체 존댓말로 쓰고, 항목당 1~2문장을 넘기지 않습니다.",
    "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
  ].join("\n");
}

export function buildSectionPrompt(section: SectionId, items: HandoverItem[], asOf: string): string {
  return [
    `기준일 ${asOf} · 인수인계서 [${SECTION_TITLE[section]}] 항목입니다.`,
    "",
    JSON.stringify(
      items.map((item) => ({ id: item.id, org: item.orgLabel, text: item.text, facts: item.facts })),
      null,
      2,
    ),
    "",
    '출력 형식: {"lines":[{"id":"...","line":"..."}]}',
    "JSON만 출력하세요.",
  ].join("\n");
}

export type HandoverLine = { id: string; line: string };

export function validateHandoverOutput(value: unknown): HandoverLine[] | null {
  if (!isRecord(value)) return null;
  const raw = value.lines ?? value.items ?? value.results;
  if (!Array.isArray(raw)) return null;
  const lines = raw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const id = asText(entry.id);
      const line = oneLine(entry.line ?? entry.text);
      return id && line ? { id, line } : null;
    })
    .filter((entry): entry is HandoverLine => entry !== null);
  return lines.length ? lines : null;
}

/* ── 조립 ───────────────────────────────────────────────── */

export type HandoverEntry = { item: HandoverItem; line: string; fromLlm: boolean };

export type Handover = {
  asOf: string;
  sections: Record<SectionId, HandoverEntry[]>;
  byOrg: OrgContact[];
  /** 모델을 못 쓴 섹션의 사유. 비어 있으면 정상. */
  notes: string[];
};

/** 규칙만으로 만드는 문장. 사실을 그대로 이어 붙인다 — 어색해도 틀리지는 않는다. */
export function fallbackLine(item: HandoverItem): string {
  const facts = item.facts.join(" · ");
  return `${item.orgLabel ? `[${item.orgLabel}] ` : ""}${item.text}${facts ? ` — ${facts}` : ""}`;
}

/** 입력 기준으로 다시 맞춘다. 모델이 지어낸 id는 버리고 빠뜨린 항목은 규칙 문장으로 채운다. */
export function bindSection(items: HandoverItem[], lines: HandoverLine[] | null): HandoverEntry[] {
  const byId = new Map((lines ?? []).map((entry) => [entry.id, entry.line]));
  return items.map((item) => {
    const line = byId.get(item.id);
    return { item, line: line || fallbackLine(item), fromLlm: Boolean(line) };
  });
}

/**
 * 인수인계서를 만든다.
 *
 * 섹션마다 한 번씩 호출한다. 섹션별로 요구하는 문체가 다르고, 한 번에 던지면 뒤쪽
 * 섹션이 조용히 부실해진다. 섹션 ④는 호출하지 않는다 — 숫자와 날짜뿐이다.
 */
export async function generateHandover(
  tasks: MyTask[],
  events: TaskEvent[],
  today: string,
  call: LlmCall | null,
  holidays: Holidays = NO_HOLIDAYS,
): Promise<Handover> {
  const facts = selectHandover(tasks, events, today, holidays);
  const sections = {} as Record<SectionId, HandoverEntry[]>;
  const notes: string[] = [];

  for (const section of ["ongoing", "awaiting", "delayed"] as SectionId[]) {
    const items = facts[section];
    if (!items.length || !call) {
      sections[section] = bindSection(items, null);
      continue;
    }
    try {
      const raw = await call(buildSectionPrompt(section, items, today), handoverSystem(section));
      sections[section] = bindSection(items, parseResponse(raw, validateHandoverOutput));
    } catch (cause) {
      // 한 섹션이 실패해도 나머지는 계속한다. 문서는 나와야 한다.
      sections[section] = bindSection(items, null);
      notes.push(`${SECTION_TITLE[section]}: ${cause instanceof Error ? cause.message : "모델 호출 실패"}`);
    }
  }

  return { asOf: today, sections, byOrg: facts.byOrg, notes };
}

/** 내보내기용 텍스트. 섹션 ④는 표로 그대로 찍는다. */
export function renderHandoverText(handover: Handover): string {
  const lines: string[] = [`업무 인수인계서 (기준일 ${handover.asOf})`, ""];

  for (const section of ["ongoing", "awaiting", "delayed"] as SectionId[]) {
    const entries = handover.sections[section];
    lines.push(`□ ${SECTION_TITLE[section]} ${entries.length}건`);
    if (!entries.length) {
      lines.push("  - 해당 없음");
    } else {
      // 기관별로 묶어야 인계받는 사람이 한 기관씩 읽을 수 있다
      for (const org of ORGS) {
        const mine = entries.filter((entry) => entry.item.orgId === org.id);
        if (!mine.length) continue;
        lines.push(`  [${org.name}]`);
        for (const entry of mine) {
          lines.push(`    - ${entry.line}`);
          if (entry.fromLlm) lines.push(`      · ${entry.item.facts.join(" · ")}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("□ 기관별 접촉 이력");
  lines.push("    기관 / 진행 중 / 미결 / 최종 접촉");
  for (const contact of handover.byOrg) {
    lines.push(
      `    ${contact.name} / ${contact.openCount}건 / ${contact.awaitingCount}건 / ${contact.lastContact || "기록 없음"}`,
    );
  }

  if (handover.notes.length) {
    lines.push("", `※ 일부 섹션은 규칙 문장으로 작성했습니다 (${handover.notes.join("; ")})`);
  }

  return lines.join("\n").trimEnd();
}
