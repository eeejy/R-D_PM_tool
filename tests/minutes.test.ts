import { describe, expect, it } from "vitest";
import {
  actionsToDrafts,
  generateMinutes,
  MAX_MINUTES_CHARS,
  MAX_SEGMENT_CHARS,
  minutesTooLong,
  mergeMinutes,
  parseMeetingMeta,
  renderOnePager,
  splitAgenda,
  validateSegmentOutput,
  requestsToDrafts,
  dateGroundedIn,
  type Action,
} from "../lib/minutes";

const TODAY = "2026-08-13";

const MINUTES = `회의명: 제3차 CDX 실무회의
일시: 2026-08-12
참석자: 홍길동, 김철수, 이영희

1. 데이터 수급 현황
A기관은 데이터 3종 중 2종만 제공했다고 보고함.
B기관은 비식별 처리 일정이 늦어지고 있다는 입장.

2. 실증 대상지 선정
A기관은 상반기 내 확정을 요청.
B기관은 데이터 확보 이후 검토가 필요하다는 입장.
다음 월간회의에서 확정하기로 함.

3. 차년도 예산
증액 요구안을 이달 말까지 정리하기로 함.`;

describe("안건 분할 — 룰", () => {
  it("번호 매긴 안건으로 나눈다", () => {
    const segments = splitAgenda(MINUTES);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments.map((segment) => segment.heading)).toContain("2. 실증 대상지 선정");
  });

  it("세그먼트 번호는 1부터 연속으로 붙는다", () => {
    const segments = splitAgenda(MINUTES);
    expect(segments.map((segment) => segment.index)).toEqual(segments.map((_, order) => order + 1));
  });

  it("마지막 안건이 사라지지 않는다", () => {
    // 8B 모델의 최대 약점이 뒷부분 누락이다. 분할 단계에서부터 확인한다.
    const segments = splitAgenda(MINUTES);
    expect(segments.some((segment) => segment.text.includes("증액 요구안"))).toBe(true);
  });

  it("○·가. 같은 표기도 경계로 본다", () => {
    const text = "○ 첫째 안건\n내용입니다.\n가. 둘째 안건\n다른 내용입니다.";
    expect(splitAgenda(text)).toHaveLength(2);
  });

  it("'안건' 표기를 경계로 본다", () => {
    const text = "안건 1: 데이터 수급\n내용입니다.\n안건 2: 실증 계획\n다른 내용입니다.";
    expect(splitAgenda(text)).toHaveLength(2);
  });

  it("번호로 시작해도 긴 문장은 제목으로 보지 않는다", () => {
    const long = `1. ${"매우 긴 서술형 문장입니다. ".repeat(5)}`;
    expect(splitAgenda(long)).toHaveLength(1);
  });

  it("경계가 없으면 문단으로라도 나눈다 — 통째로 던지지 않는다", () => {
    const text = "첫 문단입니다. 내용이 이어집니다.\n\n둘째 문단입니다. 내용이 이어집니다.";
    expect(splitAgenda(text)).toHaveLength(2);
  });

  it("한 안건이 너무 길면 다시 자른다", () => {
    const huge = `1. 긴 안건\n${"가나다라마바사아자차 ".repeat(600)}`;
    const segments = splitAgenda(huge);
    expect(segments.length).toBeGreaterThan(1);
    expect(Math.max(...segments.map((segment) => segment.text.length))).toBeLessThanOrEqual(MAX_SEGMENT_CHARS + 200);
  });

  it("머리말은 안건으로 세지 않는다", () => {
    // 회의명·일시·참석자 블록이 안건 1이 되면 호출이 한 번 늘고 번호가 전부 밀린다
    const segments = splitAgenda(MINUTES);
    expect(segments).toHaveLength(3);
    expect(segments[0].heading).toBe("1. 데이터 수급 현황");
  });

  it("머리말 뒤에 본문이 붙어 있으면 버리지 않는다", () => {
    const text = "일시: 2026-08-12\n논의 내용이 여기에 바로 이어집니다.\n\n1. 첫 안건\n내용";
    expect(splitAgenda(text)[0].text).toMatch(/논의 내용/);
  });

  it("빈 회의록은 빈 배열", () => {
    expect(splitAgenda("")).toEqual([]);
  });
});

describe("회의 정보 — 룰", () => {
  it("제목·일시·참석자를 뽑는다", () => {
    const meta = parseMeetingMeta(MINUTES, TODAY);
    expect(meta.title).toBe("제3차 CDX 실무회의");
    expect(meta.date).toBe("2026-08-12");
    expect(meta.attendees).toEqual(["홍길동", "김철수", "이영희"]);
  });

  it("일시가 없으면 오늘로 둔다 — 지어내지 않는다", () => {
    const meta = parseMeetingMeta("회의명: 아무 회의\n내용만 있음", TODAY);
    expect(meta.date).toBe(TODAY);
    expect(meta.attendees).toEqual([]);
  });
});

describe("응답 검증", () => {
  it("정상 응답을 받아들인다", () => {
    const parsed = validateSegmentOutput({
      issues: [{ topic: "실증 대상지", positions: ["A기관은 조기 확정", "B기관은 유보"] }],
      decisions: [{ text: "다음 회의에서 확정" }],
      actions: [{ text: "비교표 작성", owner: "A기관", due: "2026-08-20" }],
    });
    expect(parsed?.issues[0].positions).toHaveLength(2);
    expect(parsed?.actions[0]).toEqual({ text: "비교표 작성", owner: "A기관", due: "2026-08-20" });
  });

  it("일부 배열만 와도 받아들인다", () => {
    expect(validateSegmentOutput({ decisions: [] })).toEqual({ issues: [], decisions: [], actions: [], requests: [], items: [] });
  });

  it("항목이 문자열로 와도 살린다", () => {
    const parsed = validateSegmentOutput({ decisions: ["확정하기로 함"], issues: ["대상지 선정"], actions: ["비교표 작성"] });
    expect(parsed?.decisions[0].text).toBe("확정하기로 함");
    expect(parsed?.issues[0].topic).toBe("대상지 선정");
    expect(parsed?.actions[0].text).toBe("비교표 작성");
  });

  it("날짜 형식이 아닌 기한은 버린다 — 억지로 날짜를 만들지 않는다", () => {
    const parsed = validateSegmentOutput({ actions: [{ text: "정리", due: "다음 주까지" }] });
    expect(parsed?.actions[0].due).toBe("");
  });

  it("원문에 없는 날짜는 버린다 — 모델이 한 날짜 계산을 믿지 않는다", () => {
    // "이달 말까지"를 8월 31일로 바꿔 오는 건 8B 모델이 실제로 하는 행동이다
    const source = "증액 요구안을 이달 말까지 정리하기로 함.";
    expect(validateSegmentOutput({ actions: [{ text: "정리", due: "2026-08-31" }] }, source)?.actions[0].due).toBe("");
  });

  it("원문에 적힌 날짜는 그대로 받는다", () => {
    const source = "잔여 1종은 8월 18일까지 송부하기로 함.";
    expect(validateSegmentOutput({ actions: [{ text: "송부", due: "2026-08-18" }] }, source)?.actions[0].due).toBe("2026-08-18");
  });

  it("여러 표기를 근거로 인정한다", () => {
    expect(dateGroundedIn("2026-08-18", "2026-08-18까지")).toBe(true);
    expect(dateGroundedIn("2026-08-18", "8/18까지")).toBe(true);
    expect(dateGroundedIn("2026-08-18", "18일까지 송부")).toBe(true);
    expect(dateGroundedIn("2026-08-18", "3종 중 2종만 제공")).toBe(false);
  });

  it("모양이 아예 다르면 null", () => {
    expect(validateSegmentOutput({ 요약: "없음" })).toBeNull();
    expect(validateSegmentOutput("문자열")).toBeNull();
  });
});

describe("병합", () => {
  const segments = splitAgenda(MINUTES);

  it("어느 안건에서 나왔는지 번호를 붙인다", () => {
    const results = segments.map((segment) =>
      segment.index === 2
        ? { issues: [{ topic: "실증 대상지", positions: [] }], decisions: [], actions: [] }
        : { issues: [], decisions: [], actions: [] },
    );
    const report = mergeMinutes(parseMeetingMeta(MINUTES, TODAY), segments, results);
    expect(report.issues[0].sourceSegment).toBe(2);
  });

  it("실패한 안건 번호를 남긴다 — 조용히 빠지지 않는다", () => {
    const results = segments.map((segment) => (segment.index === 1 ? null : { issues: [], decisions: [], actions: [] }));
    expect(mergeMinutes(parseMeetingMeta(MINUTES, TODAY), segments, results).failedSegments).toContain(1);
  });
});

describe("1페이지 보고서", () => {
  const report = mergeMinutes(
    { title: "제3차 실무회의", date: "2026-08-12", attendees: ["홍길동"] },
    splitAgenda(MINUTES),
    splitAgenda(MINUTES).map((segment) =>
      segment.index === 1
        ? {
            issues: [{ topic: "데이터 수급 지연", positions: ["A기관 2종만 제공"] }],
            decisions: [{ text: "잔여 1종은 금주 내 제공" }],
            actions: [{ text: "잔여 데이터 송부", owner: "A기관", due: "2026-08-18" }],
          }
        : { issues: [], decisions: [], actions: [] },
    ),
  );

  it("정해진 순서로 나온다", () => {
    const text = renderOnePager(report);
    expect(text.indexOf("주요 쟁점")).toBeLessThan(text.indexOf("결정사항"));
    expect(text.indexOf("결정사항")).toBeLessThan(text.indexOf("후속조치"));
  });

  it("각 항목에 안건 번호를 달아 원문으로 되짚을 수 있다", () => {
    expect(renderOnePager(report)).toMatch(/잔여 1종은 금주 내 제공 \(안건 1\)/);
  });

  it("비어 있는 절은 '해당 없음'으로 둔다", () => {
    const empty = mergeMinutes({ title: "회의", date: TODAY, attendees: [] }, [], []);
    expect(renderOnePager(empty)).toMatch(/해당 없음/);
  });

  it("추출에 실패한 안건을 보고서에 표시한다", () => {
    const failed = mergeMinutes({ title: "회의", date: TODAY, attendees: [] }, splitAgenda(MINUTES), [null, null, null]);
    expect(renderOnePager(failed)).toMatch(/자동 추출에 실패/);
  });
});

describe("후속조치 → 업무 등록", () => {
  const actions: Action[] = [
    { text: "잔여 데이터 송부 요청", owner: "A기관", due: "2026-08-18", sourceSegment: 1 },
  ];

  it("담당기관과 기한을 회의록 값으로 채운다", () => {
    const [draft] = actionsToDrafts(actions, TODAY);
    expect(draft.org).toBe("A기관");
    expect(draft.due).toBe("2026-08-18");
  });

  it("기존 분류 규칙을 그대로 쓴다", () => {
    expect(actionsToDrafts(actions, TODAY)[0].categoryId).toBe("data");
  });

  it("어느 안건에서 왔는지 근거를 남긴다", () => {
    expect(actionsToDrafts(actions, TODAY)[0].note).toMatch(/안건 1/);
  });
});

describe("generateMinutes", () => {
  it("안건마다 한 번씩 호출한다", async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      return JSON.stringify({ issues: [], decisions: [{ text: `결정 ${calls}` }], actions: [] });
    };
    const report = await generateMinutes(MINUTES, TODAY, call);
    expect(calls).toBe(report.segments.length);
    expect(report.decisions).toHaveLength(report.segments.length);
  });

  it("진행률을 알려 준다", async () => {
    const seen: number[] = [];
    await generateMinutes(MINUTES, TODAY, async () => "{}", { onProgress: (progress) => seen.push(progress.done) });
    expect(seen[seen.length - 1]).toBe(splitAgenda(MINUTES).length);
  });

  it("한 안건이 실패해도 나머지는 계속한다", async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      if (calls === 1) throw new Error("타임아웃");
      return JSON.stringify({ issues: [], decisions: [{ text: "정상" }], actions: [] });
    };
    const report = await generateMinutes(MINUTES, TODAY, call);
    expect(report.failedSegments).toEqual([1]);
    expect(report.decisions.length).toBeGreaterThan(0);
  });

  it("모델 없이도 안건 분할 결과는 나온다", async () => {
    const report = await generateMinutes(MINUTES, TODAY, null);
    expect(report.segments.length).toBeGreaterThanOrEqual(3);
    expect(report.meeting.title).toBe("제3차 CDX 실무회의");
  });
});

describe("요청사항 추출", () => {
  const source = "A기관이 지엠티에 데이터 3종 제공을 요청함. 지엠티는 8월 20일까지 회신하기로 함.";

  it("방향만 모델이 정한다", () => {
    const parsed = validateSegmentOutput(
      { requests: [{ direction: "incoming", text: "데이터 3종 제공", org: "지엠티", due: "2026-08-20" }] },
      source,
    );
    expect(parsed?.requests?.[0].direction).toBe("incoming");
  });

  it("방향이 없거나 이상하면 outgoing으로 둔다", () => {
    const parsed = validateSegmentOutput({ requests: [{ text: "자료 제출", direction: "옆으로" }] }, source);
    expect(parsed?.requests?.[0].direction).toBe("outgoing");
  });

  it("기관은 모델이 아니라 별칭 매칭이 정한다", () => {
    const parsed = validateSegmentOutput(
      { requests: [{ text: "지엠티 데이터 제공", counterpartOrgId: "kimst" }] },
      source,
    );
    // 모델이 KIMST라고 우겨도 문장에 있는 기관을 쓴다
    expect(parsed?.requests?.[0].counterpartOrgId).toBe("gmt");
  });

  it("원문에 없는 기관 id는 받지 않는다", () => {
    const parsed = validateSegmentOutput(
      { requests: [{ text: "자료 제출", counterpartOrgId: "surromind" }] },
      "특별한 기관명이 없는 문장입니다.",
    );
    expect(parsed?.requests?.[0].counterpartOrgId).toBe("etc");
  });

  it("분류는 기존 8개 영역이 정한다 — 모델이 새 분류를 만들지 못한다", () => {
    const parsed = validateSegmentOutput({ requests: [{ text: "데이터 3종 제공 요청", category: "새분류" }] }, source);
    expect(parsed?.requests?.[0].categoryId).toBe("data");
  });

  it("원문에 없는 기한은 버린다", () => {
    const parsed = validateSegmentOutput({ requests: [{ text: "자료 제출", due: "2026-12-31" }] }, source);
    expect(parsed?.requests?.[0].due).toBe("");
  });

  it("기한이나 기관이 비면 확신도를 낮춘다", () => {
    const high = validateSegmentOutput(
      { requests: [{ text: "지엠티 데이터 제공", due: "2026-08-20" }] }, source);
    expect(high?.requests?.[0].confidence).toBe("high");

    const low = validateSegmentOutput({ requests: [{ text: "자료 제출" }] }, source);
    expect(low?.requests?.[0].confidence).toBe("low");
  });
});

describe("요청사항 → 업무 등록", () => {
  const requests = [
    { direction: "outgoing" as const, counterpartOrgId: "gmt" as const, text: "데이터 3종 제공 요청",
      due: "2026-08-20", categoryId: "data" as const, sourceSegment: 2, confidence: "high" as const },
    { direction: "incoming" as const, counterpartOrgId: "kimst" as const, text: "제출자료 검토",
      due: "", categoryId: "report" as const, sourceSegment: 3, confidence: "low" as const },
  ];

  it("기관과 분류를 그대로 옮긴다", () => {
    const [draft] = requestsToDrafts(requests, TODAY);
    expect(draft.orgId).toBe("gmt");
    expect(draft.org).toBe("지엠티");
    expect(draft.categoryId).toBe("data");
    expect(draft.due).toBe("2026-08-20");
  });

  it("방향에 따라 상태가 갈린다", () => {
    // 나간 요청은 회신 대기가 되고, 받은 요청은 내가 처리할 일이 된다
    const [outgoing, incoming] = requestsToDrafts(requests, TODAY);
    expect(outgoing.status).toBe("요청 필요");
    expect(outgoing.awaiting).toBe(true);
    expect(incoming.status).toBe("확인 필요");
    expect(incoming.awaiting).toBe(false);
  });

  it("어느 발언에서 나왔는지 근거를 남긴다", () => {
    const [draft] = requestsToDrafts(requests, TODAY, "제3차 실무회의");
    expect(draft.note).toMatch(/제3차 실무회의 회의록 안건 2/);
  });
});

describe("회의록 길이 가드", () => {
  it("상한을 넘으면 알린다 — 자르지는 않는다", () => {
    // 어디까지 넣을지는 사람이 정하는 게 맞다
    expect(minutesTooLong("가".repeat(MAX_MINUTES_CHARS + 1))).toBe(true);
    expect(minutesTooLong(MINUTES)).toBe(false);
  });
});
