import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWbsBuffer } from "../lib/parseFile";
import { summarize } from "../lib/wbsStatus";

/**
 * 진짜 엑셀을 읽어 현재 상태 요약까지 통째로 돌린다.
 * 단위 테스트는 통과하는데 실제 파일에서 깨지는 일(헤더 오프셋, 다중 시트)을 여기서 잡는다.
 */
const TODAY = "2026-08-13";
const file = parseWbsBuffer(
  readFileSync(resolve(__dirname, "../public/samples/WBS_20260812.xlsx")),
  "WBS_20260812.xlsx",
);
const status = summarize(file.tasks, TODAY, file.reported);

describe("파일 읽기", () => {
  it("기관별 탭을 모두 찾아 합친다", () => {
    expect(file.sheets.filter((sheet) => sheet.rows).map((sheet) => sheet.name))
      .toEqual(["가온연구원", "한들소프트"]);
    expect(file.tasks).toHaveLength(14);
  });

  it("총괄·코드매핑 탭은 과업으로 읽지 않는다", () => {
    expect(file.reported).toHaveLength(2);
    expect(file.sheets.find((sheet) => sheet.name === "총괄")?.rows).toBe(0);
  });
});

describe("현재 상태 요약", () => {
  it("상위 집계 항목은 목록에 넣지 않는다", () => {
    expect(status.leaves).toBe(10);
    expect(status.total).toBe(14);
  });

  it("종료일이 지난 미완료 과업을 지연으로 뽑는다", () => {
    expect(status.delayed.map((item) => item.title)).toContain("통합 모델 2차 학습");
  });

  it("지연 항목은 계획 대비 미달 폭이 큰 순으로 온다", () => {
    const variances = status.delayed.map((item) => item.variance ?? 0);
    expect([...variances].sort((a, b) => a - b)).toEqual(variances);
  });

  it("같은 과업이 지연과 주의에 동시에 들어가지 않는다", () => {
    const delayed = new Set(status.delayed.map((item) => item.code));
    expect(status.watch.every((item) => !delayed.has(item.code))).toBe(true);
  });

  it("완료 과업을 따로 모은다", () => {
    expect(status.completed.every((item) => item.progress >= 100)).toBe(true);
    expect(status.completed.map((item) => item.title)).toContain("데이터 정합성 검증");
  });

  it("기관별 집계는 총괄 시트 값을 쓴다", () => {
    expect(status.institutions.map((org) => org.name).sort()).toEqual(["가온연구원", "한들소프트"]);
    expect(status.institutions.every((org) => org.basis === "계층 자동집계")).toBe(true);
  });

  it("담당자가 확인할 사항을 뽑는다", () => {
    expect(status.checks.length).toBeGreaterThan(0);
    expect(status.checks.every((check) => check.count > 0)).toBe(true);
  });

  it("전체 진척과 계획을 함께 낸다", () => {
    expect(status.overall.progress).toBeGreaterThan(0);
    expect(status.overall.planned).toBeGreaterThan(0);
  });
});
