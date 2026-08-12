import { describe, expect, it } from "vitest";
import { bucket, score, type MyTask } from "../lib/mytask";

const TODAY = "2026-08-13";

const base: MyTask = {
  id: "t", title: "기본 업무", categoryId: "etc", org: "A기관",
  due: "", dueNote: "", status: "확인 필요", note: "", createdAt: TODAY,
};

describe("score", () => {
  it("기한이 지난 업무는 긴급", () => {
    const result = score({ ...base, due: "2026-08-10" }, TODAY);
    expect(result.urgency).toBe("긴급");
    expect(result.reasons.join()).toMatch(/3일 초과/);
  });

  it("오늘 마감은 긴급", () => {
    expect(score({ ...base, due: TODAY }, TODAY).urgency).toBe("긴급");
  });

  it("7일 내 마감은 이번 주 중요", () => {
    expect(score({ ...base, due: "2026-08-18" }, TODAY).urgency).toBe("이번 주 중요");
  });

  it("회의 전 확정이 필요하면 날짜가 없어도 올라온다", () => {
    const result = score({ ...base, dueNote: "다음 월간회의 이전", beforeMeeting: true }, TODAY);
    expect(result.urgency).toBe("이번 주 중요");
    expect(result.reasons.join()).toMatch(/회의 전/);
  });

  it("연구개발 지연에 직접 영향이면 가중된다", () => {
    const plain = score({ ...base, due: "2026-08-25" }, TODAY);
    const blocking = score({ ...base, due: "2026-08-25", blocksRnd: true }, TODAY);
    expect(blocking.score).toBeGreaterThan(plain.score);
    expect(blocking.reasons.join()).toMatch(/연구개발 지연/);
  });

  it("반복해서 미룬 업무를 표시한다", () => {
    expect(score({ ...base, deferred: 3 }, TODAY).reasons.join()).toMatch(/3회 미뤄짐/);
  });

  it("기한이 없으면 정하라고 알린다", () => {
    expect(score(base, TODAY).reasons.join()).toMatch(/기한 미정/);
  });

  it("보고·예산 대응은 가중된다", () => {
    const etc = score({ ...base, due: "2026-08-25" }, TODAY);
    const budget = score({ ...base, due: "2026-08-25", categoryId: "budget" }, TODAY);
    expect(budget.score).toBeGreaterThan(etc.score);
  });
});

describe("bucket", () => {
  const tasks: MyTask[] = [
    { ...base, id: "over", due: "2026-08-01" },
    { ...base, id: "today", due: TODAY },
    { ...base, id: "week", due: "2026-08-18" },
    { ...base, id: "month", due: "2026-09-05" },
    { ...base, id: "none" },
    { ...base, id: "meet", dueNote: "다음 회의 이전", beforeMeeting: true },
    { ...base, id: "done", due: TODAY, status: "완료" },
  ];
  const buckets = bucket(tasks, TODAY);

  it("기한이 지난 업무를 오늘로 올린다", () => {
    expect(buckets.today.map((task) => task.id).sort()).toEqual(["over", "today"]);
  });

  it("7일 이내는 이번 주로 넣는다", () => {
    expect(buckets.week.map((task) => task.id)).toContain("week");
  });

  it("회의 전 확정 건은 날짜가 없어도 이번 주로 올린다", () => {
    expect(buckets.week.map((task) => task.id)).toContain("meet");
  });

  it("한 달 이내는 이번 달로 넣는다", () => {
    expect(buckets.month.map((task) => task.id)).toEqual(["month"]);
  });

  it("기한 없는 일반 업무는 따로 모은다", () => {
    expect(buckets.undated.map((task) => task.id)).toEqual(["none"]);
  });

  it("완료한 업무는 어디에도 넣지 않는다", () => {
    const all = [...buckets.today, ...buckets.week, ...buckets.month, ...buckets.undated];
    expect(all.some((task) => task.id === "done")).toBe(false);
  });

  it("각 통 안에서 점수 순으로 정렬한다", () => {
    const scores = buckets.today.map((task) => task.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
