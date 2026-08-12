import { describe, expect, it } from "vitest";
import { charCount, readRfpFile, RfpParseError } from "../lib/rfpParse";

/** Node의 File로 업로드를 흉내낸다 — 브라우저와 같은 경로를 탄다. */
const asFile = (name: string, text: string) => new File([text], name, { type: "text/plain" });

describe("형식 판별", () => {
  it("HWP는 지원하지 않는다고 분명히 알린다", async () => {
    await expect(readRfpFile(asFile("RFP.hwp", "내용"))).rejects.toMatchObject({
      message: expect.stringContaining("한글 문서"),
      hint: expect.stringContaining("PDF"),
    });
  });

  it("지원하지 않는 확장자를 거른다", async () => {
    await expect(readRfpFile(asFile("RFP.xlsx", "내용"))).rejects.toBeInstanceOf(RfpParseError);
  });
});

describe("TXT 읽기", () => {
  it("문서 정보를 채운다", async () => {
    const doc = await readRfpFile(asFile("CDX_RFP.txt", "본 사업은 현장 실증을 포함한다."));
    expect(doc.fileName).toBe("CDX_RFP.txt");
    expect(doc.kind).toBe("txt");
    expect(doc.pageCount).toBe(1);
    expect(doc.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(charCount(doc)).toBeGreaterThan(0);
  });

  it("긴 글은 문단 경계를 지키며 쪽으로 나눈다", async () => {
    const paragraph = `${"가".repeat(600)}`;
    const doc = await readRfpFile(asFile("long.txt", Array(8).fill(paragraph).join("\n\n")));
    expect(doc.pageCount).toBeGreaterThan(1);
    // 문단 중간에서 자르지 않으므로 어느 쪽도 문단을 쪼개지 않는다
    for (const page of doc.pages) {
      expect(page.text.split("\n\n").every((part) => part.length === 600)).toBe(true);
    }
  });

  it("쪽 번호는 1부터 이어진다", async () => {
    const doc = await readRfpFile(asFile("long.txt", Array(6).fill("나".repeat(700)).join("\n\n")));
    expect(doc.pages.map((page) => page.pageNumber)).toEqual(
      Array.from({ length: doc.pageCount }, (_, index) => index + 1),
    );
  });

  it("글자가 없으면 스캔 PDF 가능성을 알린다", async () => {
    await expect(readRfpFile(asFile("empty.txt", "   \n\n  "))).rejects.toMatchObject({
      hint: expect.stringContaining("스캔"),
    });
  });
});
