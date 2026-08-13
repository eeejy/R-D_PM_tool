import { describe, expect, it } from "vitest";
import {
  buildReportPrompt,
  FAILED_LINE,
  EMPTY_LINE,
  generateWeeklyReport,
  hasAllSections,
  renderReport,
  SECTIONS,
  validateReportBody,
} from "../lib/weeklyReport";
import {
  buildWeeklyContext,
  CAPS,
  cap,
  CONTEXT_TOKEN_LIMIT,
  estimateTokens,
  weekLabel,
  weekRange,
} from "../lib/llmContext";
import { event } from "../lib/history";
import type { MyTask } from "../lib/mytask";
import type { WbsStatus } from "../lib/wbsStatus";
import type { WbsTask } from "../lib/types";

const TODAY = "2026-08-13"; // 목요일

const task = (over: Partial<MyTask>): MyTask => ({
  id: "t1", title: "데이터 3종 재확인", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "2026-08-14", dueNote: "", status: "회신 대기", note: "지엠티 데이터 3종 미수령",
  createdAt: TODAY, ...over,
});

const wbsItem = (over: Record<string, unknown>) => ({
  code: "W1", title: "과업", org: "지엠티", assignee: "", due: "2026-08-01",
  dueLabel: "8월 1일", dday: -12, planned: 80, progress: 40, variance: -40, deliverable: "",
  ...over,
});

const STATUS = {
  overall: { name: "전체", planned: 49, progress: 46, variance: -3, status: "주의", count: 226, missing: 1 },
  institutions: [
    { name: "지엠티", planned: 70, progress: 62, variance: -8, status: "지연", count: 100, missing: 1 },
    { name: "유원GIS", planned: 55, progress: 61, variance: 6, status: "정상", count: 58, missing: 0 },
  ],
  running: [], completed: [],
  delayed: Array.from({ length: 15 }, (_, i) => wbsItem({ code: `W${i}`, title: `지연과업 ${i}` })),
  watch: Array.from({ length: 9 }, (_, i) => wbsItem({ code: `V${i}`, title: `주의과업 ${i}` })),
  checks: [], total: 226, leaves: 200,
} as unknown as WbsStatus;

const WBS_TASKS = [
  { code: "M1", title: "중간보고 산출물", owner: "지엠티", assignee: "", start: "", end: "2026-09-30",
    planned: null, progress: null, weight: null, status: "", predecessors: [], deliverable: "보고서",
    milestone: true, depth: 2, isLeaf: true, sheet: "지엠티", row: 9 },
] as unknown as WbsTask[];

const input = {
  projectName: "CDX 연구개발사업",
  today: TODAY,
  tasks: [task({}), task({ id: "t2", due: "2026-09-05", title: "다음 달 건" }), task({ id: "t3", status: "완료" as const })],
  events: [event("t1", "sent", "2026-08-07", { orgId: "gmt" as const })],
  status: STATUS,
  wbsTasks: WBS_TASKS,
  issues: [{ text: "실증 대상지 미확정", org: "지엠티" }],
};

describe("주간 범위", () => {
  it("월요일부터 일요일까지", () => {
    // 목요일 기준이면 그 주 월요일이 시작이다
    expect(weekRange("2026-08-13")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("일요일은 그 주의 마지막으로 본다", () => {
    expect(weekRange("2026-08-16")).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("월요일은 그 주의 시작", () => {
    expect(weekRange("2026-08-10").start).toBe("2026-08-10");
  });

  it("제목에 쓸 표기를 만든다", () => {
    expect(weekLabel(TODAY)).toBe("2026.08.10 ~ 08.16");
  });
});

describe("입력 압축", () => {
  const context = buildWeeklyContext(input);

  it("토큰 상한 안에 들어온다", () => {
    expect(estimateTokens(context)).toBeLessThanOrEqual(CONTEXT_TOKEN_LIMIT);
  });

  it("지연 항목은 상위 10건까지만 넣는다", () => {
    // 15건을 줬지만 10건만 나가야 한다
    const rows = context.split("\n").filter((line) => line.includes("지연과업"));
    expect(rows).toHaveLength(CAPS.delayed);
  });

  it("주의 항목은 상위 5건까지만", () => {
    expect(context.split("\n").filter((line) => line.includes("주의과업"))).toHaveLength(CAPS.watch);
  });

  it("집계 숫자를 그대로 싣는다", () => {
    expect(context).toMatch(/전체 계획 49% \/ 실적 46% \(-3%p\)/);
    expect(context).toMatch(/지엠티 계획 70% \/ 실적 62% \(-8%p\) 지연/);
  });

  it("완료된 업무는 넣지 않는다", () => {
    const done = buildWeeklyContext({ ...input, tasks: [task({ id: "z", title: "끝난건", status: "완료" })] });
    expect(done).not.toMatch(/끝난건/);
  });

  it("이번 주와 다음 달을 나눠 담는다", () => {
    expect(context).toMatch(/\[이번 주 업무\]/);
    expect(context).toMatch(/\[다음 주 이후 예정\]/);
    expect(context).toMatch(/다음 달 건/);
  });

  it("이력이 있으면 경위를 한 줄로 붙인다", () => {
    expect(context).toMatch(/회신대기 \d+영업일/);
  });

  it("빈 절도 남긴다 — 모델이 없다는 걸 알아야 지어내지 않는다", () => {
    const bare = buildWeeklyContext({ ...input, status: null, wbsTasks: [], issues: [] });
    expect(bare).toMatch(/WBS 미등록/);
    expect(bare).toMatch(/해당 없음/);
  });

  it("상한을 넘으면 줄 단위로 자르고 잘렸다고 알린다", () => {
    // 문장 중간에서 끊으면 모델이 잘린 조각을 사실로 읽는다
    const huge = Array.from({ length: 2000 }, (_, i) => `- 아주 긴 항목 ${i}`).join("\n");
    const capped = cap(huge);
    expect(estimateTokens(capped)).toBeLessThanOrEqual(CONTEXT_TOKEN_LIMIT);
    expect(capped).toMatch(/뒷부분을 생략했습니다/);
    expect(capped.split("\n").every((line) => !line.endsWith("아주"))).toBe(true);
  });
});

describe("4개 요소 골격", () => {
  it("모델 응답이 비어도 전부 나온다", () => {
    // 이 양식의 조건이다. 섹션이 사라지는 경로가 없어야 한다.
    const report = renderReport("CDX 연구개발사업", TODAY, null, { failed: true });
    expect(hasAllSections(report.text)).toBe(true);
    for (const name of SECTIONS) expect(report.text).toMatch(new RegExp(`□ ${name}`));
    expect(report.text).toMatch(/생성 실패 — 직접 작성/);
  });

  it("데이터가 없는 섹션은 '해당 없음'으로 채운다", () => {
    const report = renderReport("사업", TODAY, { 추진배경: ["배경 있음"], 주요내용: [], 향후계획: [] });
    expect(report.body.주요내용).toEqual([EMPTY_LINE]);
    expect(report.body.향후계획).toEqual([EMPTY_LINE]);
    expect(hasAllSections(report.text)).toBe(true);
  });

  it("타이틀과 기간은 코드가 만든다 — 모델에 맡기지 않는다", () => {
    const report = renderReport("CDX 연구개발사업", TODAY, null);
    expect(report.title).toBe("[CDX 연구개발사업] 주간업무계획 (2026.08.10 ~ 08.16)");
  });

  it("개조식 기호와 순서를 지킨다", () => {
    const report = renderReport("사업", TODAY, { 추진배경: ["가"], 주요내용: ["나"], 향후계획: ["다"] });
    expect(report.text.indexOf("□ 추진배경")).toBeLessThan(report.text.indexOf("□ 주요내용"));
    expect(report.text.indexOf("□ 주요내용")).toBeLessThan(report.text.indexOf("□ 향후계획"));
    expect(report.text).toMatch(/ {2}○ 가/);
  });

  it("말미 안내문이 항상 붙는다", () => {
    expect(renderReport("사업", TODAY, null).text.trimEnd().endsWith("반드시 확인하세요.")).toBe(true);
  });

  it("항목이 많아도 4개까지만 싣는다", () => {
    const parsed = validateReportBody({ 추진배경: ["1", "2", "3", "4", "5", "6"] });
    expect(parsed?.추진배경).toHaveLength(4);
  });
});

describe("응답 검증", () => {
  it("정상 응답을 받아들인다", () => {
    const parsed = validateReportBody({ 추진배경: ["가"], 주요내용: ["나"], 향후계획: ["다"] });
    expect(parsed).toEqual({ 추진배경: ["가"], 주요내용: ["나"], 향후계획: ["다"] });
  });

  it("일부 섹션만 와도 나머지는 빈 배열로 채운다", () => {
    expect(validateReportBody({ 주요내용: ["나"] })).toEqual({ 추진배경: [], 주요내용: ["나"], 향후계획: [] });
  });

  it("모양이 다르면 null", () => {
    expect(validateReportBody({ 결과: "없음" })).toBeNull();
    expect(validateReportBody("문자열")).toBeNull();
  });
});

describe("generateWeeklyReport", () => {
  it("모델 문장을 섹션에 넣는다", async () => {
    const call = async () => JSON.stringify({
      추진배경: ["2차년도 진척이 계획 대비 -3%p로 지연 기관 집중 관리 필요"],
      주요내용: ["지엠티 데이터 3종 미수령분 재요청"],
      향후계획: ["제3차 실무회의 개최"],
    });
    const report = await generateWeeklyReport(input, call);
    expect(report.fromLlm).toBe(true);
    expect(report.text).toMatch(/지엠티 데이터 3종 미수령분 재요청/);
    expect(hasAllSections(report.text)).toBe(true);
  });

  it("모델이 죽어도 골격은 나온다", async () => {
    const report = await generateWeeklyReport(input, async () => { throw new Error("연결 실패"); });
    expect(hasAllSections(report.text)).toBe(true);
    expect(report.note).toMatch(/연결 실패/);
    expect(report.text).toMatch(/생성 실패 — 직접 작성/);
  });

  it("응답이 형식을 벗어나도 골격은 나온다", async () => {
    const report = await generateWeeklyReport(input, async () => "그건 못 하겠습니다");
    expect(hasAllSections(report.text)).toBe(true);
    expect(report.fromLlm).toBe(false);
  });

  it("모델 없이도 골격은 나온다", async () => {
    const report = await generateWeeklyReport(input, null);
    expect(hasAllSections(report.text)).toBe(true);
    expect(report.note).toMatch(/연결되지 않았습니다/);
  });

  it("모델에는 요약만 넘긴다 — 업무 원문을 통째로 넣지 않는다", async () => {
    let sent = "";
    await generateWeeklyReport(input, async (prompt) => { sent = prompt; return "{}"; });
    expect(estimateTokens(sent)).toBeLessThan(CONTEXT_TOKEN_LIMIT + 1000);
    expect(buildReportPrompt("x")).toMatch(/JSON만 출력하세요/);
  });
});
