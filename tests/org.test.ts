import { describe, expect, it } from "vitest";
import {
  ETC,
  isOrgId,
  matchOrg,
  normalizeOrg,
  ORGS,
  ORG_IDS,
  orgName,
  orgRole,
  replyDaysOf,
  WBS_ORGS,
} from "../lib/org";
import { capture } from "../lib/capture";

const TODAY = "2026-08-13";

describe("기관 마스터", () => {
  it("11개에서 늘어나지 않는다", () => {
    // 업무 분류 8개를 고정한 것과 같은 이유다. 늘어나기 시작하면 집계가 무너진다.
    expect(ORGS).toHaveLength(11);
    expect(new Set(ORG_IDS).size).toBe(11);
  });

  it("역할이 실제 사업 구조와 맞다", () => {
    expect(orgRole("gmt")).toBe("주관");
    expect(orgRole("kimst")).toBe("전문");
    expect(ORGS.filter((org) => org.role === "주관")).toHaveLength(1);
    expect(ORGS.filter((org) => org.role === "공동")).toHaveLength(8);
  });

  it("WBS 시트가 있는 9개 기관을 따로 센다", () => {
    // KIMST와 기타는 WBS에 시트가 없어 진척 집계 대상이 아니다
    expect(WBS_ORGS).toHaveLength(9);
    expect(WBS_ORGS.map((org) => org.name)).toEqual(
      ["지엠티", "유원GIS", "세명소프트", "그린블루", "엑셈", "MIT", "동국대", "T3Q", "써로마인드"],
    );
  });

  it("회신 임계일이 역할에 따라 다르다", () => {
    // 주관은 짧게, 전문기관은 길게 — 실제 회신 관행이 다르다
    expect(replyDaysOf("gmt")).toBeLessThan(replyDaysOf("kimst"));
    expect(replyDaysOf(undefined)).toBe(ETC.replyDays);
  });

  it("id로 표기명을 찾는다", () => {
    expect(orgName("uwon")).toBe("유원GIS");
    expect(orgName(undefined)).toBe("기타 / 미분류");
  });

  it("저장된 값이 기관 id인지 가린다", () => {
    expect(isOrgId("gmt")).toBe(true);
    expect(isOrgId("없는기관")).toBe(false);
    expect(isOrgId(null)).toBe(false);
  });
});

describe("표기 정규화", () => {
  it("법인 표기와 공백을 걷어낸다", () => {
    expect(normalizeOrg("㈜ 지엠티")).toBe(normalizeOrg("지엠티"));
    expect(normalizeOrg("지엠티(주)")).toBe(normalizeOrg("지엠티"));
    expect(normalizeOrg("주식회사 엑셈")).toBe(normalizeOrg("엑셈"));
  });
});

describe("기관 매칭", () => {
  it("정규 표기명을 찾는다", () => {
    for (const org of ORGS.filter((item) => item.id !== "etc")) {
      expect(matchOrg(`${org.name}에 자료 요청`).org.id).toBe(org.id);
    }
  });

  it("표기가 달라도 같은 기관으로 본다", () => {
    // 이게 이 기능의 존재 이유다 — 표기가 갈리면 기관별 집계가 조용히 무너진다
    for (const text of ["㈜지엠티 회신 대기", "지엠티(주)에 요청", "GMT 자료 확인", "지엠티 데이터"]) {
      expect(matchOrg(text).org.id).toBe("gmt");
    }
  });

  it("KIMST는 한글 정식명칭으로도 걸린다", () => {
    expect(matchOrg("해양수산과학기술진흥원 제출자료").org.id).toBe("kimst");
    expect(matchOrg("진흥원 회신 확인").org.id).toBe("kimst");
  });

  it("동국대는 약칭·정식명칭 모두 걸린다", () => {
    expect(matchOrg("동국대 산학협력단 협의").org.id).toBe("dongguk");
    expect(matchOrg("동국대학교 자료").org.id).toBe("dongguk");
  });

  it("영문 약칭이 평범한 단어에 걸리지 않는다", () => {
    // MIT를 부분일치로 잡으면 submit·limit에 걸려 엉뚱한 기관이 붙는다
    expect(matchOrg("submit 자료 확인").org.id).toBe("etc");
    expect(matchOrg("rate limit 확인").org.id).toBe("etc");
    expect(matchOrg("MIT 진척 확인").org.id).toBe("mit");
    expect(matchOrg("(MIT) 자료").org.id).toBe("mit");
  });

  it("후보가 둘이면 고르지 않고 기타로 보낸다", () => {
    // 반반 확률로 찍는 것보다 사람이 고치게 하는 편이 낫다
    const result = matchOrg("지엠티와 엑셈 합동 점검");
    expect(result.org.id).toBe("etc");
    expect(result.candidates.map((org) => org.id).sort()).toEqual(["exem", "gmt"]);
  });

  it("못 찾으면 기타로 보낸다", () => {
    expect(matchOrg("어디에도 없는 회사 자료").org.id).toBe("etc");
    expect(matchOrg("").org.id).toBe("etc");
    expect(matchOrg("어디에도 없는 회사").candidates).toEqual([]);
  });
});

describe("빠른 입력 연결", () => {
  it("등록할 때 기관 id가 함께 붙는다", () => {
    const draft = capture("㈜지엠티 데이터 3종 금요일까지 재확인", TODAY);
    expect(draft.orgId).toBe("gmt");
  });

  it("표기를 정규 표기명으로 바꿔 저장한다", () => {
    expect(capture("지엠티(주)에 자료 요청", TODAY).org).toBe("지엠티");
    expect(capture("GMT 진척 확인", TODAY).org).toBe("지엠티");
  });

  it("마스터에 없는 기관은 원문 표기를 남기되 기타로 모은다", () => {
    // 여기 쌓이는 항목이 alias 보강 신호가 된다
    const draft = capture("A기관에 데이터 요청", TODAY);
    expect(draft.orgId).toBe("etc");
    expect(draft.org).toBe("A기관");
  });

  it("KIMST 건도 그대로 잡힌다", () => {
    const draft = capture("KIMST 제출자료 다음 주까지 작성", TODAY);
    expect(draft.orgId).toBe("kimst");
    expect(draft.org).toBe("KIMST");
  });
});
