/**
 * 일일 업무보고 추출.
 *
 * **선별은 룰, 문장은 LLM.** 무엇을 보고할지 고르는 일은 `mytask.ts`의 우선순위
 * 점수가 하고, LLM은 그렇게 고른 것을 구두로 말하기 좋은 한 문장으로 바꾸기만 한다.
 * 선별까지 모델에 맡기면 "왜 이게 보고사항인지"를 설명할 수 없게 된다.
 *
 * 그래서 LLM이 실패해도 보고서는 나온다 — 규칙으로 만든 문장으로 떨어질 뿐이다.
 */

import { score, type MyTask, type Scored } from "./mytask";
import { formatKoreanDate } from "./text";
import { categoryTitle, type CategoryId } from "./worktree";
import { asText, isRecord, oneLine, parseResponse, type LlmCall } from "./llm";

/** 누구에게 하는 보고인가. 카테고리를 늘리지 않듯 이 값도 셋으로 고정한다. */
export type Audience = "supervisor" | "pi" | "both";

export const AUDIENCE_LABEL: Record<Audience, string> = {
  supervisor: "상부 구두보고",
  pi: "연구책임자 전달",
  both: "양쪽 모두",
};

/**
 * 카테고리 → 보고 대상.
 *
 * 예산·공식일정·보고자료는 결재선 위로 올라가는 일이고, 데이터·진도·실증은
 * 연구책임자와 맞추는 일이다. 회의 후속조치와 미분류는 연구 쪽 성격이 강해
 * 연구책임자로 보내되, 아래 `audienceOf`에서 지연·기한초과면 양쪽으로 올린다.
 */
const BASE_AUDIENCE: Record<CategoryId, Audience> = {
  budget: "supervisor",
  milestone: "supervisor",
  report: "supervisor",
  data: "pi",
  progress: "pi",
  pilot: "pi",
  meeting: "pi",
  etc: "pi",
};

/**
 * 보고 대상을 정한다.
 *
 * 지연 과업에 직접 영향을 주거나 기한을 넘긴 건은 한쪽만 알아서는 안 된다 —
 * 위에는 일정 리스크로, 연구책임자에게는 처리 요청으로 동시에 가야 한다.
 */
export function audienceOf(task: Scored): Audience {
  if (task.blocksRnd) return "both";
  if (task.dday != null && task.dday < 0) return "both";
  return BASE_AUDIENCE[task.categoryId] ?? "pi";
}

/** 보고 대상으로 뽑힌 업무 한 건. LLM에 넘기는 단위이자 화면에 띄우는 단위다. */
export type ReportItem = {
  id: string;
  category: string;
  org: string;
  /** 등록 당시 원문. 모델이 문장을 만들 재료이자 화면에 띄우는 근거다. */
  text: string;
  due: string;
  status: MyTask["status"];
  /** 왜 보고 대상인지 — 화면에 그대로 띄운다 */
  reason: string;
  audience: Audience;
  /** 정렬·표시용. LLM에는 넘기지 않는다. */
  score: number;
  dueLabel: string;
};

/**
 * 보고할 것을 고른다.
 *
 * 조건은 전부 사실이다. 담당자가 "왜 이게 올라왔냐"고 물으면 화면의 근거로 답할 수 있다.
 */
export function selectReportItems(tasks: MyTask[], today: string): ReportItem[] {
  return tasks
    .filter((task) => task.status !== "완료")
    .map((task) => score(task, today))
    .filter(isReportable)
    .sort((a, b) => b.score - a.score)
    .map(toReportItem);
}

/** 보고 대상 판정. 조건 하나라도 맞으면 올린다. */
export function isReportable(task: Scored): boolean {
  if (task.urgency === "긴급") return true;
  if (task.dday != null && task.dday <= 1) return true;
  if ((task.deferred ?? 0) >= 2) return true;
  if (task.awaiting) return true;
  if (task.beforeMeeting) return true;
  return false;
}

function toReportItem(task: Scored): ReportItem {
  return {
    id: task.id,
    category: categoryTitle(task.categoryId),
    org: task.org,
    text: task.note || task.title,
    due: task.due,
    status: task.status,
    reason: task.reasons.slice(0, 3).join(" · "),
    audience: audienceOf(task),
    score: task.score,
    dueLabel: task.dueLabel,
  };
}

/** 대상별로 갈라 담는다. `both`는 양쪽에 모두 들어간다. */
export function splitByAudience(items: ReportItem[]): { supervisor: ReportItem[]; pi: ReportItem[] } {
  return {
    supervisor: items.filter((item) => item.audience !== "pi"),
    pi: items.filter((item) => item.audience !== "supervisor"),
  };
}

/* ── LLM 입출력 ──────────────────────────────────────────── */

export type ReportInput = {
  today: string;
  items: {
    id: string;
    category: string;
    org: string;
    text: string;
    due: string;
    status: string;
    reason: string;
    audience: Audience;
  }[];
};

/** 모델에 넘기는 값. 화면의 "보낼 원문 보기"가 이 결과를 그대로 띄운다. */
export function buildReportInput(items: ReportItem[], today: string): ReportInput {
  return {
    today,
    items: items.map(({ id, category, org, text, due, status, reason, audience }) => ({
      id, category, org, text, due, status, reason, audience,
    })),
  };
}

export const REPORT_SYSTEM = [
  "당신은 공공 R&D 사업담당자의 일일 업무보고를 정리하는 보조자입니다.",
  "주어진 업무 목록을 구두로 보고하기 좋은 한국어 문장으로 바꾸는 일만 합니다.",
  "다음을 반드시 지킵니다.",
  "- 입력에 없는 사실을 만들지 않습니다. 기관명·날짜·수치는 입력에 적힌 것만 씁니다.",
  "- 항목을 합치거나 빼지 않습니다. 입력 항목 수와 출력 항목 수가 같아야 합니다.",
  "- id는 반드시 입력에 있던 값을 그대로 씁니다.",
  "- 한 항목당 한 문장, 구어체 존댓말(~습니다/~하겠습니다)로 씁니다.",
  "- audience가 supervisor 또는 both이면 toSupervisor에, pi 또는 both이면 toPI에 넣습니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

const REPORT_EXAMPLE = `{"toSupervisor":[{"id":"t_003","line":"예산 설명자료는 금주 내 초안 완료 예정입니다."}],"toPI":[{"id":"t_001","line":"A기관 데이터 3종이 아직 미수령이라 금요일까지 재확인하겠습니다."}]}`;

export function buildReportPrompt(input: ReportInput): string {
  return [
    `오늘은 ${input.today}입니다.`,
    "아래 업무를 상부 구두보고용(toSupervisor)과 연구책임자 전달용(toPI)으로 나눠 각각 한 문장으로 정리하세요.",
    "",
    "[업무 목록]",
    JSON.stringify(input, null, 2),
    "",
    "[출력 형식 예시]",
    REPORT_EXAMPLE,
    "",
    "위 형식의 JSON만 출력하세요.",
  ].join("\n");
}

export type ReportLine = { id: string; line: string };
export type ReportOutput = { toSupervisor: ReportLine[]; toPI: ReportLine[] };

/**
 * 모델 응답을 검증한다.
 *
 * 모양이 아예 다르면 null을 돌려 호출부가 규칙 기반으로 떨어지게 하고, 배열 안의
 * 이상한 항목은 조용히 버린다. 어차피 뒤에서 입력 기준으로 다시 맞추기 때문이다.
 */
export function validateReportOutput(value: unknown): ReportOutput | null {
  if (!isRecord(value)) return null;
  const supervisor = pickLines(value.toSupervisor);
  const pi = pickLines(value.toPI ?? value.toPi);
  if (supervisor == null && pi == null) return null;
  return { toSupervisor: supervisor ?? [], toPI: pi ?? [] };
}

function pickLines(value: unknown): ReportLine[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const id = asText(entry.id);
      const line = oneLine(entry.line ?? entry.text ?? entry.sentence);
      return id && line ? { id, line } : null;
    })
    .filter((entry): entry is ReportLine => entry !== null);
}

/* ── 결과 조립 ──────────────────────────────────────────── */

export type ReportEntry = {
  item: ReportItem;
  line: string;
  /** 이 문장이 모델에서 왔는지. 화면에 표시해 규칙 문장과 구분한다. */
  fromLlm: boolean;
};

export type DailyReport = {
  today: string;
  toSupervisor: ReportEntry[];
  toPI: ReportEntry[];
  /** 모델을 아예 못 쓴 경우의 사유. 없으면 정상. */
  note?: string;
};

/**
 * 규칙만으로 만드는 보고 문장.
 *
 * LLM이 없을 때의 대비책이자, 모델이 특정 항목을 빠뜨렸을 때 그 자리를 메우는 값이다.
 * 어색해도 사실은 정확하다 — 전부 입력 데이터에서만 조립한다.
 */
export function fallbackLine(item: ReportItem): string {
  const who = item.org ? `${item.org} ` : "";
  const what = item.text.replace(/\s+/g, " ").trim();
  const when = item.due ? `${formatKoreanDate(item.due)}까지 ` : "";
  const tail =
    item.status === "요청 필요" ? `${when}요청하겠습니다.`
    : item.status === "회신 대기" ? `${when}회신을 기다리고 있습니다.`
    : item.status === "작성 중" ? `${when}작성하겠습니다.`
    : item.status === "완료" ? "완료했습니다."
    : `${when}확인하겠습니다.`;
  return `${who}${what} — ${tail}`;
}

/**
 * 입력 기준으로 결과를 다시 맞춘다.
 *
 * **입력에 있는 항목은 전부 나오고, 입력에 없는 id는 버린다.** 모델이 항목을
 * 합치거나 지어내도 화면에 보이는 개수는 룰이 고른 개수와 항상 같다.
 */
export function assembleReport(items: ReportItem[], today: string, output: ReportOutput | null): DailyReport {
  const split = splitByAudience(items);
  const bind = (group: ReportItem[], lines: ReportLine[]) => {
    const byId = new Map(lines.map((entry) => [entry.id, entry.line]));
    return group.map((item) => {
      const line = byId.get(item.id);
      return { item, line: line || fallbackLine(item), fromLlm: Boolean(line) };
    });
  };
  return {
    today,
    toSupervisor: bind(split.supervisor, output?.toSupervisor ?? []),
    toPI: bind(split.pi, output?.toPI ?? []),
  };
}

/**
 * 일일 보고서 한 건을 만든다.
 *
 * `call`을 주입받는 이유는 두 가지다 — 테스트에서 네트워크를 타지 않기 위해서,
 * 그리고 이 함수가 Ollama를 직접 알 필요가 없기 때문이다.
 */
export async function generateDailyReport(
  tasks: MyTask[],
  today: string,
  call: LlmCall | null,
): Promise<DailyReport> {
  const items = selectReportItems(tasks, today);
  if (!items.length) return { today, toSupervisor: [], toPI: [] };
  if (!call) return assembleReport(items, today, null);

  const prompt = buildReportPrompt(buildReportInput(items, today));
  try {
    const raw = await call(prompt, REPORT_SYSTEM);
    return assembleReport(items, today, parseResponse(raw, validateReportOutput));
  } catch (cause) {
    // 모델이 실패해도 보고서는 나와야 한다. 규칙 문장으로 떨어지고 사유만 남긴다.
    return {
      ...assembleReport(items, today, null),
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

/** 복사해서 그대로 쓰는 텍스트. 근거는 화면에만 두고 여기에는 문장만 담는다. */
export function renderReportText(report: DailyReport): string {
  const block = (title: string, entries: ReportEntry[]) =>
    entries.length
      ? [`[${title}]`, ...entries.map((entry, index) => `${index + 1}. ${entry.line}`)].join("\n")
      : "";
  return [
    `${report.today} 업무보고`,
    block("상부 구두보고", report.toSupervisor),
    block("연구책임자 전달사항", report.toPI),
  ].filter(Boolean).join("\n\n");
}
