import { describe, expect, it } from "vitest";
import {
  buildReminderPrompt,
  closingLine,
  fallbackReminderParts,
  findReminders,
  generateReminderEmail,
  markReminded,
  markReplied,
  markSent,
  reminderSubject,
  reminderSystem,
  toReminderSkeleton,
} from "../lib/reminder";
import { buildEmailSkeleton, type EmailSender } from "../lib/emailDraft";
import { deriveSignals, event, type TaskEvent } from "../lib/history";
import type { MyTask } from "../lib/mytask";

const TODAY = "2026-08-13"; // 목요일

const sender: EmailSender = {
  projectName: "CDX 연구개발사업", department: "사업총괄부", name: "홍길동", contact: "hong@example.kr",
};

const task = (over: Partial<MyTask> = {}): MyTask => ({
  id: "t1", title: "데이터 3종 제공", categoryId: "data", org: "지엠티", orgId: "gmt",
  due: "2026-08-20", dueNote: "", status: "회신 대기", note: "지엠티 데이터 3종 제공 요청",
  createdAt: "2026-07-01", ...over,
});

/** 마지막으로 보낸 날만 정해 주면 나머지는 파생된다. */
const sentOn = (at: string, extra: TaskEvent[] = []): TaskEvent[] => [
  event("t1", "created", "2026-07-01", { to: "2026-08-20", orgId: "gmt" }),
  event("t1", "sent", at, { orgId: "gmt" }),
  ...extra,
];

describe("재촉 대상 판정", () => {
  it("임계일을 넘긴 것만 고른다", () => {
    // 8월 7일(금) → 8월 13일(목)은 4영업일. 주관 임계일 3일 초과.
    expect(findReminders([task()], sentOn("2026-08-07"), TODAY)).toHaveLength(1);
    // 8월 12일(수) → 8월 13일(목)은 1영업일. 아직 아니다.
    expect(findReminders([task()], sentOn("2026-08-12"), TODAY)).toHaveLength(0);
  });

  it("기관마다 임계일이 다르다", () => {
    const events = sentOn("2026-08-07");
    expect(findReminders([task({ orgId: "gmt" })], events, TODAY)).toHaveLength(1);   // 주관 3일
    expect(findReminders([task({ orgId: "kimst" })], events, TODAY)).toHaveLength(0); // 전문 7일
  });

  it("회신이 오면 대상에서 빠진다", () => {
    const events = sentOn("2026-06-01", [event("t1", "replied", "2026-06-02", { orgId: "gmt" })]);
    expect(findReminders([task()], events, TODAY)).toHaveLength(0);
  });

  it("완료한 업무는 보지 않는다", () => {
    expect(findReminders([task({ status: "완료" })], sentOn("2026-06-01"), TODAY)).toHaveLength(0);
  });

  it("보낸 기록이 없으면 대상이 아니다", () => {
    // 아직 요청하지 않은 건을 재촉할 수는 없다
    const events = [event("t1", "created", "2026-07-01", { to: "2026-08-20", orgId: "gmt" })];
    expect(findReminders([task()], events, TODAY)).toHaveLength(0);
  });

  it("오래 기다린 것부터 나온다", () => {
    const tasks = [task({ id: "t1" }), task({ id: "t2" })];
    const events = [
      event("t1", "sent", "2026-08-06", { orgId: "gmt" }),
      event("t2", "sent", "2026-08-03", { orgId: "gmt" }),
    ];
    expect(findReminders(tasks, events, TODAY).map((item) => item.task.id)).toEqual(["t2", "t1"]);
  });

  it("판정 근거를 함께 들고 있다", () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    expect(reminder.waitingDays).toBe(4);
    expect(reminder.replyDays).toBe(3);
    expect(reminder.sentAt).toBe("2026-08-07");
  });
});

describe("단계", () => {
  it("재촉을 보낼수록 차수가 올라간다", () => {
    const stageOf = (reminded: string[]) =>
      findReminders(
        [task()],
        sentOn("2026-08-03", reminded.map((at) => event("t1", "reminded", at, { orgId: "gmt" }))),
        TODAY,
      )[0].stage;

    expect(stageOf([])).toBe(1);
    expect(stageOf(["2026-08-05"])).toBe(2);
    expect(stageOf(["2026-08-05", "2026-08-07"])).toBe(3);
    expect(stageOf(["2026-08-04", "2026-08-05", "2026-08-06"])).toBe(3); // 3차에서 멈춘다
  });

  it("차수마다 마무리 문장이 다르다", () => {
    // 같은 재촉이라도 3차와 1차의 문장이 같으면 안 된다
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const line = (stage: 1 | 2 | 3) => closingLine({ ...reminder, stage });

    expect(line(1)).toMatch(/확인 부탁드립니다/);
    expect(line(2)).toMatch(/8월 20일까지 회신 부탁드립니다/);
    expect(line(3)).toMatch(/후속 일정에 영향/);
    expect(new Set([line(1), line(2), line(3)]).size).toBe(3);
  });

  it("기한이 없으면 2차에서 날짜를 지어내지 않는다", () => {
    const [reminder] = findReminders([task({ due: "" })], sentOn("2026-08-07"), TODAY);
    expect(closingLine({ ...reminder, stage: 2 })).not.toMatch(/\d+월 \d+일까지/);
  });

  it("제목에 차수를 밝힌다", () => {
    const skeleton = buildEmailSkeleton([task()], sender, TODAY);
    expect(reminderSubject(skeleton, 2)).toMatch(/\(2차 재요청\)$/);
  });

  it("차수에 따라 지시 문구가 바뀐다", () => {
    expect(reminderSystem(1)).toMatch(/재촉하는 인상을 주지 않습니다/);
    expect(reminderSystem(3)).toMatch(/후속 일정에 영향/);
  });
});

describe("경위 주입", () => {
  it("날짜와 경과 일수는 룰이 채운다", () => {
    // 모델에게 날짜를 세게 하면 반드시 틀린다
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const skeleton = toReminderSkeleton(buildEmailSkeleton([task()], sender, TODAY), reminder);
    expect(skeleton.deadlineLine).toMatch(/8월 7일/);
    expect(skeleton.subject).toMatch(/1차 재요청/);
  });

  it("프롬프트가 모델에게 날짜를 쓰지 말라고 한다", () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    expect(buildReminderPrompt(reminder)).toMatch(/날짜와 경과 일수는 쓰지 마세요/);
  });

  it("모델에 경과 일수를 넘기지 않는다", () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    expect(buildReminderPrompt(reminder)).not.toMatch(/4영업일/);
  });
});

describe("메일 생성", () => {
  it("수신처와 근거는 원본 업무에서 온다", async () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const draft = await generateReminderEmail(reminder, sender, TODAY, null);
    expect(draft.recipients).toEqual(["지엠티"]);
    expect(draft.sourceIds).toEqual(["t1"]);
    expect(draft.body).toMatch(/8월 7일/);
  });

  it("모델 문장을 본문에 넣는다", async () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const call = async () => JSON.stringify({
      background: "앞서 요청드린 자료에 대한 회신을 기다리고 있습니다.",
      requests: ["진행 상황을 회신하여 주시기 바랍니다."],
    });
    const draft = await generateReminderEmail(reminder, sender, TODAY, call);
    expect(draft.fromLlm).toBe(true);
    expect(draft.body).toMatch(/진행 상황을 회신하여 주시기 바랍니다/);
  });

  it("모델이 실패해도 초안은 나온다", async () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const draft = await generateReminderEmail(reminder, sender, TODAY, async () => { throw new Error("연결 실패"); });
    expect(draft.body).toMatch(/요청사항/);
    expect(draft.note).toMatch(/연결 실패/);
  });

  it("규칙 문장은 상대를 탓하지 않는다", () => {
    const [reminder] = findReminders([task()], sentOn("2026-08-07"), TODAY);
    const parts = fallbackReminderParts(reminder);
    expect(`${parts.background} ${parts.requests.join(" ")}`).not.toMatch(/지연|늦|미이행|왜/);
  });
});

describe("발송 기록", () => {
  it("보냈다고 기록하면 그날은 목록에서 사라진다", () => {
    // 방금 보낸 건이 같은 날 또 뜨면 안 된다
    const events = sentOn("2026-08-07");
    const [first] = findReminders([task()], events, TODAY);
    expect(first.stage).toBe(1);
    expect(findReminders([task()], [...events, markReminded(first, TODAY)], TODAY)).toHaveLength(0);
  });

  it("임계일이 다시 지나면 다음 차수로 돌아온다", () => {
    const events = sentOn("2026-08-03");
    const [first] = findReminders([task()], events, TODAY);
    const later = findReminders(
      [task()],
      [...events, markReminded(first, "2026-08-06")],
      TODAY, // 8월 6일(목) → 8월 13일(목)은 5영업일, 임계일 3일 초과
    );
    expect(later[0].stage).toBe(2);
  });

  it("기록하지 않으면 판정이 그대로다 — 내일 또 뜬다", () => {
    // 초안을 만든 것만으로는 남기지 않는다. 실제로 보냈는지는 사람만 안다.
    const events = sentOn("2026-08-07");
    expect(findReminders([task()], events, TODAY)[0].stage).toBe(1);
    expect(findReminders([task()], events, TODAY)[0].stage).toBe(1);
  });

  it("회신 기록을 남기면 대상에서 빠진다", () => {
    const events = [...sentOn("2026-08-07"), markReplied("t1", "gmt", TODAY)];
    expect(findReminders([task()], events, TODAY)).toHaveLength(0);
  });

  it("요청 기록이 있어야 대기 판정이 시작된다", () => {
    const events = [event("t1", "created", "2026-07-01", { orgId: "gmt" }), markSent("t1", "gmt", "2026-08-03")];
    expect(deriveSignals(events, "t1", TODAY).awaitingReply).toBe(true);
    expect(findReminders([task()], events, TODAY)).toHaveLength(1);
  });
});
