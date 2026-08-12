import { describe, expect, it } from "vitest";
import { extractOwner, parseDeadline, scoreImportance, splitSentences, toTitle } from "../lib/nlp";

// 2026-08-12는 수요일
const TODAY = "2026-08-12";

describe("parseDeadline", () => {
  it("8/20 같은 축약 표기를 읽는다", () => {
    expect(parseDeadline("A기관에서 데이터 3종 8/20까지 필요", TODAY)).toBe("2026-08-20");
  });

  it("이미 지난 축약 날짜는 내년으로 넘긴다", () => {
    expect(parseDeadline("1/5까지 제출", TODAY)).toBe("2027-01-05");
  });

  it("연월일 전체 표기를 읽는다", () => {
    expect(parseDeadline("2026년 9월 3일까지 회신", TODAY)).toBe("2026-09-03");
  });

  it("다음 주 화요일을 계산한다", () => {
    expect(parseDeadline("다음 주 화요일까지 성능자료 제출", TODAY)).toBe("2026-08-18");
  });

  it("오늘이 그 요일이면 다음 주로 민다", () => {
    expect(parseDeadline("수요일까지 확인", TODAY)).toBe("2026-08-19");
  });

  it("D-7 표기를 읽는다", () => {
    expect(parseDeadline("보고서 마감 D-7", TODAY)).toBe("2026-08-19");
  });

  it("월말을 계산한다", () => {
    expect(parseDeadline("이번 달 말까지 정산자료 정리", TODAY)).toBe("2026-08-31");
  });

  it("날짜 단서가 없으면 지어내지 않는다", () => {
    expect(parseDeadline("모델 성능이 개선되었는지 확인 필요", TODAY)).toBe("");
  });
});

describe("extractOwner", () => {
  it("기관명을 찾는다", () => {
    expect(extractOwner("B기관에서 아직 자료를 안 줌")).toBe("B기관");
  });

  it("사람 이름과 직함을 찾는다", () => {
    expect(extractOwner("김연구원에게 확인 요청")).toContain("김");
  });

  it("주체가 없으면 내 업무로 둔다", () => {
    expect(extractOwner("결과보고서 초안 작성하기")).toBe("내 업무");
  });
});

describe("scoreImportance", () => {
  it("지연·평가·제출은 상", () => {
    expect(scoreImportance("B기관 자료 미제출로 평가 준비 지연")).toBe("상");
  });

  it("참고성 메모는 하", () => {
    expect(scoreImportance("나중에 참고할 아이디어 정리")).toBe("하");
  });
});

describe("splitSentences / toTitle", () => {
  it("줄바꿈과 글머리표로 문장을 자른다", () => {
    expect(splitSentences("- A기관 자료 요청\n- B기관 회신 확인")).toHaveLength(2);
  });

  it("제목에서 날짜 표현을 걷어낸다", () => {
    expect(toTitle("B기관 모델 성능자료를 다음 주 화요일까지 받기")).not.toMatch(/화요일/);
  });
});
