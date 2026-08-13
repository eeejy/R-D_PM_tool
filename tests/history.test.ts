import { describe, expect, it } from "vitest";
import {
  businessDaysBetween,
  deriveAll,
  deriveSignals,
  event,
  eventsOf,
  isBusinessDay,
  needsReminder,
  reminderStageOf,
  type TaskEvent,
} from "../lib/history";
import { score, type MyTask } from "../lib/mytask";

const TODAY = "2026-08-13"; // 목요일

const base: MyTask = {
  id: "t1", title: "데이터 재확인", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "", dueNote: "", status: "확인 필요", note: "", createdAt: TODAY,
};

describe("영업일 계산", () => {
  // 임계일 판정이 전부 여기 걸려 있다. 주말 처리는 조용히 틀리기 쉽다.
  it("주말은 영업일이 아니다", () => {
    expect(isBusinessDay("2026-08-13")).toBe(true);  // 목
    expect(isBusinessDay("2026-08-08")).toBe(false); // 토
    expect(isBusinessDay("2026-08-09")).toBe(false); // 일
  });

  it("보낸 날 당일은 세지 않는다", () => {
    // 아침에 보낸 요청을 그날 오후에 "1일 지났다"고 재촉할 수는 없다
    expect(businessDaysBetween(TODAY, TODAY)).toBe(0);
  });

  it("주말을 건너뛴다", () => {
    // 금요일에 보내고 다음 월요일이면 1영업일이다
    expect(businessDaysBetween("2026-08-07", "2026-08-10")).toBe(1);
    expect(businessDaysBetween("2026-08-07", "2026-08-14")).toBe(5);
  });

  it("연속된 평일을 그대로 센다", () => {
    expect(businessDaysBetween("2026-08-10", "2026-08-13")).toBe(3);
  });

  it("공휴일을 넘겨주면 빼고 센다", () => {
    // 음력 명절처럼 해마다 바뀌는 날짜를 코드에 박지 않고 호출부가 넘긴다
    const holidays = new Set(["2026-08-12"]);
    expect(businessDaysBetween("2026-08-10", "2026-08-13", holidays)).toBe(2);
  });

  it("과거로 거슬러 가면 0", () => {
    expect(businessDaysBetween("2026-08-13", "2026-08-10")).toBe(0);
  });
});

describe("이벤트 정렬", () => {
  it("해당 업무 것만 시간순으로 모은다", () => {
    const events: TaskEvent[] = [
      event("t2", "created", "2026-08-01"),
      event("t1", "sent", "2026-08-10"),
      event("t1", "created", "2026-08-01"),
    ];
    expect(eventsOf(events, "t1").map((item) => item.type)).toEqual(["created", "sent"]);
  });

  it("같은 날짜는 기록된 순서를 지킨다", () => {
    const events: TaskEvent[] = [
      event("t1", "status_changed", TODAY, { to: "완료" }),
      event("t1", "closed", TODAY),
    ];
    expect(eventsOf(events, "t1").map((item) => item.type)).toEqual(["status_changed", "closed"]);
  });
});

describe("파생 지표", () => {
  it("이벤트가 없으면 빈 지표", () => {
    const signals = deriveSignals([], "t1", TODAY);
    expect(signals.postponeCount).toBe(0);
    expect(signals.daysSinceContact).toBeNull();
    expect(signals.awaitingReply).toBe(false);
  });

  it("기한이 뒤로 밀린 횟수만 센다", () => {
    // 당겨진 건 연기가 아니다
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-07-31" }),
      event("t1", "due_changed", "2026-07-29", { from: "2026-07-31", to: "2026-09-30" }),
      event("t1", "due_changed", "2026-08-01", { from: "2026-09-30", to: "2026-09-20" }),
    ];
    expect(deriveSignals(events, "t1", TODAY).postponeCount).toBe(2);
  });

  it("당초 기한과 누적 지연일을 계산한다", () => {
    // "당초 6월 → 현재 9월"을 말할 수 있어야 인수인계가 된다
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-09-30" }),
    ];
    const signals = deriveSignals(events, "t1", TODAY);
    expect(signals.originalDue).toBe("2026-06-30");
    expect(signals.currentDue).toBe("2026-09-30");
    expect(signals.totalSlipDays).toBe(92);
  });

  it("등록 시 기한이 없었으면 첫 변경 값을 당초 기한으로 본다", () => {
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01"),
      event("t1", "due_changed", "2026-06-10", { to: "2026-07-01" }),
    ];
    expect(deriveSignals(events, "t1", TODAY).originalDue).toBe("2026-07-01");
  });

  it("기록된 연기 사유만 모은다 — 없는 사유를 지어내지 않는다", () => {
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-07-31", note: "기관 회신 지연" }),
      event("t1", "due_changed", "2026-07-29", { from: "2026-07-31", to: "2026-08-31" }),
    ];
    expect(deriveSignals(events, "t1", TODAY).postponeNotes).toEqual(["기관 회신 지연"]);
  });

  it("요청 후 회신이 없으면 대기로 본다", () => {
    const events: TaskEvent[] = [event("t1", "sent", "2026-08-07")];
    const signals = deriveSignals(events, "t1", TODAY);
    expect(signals.awaitingReply).toBe(true);
    expect(signals.daysSinceContact).toBe(4); // 금 → 목, 주말 제외
  });

  it("회신이 오면 대기가 풀린다", () => {
    const events: TaskEvent[] = [
      event("t1", "sent", "2026-08-07"),
      event("t1", "replied", "2026-08-11"),
    ];
    const signals = deriveSignals(events, "t1", TODAY);
    expect(signals.awaitingReply).toBe(false);
    expect(signals.lastContact).toBe("2026-08-11");
  });

  it("회신 후 다시 요청하면 또 대기가 된다", () => {
    const events: TaskEvent[] = [
      event("t1", "sent", "2026-08-03"),
      event("t1", "replied", "2026-08-05"),
      event("t1", "sent", "2026-08-10"),
    ];
    expect(deriveSignals(events, "t1", TODAY).awaitingReply).toBe(true);
  });

  it("재촉도 접촉으로 세고 단계를 올린다", () => {
    const events: TaskEvent[] = [
      event("t1", "sent", "2026-08-03"),
      event("t1", "reminded", "2026-08-12"),
    ];
    const signals = deriveSignals(events, "t1", TODAY);
    expect(signals.reminderStage).toBe(1);
    expect(signals.daysSinceContact).toBe(1); // 마지막 접촉은 재촉일
  });

  it("여러 업무를 한 번에 계산한다", () => {
    const events: TaskEvent[] = [
      event("t1", "sent", "2026-08-10"),
      event("t2", "created", "2026-08-10", { to: "2026-08-20" }),
    ];
    const all = deriveAll(events, ["t1", "t2", "t3"], TODAY);
    expect(all.get("t1")?.awaitingReply).toBe(true);
    expect(all.get("t2")?.awaitingReply).toBe(false);
    expect(all.get("t3")?.postponeCount).toBe(0);
  });
});

describe("리마인드 판정", () => {
  it("기관마다 임계일이 다르다", () => {
    // 주관 3영업일 / 전문 7영업일 — 같은 4영업일이어도 판정이 갈린다
    const signals = deriveSignals([event("t1", "sent", "2026-08-07")], "t1", TODAY);
    expect(signals.daysSinceContact).toBe(4);
    expect(needsReminder(signals, "gmt")).toBe(true);
    expect(needsReminder(signals, "kimst")).toBe(false);
  });

  it("회신이 왔으면 아무리 오래돼도 대상이 아니다", () => {
    const events: TaskEvent[] = [
      event("t1", "sent", "2026-06-01"),
      event("t1", "replied", "2026-06-02"),
    ];
    expect(needsReminder(deriveSignals(events, "t1", TODAY), "gmt")).toBe(false);
  });

  it("보낸 적이 없으면 대상이 아니다", () => {
    expect(needsReminder(deriveSignals([], "t1", TODAY), "gmt")).toBe(false);
  });

  it("재촉 단계가 올라간다 — 3차에서 멈춘다", () => {
    const stage = (count: number) =>
      reminderStageOf(deriveSignals(
        [event("t1", "sent", "2026-06-01"), ...Array.from({ length: count }, (_, i) =>
          event("t1", "reminded", `2026-06-${String(10 + i).padStart(2, "0")}`))],
        "t1", TODAY,
      ));
    expect(stage(0)).toBe(1);
    expect(stage(1)).toBe(2);
    expect(stage(2)).toBe(3);
    expect(stage(5)).toBe(3);
  });
});

describe("우선순위 점수 반영", () => {
  it("지표가 없으면 기존 점수 그대로", () => {
    // 기존 배점은 건드리지 않는다 — 이벤트가 없는 업무는 예전과 같아야 한다
    const task = { ...base, due: "2026-08-25" };
    expect(score(task, TODAY, undefined).score).toBe(score(task, TODAY).score);
  });

  it("2회 연기에 가점이 붙는다", () => {
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-07-15" }),
      event("t1", "due_changed", "2026-07-14", { from: "2026-07-15", to: "2026-08-25" }),
    ];
    const signals = deriveSignals(events, "t1", TODAY);
    const task = { ...base, due: "2026-08-25" };
    const scored = score(task, TODAY, signals);
    expect(scored.score).toBeGreaterThan(score(task, TODAY).score);
    expect(scored.reasons.join()).toMatch(/2회 연기/);
  });

  it("누적 지연이 길면 근거에 일수가 나온다", () => {
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-09-30" }),
    ];
    const scored = score({ ...base, due: "2026-09-30" }, TODAY, deriveSignals(events, "t1", TODAY));
    expect(scored.reasons.join()).toMatch(/당초 기한 대비 92일 경과/);
  });

  it("회신 대기가 임계일을 넘기면 근거에 영업일이 나온다", () => {
    const signals = deriveSignals([event("t1", "sent", "2026-08-07")], "t1", TODAY);
    const scored = score({ ...base, due: "2026-08-25" }, TODAY, signals);
    expect(scored.reasons.join()).toMatch(/회신 대기 4영업일 경과/);
  });

  it("이벤트가 있으면 연기 횟수는 이벤트 쪽을 쓴다", () => {
    // 두 곳에서 따로 세면 값이 어긋난다
    const events: TaskEvent[] = [
      event("t1", "created", "2026-06-01", { to: "2026-06-30" }),
      event("t1", "due_changed", "2026-06-28", { from: "2026-06-30", to: "2026-07-15" }),
      event("t1", "due_changed", "2026-07-14", { from: "2026-07-15", to: "2026-08-25" }),
      event("t1", "due_changed", "2026-08-01", { from: "2026-08-25", to: "2026-08-26" }),
    ];
    const scored = score(
      { ...base, due: "2026-08-26", deferred: 99 },
      TODAY,
      deriveSignals(events, "t1", TODAY),
    );
    expect(scored.reasons.join()).toMatch(/3회 미뤄짐/);
    expect(scored.reasons.join()).not.toMatch(/99회/);
  });
});
