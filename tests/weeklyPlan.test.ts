import { describe, expect, it } from "vitest";
import {
  BODY_DEAD_ZONE,
  buildPlanPrompt,
  buildRetryPrompt,
  bureauStyle,
  classifyPlanType,
  generatePlanItem,
  normalize,
  SHAPE_OF,
  TYPE_ORDER,
  TYPE_SPEC,
  typeLabel,
  validateItem,
  width,
} from "../lib/weeklyPlan";

/** 원문에서 그대로 가져온 항목. 검증기 캘리브레이션의 기준점이다. */
const REAL_ITEM =
  "④ [신규] 해양환경감시원 인력풀 및 불명오염사고 광역조사지원팀 재구성(오염예방)\n" +
  "- (추진배경) 정기인사발령에 따른 해양환경감시원(410명, ’25년) 및 불명오염사고 광역조사지원팀(방제+관제+수사 66명, ’25년) 인력운영체계 정비\n" +
  "- (주요내용) ➊해양환경감시원 인력풀 현행화하여 교육이수 이력 관리, ➋불명오염사고 광역조사지원팀 전문인력 중심으로 신속한 행위자 색출 지원";

describe("표시폭", () => {
  it("한글은 2, 영문·숫자는 1로 센다", () => {
    expect(width("가나다")).toBe(6);
    expect(width("abc123")).toBe(6);
    expect(width("해경 AI")).toBe(7); // 한글2*2 + 공백1 + AI 2
  });

  it("항목 기호는 1로 센다", () => {
    // ①·➊는 유니코드상 '모호'라 1이다. 원문 실측이 이 기준이라 바꾸면 예산이 어긋난다.
    expect(width("①")).toBe(1);
    expect(width("➊")).toBe(1);
    expect(width("’26년")).toBe(5); // ’ 1 + 2 1 + 6 1 + 년 2
  });

  it("빈 값도 견딘다", () => {
    expect(width("")).toBe(0);
  });
});

describe("유형 판정 — 규칙", () => {
  it("제목 키워드로 8종을 가른다", () => {
    expect(classifyPlanType("「영해 및 접속수역법」개정 추진")).toBe("T2_법령제개정");
    expect(classifyPlanType("발전전략 수립 연구용역 추진")).toBe("T6_연구용역");
    expect(classifyPlanType("업무협의회 개최")).toBe("T3_회의행사");
    expect(classifyPlanType("통합방위 실무자 교육")).toBe("T4_교육훈련");
    expect(classifyPlanType("HNS 해상운송 통계 분석")).toBe("T5_점검조사");
    expect(classifyPlanType("해양환경감시원 인력풀 재구성")).toBe("T8_인력조직");
    expect(classifyPlanType("함정정비통합관제플랫폼 시범운용")).toBe("T7_사업구축");
    expect(classifyPlanType("’26년 국민 만족도 조사 운영 계획 수립")).toBe("T1_계획수립");
  });

  it("아무것도 안 걸리면 계획수립으로 둔다", () => {
    expect(classifyPlanType("무엇인지 알 수 없는 제목")).toBe("T1_계획수립");
  });

  it("'협의'만으로는 회의행사로 안 간다 — 원본 규칙 그대로다", () => {
    // 원본 문서의 T3 예시 제목("실무자 협의")조차 규칙상 T3에 안 걸린다.
    // 캘리브레이션된 규칙을 임의로 넓히면 "관계기관 협의를 통해 계획 수립"까지
    // 회의로 끌려오므로, 원본과 같게 두고 화면에서 유형을 고칠 수 있게 했다.
    expect(classifyPlanType("과학수사 업무 협력 실무자 협의")).toBe("T1_계획수립");
  });

  it("먼저 걸리는 규칙이 이긴다", () => {
    // 법령 규칙이 회의 규칙보다 앞에 있다
    expect(classifyPlanType("「해양경비법」개정 관련 협의회")).toBe("T2_법령제개정");
  });
});

describe("국별 관행", () => {
  it("수사국은 다른 번호 기호를 쓴다", () => {
    expect(bureauStyle("수사국").numbers).toBe("➀➁➂➃");
    expect(bureauStyle("기획조정관").numbers).toBe("①②③④⑤");
  });

  it("기획조정관은 배경을 생략하고 ※ 각주를 쓴다", () => {
    const style = bureauStyle("기획조정관");
    expect(style.labels).toEqual(["주요내용"]);
    expect(style.note).toBe("※");
  });

  it("모르는 국은 기본 골격으로 떨어진다", () => {
    expect(bureauStyle("없는국").labels).toContain("주요내용");
  });
});

describe("프롬프트", () => {
  const input = {
    bureau: "AI미래기술정보융합단", dept: "인공지능",
    titleSeed: "AI 사업 카탈로그 시스템 구축 추진",
    facts: "- 13개 AI 사업을 웹 카탈로그로 전환\n- 4월 프로토타입, 6월 시범운영",
  };

  it("판정된 유형의 예시만 넣는다", () => {
    const prompt = buildPlanPrompt(input);
    expect(prompt).toMatch(/T7_사업구축/);
    expect(prompt).toMatch(/함정정비통합관제플랫폼/); // T7 예시
    expect(prompt).not.toMatch(/영해 및 접속수역법/);  // T2 예시
  });

  it("few-shot은 2개로 고정한다", () => {
    // 3개 이상이면 소형 모델이 예시를 그대로 베낀다
    for (const spec of Object.values(TYPE_SPEC)) expect(spec.shots).toHaveLength(2);
    expect(buildPlanPrompt(input)).toMatch(/\[예시 2\]/);
    expect(buildPlanPrompt(input)).not.toMatch(/\[예시 3\]/);
  });

  it("국 관행과 분량표를 함께 넣는다", () => {
    const prompt = buildPlanPrompt(input);
    expect(prompt).toMatch(/소속 국   : AI미래기술정보융합단/);
    expect(prompt).toMatch(/82~99폭은 금지 구간/);
  });

  it("사실관계 밖을 쓰지 말라고 지시한다", () => {
    expect(buildPlanPrompt(input)).toMatch(/없는 수치나 일정을 지어내지 마시오/);
  });

  it("유형을 강제할 수 있다", () => {
    expect(buildPlanPrompt({ ...input, forceType: "T1_계획수립" })).toMatch(/T1_계획수립/);
  });
});

describe("검증기", () => {
  it("원문 항목을 통과시킨다", () => {
    const check = validateItem(REAL_ITEM);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.stats).toMatchObject({ title: 1, body: 2 });
  });

  it("제목이 길면 몇 폭 줄일지 숫자로 알려준다", () => {
    // 막연히 "줄여라"로는 소형 모델이 엉뚱한 줄을 건드린다
    const long = `① [신규] ${"매우긴제목".repeat(12)}(기획)\n- (주요내용) ${"내용".repeat(20)} 등`;
    const check = validateItem(long);
    expect(check.errors.join()).toMatch(/제목 \d+폭 → 80폭 이하로 \d+폭 줄일 것/);
  });

  it("본문 금지구간을 잡아낸다", () => {
    // 1줄로 끝나지도 2줄을 채우지도 못하는 폭이라 오른쪽이 크게 빈다
    const mid = "가".repeat(43); // 86폭 + 라벨
    const text = `① [신규] 제목 테스트(기획)\n- (주요내용) ${mid}\n* 각주 내용 보충`;
    const check = validateItem(text);
    expect(check.errors.join()).toMatch(/금지구간\(82~99\)/);
    expect(check.errors.join()).toMatch(/폭 줄이거나 \d+폭 늘릴 것/);
  });

  it("서술형 종결어미를 잡아낸다", () => {
    const text = `① [신규] 제목(기획)\n- (주요내용) 이러이러한 사업을 추진합니다`;
    expect(validateItem(text).errors.join()).toMatch(/개조식 명사형/);
  });

  it("본문이 없으면 실패", () => {
    expect(validateItem("① [신규] 제목만 있음(기획)").errors.join()).toMatch(/본문 라인 없음/);
  });

  it("형식을 벗어난 줄을 잡아낸다", () => {
    const text = `① [신규] 제목(기획)\n- (주요내용) 내용\n설명을 덧붙였습니다만 형식이 아님`;
    expect(validateItem(text).errors.join()).toMatch(/형식 불명/);
  });

  it("빈 출력도 죽지 않는다", () => {
    const check = validateItem("");
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual(["빈 출력"]);
  });

  it("담당과 표기 없음은 경고일 뿐 실패가 아니다", () => {
    // 단(團)·상황실은 생략하는 관행이 있다
    const check = validateItem(REAL_ITEM.replace("(오염예방)", ""));
    expect(check.warnings.join()).toMatch(/담당과/);
  });

  it("금지구간 경계값을 정확히 본다", () => {
    expect(BODY_DEAD_ZONE).toEqual([82, 99]);
  });
});

describe("후처리", () => {
  it("화살표를 강제한다", () => {
    expect(normalize("계약 -> 수행 => 완료")).toBe("계약 → 수행 → 완료");
  });

  it("줄 중간의 나열은 불릿으로 바꾼다", () => {
    expect(normalize("- (주요내용) 대상은 1) 첫째 2) 둘째")).toMatch(/➊첫째 ➋둘째/);
  });

  it("줄 맨 앞의 번호는 항목 번호로 본다", () => {
    // qwen3:8b가 "1) [신규] …"로 시작하는 출력을 낸다. 여기서 불릿으로 바꾸면
    // 제목 라인이 통째로 형식을 벗어나 검증이 "형식 불명"으로 떨어진다.
    expect(normalize("1) [신규] 제목(기획)")).toBe("① [신규] 제목(기획)");
    expect(normalize("2. [신규] 제목(기획)")).toBe("② [신규] 제목(기획)");
  });

  it("연도를 공문 표기로 바꾼다", () => {
    expect(normalize("2026년 계획")).toBe("’26년 계획");
    expect(normalize("'26년 계획")).toBe("’26년 계획");
  });

  it("코드펜스와 빈 줄을 걷어낸다", () => {
    expect(normalize("```\n① 제목\n\n\n- (주요내용) 내용\n```")).toBe("① 제목\n- (주요내용) 내용");
  });
});

describe("재생성 프롬프트", () => {
  it("위반 폭을 숫자로 넘긴다", () => {
    const prompt = buildRetryPrompt("① 제목", ["1행 제목 92폭 → 80폭 이하로 12폭 줄일 것"]);
    expect(prompt).toMatch(/12폭 줄일 것/);
    expect(prompt).toMatch(/라벨 구성은 그대로 두고/);
  });
});

describe("생성 루프", () => {
  it("통과하면 한 번만 부른다", async () => {
    let calls = 0;
    const call = async () => { calls += 1; return REAL_ITEM; };
    const result = await generatePlanItem(
      { bureau: "해양오염방제국", dept: "오염예방", titleSeed: "인력풀 재구성", facts: "메모" }, call);
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("길이가 안 맞으면 다시 만든다", async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      return calls === 1 ? "① [신규] 짧음(기획)\n- (주요내용) 너무 짧다" : REAL_ITEM;
    };
    const result = await generatePlanItem(
      { bureau: "기획조정관", dept: "기획재정", titleSeed: "계획 수립", facts: "메모" }, call);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("끝내 안 맞으면 마지막 결과와 위반 목록을 함께 준다", async () => {
    // 사람이 고칠 수 있어야 한다
    const call = async () => "① [신규] 계속 짧음(기획)\n- (주요내용) 짧다";
    const result = await generatePlanItem(
      { bureau: "기획조정관", dept: "기획재정", titleSeed: "계획 수립", facts: "메모" }, call, 2);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.text).toMatch(/계속 짧음/);
  });

  it("모델이 죽어도 화면이 받을 값을 준다", async () => {
    const result = await generatePlanItem(
      { bureau: "기획조정관", dept: "기획재정", titleSeed: "계획 수립", facts: "메모" },
      async () => { throw new Error("연결 실패"); });
    expect(result.note).toMatch(/연결 실패/);
    expect(result.ok).toBe(false);
  });

  it("모델이 없으면 그렇게 알린다", async () => {
    const result = await generatePlanItem(
      { bureau: "기획조정관", dept: "기획재정", titleSeed: "계획 수립", facts: "메모" }, null);
    expect(result.note).toMatch(/연결되지 않았습니다/);
    expect(result.type).toBe("T1_계획수립");
  });
});

describe("서식 10종", () => {
  it("원문 빈도순으로 10종을 둔다", () => {
    expect(TYPE_ORDER).toHaveLength(10);
    expect(TYPE_ORDER[0].id).toBe("T1_계획수립");   // 36건으로 가장 많다
    const counts = TYPE_ORDER.map((item) => item.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("10종 전부 규칙과 예시를 갖는다", () => {
    for (const item of TYPE_ORDER) {
      expect(TYPE_SPEC[item.id].shots).toHaveLength(2);
      expect(TYPE_SPEC[item.id].rules.length).toBeGreaterThan(0);
      expect(typeLabel(item.id)).toBe(item.label);
    }
  });

  it("업무성과·기타일정은 골격이 다르다", () => {
    expect(SHAPE_OF.R1_업무성과).toBe("result");
    expect(SHAPE_OF.E1_기타일정).toBe("schedule");
    expect(SHAPE_OF.T1_계획수립).toBe("plan");
  });
});

describe("업무성과 서식", () => {
  const REAL = "① 민·관 대테러업무 혁신 TF 2차 전체회의 참석(2.26.)";

  it("제목 한 줄이면 통과한다", () => {
    // 원문 22건 전부 하위 라인이 0개였다
    const check = validateItem(REAL, "R1_업무성과");
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("업무계획 기준을 대면 떨어진다 — 그래서 서식을 나눴다", () => {
    expect(validateItem(REAL, "T1_계획수립").ok).toBe(false);
  });

  it("본문을 붙이면 잡아낸다", () => {
    const check = validateItem(`${REAL}\n- (주요내용) 붙이면 안 되는 본문`, "R1_업무성과");
    expect(check.errors.join()).toMatch(/본문\(-\) 라인 1개/);
  });

  it("제목이 길면 잡아낸다", () => {
    const long = `① ${"매우 긴 성과 제목".repeat(8)}(4.1)`;
    expect(validateItem(long, "R1_업무성과").errors.join()).toMatch(/제목 \d+폭 → 70폭 이하로/);
  });

  it("담당과·태그 경고를 내지 않는다", () => {
    // 업무성과에는 (담당과)도 [신규]도 붙이지 않는다
    expect(validateItem(REAL, "R1_업무성과").warnings).toEqual([]);
  });
});

describe("기타일정 서식", () => {
  const REAL =
    "① ’26년 정부조직 운영방향 논의를 위한 중앙부처 조직담당관 워크숍 참석\n" +
    "※時/所/參 3.5.(목) / 세종컨벤션센터 / 代혁신행정법무담당관 등 3명";

  it("제목 + 각주 1개를 통과시킨다", () => {
    const check = validateItem(REAL, "E1_기타일정");
    expect(check.errors).toEqual([]);
  });

  it("각주 없이 제목만 있어도 통과한다", () => {
    // 날짜가 짧으면 제목에 인라인으로 넣는다
    const check = validateItem("① 농해수위 전체회의(법안상정) 대응(3.11. / 청장 직무대행 등)", "E1_기타일정");
    expect(check.errors).toEqual([]);
  });

  it("각주가 2개 이상이면 잡아낸다", () => {
    expect(validateItem(`${REAL}\n* 추가 각주`, "E1_기타일정").errors.join()).toMatch(/각주 라인 2개/);
  });

  it("본문을 붙이면 잡아낸다", () => {
    expect(validateItem(`${REAL}\n- (주요내용) 본문`, "E1_기타일정").errors.join()).toMatch(/본문\(-\) 라인/);
  });
});

describe("서식별 프롬프트", () => {
  const base = { bureau: "기획조정관", dept: "기획재정", titleSeed: "회의 참석", facts: "메모" };

  it("업무성과에는 본문을 쓰지 말라고 한다", () => {
    const prompt = buildPlanPrompt({ ...base, forceType: "R1_업무성과" });
    expect(prompt).toMatch(/본문·각주 라인을 쓰지 않는다/);
    expect(prompt).not.toMatch(/금지 구간/);
  });

  it("기타일정에는 각주 1개까지만 허용한다고 한다", () => {
    const prompt = buildPlanPrompt({ ...base, forceType: "E1_기타일정" });
    expect(prompt).toMatch(/0개 또는 1개만/);
    expect(prompt).toMatch(/본문\(-\) 라인을 쓰지 않는다/);
  });

  it("업무계획에는 금지 구간을 알려준다", () => {
    expect(buildPlanPrompt({ ...base, forceType: "T1_계획수립" })).toMatch(/82~99폭은 금지 구간/);
  });
});
