import { describe, expect, it } from "vitest";
import {
  bindSection,
  buildSectionPrompt,
  fallbackLine,
  generateHandover,
  handoverSystem,
  renderHandoverText,
  selectHandover,
  validateHandoverOutput,
} from "../lib/handover";
import { event, type TaskEvent } from "../lib/history";
import type { MyTask } from "../lib/mytask";

const TODAY = "2026-08-13";

const task = (over: Partial<MyTask>): MyTask => ({
  id: "t1", title: "데이터 3종", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "2026-09-30", dueNote: "", status: "회신 대기", note: "지엠티 데이터 3종 제공 요청",
  createdAt: "2026-06-01", ...over,
});

const TASKS: MyTask[] = [
  task({ id: "t1" }),
  task({ id: "t2", orgId: "kimst", org: "KIMST", note: "KIMST 제출자료 작성", due: "2026-08-01" }),
  task({ id: "t3", status: "완료", note: "끝난 건" }),
];

const EVENTS: TaskEvent[] = [
  event("t1", "created", "2026-06-01", { to: "2026-06-30", orgId: "gmt" }),
  event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-07-31", note: "기관 회신 지연", orgId: "gmt" }),
  event("t1", "due_changed", "2026-07-29", { from: "2026-07-31", to: "2026-09-30", orgId: "gmt" }),
  event("t1", "sent", "2026-08-07", { orgId: "gmt" }),
  event("t2", "created", "2026-06-01", { to: "2026-08-01", orgId: "kimst" }),
];

describe("선별 — 룰", () => {
  const facts = selectHandover(TASKS, EVENTS, TODAY);

  it("완료한 업무는 넣지 않는다", () => {
    expect(facts.ongoing.map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  it("미결 요청은 회신을 기다리는 것만", () => {
    expect(facts.awaiting.map((item) => item.id)).toEqual(["t1"]);
  });

  it("연기됐거나 기한을 넘긴 것을 지연 이력으로 모은다", () => {
    // t1은 2회 연기, t2는 기한 초과
    expect(facts.delayed.map((item) => item.id).sort()).toEqual(["t1", "t2"]);
  });

  it("한 업무가 여러 섹션에 나와도 된다", () => {
    // 인계받는 사람은 목록과 경위에서 서로 다른 것을 읽는다
    expect(facts.ongoing.some((item) => item.id === "t1")).toBe(true);
    expect(facts.delayed.some((item) => item.id === "t1")).toBe(true);
  });
});

describe("경위 사실 조립", () => {
  const facts = selectHandover(TASKS, EVENTS, TODAY);
  const delayed = facts.delayed.find((item) => item.id === "t1")!;

  it("당초 기한과 현재 기한을 나란히 적는다", () => {
    expect(delayed.facts.join(" ")).toMatch(/당초 6월 30일 → 현재 9월 30일/);
  });

  it("연기 횟수와 누적 일수를 적는다", () => {
    expect(delayed.facts.join(" ")).toMatch(/2회 연기/);
    expect(delayed.facts.join(" ")).toMatch(/누적 92일 연기/);
  });

  it("기록된 사유만 담는다", () => {
    expect(delayed.facts.join(" ")).toMatch(/사유: 기관 회신 지연/);
  });

  it("사유가 없으면 '사유 미기재'로 그대로 둔다", () => {
    // 지어내지 않는다. 인수인계서는 나중에 근거 문서가 된다.
    const t2 = facts.delayed.find((item) => item.id === "t2")!;
    expect(t2.facts).toContain("사유 미기재");
  });

  it("미결 요청에는 요청일과 대기 일수를 적는다", () => {
    const awaiting = facts.awaiting[0];
    expect(awaiting.facts.join(" ")).toMatch(/8월 7일 요청/);
    expect(awaiting.facts.join(" ")).toMatch(/4영업일 대기/);
  });
});

describe("기관별 접촉 이력", () => {
  const facts = selectHandover(TASKS, EVENTS, TODAY);

  it("기관 11개를 전부 남긴다 — 없다는 사실도 인계 내용이다", () => {
    expect(facts.byOrg).toHaveLength(11);
  });

  it("기관별 건수와 최종 접촉일을 센다", () => {
    const gmt = facts.byOrg.find((row) => row.orgId === "gmt")!;
    expect(gmt).toMatchObject({ openCount: 1, awaitingCount: 1, lastContact: "2026-08-07" });
    const kimst = facts.byOrg.find((row) => row.orgId === "kimst")!;
    expect(kimst).toMatchObject({ openCount: 1, awaitingCount: 0, lastContact: "" });
  });
});

describe("프롬프트", () => {
  const facts = selectHandover(TASKS, EVENTS, TODAY);

  it("조립한 사실만 넘긴다", () => {
    const prompt = buildSectionPrompt("delayed", facts.delayed, TODAY);
    expect(prompt).toMatch(/당초 6월 30일/);
    expect(prompt).toMatch(/사유 미기재/);
  });

  it("섹션마다 지시가 다르다", () => {
    expect(handoverSystem("ongoing")).toMatch(/지금 어떤 상태인지/);
    expect(handoverSystem("delayed")).toMatch(/경위/);
  });

  it("사유를 추측하지 말라고 지시한다", () => {
    expect(handoverSystem("delayed")).toMatch(/기록되지 않은 지연 사유를 추측하지 않습니다/);
  });

  it("기관 평가를 금지한다", () => {
    // "A기관 대응이 느림" 같은 문장이 문서로 남으면 곤란해진다
    for (const section of ["ongoing", "awaiting", "delayed"] as const) {
      expect(handoverSystem(section)).toMatch(/평가하거나 탓하는 표현을 쓰지 않습니다/);
    }
  });
});

describe("응답 검증", () => {
  it("정상 응답을 받아들인다", () => {
    expect(validateHandoverOutput({ lines: [{ id: "t1", line: "문장." }] })).toEqual([{ id: "t1", line: "문장." }]);
  });

  it("망가진 항목만 버린다", () => {
    const parsed = validateHandoverOutput({ lines: [{ id: "t1", line: "정상" }, { line: "id 없음" }, 7] });
    expect(parsed).toEqual([{ id: "t1", line: "정상" }]);
  });

  it("모양이 다르면 null", () => {
    expect(validateHandoverOutput({ 결과: [] })).toBeNull();
    expect(validateHandoverOutput("문자열")).toBeNull();
  });
});

describe("조립", () => {
  const facts = selectHandover(TASKS, EVENTS, TODAY);

  it("입력 개수와 출력 개수가 같다", () => {
    expect(bindSection(facts.ongoing, [])).toHaveLength(facts.ongoing.length);
  });

  it("모델이 지어낸 id는 버린다", () => {
    const bound = bindSection(facts.ongoing, [{ id: "없는id", line: "없는 얘기" }]);
    expect(bound.every((entry) => !entry.fromLlm)).toBe(true);
    expect(bound.map((entry) => entry.line).join()).not.toMatch(/없는 얘기/);
  });

  it("모델이 빠뜨린 항목은 규칙 문장으로 채운다", () => {
    const bound = bindSection(facts.ongoing, [{ id: "t1", line: "모델 문장." }]);
    expect(bound[0]).toMatchObject({ line: "모델 문장.", fromLlm: true });
    expect(bound[1].fromLlm).toBe(false);
  });

  it("규칙 문장은 사실만 이어 붙인다", () => {
    const line = fallbackLine(facts.delayed.find((item) => item.id === "t1")!);
    expect(line).toMatch(/지엠티/);
    expect(line).toMatch(/2회 연기/);
  });
});

describe("generateHandover", () => {
  it("섹션마다 한 번씩 호출한다", async () => {
    const sections: string[] = [];
    const call = async (prompt: string) => {
      sections.push(prompt.match(/\[(.+?)\]/)?.[1] ?? "");
      return JSON.stringify({ lines: [{ id: "t1", line: "모델 문장." }] });
    };
    const handover = await generateHandover(TASKS, EVENTS, TODAY, call);
    expect(sections).toEqual(["진행 중 과업", "미결 요청", "지연 이력"]);
    expect(handover.notes).toEqual([]);
  });

  it("기관별 접촉 이력은 모델을 태우지 않는다", async () => {
    // 숫자와 날짜뿐이라 문장화할 이유가 없다
    let calls = 0;
    await generateHandover(TASKS, EVENTS, TODAY, async () => {
      calls += 1;
      return JSON.stringify({ lines: [] });
    });
    expect(calls).toBe(3);
  });

  it("한 섹션이 실패해도 문서는 나온다", async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      if (calls === 2) throw new Error("타임아웃");
      return JSON.stringify({ lines: [{ id: "t1", line: "모델 문장." }] });
    };
    const handover = await generateHandover(TASKS, EVENTS, TODAY, call);
    expect(handover.sections.awaiting).toHaveLength(1);
    expect(handover.notes.join()).toMatch(/미결 요청/);
  });

  it("모델 없이도 문서는 나온다", async () => {
    const handover = await generateHandover(TASKS, EVENTS, TODAY, null);
    expect(handover.sections.ongoing).toHaveLength(2);
    expect(handover.byOrg).toHaveLength(11);
  });
});

describe("내보내기 텍스트", () => {
  it("정해진 순서로 나온다", async () => {
    const handover = await generateHandover(TASKS, EVENTS, TODAY, null);
    const text = renderHandoverText(handover);
    expect(text.indexOf("진행 중 과업")).toBeLessThan(text.indexOf("미결 요청"));
    expect(text.indexOf("미결 요청")).toBeLessThan(text.indexOf("지연 이력"));
    expect(text.indexOf("지연 이력")).toBeLessThan(text.indexOf("기관별 접촉 이력"));
  });

  it("기관별로 묶어 적는다", async () => {
    const handover = await generateHandover(TASKS, EVENTS, TODAY, null);
    expect(renderHandoverText(handover)).toMatch(/\[지엠티\]/);
  });

  it("기관 11개를 표로 전부 적는다", async () => {
    const handover = await generateHandover(TASKS, EVENTS, TODAY, null);
    const text = renderHandoverText(handover);
    expect(text).toMatch(/써로마인드 \/ 0건/);
    expect(text).toMatch(/KIMST \/ 1건 \/ 0건 \/ 기록 없음/);
  });
});
