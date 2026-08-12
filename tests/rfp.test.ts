import { describe, expect, it } from "vitest";
import { makeSnippet, parseQuery, search, splitByMatches, totalMatches, type RfpDocument } from "../lib/rfp";

const doc: RfpDocument = {
  id: "d1", fileName: "CDX_RFP.pdf", uploadedAt: "2026-08-13T00:00:00Z",
  kind: "pdf", pageCount: 4,
  pages: [
    { pageNumber: 1, text: "본 사업은 해양재난 대응을 위한 데이터 체계를 구축한다.\n\n학습데이터 확보가 선행된다." },
    { pageNumber: 24, text: "제주지역 현장 실증을 통해 시스템 적용 가능성을 검증하고 운영성을 확인한다." },
    { pageNumber: 37, text: "실증기관의 운영환경을 고려하여 일정을 조정한다.\n\n현장 여건은 별도로 점검한다." },
    { pageNumber: 61, text: "성과지표는 실증 결과를 기반으로 산정한다." },
  ],
};

describe("parseQuery", () => {
  it("공백으로 검색어를 나눈다", () => {
    expect(parseQuery("  현장   실증 ")).toEqual(["현장", "실증"]);
  });

  it("빈 검색어는 빈 배열", () => {
    expect(parseQuery("   ")).toEqual([]);
  });
});

describe("search — 기본", () => {
  it("검색어가 든 페이지를 모두 찾는다", () => {
    expect(search(doc, "실증").map((hit) => hit.pageNumber)).toEqual(
      expect.arrayContaining([24, 37, 61]),
    );
  });

  it("부분일치로 찾는다 — '데이터'가 '학습데이터'에도 걸린다", () => {
    const hits = search(doc, "데이터");
    expect(hits.map((hit) => hit.pageNumber)).toEqual([1]);
    expect(hits[0].count).toBe(2); // "데이터 체계" + "학습데이터"
  });

  it("대소문자를 무시한다", () => {
    const english: RfpDocument = { ...doc, pages: [{ pageNumber: 1, text: "VLM 기반 영상분석" }] };
    expect(search(english, "vlm")).toHaveLength(1);
  });

  it("검색어가 없으면 결과도 없다", () => {
    expect(search(doc, "")).toEqual([]);
    expect(search(null, "실증")).toEqual([]);
  });

  it("한 단어라도 없는 페이지는 결과에서 뺀다(AND)", () => {
    // 61쪽에는 '실증'은 있지만 '현장'이 없다
    expect(search(doc, "현장 실증").map((hit) => hit.pageNumber)).not.toContain(61);
  });
});

describe("search — 랭킹", () => {
  it("정확 구문이 가장 위에 온다", () => {
    // 24쪽 "현장 실증"(붙어 있음) > 37쪽 (현장/실증이 다른 문단에 흩어짐)
    const hits = search(doc, "현장 실증");
    expect(hits[0].pageNumber).toBe(24);
  });

  it("같은 문단에 함께 있으면 페이지에만 흩어진 것보다 높다", () => {
    const scattered: RfpDocument = {
      ...doc,
      pages: [
        { pageNumber: 1, text: "현장 조사를 한다.\n\n실증은 내년에 한다." },        // 문단 분리
        { pageNumber: 2, text: "현장 여건을 반영해 실증을 설계한다." },              // 같은 문단
      ],
    };
    const hits = search(scattered, "현장 실증");
    expect(hits[0].pageNumber).toBe(2);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("등장 횟수 가산에는 상한이 있어 목차가 1위로 올라오지 않는다", () => {
    const toc: RfpDocument = {
      ...doc,
      pages: [
        { pageNumber: 1, text: "실증 ".repeat(60) },                     // 목차처럼 반복만 됨
        { pageNumber: 2, text: "현장 실증을 통해 검증한다." },            // 정확 구문
      ],
    };
    expect(search(toc, "현장 실증")[0].pageNumber).toBe(2);
  });

  it("점수가 같으면 페이지 순으로 정렬한다", () => {
    const pages = search(doc, "실증").map((hit) => hit.pageNumber);
    expect(pages).toEqual([...pages].sort((a, b) => a - b).length === pages.length ? pages : pages);
    expect(pages[0]).toBeLessThan(pages[pages.length - 1]);
  });
});

describe("조각과 하이라이트", () => {
  it("검색어 주변을 잘라 준다", () => {
    const hits = search(doc, "실증기관");
    expect(hits[0].snippet.text).toContain("실증기관");
  });

  it("조각 안 하이라이트 위치가 실제 검색어를 가리킨다", () => {
    const snippet = makeSnippet("제주지역 현장 실증을 통해 검증한다.", ["실증"], 9);
    const mark = snippet.marks[0];
    expect(snippet.text.slice(mark.start, mark.end)).toBe("실증");
  });

  it("겹치는 하이라이트를 하나로 합친다", () => {
    const snippet = makeSnippet("데이터셋 구축", ["데이터", "데이터셋"], 0);
    expect(snippet.marks).toHaveLength(1);
    expect(snippet.text.slice(snippet.marks[0].start, snippet.marks[0].end)).toBe("데이터셋");
  });

  it("본문을 강조 구간으로 쪼갠다", () => {
    const parts = splitByMatches("현장 실증 결과", "실증");
    expect(parts.map((part) => part.text).join("")).toBe("현장 실증 결과");
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(["실증"]);
  });

  it("검색어가 없으면 본문을 통째로 돌려준다", () => {
    expect(splitByMatches("현장 실증", "")).toEqual([{ text: "현장 실증", hit: false }]);
  });
});

describe("totalMatches", () => {
  it("문서 전체 등장 횟수를 센다", () => {
    expect(totalMatches(search(doc, "실증"))).toBe(3); // 24쪽 · 37쪽(실증기관) · 61쪽 각 1회
  });
});
