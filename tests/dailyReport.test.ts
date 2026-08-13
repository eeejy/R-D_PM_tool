import { describe, expect, it } from "vitest";
import {
  assembleReport,
  audienceOf,
  buildReportInput,
  fallbackLine,
  generateDailyReport,
  isReportable,
  renderReportText,
  selectReportItems,
  splitByAudience,
  validateReportOutput,
} from "../lib/dailyReport";
import { score, type MyTask } from "../lib/mytask";

const TODAY = "2026-08-13";

const base: MyTask = {
  id: "t", title: "기본 업무", categoryId: "etc", org: "A기관",
  due: "", dueNote: "", status: "확인 필요", note: "", createdAt: TODAY,
};

const scored = (task: Partial<MyTask>) => score({ ...base, ...task }, TODAY);

describe("보고 대상 선별 — 룰", () => {
  it("기한이 지난 업무는 보고한다", () => {
    expect(isReportable(scored({ due: "2026-08-10" }))).toBe(true);
  });

  it("오늘·내일 마감은 보고한다", () => {
    expect(isReportable(scored({ due: TODAY }))).toBe(true);
    expect(isReportable(scored({ due: "2026-08-14" }))).toBe(true);
  });

  it("2회 이상 미뤄진 항목은 보고한다", () => {
    expect(isReportable(scored({ due: "2026-09-30", deferred: 2 }))).toBe(true);
  });

  it("외부기관 회신 대기는 보고한다", () => {
    expect(isReportable(scored({ awaiting: true }))).toBe(true);
  });

  it("다음 회의 전 확정 필요는 보고한다", () => {
    expect(isReportable(scored({ beforeMeeting: true }))).toBe(true);
  });

  it("한가한 일반 업무는 올리지 않는다", () => {
    expect(isReportable(scored({ due: "2026-09-30" }))).toBe(false);
  });

  it("완료한 업무는 선별에서 빠진다", () => {
    const tasks: MyTask[] = [{ ...base, id: "done", due: TODAY, status: "완료" }];
    expect(selectReportItems(tasks, TODAY)).toHaveLength(0);
  });

  it("점수가 높은 것부터 나온다", () => {
    const tasks: MyTask[] = [
      { ...base, id: "soon", due: "2026-08-14" },
      { ...base, id: "over", due: "2026-08-01" },
    ];
    expect(selectReportItems(tasks, TODAY).map((item) => item.id)).toEqual(["over", "soon"]);
  });

  it("왜 보고 대상인지 근거를 함께 담는다", () => {
    const [item] = selectReportItems([{ ...base, id: "over", due: "2026-08-10" }], TODAY);
    expect(item.reason).toMatch(/초과/);
  });
});

describe("보고 대상 분류 — 룰", () => {
  it("예산·마일스톤·보고자료는 상부 구두보고", () => {
    expect(audienceOf(scored({ categoryId: "budget", due: TODAY }))).toBe("supervisor");
    expect(audienceOf(scored({ categoryId: "milestone", due: TODAY }))).toBe("supervisor");
    expect(audienceOf(scored({ categoryId: "report", due: TODAY }))).toBe("supervisor");
  });

  it("데이터·진도관리·실증은 연구책임자 전달", () => {
    expect(audienceOf(scored({ categoryId: "data", due: TODAY }))).toBe("pi");
    expect(audienceOf(scored({ categoryId: "progress", due: TODAY }))).toBe("pi");
    expect(audienceOf(scored({ categoryId: "pilot", due: TODAY }))).toBe("pi");
  });

  it("지연 과업에 직접 영향을 주면 양쪽 모두", () => {
    expect(audienceOf(scored({ categoryId: "data", due: TODAY, blocksRnd: true }))).toBe("both");
  });

  it("기한을 넘긴 예산 건도 양쪽 모두 — 한쪽만 알아서는 안 된다", () => {
    expect(audienceOf(scored({ categoryId: "budget", due: "2026-08-01" }))).toBe("both");
  });

  it("양쪽 대상은 두 목록에 모두 들어간다", () => {
    const items = selectReportItems([{ ...base, id: "block", due: TODAY, blocksRnd: true }], TODAY);
    const split = splitByAudience(items);
    expect(split.supervisor.map((item) => item.id)).toEqual(["block"]);
    expect(split.pi.map((item) => item.id)).toEqual(["block"]);
  });
});

describe("LLM 입력", () => {
  it("점수 같은 내부 값은 모델에 넘기지 않는다", () => {
    const items = selectReportItems([{ ...base, id: "a", due: TODAY }], TODAY);
    const input = buildReportInput(items, TODAY);
    expect(input.today).toBe(TODAY);
    expect(Object.keys(input.items[0]).sort()).toEqual(
      ["audience", "category", "due", "id", "org", "reason", "status", "text"],
    );
  });
});

describe("응답 검증", () => {
  it("정상 응답을 받아들인다", () => {
    const parsed = validateReportOutput({ toSupervisor: [{ id: "a", line: "보고합니다." }], toPI: [] });
    expect(parsed).toEqual({ toSupervisor: [{ id: "a", line: "보고합니다." }], toPI: [] });
  });

  it("toPi처럼 키가 흔들려도 받아준다", () => {
    expect(validateReportOutput({ toPi: [{ id: "a", line: "확인하겠습니다." }] })?.toPI).toHaveLength(1);
  });

  it("배열 안의 망가진 항목만 버린다", () => {
    const parsed = validateReportOutput({ toSupervisor: [{ id: "a", line: "정상" }, { line: "id 없음" }, 3], toPI: [] });
    expect(parsed?.toSupervisor).toEqual([{ id: "a", line: "정상" }]);
  });

  it("여러 줄로 온 문장은 한 줄로 합친다", () => {
    const parsed = validateReportOutput({ toSupervisor: [{ id: "a", line: "앞줄\n뒷줄" }] });
    expect(parsed?.toSupervisor[0].line).toBe("앞줄 뒷줄");
  });

  it("모양이 아예 다르면 null — 호출부가 규칙 결과로 떨어진다", () => {
    expect(validateReportOutput({ 결과: "없음" })).toBeNull();
    expect(validateReportOutput("문자열")).toBeNull();
    expect(validateReportOutput(null)).toBeNull();
  });
});

describe("결과 조립", () => {
  const tasks: MyTask[] = [
    { ...base, id: "a", categoryId: "budget", due: TODAY, title: "예산 설명자료" },
    { ...base, id: "b", categoryId: "data", due: "2026-08-14", title: "데이터 3종" },
  ];
  const items = selectReportItems(tasks, TODAY);

  it("입력 개수와 출력 개수가 같다", () => {
    const report = assembleReport(items, TODAY, { toSupervisor: [], toPI: [] });
    expect(report.toSupervisor).toHaveLength(1);
    expect(report.toPI).toHaveLength(1);
  });

  it("모델이 빠뜨린 항목은 규칙 문장으로 채운다", () => {
    const report = assembleReport(items, TODAY, { toSupervisor: [{ id: "a", line: "모델 문장." }], toPI: [] });
    expect(report.toSupervisor[0]).toMatchObject({ line: "모델 문장.", fromLlm: true });
    expect(report.toPI[0].fromLlm).toBe(false);
  });

  it("입력에 없는 id는 버린다 — 지어낸 항목이 화면에 뜨지 않는다", () => {
    const report = assembleReport(items, TODAY, { toSupervisor: [{ id: "지어낸id", line: "없는 얘기" }], toPI: [] });
    expect(renderReportText(report)).not.toMatch(/없는 얘기/);
    expect(report.toSupervisor).toHaveLength(1);
  });

  it("각 항목이 근거 업무를 그대로 들고 있다", () => {
    const report = assembleReport(items, TODAY, null);
    expect(report.toSupervisor[0].item.id).toBe("a");
    expect(report.toSupervisor[0].item.reason).toBeTruthy();
  });

  it("규칙 문장은 원본 사실만으로 만든다", () => {
    const line = fallbackLine(items[1]);
    expect(line).toMatch(/A기관/);
    expect(line).toMatch(/8월 14일/);
  });
});

describe("generateDailyReport", () => {
  const tasks: MyTask[] = [{ ...base, id: "a", categoryId: "data", due: TODAY, title: "데이터 3종" }];

  it("모델 문장을 받아 넣는다", async () => {
    const call = async () => JSON.stringify({ toSupervisor: [], toPI: [{ id: "a", line: "A기관 데이터 3종을 재확인하겠습니다." }] });
    const report = await generateDailyReport(tasks, TODAY, call);
    expect(report.toPI[0].line).toBe("A기관 데이터 3종을 재확인하겠습니다.");
    expect(report.note).toBeUndefined();
  });

  it("모델이 이상한 답을 줘도 보고서는 나온다", async () => {
    const call = async () => "죄송합니다. 도와드릴 수 없습니다.";
    const report = await generateDailyReport(tasks, TODAY, call);
    expect(report.toPI).toHaveLength(1);
    expect(report.toPI[0].fromLlm).toBe(false);
    expect(report.note).toBeTruthy();
  });

  it("모델이 죽어도 보고서는 나온다", async () => {
    const call = async () => { throw new Error("연결 실패"); };
    const report = await generateDailyReport(tasks, TODAY, call);
    expect(report.toPI).toHaveLength(1);
    expect(report.note).toMatch(/연결 실패/);
  });

  it("모델 없이도 동작한다", async () => {
    const report = await generateDailyReport(tasks, TODAY, null);
    expect(report.toPI).toHaveLength(1);
  });

  it("보고할 게 없으면 빈 보고서", async () => {
    const report = await generateDailyReport([{ ...base, id: "z", due: "2026-12-31" }], TODAY, null);
    expect(report.toSupervisor).toHaveLength(0);
    expect(report.toPI).toHaveLength(0);
  });
});
