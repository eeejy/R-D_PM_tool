import { describe, expect, it } from "vitest";
import {
  closeIssue,
  decisions,
  openIssues,
  reopenIssue,
  toContextIssues,
  toExtracted,
  toTrackItem,
  type TrackItem,
} from "../lib/track";
import { matchOrg } from "../lib/org";
import { dateGroundedIn } from "../lib/minutes";

const TODAY = "2026-08-13";
const SOURCE = "지엠티가 데이터 3종을 8월 20일까지 제출하기로 함. 실증 대상지는 결론 못 냄.";

const ctx = {
  segment: 2,
  source: SOURCE,
  orgOf: (text: string) => matchOrg(text).org.id,
  dateOk: (iso: string, src: string) => dateGroundedIn(iso, src),
};

describe("추출 항목 다듬기", () => {
  it("유형과 문장만 모델이 정한다", () => {
    const item = toExtracted(
      { type: "issue", text: "실증 대상지는 결론 못 냄", summary: "실증 대상지 미확정", org: "지엠티" }, ctx);
    expect(item).toMatchObject({ type: "issue", summary: "실증 대상지 미확정", orgId: "gmt", sourceSegment: 2 });
  });

  it("모르는 유형은 요청으로 둔다", () => {
    expect(toExtracted({ type: "무엇", summary: "가" }, ctx)?.type).toBe("request");
  });

  it("기관은 별칭 매칭이 정한다", () => {
    // 모델이 다른 기관을 우겨도 문장에 있는 기관을 쓴다
    const item = toExtracted({ type: "request", summary: "지엠티 데이터 제출", orgId: "kimst" }, ctx);
    expect(item?.orgId).toBe("gmt");
  });

  it("원문에 없는 날짜는 버리고 원문 표현을 남긴다", () => {
    const item = toExtracted(
      { type: "request", summary: "정리", dueDate: "2026-12-31", dueRaw: "다음 월간회의 전" }, ctx);
    expect(item?.dueDate).toBe("");
    expect(item?.dueRaw).toBe("다음 월간회의 전");
  });

  it("원문에 있는 날짜는 받는다", () => {
    expect(toExtracted({ type: "request", summary: "제출", dueDate: "2026-08-20" }, ctx)?.dueDate).toBe("2026-08-20");
  });

  it("담당은 셋 중 하나로 고정한다", () => {
    expect(toExtracted({ summary: "가", owner: "기관" }, ctx)?.owner).toBe("기관");
    expect(toExtracted({ summary: "가", owner: "아무개" }, ctx)?.owner).toBe("불명");
  });

  it("요약이 없으면 버린다", () => {
    expect(toExtracted({ type: "issue" }, ctx)).toBeNull();
    expect(toExtracted("문자열", ctx)).toBeNull();
  });
});

describe("트랙 항목", () => {
  it("쟁점은 열린 상태로 들어간다", () => {
    const item = toExtracted({ type: "issue", summary: "실증 대상지 미확정" }, ctx)!;
    const track = toTrackItem(item, "제3차 실무회의", TODAY);
    expect(track).toMatchObject({ kind: "issue", status: "open" });
    expect(track.origin).toMatch(/제3차 실무회의 안건 2/);
  });

  it("결정은 이미 확정된 것이라 닫힌 채로 들어간다", () => {
    const item = toExtracted({ type: "decision", summary: "다음 회의에서 확정" }, ctx)!;
    expect(toTrackItem(item, "회의", TODAY)).toMatchObject({ kind: "decision", status: "closed" });
  });

  it("근거 문장을 함께 저장한다 — 검토 화면이 이걸 보여준다", () => {
    const item = toExtracted({ type: "issue", text: SOURCE, summary: "요약" }, ctx)!;
    expect(toTrackItem(item, "회의", TODAY).source).toBe(SOURCE);
  });
});

describe("쟁점 트랙", () => {
  const items: TrackItem[] = [
    { id: "i1", kind: "issue", summary: "열린 쟁점", source: "", origin: "회의", at: TODAY, status: "open" },
    { id: "i2", kind: "issue", summary: "닫힌 쟁점", source: "", origin: "회의", at: TODAY, status: "closed" },
    { id: "d1", kind: "decision", summary: "결정", source: "", origin: "회의", at: TODAY, status: "closed" },
  ];

  it("미해결 쟁점만 센다", () => {
    expect(openIssues(items).map((item) => item.id)).toEqual(["i1"]);
    expect(decisions(items).map((item) => item.id)).toEqual(["d1"]);
  });

  it("닫아도 지우지 않는다 — 인수인계의 재료다", () => {
    const closed = closeIssue(items, "i1", TODAY);
    expect(closed).toHaveLength(3);
    expect(closed.find((item) => item.id === "i1")).toMatchObject({ status: "closed", closedAt: TODAY });
    expect(openIssues(closed)).toEqual([]);
  });

  it("다시 열 수 있다", () => {
    const reopened = reopenIssue(closeIssue(items, "i1", TODAY), "i1");
    expect(openIssues(reopened).map((item) => item.id)).toEqual(["i1"]);
  });

  it("보고서 컨텍스트로 넘길 때 미해결만 간다", () => {
    expect(toContextIssues(items)).toEqual([{ text: "열린 쟁점", org: undefined, at: TODAY }]);
  });
});
