import { describe, expect, it } from "vitest";
import {
  assembleSections,
  buildOverviewInput,
  buildOverviewPrompt,
  FAILED_LINE,
  generateHandoverDoc,
  OVERVIEW_SYSTEM,
  renderHandoverDoc,
  SECTIONS,
  SECTION_TITLE,
  validateOverview,
  type HandoverInput,
} from "../lib/handover";
import { event } from "../lib/history";
import type { MyTask } from "../lib/mytask";
import type { WbsStatus } from "../lib/wbsStatus";
import type { WbsTask } from "../lib/types";

const TODAY = "2026-08-13";

const task = (over: Partial<MyTask>): MyTask => ({
  id: "t1", title: "데이터 3종 제공 요청", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "2026-09-30", dueNote: "", status: "회신 대기", note: "지엠티 데이터 3종",
  createdAt: "2026-06-01", ...over,
});

const STATUS = {
  overall: { name: "전체", planned: 49, progress: 46, variance: -3, status: "주의", count: 226, missing: 1 },
  institutions: [],
  running: [], completed: [],
  delayed: [{ code: "W3.1", title: "모델 학습", org: "지엠티", assignee: "", due: "2026-08-01",
    dueLabel: "8월 1일", dday: -12, planned: 80, progress: 40, variance: -40, deliverable: "" }],
  watch: [], checks: [], total: 226, leaves: 200,
} as unknown as WbsStatus;

const WBS_TASKS = [
  { code: "M1", title: "중간보고 산출물", owner: "지엠티", assignee: "", start: "", end: "2026-09-30",
    planned: null, progress: null, weight: null, status: "", predecessors: [], deliverable: "보고서",
    milestone: true, depth: 2, isLeaf: true, sheet: "지엠티", row: 9 },
] as unknown as WbsTask[];

const input: HandoverInput = {
  projectName: "CDX 연구개발사업",
  today: TODAY,
  tasks: [
    task({}),
    task({ id: "t2", title: "완료된 건", status: "완료" }),
    task({ id: "t3", title: "반복 지연 건", orgId: "exem", org: "엑셈" }),
  ],
  events: [
    event("t1", "created", "2026-06-01", { to: "2026-06-30", orgId: "gmt" }),
    event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-09-30", note: "기관 회신 지연", orgId: "gmt" }),
    event("t1", "sent", "2026-08-07", { orgId: "gmt" }),
    event("t3", "created", "2026-06-01", { to: "2026-06-30", orgId: "exem" }),
    event("t3", "due_changed", "2026-06-20", { from: "2026-06-30", to: "2026-07-31", orgId: "exem" }),
    event("t3", "due_changed", "2026-07-20", { from: "2026-07-31", to: "2026-09-30", orgId: "exem" }),
  ],
  status: STATUS,
  wbsTasks: WBS_TASKS,
  issues: [{ text: "실증 대상지 미확정", org: "지엠티" }],
};

describe("6개 절", () => {
  it("절 순서와 이름이 고정이다", () => {
    expect(SECTIONS).toEqual(["overview", "ongoing", "awaiting", "orgNotes", "upcoming", "issues"]);
    expect(SECTION_TITLE.overview).toBe("사업 개요");
  });

  it("개요를 뺀 다섯 절은 모델 없이 조립된다", () => {
    const { sections } = assembleSections(input);
    expect(sections.ongoing.length).toBeGreaterThan(0);
    expect(sections.awaiting.length).toBeGreaterThan(0);
    expect(sections.orgNotes.length).toBeGreaterThan(0);
    expect(sections.upcoming.length).toBeGreaterThan(0);
    expect(sections.issues.length).toBeGreaterThan(0);
    expect(sections.overview).toEqual([]); // 여기만 모델이 채운다
  });
});

describe("진행 중 과업", () => {
  const { sections } = assembleSections(input);

  it("WBS 지연 항목과 내 업무를 함께 싣는다", () => {
    expect(sections.ongoing.join("\n")).toMatch(/\[지연\] W3.1 모델 학습/);
    expect(sections.ongoing.join("\n")).toMatch(/\[내 업무\] 데이터 3종 제공 요청/);
  });

  it("완료된 업무는 넣지 않는다", () => {
    expect(sections.ongoing.join("\n")).not.toMatch(/완료된 건/);
  });

  it("전체 진척을 맨 앞에 적는다", () => {
    expect(sections.ongoing[0]).toMatch(/전체 진척 계획 49% \/ 실적 46% \(-3%p\)/);
  });
});

describe("미결 요청사항", () => {
  const { sections } = assembleSections(input);

  it("회신을 못 받은 건만, 오래 기다린 것부터", () => {
    expect(sections.awaiting).toHaveLength(1);
    expect(sections.awaiting[0]).toMatch(/지엠티 · 데이터 3종 제공 요청/);
    expect(sections.awaiting[0]).toMatch(/2026-08-07 요청/);
    expect(sections.awaiting[0]).toMatch(/4영업일 대기/);
  });

  it("임계일을 넘겼으면 표시한다", () => {
    expect(sections.awaiting[0]).toMatch(/임계일 초과/);
  });
});

describe("기관별 특이사항", () => {
  const { sections } = assembleSections(input);

  it("2회 이상 밀린 건만 모은다", () => {
    // 두 번은 우연일 수 있지만 그 이상은 패턴이다
    const text = sections.orgNotes.join("\n");
    expect(text).toMatch(/\[엑셈\]/);
    expect(text).toMatch(/2회 연기/);
    expect(text).not.toMatch(/\[유원GIS\]/);
  });

  it("사유가 없으면 '사유 미기재'로 둔다", () => {
    expect(sections.orgNotes.join("\n")).toMatch(/사유 미기재/);
  });

  it("기관을 평가하는 표현을 쓰지 않는다", () => {
    // "대응이 느림" 같은 문장이 문서로 남으면 곤란해진다
    expect(sections.orgNotes.join("\n")).not.toMatch(/느림|미흡|불성실|소극/);
  });
});

describe("다가오는 일정 · 쟁점", () => {
  const { sections } = assembleSections(input);

  it("안 지난 마일스톤만", () => {
    expect(sections.upcoming[0]).toMatch(/9월 30일 · 중간보고 산출물/);
  });

  it("미해결 쟁점을 그대로 옮긴다", () => {
    expect(sections.issues[0]).toMatch(/실증 대상지 미확정 · 지엠티/);
  });
});

describe("개요 — 유일한 LLM 절", () => {
  const { signals } = assembleSections(input);

  it("집계값만 넘긴다 — 업무 원문은 나가지 않는다", () => {
    const sent = buildOverviewInput(input, signals);
    expect(JSON.stringify(sent)).not.toMatch(/데이터 3종/);
    expect(sent).toMatchObject({ openCount: 2, awaitingCount: 1, repeatDelayCount: 1, issueCount: 1 });
  });

  it("기관 평가와 사유 추측을 금지한다", () => {
    expect(OVERVIEW_SYSTEM).toMatch(/평가하거나 탓하는 표현을 쓰지 않습니다/);
    expect(OVERVIEW_SYSTEM).toMatch(/기록되지 않은 지연 사유를 추측하지 않습니다/);
  });

  it("세 문단으로 자른다", () => {
    expect(validateOverview({ overview: ["1", "2", "3", "4"] })).toHaveLength(3);
  });

  it("모양이 다르면 null", () => {
    expect(validateOverview({ 결과: "없음" })).toBeNull();
  });

  it("프롬프트에 집계값이 들어간다", () => {
    expect(buildOverviewPrompt(input, signals)).toMatch(/"openCount": 2/);
  });
});

describe("generateHandoverDoc", () => {
  it("모델이 죽어도 나머지 다섯 절은 그대로 나온다", async () => {
    // 이 기능의 조건이다. 인수인계서가 모델 사정에 좌우되면 안 된다.
    const doc = await generateHandoverDoc(input, async () => { throw new Error("연결 실패"); });
    expect(doc.sections.overview).toEqual([FAILED_LINE]);
    expect(doc.sections.ongoing.length).toBeGreaterThan(0);
    expect(doc.sections.awaiting.length).toBeGreaterThan(0);
    expect(doc.sections.upcoming.length).toBeGreaterThan(0);
    expect(doc.note).toMatch(/연결 실패/);
  });

  it("모델 없이도 문서가 나온다", async () => {
    const doc = await generateHandoverDoc(input, null);
    expect(doc.text).toMatch(/□ 진행 중 과업/);
    expect(doc.fromLlm).toBe(false);
  });

  it("개요가 오면 문서 맨 앞에 붙는다", async () => {
    const call = async () => JSON.stringify({ overview: ["현황 문단.", "걸린 것 문단.", "먼저 볼 것 문단."] });
    const doc = await generateHandoverDoc(input, call);
    expect(doc.fromLlm).toBe(true);
    expect(doc.text.indexOf("현황 문단.")).toBeLessThan(doc.text.indexOf("□ 진행 중 과업"));
  });

  it("한 번만 호출한다 — 나머지는 조립이다", async () => {
    let calls = 0;
    await generateHandoverDoc(input, async () => { calls += 1; return JSON.stringify({ overview: ["가"] }); });
    expect(calls).toBe(1);
  });
});

describe("플레인 텍스트 출력", () => {
  it("여섯 절이 정해진 순서로 나온다", async () => {
    const doc = await generateHandoverDoc(input, null);
    const text = renderHandoverDoc(doc);
    let last = -1;
    for (const id of SECTIONS) {
      const at = text.indexOf(`□ ${SECTION_TITLE[id]}`);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it("빈 절도 지우지 않고 '해당 없음'으로 둔다", async () => {
    const bare = await generateHandoverDoc(
      { projectName: "사업", today: TODAY, tasks: [] }, null);
    expect(bare.text).toMatch(/□ 주요 쟁점\n {2}○ 해당 없음/);
  });

  it("기관 11개를 표로 전부 적는다", async () => {
    const doc = await generateHandoverDoc(input, null);
    expect(doc.byOrg).toHaveLength(11);
    expect(doc.text).toMatch(/써로마인드 \/ 0건/);
  });

  it("개요 생성 실패를 문서 끝에 밝힌다", async () => {
    const doc = await generateHandoverDoc(input, async () => { throw new Error("타임아웃"); });
    expect(doc.text).toMatch(/사업 개요는 자동 생성하지 못했습니다/);
  });
});
