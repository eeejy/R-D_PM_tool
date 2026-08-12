import { describe, expect, it } from "vitest";
import { mapHeaders, toTasks } from "../lib/wbs";
import type { WbsTask } from "../lib/types";

const task = (over: Partial<WbsTask>): WbsTask => ({
  code: "", title: "", owner: "", assignee: "", start: "", end: "",
  planned: null, progress: null, weight: null, status: "", predecessors: [],
  deliverable: "", milestone: false, depth: 1, isLeaf: true, sheet: "", row: 1, ...over,
});

describe("mapHeaders", () => {
  it("기관마다 다른 헤더 이름을 표준 필드로 잇는다", () => {
    const map = mapHeaders(["WBS코드", "세부과업", "수행기관", "시작일", "종료일", "진척률", "비고"]);
    expect(map).toMatchObject({ code: "WBS코드", title: "세부과업", owner: "수행기관", start: "시작일", end: "종료일", progress: "진척률" });
  });

  it("영문 헤더도 받는다", () => {
    const map = mapHeaders(["No", "Task", "Owner", "Start", "End", "Progress"]);
    expect(map.title).toBe("Task");
    expect(map.end).toBe("End");
  });

  it("한 헤더를 두 필드가 가져가지 않는다", () => {
    const map = mapHeaders(["완료일", "완료율"]);
    expect(map.end).not.toBe(map.progress);
  });
});

describe("toTasks", () => {
  it("엑셀 serial과 백분율 서식을 정규화한다", () => {
    const tasks = toTasks([{ "과업명": "데이터 정합성 검증", "수행기관": "A기관", "종료일": 46242, "진행률": 0.8 }]);
    expect(tasks[0].end).toBe("2026-08-08");
    expect(tasks[0].progress).toBe(80);
  });

  it("과업명이 빈 행은 버린다", () => {
    expect(toTasks([{ "과업명": "", "진행률": 50 }, { "과업명": "실증 준비", "진행률": 10 }])).toHaveLength(1);
  });
});

describe("실제 기관 WBS에서 나온 문제들", () => {
  it("자정에서 몇 초 어긋난 엑셀 날짜를 하루 밀리지 않게 반올림한다", () => {
    // SheetJS가 2026-01-01을 로컬 2025-12-31 23:59:08로 돌려주는 일이 잦다.
    // 잘라내면 연도까지 바뀐다.
    const tasks = toTasks([{
      "과업명": "과제 수행 진척관리",
      "시작일": new Date(2025, 11, 31, 23, 59, 8),
      "종료일": new Date(2026, 11, 30, 23, 59, 8),
    }]);
    expect(tasks[0].start).toBe("2026-01-01");
    expect(tasks[0].end).toBe("2026-12-31");
  });

  it("계획(%)과 진척(%)을 서로 다른 필드로 읽는다", () => {
    const map = mapHeaders(["WBS코드", "담당 과제(세부 연구개발)", "계획(%)", "진척(%)", "차이(%P)"]);
    expect(map.planned).toBe("계획(%)");
    expect(map.progress).toBe("진척(%)");
    expect(map.planned).not.toBe(map.progress);
  });

  it("'담당 과제(세부 연구개발)'을 과업명으로 읽는다", () => {
    // 실제 기관 WBS는 '과업'이 아니라 '과제'를 쓴다
    expect(mapHeaders(["WBS코드", "담당 과제(세부 연구개발)", "종료일"]).title).toBe("담당 과제(세부 연구개발)");
  });

  it("선·후행 칸의 '선'/'후' 표시는 코드로 오인하지 않는다", () => {
    const tasks = toTasks([
      { "과업명": "데이터 수집", "선·후행": "선" },
      { "과업명": "LLM 학습", "선·후행": "T4.1.1.1" },
    ]);
    expect(tasks[0].predecessors).toEqual([]);
    expect(tasks[1].predecessors).toEqual(["T4.1.1.1"]);
  });

  it("하위 코드가 있는 행은 상위 집계 항목으로 표시한다", () => {
    const tasks = toTasks([
      { "과업명": "상위", "WBS코드": "1" },
      { "과업명": "중간", "WBS코드": "1.1" },
      { "과업명": "말단", "WBS코드": "1.1.1" },
    ]);
    expect(tasks.map((task) => task.isLeaf)).toEqual([false, false, true]);
    expect(tasks.map((task) => task.depth)).toEqual([1, 2, 3]);
  });
});
