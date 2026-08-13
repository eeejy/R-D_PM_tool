import { describe, expect, it } from "vitest";
import { CATEGORIES, classify, matchItem } from "../lib/worktree";
import { capture, captureMany } from "../lib/capture";

const TODAY = "2026-08-13"; // 목요일

describe("classify", () => {
  it("데이터 요청 문장을 데이터 수급으로 보낸다", () => {
    expect(classify("A기관 데이터 3종 아직 안 왔음").id).toBe("data");
  });

  it("회의 관련 문장을 회의 운영으로 보낸다", () => {
    expect(classify("다음 월간회의 안건 정리").id).toBe("meeting");
  });

  it("예산 문장을 예산 대응으로 보낸다", () => {
    expect(classify("기재부 예산 설명자료 작성").id).toBe("budget");
  });

  it("분류가 애매하면 새 카테고리를 만들지 않고 기타로 보낸다", () => {
    expect(classify("그거 한번 봐야 함").id).toBe("etc");
  });

  it("카테고리는 8개로 고정이다", () => {
    expect(CATEGORIES).toHaveLength(8);
    expect(CATEGORIES.at(-1)?.id).toBe("etc");
  });
});

describe("matchItem", () => {
  it("카테고리 안의 기본 업무와 이어준다", () => {
    const category = classify("지연 사유 확인하고 회복 일정 요청");
    expect(matchItem(category, "지연 사유 확인하고 회복 일정 요청")).toContain("지연 사유");
  });
});

describe("capture", () => {
  it("기관·기한·분류·상태를 한 문장에서 채운다", () => {
    const draft = capture("A기관에 데이터 3종 아직 안 왔음. 금요일까지 다시 확인", TODAY);
    expect(draft.categoryId).toBe("data");
    expect(draft.org).toBe("A기관");
    expect(draft.due).toBe("2026-08-14"); // 돌아오는 금요일
    expect(draft.status).toBe("확인 필요");
  });

  it("회의 기준 기한은 날짜로 지어내지 않고 표현을 남긴다", () => {
    const draft = capture("다음 월간회의 전에 B기관 모델 성능자료 받아야 함", TODAY);
    expect(draft.categoryId).toBe("meeting");
    expect(draft.org).toBe("B기관");
    expect(draft.due).toBe("");
    expect(draft.dueNote).toBe("다음 월간회의 이전");
    expect(draft.beforeMeeting).toBe(true);
  });

  it("요청 문장은 요청 필요 상태가 된다", () => {
    expect(capture("A기관에 GPU 사용계획 이번 주까지 요청", TODAY).status).toBe("요청 필요");
  });

  it("회신을 기다리는 문장을 표시한다", () => {
    const draft = capture("C기관에서 아직 답변 없음", TODAY);
    expect(draft.awaiting).toBe(true);
  });

  it("제목에서 날짜 표현을 걷어낸다", () => {
    expect(capture("B기관 성능자료 8/20까지 받기", TODAY).title).not.toContain("8/20");
  });

  it("여러 줄을 넣으면 줄마다 한 건씩 만든다", () => {
    const drafts = captureMany("A기관 데이터 확인\nB기관 발표자료 요청\n예산 설명자료 작성", TODAY);
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.categoryId)).toEqual(["data", "meeting", "budget"]);
  });

  it("너무 짧은 줄은 업무로 만들지 않는다", () => {
    expect(captureMany("ok\n확인", TODAY)).toHaveLength(0);
  });
});

describe("공공문서 붙여넣기", () => {
  it("□·ㅇ 같은 글머리를 떼고 읽는다", () => {
    // 공고문·회의록을 그대로 붙여넣으면 글머리가 딸려 와 제목과 분류를 망친다
    const drafts = captureMany("□ 해양재난 데이터 체계 구축\nㅇ 실증 대상지 협의", "2026-08-13");
    expect(drafts[0].title.startsWith("□")).toBe(false);
    expect(drafts[0].categoryId).toBe("data");
    expect(drafts[1].title.startsWith("ㅇ")).toBe(false);
  });
});
