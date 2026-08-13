/**
 * 사업 주간보고서 — 4개 요소 고정 양식.
 *
 * 주간업무계획(`weeklyPlan.ts`)이 청 문서에 낄 **항목 한 건**이라면, 이건 사업
 * 단위로 한 주를 정리하는 **문서 한 장**이다. 서식도 용도도 다르다.
 *
 * 이 파일의 핵심은 하나다 — **골격은 코드가 만든다.**
 *
 *   타이틀 · 섹션 헤더 · 말미 안내문은 고정 문자열로 조립하고, LLM은 각 섹션의
 *   `○` 항목 내용만 만든다. 그래서 **모델이 실패해도 4개 요소가 절대 빠지지 않는다.**
 *   데이터가 없는 섹션도 지우지 않고 `○ 해당 없음`으로 채운다.
 *
 * React를 import하지 않는다.
 */

import { buildWeeklyContext, weekLabel, type ContextInput } from "./llmContext";
import { asTextList, isRecord, oneLine, parseResponse, type LlmCall, type LlmConfig } from "./llm";

/** 순서 고정. 추가하거나 이름을 바꾸지 않는다. */
export const SECTIONS = ["추진배경", "주요내용", "향후계획"] as const;
export type SectionName = (typeof SECTIONS)[number];

/** 섹션마다 무엇을 담는지. 프롬프트와 화면 안내에 같은 문장을 쓴다. */
export const SECTION_GUIDE: Record<SectionName, string> = {
  추진배경: "사업 개요 1~2줄, 현재 진척 상황, 이번 주 중점 사유",
  주요내용: "이번 주 수행 업무, 기관 대응, 회의 결과, 지연 대응",
  향후계획: "다음 주 예정 업무, 다가오는 마일스톤, 요청·확인 필요 사항",
};

export const EMPTY_LINE = "해당 없음";
export const FAILED_LINE = "(생성 실패 — 직접 작성)";
export const FOOTER = "※ 생성된 초안입니다. 숫자·기관명은 반드시 확인하세요.";

/** 섹션당 `○` 항목 개수. 너무 적으면 빈약하고 많으면 한 장을 넘긴다. */
export const ITEMS_PER_SECTION: readonly [number, number] = [2, 4];

export type ReportBody = Record<SectionName, string[]>;

/* ── 프롬프트 ────────────────────────────────────────────── */

export const REPORT_SYSTEM = [
  "당신은 공공 R&D 사업담당자의 주간업무계획 초안을 쓰는 보조자입니다.",
  "주어진 요약 자료만 사용해 각 섹션의 항목을 만듭니다.",
  "다음을 반드시 지킵니다.",
  "- 자료에 있는 숫자만 씁니다. 추정하거나 계산해서 새 숫자를 만들지 않습니다.",
  "- 자료에 없는 기관명·일정·성과를 만들지 않습니다.",
  "- 각 항목은 한 문장이며 명사형으로 끝냅니다. (예: ~ 요청함, ~ 완료, ~ 협의 예정)",
  "- 서술형 종결어미(습니다/입니다)와 마침표를 쓰지 않습니다.",
  `- 섹션마다 ${ITEMS_PER_SECTION[0]}~${ITEMS_PER_SECTION[1]}개 항목을 만듭니다.`,
  "- 자료가 없는 섹션은 빈 배열로 둡니다. 억지로 채우지 않습니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

const EXAMPLE = [
  "[예시]",
  '{"추진배경":["2차년도 진척이 계획 대비 -3%p로 지연 기관 3곳 집중 관리 필요"],' +
  '"주요내용":["지엠티 데이터 3종 미수령분 재요청","엑셈 지연 과업 회복 일정 협의 완료"],' +
  '"향후계획":["제3차 실무회의 개최(8.19)","중간보고회 발표자료 작성 착수"]}',
].join("\n");

export function buildReportPrompt(context: string): string {
  return [
    "아래 요약 자료로 주간업무계획의 각 섹션 항목을 만드세요.",
    "",
    "[섹션별 담을 내용]",
    ...SECTIONS.map((name) => `${name}: ${SECTION_GUIDE[name]}`),
    "",
    "[요약 자료]",
    context,
    "",
    EXAMPLE,
    "",
    `출력 형식: {"추진배경":["..."],"주요내용":["..."],"향후계획":["..."]}`,
    "JSON만 출력하세요.",
  ].join("\n");
}

/** 세 키 중 하나라도 배열이면 받아들인다. 없는 섹션은 빈 배열로 채워 돌려준다. */
export function validateReportBody(value: unknown): ReportBody | null {
  if (!isRecord(value)) return null;
  const body = {} as ReportBody;
  let found = false;
  for (const name of SECTIONS) {
    const raw = value[name];
    if (Array.isArray(raw)) found = true;
    body[name] = asTextList(raw).map(oneLine).filter(Boolean).slice(0, ITEMS_PER_SECTION[1]);
  }
  return found ? body : null;
}

/* ── 조립 — 골격은 코드가 만든다 ───────────────────────── */

export type WeeklyReport = {
  title: string;
  period: string;
  body: ReportBody;
  text: string;
  /** 모델 내용이 들어갔는지. 섹션별로 다를 수 있다. */
  fromLlm: boolean;
  note?: string;
};

/**
 * 보고서 한 장을 조립한다.
 *
 * `body`가 null이면 모델이 실패한 것이다. 그래도 **4개 요소는 그대로 나오고**
 * 내용만 "생성 실패 — 직접 작성"으로 표시된다. 섹션이 사라지는 경로는 없다.
 */
export function renderReport(
  projectName: string,
  today: string,
  body: ReportBody | null,
  options: { failed?: boolean } = {},
): WeeklyReport {
  const period = weekLabel(today);
  const title = `[${projectName || "사업"}] 주간업무계획 (${period})`;
  const filled = {} as ReportBody;

  for (const name of SECTIONS) {
    const rows = body?.[name] ?? [];
    // 데이터가 없어도 섹션을 지우지 않는다. 이게 이 양식의 조건이다.
    filled[name] = rows.length ? rows : [options.failed ? FAILED_LINE : EMPTY_LINE];
  }

  const lines: string[] = [title, ""];
  for (const name of SECTIONS) {
    lines.push(`□ ${name}`);
    for (const row of filled[name]) lines.push(`  ○ ${row}`);
    lines.push("");
  }
  lines.push(FOOTER);

  return {
    title,
    period,
    body: filled,
    text: lines.join("\n"),
    fromLlm: Boolean(body),
  };
}

/** 4개 요소가 전부 있는지. 화면과 테스트가 같은 함수로 확인한다. */
export function hasAllSections(text: string): boolean {
  if (!text.includes("주간업무계획")) return false;
  return SECTIONS.every((name) => text.includes(`□ ${name}`));
}

/**
 * 주간보고서를 만든다.
 *
 * 모델에는 **요약 컨텍스트만** 넘긴다(`llmContext.ts`). WBS 전체 행이나 업무
 * 원문을 통째로 넣지 않는다.
 */
export async function generateWeeklyReport(
  input: ContextInput,
  call: LlmCall | null,
): Promise<WeeklyReport & { context: string }> {
  const context = buildWeeklyContext(input);
  if (!call) {
    return { ...renderReport(input.projectName, input.today, null, { failed: true }), context, note: "모델에 연결되지 않았습니다." };
  }

  try {
    const raw = await call(buildReportPrompt(context), REPORT_SYSTEM);
    return { ...renderReport(input.projectName, input.today, parseResponse(raw, validateReportBody)), context };
  } catch (cause) {
    return {
      ...renderReport(input.projectName, input.today, null, { failed: true }),
      context,
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

/** 이 기능에 맞는 호출 설정. 한 장짜리 문서라 출력 상한을 둔다. */
export const REPORT_LLM_OPTIONS: Partial<LlmConfig> = {
  temperature: 0.3,
  numPredict: 1500,
};
