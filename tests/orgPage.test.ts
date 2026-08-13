import { describe, expect, it } from "vitest";
import {
  buildOrgPage,
  defaultOrgId,
  STALE_DAYS,
  buildOrgSummaryInput,
  fallbackSummary,
  generateOrgSummary,
  orgSummaries,
  renderOrgPageText,
  validateOrgSummary,
} from "../lib/orgPage";
import { event, type TaskEvent } from "../lib/history";
import type { MyTask } from "../lib/mytask";
import type { WbsStatus } from "../lib/wbsStatus";
import type { WbsTask } from "../lib/types";

const TODAY = "2026-08-13"; // 목요일

const task = (over: Partial<MyTask>): MyTask => ({
  id: "t1", title: "데이터 3종", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "2026-08-20", dueNote: "", status: "회신 대기", note: "지엠티 데이터 3종 미수령",
  createdAt: TODAY, ...over,
});

const TASKS: MyTask[] = [
  task({ id: "t1" }),
  task({ id: "t2", org: "유원GIS", orgId: "uwon", note: "유원GIS 품질 확인" }),
  task({ id: "t3", orgId: "gmt", status: "완료", note: "끝난 건" }),
  task({ id: "t4", orgId: "kimst", org: "KIMST", note: "KIMST 제출자료" }),
];

const EVENTS: TaskEvent[] = [
  event("t1", "created", "2026-07-01", { to: "2026-08-20", orgId: "gmt" }),
  event("t1", "sent", "2026-08-07", { orgId: "gmt" }),
  event("t2", "sent", "2026-08-12", { orgId: "uwon" }),
  event("t2", "replied", "2026-08-13", { orgId: "uwon" }),
];

const STATUS = {
  overall: { name: "전체", planned: 49, progress: 46, variance: -3, status: "주의", count: 226, missing: 1 },
  institutions: [
    { name: "지엠티", planned: 70, progress: 62, variance: -8, status: "지연", count: 100, missing: 1 },
    { name: "유원GIS", planned: 55, progress: 61, variance: 6, status: "정상", count: 58, missing: 0 },
  ],
  running: [],
  completed: [],
  delayed: [
    { code: "W3.1", title: "모델 학습", org: "지엠티", assignee: "", due: "2026-08-01",
      dueLabel: "8월 1일", dday: -12, planned: 80, progress: 40, variance: -40, deliverable: "" },
    { code: "W4.2", title: "지도 연계", org: "유원GIS", assignee: "", due: "2026-08-05",
      dueLabel: "8월 5일", dday: -8, planned: 70, progress: 50, variance: -20, deliverable: "" },
  ],
  watch: [],
  checks: [],
  total: 226,
  leaves: 200,
} as unknown as WbsStatus;

const WBS_TASKS = [
  { code: "W3.9", title: "중간보고 산출물", owner: "지엠티", assignee: "", start: "", end: "2026-09-30",
    planned: null, progress: null, weight: null, status: "", predecessors: [], deliverable: "보고서",
    milestone: true, depth: 2, isLeaf: true, sheet: "지엠티", row: 9 },
  { code: "W3.8", title: "지난 마일스톤", owner: "지엠티", assignee: "", start: "", end: "2026-06-30",
    planned: null, progress: null, weight: null, status: "", predecessors: [], deliverable: "",
    milestone: true, depth: 2, isLeaf: true, sheet: "지엠티", row: 8 },
] as unknown as WbsTask[];

const input = { tasks: TASKS, events: EVENTS, status: STATUS, wbsTasks: WBS_TASKS, today: TODAY };

describe("기관별 원페이지", () => {
  it("해당 기관 것만 모은다", () => {
    const page = buildOrgPage("gmt", input);
    expect(page.org.name).toBe("지엠티");
    expect(page.openCount).toBe(1); // 완료된 t3은 빠진다
    expect(page.delayedTasks.map((item) => item.code)).toEqual(["W3.1"]);
  });

  it("WBS 집계값을 그대로 가져온다 — 다시 계산하지 않는다", () => {
    const page = buildOrgPage("gmt", input);
    expect(page.progress).toMatchObject({ planned: 70, progress: 62, variance: -8 });
  });

  it("KIMST는 WBS 시트가 없어 진척을 비운다", () => {
    // 억지로 0%를 보여주면 지연으로 오해된다
    const page = buildOrgPage("kimst", input);
    expect(page.progress).toBeNull();
    expect(page.openCount).toBe(1);
  });

  it("기타 / 미분류도 원페이지를 만든다", () => {
    // 여기 항목이 쌓이면 별칭 보강 신호다
    expect(buildOrgPage("etc", input).org.name).toBe("기타 / 미분류");
  });

  it("WBS를 안 넣었어도 나머지는 나온다", () => {
    const page = buildOrgPage("gmt", { ...input, status: null, wbsTasks: [] });
    expect(page.progress).toBeNull();
    expect(page.delayedTasks).toEqual([]);
    expect(page.openCount).toBe(1);
  });
});

describe("미결 요청", () => {
  it("회신을 못 받은 것만 올린다", () => {
    const page = buildOrgPage("gmt", input);
    expect(page.openRequests.map((item) => item.id)).toEqual(["t1"]);
    expect(page.awaitingCount).toBe(1);
  });

  it("회신이 온 기관은 미결이 없다", () => {
    expect(buildOrgPage("uwon", input).openRequests).toEqual([]);
  });

  it("대기 영업일과 임계일 초과를 표시한다", () => {
    // 8월 7일(금) 요청 → 8월 13일(목)은 4영업일. 주관 임계일 3일을 넘겼다.
    const [request] = buildOrgPage("gmt", input).openRequests;
    expect(request.waitingDays).toBe(4);
    expect(request.overdue).toBe(true);
  });

  it("최종 접촉일을 잡는다", () => {
    expect(buildOrgPage("gmt", input).lastContact).toBe("2026-08-07");
    expect(buildOrgPage("uwon", input).lastContact).toBe("2026-08-13");
  });
});

describe("다음 마일스톤", () => {
  it("아직 안 지난 것만 가까운 순으로", () => {
    const page = buildOrgPage("gmt", input);
    expect(page.nextMilestones.map((item) => item.code)).toEqual(["W3.9"]);
  });
});

describe("최근 이력", () => {
  it("최신 순으로 자른다", () => {
    const page = buildOrgPage("gmt", input);
    expect(page.recent[0].at).toBe("2026-08-07");
    expect(page.recent[0].label).toBe("요청 발송");
  });

  it("기록된 사유만 담는다 — 없는 사유를 지어내지 않는다", () => {
    const events = [event("t1", "due_changed", TODAY, { from: "2026-06-30", to: "2026-08-20", orgId: "gmt" })];
    const page = buildOrgPage("gmt", { ...input, events });
    expect(page.recent[0].note).toBe("2026-06-30 → 2026-08-20");
  });
});

describe("11개 기관 요약", () => {
  it("기관을 하나도 빠뜨리지 않는다", () => {
    const rows = orgSummaries(input);
    expect(rows).toHaveLength(11);
    expect(rows.find((row) => row.org.id === "gmt")?.awaitingCount).toBe(1);
  });
});

describe("요약 문단", () => {
  it("모델에는 집계값만 넘긴다 — 원자료를 통째로 넣지 않는다", () => {
    const sent = buildOrgSummaryInput(buildOrgPage("gmt", input));
    expect(Object.keys(sent).sort()).toEqual(
      ["asOf", "awaitingCount", "delayedCount", "lastContact", "nextMilestone", "openCount", "org", "progress", "role"],
    );
    expect(JSON.stringify(sent)).not.toMatch(/미수령/); // 업무 원문은 나가지 않는다
  });

  it("규칙 요약이 집계값을 그대로 인용한다", () => {
    const lines = fallbackSummary(buildOrgPage("gmt", input)).join(" ");
    expect(lines).toMatch(/계획 70% 대비 실적 62%/);
    expect(lines).toMatch(/-8%p/);
  });

  it("확인할 게 없으면 그렇게 말한다", () => {
    const empty = buildOrgPage("semyung", { ...input, status: null, wbsTasks: [] });
    expect(fallbackSummary(empty)).toEqual(["현재 확인이 필요한 항목이 없습니다."]);
  });

  it("응답을 3문장으로 자른다", () => {
    const parsed = validateOrgSummary({ summary: ["1", "2", "3", "4"] });
    expect(parsed).toHaveLength(3);
  });

  it("모양이 다르면 null", () => {
    expect(validateOrgSummary({ 요약: "없음" })).toBeNull();
    expect(validateOrgSummary("문자열")).toBeNull();
  });

  it("모델이 실패해도 요약은 나온다", async () => {
    const page = buildOrgPage("gmt", input);
    const summary = await generateOrgSummary(page, async () => { throw new Error("연결 실패"); });
    expect(summary.fromLlm).toBe(false);
    expect(summary.lines.length).toBeGreaterThan(0);
    expect(summary.note).toMatch(/연결 실패/);
  });

  it("모델 없이도 요약은 나온다", async () => {
    const summary = await generateOrgSummary(buildOrgPage("gmt", input), null);
    expect(summary.fromLlm).toBe(false);
  });
});

describe("복사용 텍스트", () => {
  it("정해진 순서로 나온다", () => {
    const page = buildOrgPage("gmt", input);
    const text = renderOrgPageText(page, fallbackSummary(page));
    expect(text.indexOf("□ 지연 과업")).toBeLessThan(text.indexOf("□ 미결 요청"));
    expect(text.indexOf("□ 미결 요청")).toBeLessThan(text.indexOf("□ 다음 마일스톤"));
    expect(text).toMatch(/계획 70% \/ 실적 62%/);
  });

  it("WBS가 없으면 없다고 적는다", () => {
    const page = buildOrgPage("kimst", input);
    expect(renderOrgPageText(page, fallbackSummary(page))).toMatch(/WBS 시트 없음/);
  });
});

describe("기본 선택 기관", () => {
  it("미회신이 가장 많은 기관을 고른다", () => {
    // 원페이저를 여는 이유가 대개 그것이다
    expect(defaultOrgId(input)).toBe("gmt");
  });

  it("미회신이 없으면 업무가 많은 기관", () => {
    const noReply = { ...input, events: [] };
    expect(["gmt", "uwon", "kimst"]).toContain(defaultOrgId(noReply));
  });

  it("아무것도 없으면 주관연구기관", () => {
    expect(defaultOrgId({ ...input, tasks: [], events: [] })).toBe("gmt");
  });
});

describe("요청사항 정렬·표시", () => {
  it("경과일 내림차순이다 — 기한이 아니다", () => {
    const events = [
      event("t1", "sent", "2026-07-20", { orgId: "gmt" as const }),
      event("t5", "sent", "2026-08-11", { orgId: "gmt" as const }),
    ];
    const tasks = [...TASKS, task({ id: "t5", note: "최근 요청" })];
    const page = buildOrgPage("gmt", { ...input, tasks, events });
    expect(page.openRequests.map((item) => item.id)).toEqual(["t1", "t5"]);
  });

  it("오래 방치된 건을 따로 표시한다", () => {
    const events = [event("t1", "sent", "2026-07-20", { orgId: "gmt" as const })];
    const [request] = buildOrgPage("gmt", { ...input, events }).openRequests;
    expect(request.waitingDays).toBeGreaterThan(STALE_DAYS);
    expect(request.stale).toBe(true);
  });

  it("최근 요청은 방치로 보지 않는다", () => {
    const events = [event("t1", "sent", "2026-08-12", { orgId: "gmt" as const })];
    expect(buildOrgPage("gmt", { ...input, events }).openRequests[0].stale).toBe(false);
  });
});
