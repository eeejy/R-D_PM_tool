/**
 * 주간업무계획 초안 작성.
 *
 * 해양경찰청 주간업무계획 3개 호(업무계획 117건)를 실측해 만든 규칙을 그대로 옮겼다.
 * 다른 기능과 성격이 다르다 — 여기서는 **분량 자체가 형식이다.** 한글 파일의 줄배치
 * 캐시에서 센 값이라, 넘기면 목록 정렬이 실제로 깨진다.
 *
 * 그래서 이 기능만 **생성 → 검증 → 재생성 루프**를 돈다.
 *
 *   1) **유형 판정은 규칙이 한다.** 제목 키워드로 8종 중 하나를 고르고 그 유형의
 *      프롬프트만 준다. 모델에 유형을 맡기면 라벨 조합이 매번 흔들린다.
 *   2) **분량은 프롬프트만으로 안 맞는다.** 소형 모델은 한국어 표시폭을 세지 못한다.
 *      그래서 재생성 프롬프트는 "줄여라"가 아니라 **"현재 N폭 → 목표 M폭, 몇 폭 초과"**
 *      를 숫자로 알려준다.
 *   3) **기호는 후처리로 강제한다.** `➊➋➌` · `→` · `’26년`은 모델이 자주 틀린다.
 */

import { asText, type LlmCall, type LlmConfig } from "./llm";
import { deriveSignals, type Holidays, NO_HOLIDAYS, type TaskEvent } from "./history";
import type { MyTask } from "./mytask";
import { orgName } from "./org";
import { formatKoreanDate } from "./text";
import { categoryTitle } from "./worktree";

/* ── 1. 분량 — 표시폭 ────────────────────────────────────── */

/**
 * 한글 문서 기준 표시폭. 한글·전각은 2, 영문·숫자·기호는 1.
 *
 * `①`이나 `➊` 같은 기호는 유니코드상 '모호(Ambiguous)'라 **1로 센다.**
 * 원문 실측이 그 기준으로 이뤄졌기 때문에 여기서 바꾸면 예산이 전부 어긋난다.
 */
export function width(text: string): number {
  let total = 0;
  for (const char of String(text ?? "")) {
    total += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return total;
}

/** 동아시아 Wide/Fullwidth 범위. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

/** 실측(줄배치 캐시) 기반 예산. */
export const BUDGET = {
  title: { max: 80, hard: 84 },
  body1: { max: 78, hard: 81 },
  body2: { min: 100, max: 143, hard: 148 },
  note: { max: 95, hard: 99 },
} as const;

/**
 * 본문 금지 구간.
 *
 * 1줄로 끝나지도, 2줄을 채우지도 못하는 폭이다. 이 구간에 걸리면 오른쪽에 빈 공간이
 * 크게 남아 문서가 성글어 보인다. 실제 원문에서도 4건이 이 구간에 걸려 있었다.
 */
export const BODY_DEAD_ZONE: readonly [number, number] = [82, 99];

export const ITEM_TOTAL_LINES: readonly [number, number] = [4, 8];
export const ITEM_TOTAL_CHARS: readonly [number, number] = [150, 330];

/** 서식별 총량. 업무성과는 제목 한 줄로 끝나므로 업무계획 기준을 대면 안 된다. */
export const SHAPE_BUDGET: Record<PlanShape, {
  lines: readonly [number, number];
  chars: readonly [number, number];
  body: readonly [number, number];
  note: readonly [number, number];
}> = {
  plan:     { lines: ITEM_TOTAL_LINES, chars: ITEM_TOTAL_CHARS, body: [1, 3], note: [0, 3] },
  // 제목 + 각주 0~1개. 날짜가 짧으면 제목에 인라인, 상세하면 ※ 각주로 뺀다.
  schedule: { lines: [1, 2], chars: [15, 150], body: [0, 0], note: [0, 1] },
};

/* ── 2. 유형 분류 — 규칙 ────────────────────────────────── */

export type PlanTypeId =
  | "T1_계획수립" | "T2_법령제개정" | "T3_회의행사" | "T4_교육훈련"
  | "T5_점검조사" | "T6_연구용역" | "T7_사업구축" | "T8_인력조직"
  | "E1_기타일정";

/**
 * 서식 골격. **업무계획과 기타일정은 라인 구성 자체가 다르다.**
 *
 * 기타일정은 제목 + 각주 0~1개라, 업무계획 검증기를 그대로 대면
 * "본문 라인 없음"으로 떨어진다.
 *
 * 업무성과(지난주 실적)는 넣지 않았다. 이 앱이 다루는 건 사업 진행사항이고,
 * 성과 정리는 다른 자료에서 온다.
 */
export type PlanShape = "plan" | "schedule";

export const SHAPE_OF: Record<PlanTypeId, PlanShape> = {
  T1_계획수립: "plan", T2_법령제개정: "plan", T3_회의행사: "plan", T4_교육훈련: "plan",
  T5_점검조사: "plan", T6_연구용역: "plan", T7_사업구축: "plan", T8_인력조직: "plan",
  E1_기타일정: "schedule",
};

/**
 * 원문 실측 빈도. 화면에서 이 순서로 보여준다 — 자주 쓰는 것이 위에 있어야 한다.
 * 업무계획 117건 + 업무성과 22건 + 기타일정 17건.
 */
export const TYPE_ORDER: { id: PlanTypeId; label: string; count: number }[] = [
  { id: "T1_계획수립", label: "계획수립", count: 36 },
  { id: "T4_교육훈련", label: "교육·훈련", count: 19 },
  { id: "T5_점검조사", label: "점검·조사·분석", count: 17 },
  { id: "E1_기타일정", label: "기타일정", count: 17 },
  { id: "T8_인력조직", label: "인력·조직 운영", count: 14 },
  { id: "T7_사업구축", label: "사업추진·시스템구축", count: 10 },
  { id: "T2_법령제개정", label: "법령·제도 제개정", count: 8 },
  { id: "T3_회의행사", label: "회의·행사 개최", count: 7 },
  { id: "T6_연구용역", label: "연구용역·R&D", count: 6 },
];

export function typeLabel(id: PlanTypeId): string {
  return TYPE_ORDER.find((item) => item.id === id)?.label ?? id;
}

/** 위에서부터 먼저 걸리는 순서다. 우선순위를 바꾸려면 이 배열의 순서를 바꾼다. */
const TYPE_RULES: { id: PlanTypeId; pattern: RegExp }[] = [
  { id: "T2_법령제개정", pattern: /제·?개정|개정\s*추진|제정\s*추진|법제화|입법|「[^」]*법」|규칙\s*제정|지침\s*개정/ },
  { id: "T6_연구용역", pattern: /연구용역|용역\s*추진|컨설팅|R&D|R＆D|실증/ },
  { id: "T3_회의행사", pattern: /회의|워크숍|설명회|간담회|협의회|토론회|TF|발대식|진수식|행사|포상/ },
  { id: "T4_교육훈련", pattern: /교육|훈련|역량\s*강화|숙달|표준화평가|세미나/ },
  { id: "T5_점검조사", pattern: /점검|실태\s*조사|수검|감사|현황\s*분석|통계\s*분석|실적\s*분석|진단|모니터링/ },
  { id: "T8_인력조직", pattern: /재정비|재구성|인력풀|선발|모집|배정기준|인사|증원|조직\s*개편/ },
  { id: "T7_사업구축", pattern: /사업|구축|개발|도입|시범\s*운[영용]|배치|플랫폼|시스템|확대\s*운영/ },
  { id: "T1_계획수립", pattern: /계획\s*수립|수립\s*추진|운영\s*계획|방안\s*마련|전략|계획$/ },
];

/**
 * 제목에서 업무 유형을 고른다.
 *
 * **유형 판정을 모델에 맡기지 않는다.** 규칙으로 먼저 고르고 그 유형의 프롬프트만
 * 주는 편이 훨씬 안정적이다 — 맡기면 라벨 조합이 매번 흔들린다.
 */
export function classifyPlanType(title: string): PlanTypeId {
  return TYPE_RULES.find((rule) => rule.pattern.test(String(title ?? "")))?.id ?? "T1_계획수립";
}

/* ── 3. 국(局)별 관행 ───────────────────────────────────── */

export type BureauStyle = {
  name: string;
  /** 항목 번호 기호. 수사국만 다른 글자를 쓴다 — 국별 관행이라 유지한다. */
  numbers: string;
  labels: string[];
  note: "*" | "※";
  hint: string;
};

export const BUREAUS: BureauStyle[] = [
  { name: "기획조정관", numbers: "①②③④⑤", labels: ["주요내용"], note: "※", hint: "추진배경 생략. ※일정 화살표 각주 필수." },
  { name: "경비국", numbers: "①②③④⑤", labels: ["주요내용"], note: "*", hint: "제목 담당과 앞에 공백 하나. * 추진일정 각주." },
  { name: "수사국", numbers: "➀➁➂➃", labels: ["추진배경", "주요내용"], note: "*", hint: "번호는 반드시 ➀➁➂➃ 사용." },
  { name: "구조안전국", numbers: "①②③④⑤", labels: ["추진배경", "주요내용"], note: "*", hint: "(목 적) 라벨도 사용 가능." },
  { name: "장비기술국", numbers: "①②③④⑤", labels: ["추진배경", "주요내용", "향후계획"], note: "*", hint: "3단 구성. 사업비·기간 각주 필수." },
  { name: "정보외사국", numbers: "①②③④⑤", labels: ["추진배경", "주요내용", "향후계획"], note: "*", hint: "3단 구성." },
  { name: "해양오염방제국", numbers: "①②③④⑤", labels: ["추진배경", "주요내용"], note: "*", hint: "전년 대비 실적 수치 각주 권장." },
  { name: "AI미래기술정보융합단", numbers: "①②③④⑤", labels: ["추진배경", "주요내용"], note: "*", hint: "※ 추진일정 각주 사용." },
  { name: "종합상황실", numbers: "①②③④⑤", labels: ["추진배경", "주요내용"], note: "*", hint: "" },
];

export function bureauStyle(name: string): BureauStyle {
  return BUREAUS.find((item) => item.name === name) ?? BUREAUS[2];
}

/* ── 4. 유형별 규칙 + few-shot ──────────────────────────── */

type TypeSpec = { labels: string; rules: string[]; shots: string[] };

/**
 * few-shot은 **2개로 고정한다.**
 * 3개 이상 넣으면 소형 모델에서 오히려 예시를 그대로 베끼는 일이 늘어난다.
 */
export const TYPE_SPEC: Record<PlanTypeId, TypeSpec> = {
  T1_계획수립: {
    labels: "(주요내용) [+ 필요시 (추진배경) 선행]",
    rules: [
      '주요내용은 "~을 위해 ➊… ➋… ➌… 등" 형태의 나열식으로 쓴다.',
      "불릿은 3개가 기본. 2개 또는 4개도 허용.",
      "각주는 대상 규모·구성(인원수, 개소수)을 숫자로 제시한다.",
    ],
    shots: [
      "② [신규] ’26년 국민 만족도 조사 운영 계획 수립(행정법무)\n" +
      "- (주요내용) 국민이 만족하는 정책 수립을 위해 ➊국민패널* 운영(정책 제안 등) ➋서비스 이용 국민 대상 만족도 조사 ➌관할해역별 체감안전도 조사 등\n" +
      "※국민패널 해·수산 관계자, 해양경찰·법학 관련 대학생 등으로 구성(1,567명)",

      "② [신규] ICAO 평가 대비 항공기 수색구조 계획 수립 추진(수색구조)\n" +
      "- (추진배경) ICAO 수검*에 대비해 해상에서의 항공기 사고 발생시 구조조정본부(RCC)의 대응체계를 설명하는 가이드라인 수립 필요\n" +
      "* ICAO평가요소 구조조정본부의 수색구조 업무수행을 위한 계획 준비\n" +
      "- (주요내용) ➊항공기 사고의 특징 ➋통신체계 운용 및 통신수단 활용 ➌항공기 사고 시 기관별 역할 ➍국내·외 수색구조 협력기관 연락처 등",
    ],
  },
  T2_법령제개정: {
    labels: "(추진배경) → (주요내용 또는 주요 개정사항) → (향후계획)",
    rules: [
      "3단 구성 필수. 향후계획은 반드시 화살표(→) 일정으로 쓴다.",
      '추진배경은 "~ 문제를 해결하기 위해 ~ 개정 필요" 형태로 필요성을 명시한다.',
      "법령명은 「」로 감싼다.",
      "입법 절차 표준: 의견조회→사전영향평가→해경위원회→입법예고→규제심사→법제처 심사",
    ],
    shots: [
      "② [신규] 「영해 및 접속수역법」개정 추진(외사)\n" +
      "- (추진배경) 영해조업 외국어선 사법처리 과정에서 발생한 몰수어선 선주 인도 문제 등을 근원적으로 해결하기 위해,「영해법」개정 필요\n" +
      "- (주요 개정사항) ➊몰수 대상 영해조업 외국어선에 대한 선주 인도소송 방지를 위한 양벌규정 도입, ➋불법조업 범위를 확대 적용토록 어로→어업활동으로 변경\n" +
      "- (향후계획) 외교부에 법률 개정 소요제기(3월중)→ 공동 대응(~ʼ26년 상반기)",

      "① [신규] 연안체험활동 안전요원·장비기준 개정 추진(해양안전)\n" +
      "- (추진배경) 연안체험활동 시 배치*해야 하는 안전요원 및 비상구조선 등의 기준(시행규칙 별표2)에 대해 관련 단체 등 개선 요구\n" +
      "- (주요내용) 국내·외 사례 검토, 전문가 자문 및 이해관계자 의견 수렴 등을 거쳐 합리적인 개선안 마련, 법제처와 협의 개정 추진\n" +
      "* 개정절차 의견조회→사전영향평가→해경위원회→입법예고→규제심사→법제처 심사",
    ],
  },
  T3_회의행사: {
    labels: "(주요내용) — 추진배경 생략",
    rules: [
      "개최 사실 자체가 배경이므로 (추진배경)은 쓰지 않는다.",
      "일시/장소/참석자 각주가 반드시 있어야 한다.",
      '각주 표기: "* 일시/장소 3. 5.(목) / 장소 / 참석자 등 N명"',
      "주요내용은 안건을 ➊➋➌로 나열한다.",
    ],
    shots: [
      "④ [신규] 해경-국과원 간 과학수사 업무 협력 강화를 위한 실무자 협의(과학수사)\n" +
      "- (주요내용) ➊ AI기반화재 신속 감정을 위한 단락흔 분석 프로그램 ➋「해경↔국과원↔경찰」과학수사 업무협의회 안건 논의 등을 통한 과학수사 협력 강화\n" +
      "* 일시/장소 ’26. 3. 5. (목) / 국립과학수사연구원(원주) 참석자 과학수사계장 등 4명",

      "③ [신규] 중점 정보화 사업 추진 총괄 TF 회의 개최(정보통신)\n" +
      "- (주요내용) ➊중점 정보화 사업 추진 현황 및 주요 협조 사항 안내, ➋총괄·사업별 TF 운영 계획 공유 ➌ 의견 수렴 등\n" +
      "- (향후계획) 총괄 TF(분기 1회, 장비기술국장, 3. 12. 1차), 실무 TF(월 1회, 정통과장)",
    ],
  },
  T4_교육훈련: {
    labels: "(추진배경 선택) → (주요내용)",
    rules: [
      "주요내용에 커리큘럼을 ➊➋➌➍로 나열한다.",
      "일시·장소·대상 각주 필수. 대상 인원수를 숫자로 밝힌다.",
      '배경을 쓸 경우 "~ 역량 강화를 위한 교육 필요" 형태로 맺는다.',
    ],
    shots: [
      "② [신규] 통합방위 및 비상대비 업무 실무자 교육(경비작전)\n" +
      "- (주요내용) ➊ 통합방위법령 상 우리청 관련 업무 ➋ 충무계획 작성 절차 및 을지연습(UFS) 준비사항 ➌ 주요 안보 관련 상황처리 지침\n" +
      "* 일시·장소 3. 5.(목) 14:30~15:30(1시간) / 영상회의 이용",

      "③ [신규] 신규 진입 보안경찰 전문성 강화 특별교육 실시(보안)\n" +
      "- (추진배경) ’26년 신규 진입 보안경찰 대상 업무공백 최소화와 안보상황 대응·수사 역량 조기 확보 및 현장 중심 실무 능력 강화 위한 교육 필요\n" +
      "* ’26년 보안경찰 35명(47%) 교체, 29명(83%)이 보안업무 경험이 없는 신임 수사관\n" +
      "- (주요내용) ➊보안업무 기본, ➋국가안보 관련 법령, ➌안보·대공수사 실무, ➍실무경험자 사례 중심교육 등",
    ],
  },
  T5_점검조사: {
    labels: "(추진배경) → (주요내용/분석내용/점검내용)",
    rules: [
      "두 번째 라벨은 성격에 맞춰 (분석내용)·(점검내용)·(진단방법)으로 변형한다.",
      '전년 대비 증감 수치 각주를 넣는다. 형식: "’24년 X건 → ’25년 Y건".',
      '기간·대상 각주 필수. 필요 시 "** 활용방안 …" 2차 각주를 덧붙인다.',
    ],
    shots: [
      "③ [신규] 위험·유해물질(HNS) 해상운송 통계 분석(기동방제)\n" +
      "- (추진배경) 해상운송 현황 분석을 통해 해역별·물질별 위험요인을 도출하여 해상화학사고 신속 대응을 위한 기초자료 확보\n" +
      "- (분석내용) ➊해역별 선박 입·출항 현황, ➋유류 및 위험·유해물질 해상운송량, ➌해양시설별 위험·유해물질 취급 현황 등\n" +
      "* 물동량 2백만톤 증가(’24년309백만톤→’25년311백만톤) 사고건수 5건 증가(’24년3건→’25년8건)",

      "④ [신규] 현장 중심 지원체계 구축을 위한 분야별 과학수사 실적 분석(과학수사)\n" +
      "- (추진배경) 지난 3년간 과학수사 운영실적* 분석을 통한 현 정책 추진사항 보완 및 ’26년 맞춤형 과학수사 정책 발굴·추진\n" +
      "* 과학수사 실적 ’23년 3,309건→’24년 2,746건→ ’25년 4,255건 (전년대비 55% 증가)\n" +
      "- (분석내용) ➊포렌식, 지문, 화재감식 등 업무 분야별(8개) 현황 ➋지방청별 감식·감정 활동 실적 ➌타기관 협력 실적 등",
    ],
  },
  T6_연구용역: {
    labels: "(추진배경) → (주요내용) → (추진계획/향후계획)",
    rules: [
      "3단 구성 + 화살표 일정 필수.",
      "기간·예산·수행기관 각주를 반드시 넣는다.",
      "표준 일정: 업체선정(입찰·계약)→착수보고→중간보고→최종보고",
    ],
    shots: [
      "① [신규] 해상 집회·시위 권리보장을 위한 연구용역 추진(정보)\n" +
      "- (추진배경) 해상에서 발생하는 집회·시위의 권리보장과 해양안전을 위해 제도 및 발전방안 마련 연구용역 추진\n" +
      "* 기간 ’26.4~8월 방향 단순 분석이 아닌 권리보장과 해양안전을 달성할 제도 마련\n" +
      "- (주요내용) ➊해상집단행동 실태와 구조·유형 분석 ➋現 법제도 적용 한계 진단 ➌법제화 방안 및 입법(안) 도출 등\n" +
      "- (추진계획) 입찰·계약(4월) → 연구수행(4~8월) → 연구결과에 따른 입법추진",

      "➀ [신규] 수사 미래 발전전략 수립 연구용역 추진(수사기획)\n" +
      "- (추진배경) 신종 해양범죄, AI 등 외부환경 변화에 대응하기 위해 미래 치안수요 예측을 통한 정책수립 및 수사인프라 재설계 방안 필요\n" +
      "- (주요내용) ➊국내·외 환경변화에 따른 미래 치안수요 예측, ➋정책 현황분석 및 미래 수사정책 수립, ➌조직개편 및 인프라 확대 방향 설계\n" +
      "* 일정 업체선정(~4월)→착수보고회(4~5월)→중간보고회(7~8월)→결과보고회(11월)",
    ],
  },
  T7_사업구축: {
    labels: "(추진배경 또는 목적) → (주요내용/적용분야) → (추진일정/향후계획)",
    rules: [
      '사업기간·총사업비 각주 필수. 형식: "* 사업정보 ’21년∼’25년 / 239.18억원".',
      '2글자 라벨은 "(목   적)", "(기 간)"처럼 공백으로 폭을 맞춘다.',
      "적용 기술·분야를 ➊➋➌로 나열한다.",
    ],
    shots: [
      "② [신규] 함정정비통합관제플랫폼 성과도출 시범운용(장비관리)\n" +
      "- (목   적) 첨단기술(IoT 센서 등) 적용, 함정 정비 통합 플랫폼 개발 완료에 따른 시범 운용으로 정비창 업무 적용 가능성 검토\n" +
      "* 사업정보 ’21년∼’25년 / 239.18억원 (우리청 73억원)\n" +
      "- (적용분야) ➊유·무선 네트워크 ➋함정 정비 공정관리 ➌모바일 정비지원(원격정비, QR코드 활용 등)\n" +
      "- (추진일정) 시범운용 계획수립(3.5)→현장설명회(3.10)→시범운용(~6월말)",

      "① [신규] 해양치안 특화 「피지컬 AI」 기술 개발 추진(인공지능)\n" +
      "- (추진배경) 해경·경찰·소방이 참여하는 다부처 사업으로 재난현장에서 기능 간 유기적 협업이 가능한 피지컬 AI 기술 개발 목표\n" +
      "* 우리청 참여 운용설계(인공지능), 수중드론(수색구조), 4족로봇(경비), 드론(해양영역)\n" +
      "- (주요내용) ➊우리청 임무에 특화된 기체 개발, ➋다부처·기체간 통합 운영 표준체계 구축 ➌기능간 공통 소요예산 확보 추진\n" +
      "* 일정 과기부 예산설명(4.10.)→국가심의위원회 대응(5월)→사업별 예산 대응(~12월)",
    ],
  },
  E1_기타일정: {
    labels: "제목 + 각주 0~1개",
    rules: [
      "본문(-)을 쓰지 않는다. 제목과 각주만 쓴다.",
      "날짜가 짧으면 제목에 괄호로 인라인, 상세하면 ※ 각주로 뺀다.",
      "각주 압축표기를 쓴다: ※時/所/參 3.5.(목) / 장소 / 참석자 등 N명",
    ],
    shots: [
      "① ’26년 정부조직 운영방향 논의를 위한 중앙부처 조직담당관 워크숍 참석\n" +
      "※時/所/參 3.5.(목) / 세종컨벤션센터 / 代혁신행정법무담당관 등 3명",

      "① 농해수위 전체회의(법안상정) 대응(3.11. / 청장 직무대행 등)",
    ],
  },
  T8_인력조직: {
    labels: "(추진배경) → (주요내용)",
    rules: [
      '인사 변동이 계기면 배경을 "정기인사발령에 따른 ~"으로 시작한다.',
      '인원수는 배경 문장 안에 괄호로 인라인 삽입한다. 예: "해양환경감시원(410명, ’25년)".',
      "자격기준·배정기준은 본문이 아니라 각주로 분리한다.",
    ],
    shots: [
      "④ [신규] 해양환경감시원 인력풀 및 불명오염사고 광역조사지원팀 재구성(오염예방)\n" +
      "- (추진배경) 정기인사발령에 따른 해양환경감시원(410명, ’25년) 및 불명오염사고 광역조사지원팀(방제+관제+수사 66명, ’25년) 인력운영체계 정비\n" +
      "- (주요내용) ➊해양환경감시원 인력풀 현행화하여 교육이수 이력 관리, ➋불명오염사고 광역조사지원팀 전문인력 중심으로 신속한 행위자 색출 지원",

      "➁ [신규] 수사인권 전담경찰관 등 재정비 및 교육 계획(수사심사)\n" +
      "- (추진배경) 사건관계인 보호·지원을 위해 수사인권관 및 피해자·발달장애인 전담경찰관*을 재정비하고, 역량 강화를 위한 교육 추진\n" +
      "* 수사인권관(13명), 피해자·발달장애인 전담 경찰관(관서별 각 1명)\n" +
      "- (주요내용) ➊자격기준 준수 재정비, ➋주요 추진정책 관련 화상회의, ➌전문교육과정 대상자 우선 선발 등",
    ],
  },
};

/* ── 5. 프롬프트 ────────────────────────────────────────── */

export const WEEKLY_SYSTEM = [
  "당신은 해양경찰청 본청에서 주간업무계획을 작성하는 행정 실무자입니다.",
  "정부 공문서의 개조식(箇條式) 문체로만 작성합니다.",
  "",
  "[절대 규칙]",
  "1. 서술형 문장(습니다/입니다)을 쓰지 않는다. 명사형으로 끝낸다. 마침표를 찍지 않는다.",
  "2. 출력은 아래 형식의 라인만 포함한다. 설명·머리말·맺음말을 절대 붙이지 않는다.",
  "   제목라인:  번호 [신규] 사업명(담당과)",
  "   본문라인:  - (라벨) 내용",
  "   각주라인:  * 라벨 내용     또는     ※ 라벨 내용",
  "3. 나열은 ➊➋➌➍ 기호를 쓴다. 1) 2) 3) 이나 - 를 쓰지 않는다.",
  "4. 연도는 ’26년 형태로 쓴다(작은따옴표 ’ 사용).",
  "5. 일정 흐름은 → 기호로 연결한다.",
  "6. 각 라인의 길이 제한을 반드시 지킨다. 길이를 초과하면 실패로 처리된다.",
].join("\n");

export type PlanInput = {
  bureau: string;
  /** 담당과 약칭 (2~6자) */
  dept: string;
  /** 제목 소재 또는 키워드 */
  titleSeed: string;
  /** 사실관계 메모. 여러 줄 가능 — 여기 없는 수치는 쓰지 못하게 한다. */
  facts: string;
  tag?: "신규" | "진행";
  number?: string;
  /** 규칙 판정을 덮어쓸 때만 */
  forceType?: PlanTypeId;
};

export function buildPlanPrompt(input: PlanInput): string {
  const type = input.forceType ?? classifyPlanType(input.titleSeed);
  const spec = TYPE_SPEC[type];
  const style = bureauStyle(input.bureau);
  const number = input.number || [...style.numbers][0];
  const tag = input.tag ?? "신규";

  return [
    WEEKLY_SYSTEM,
    "",
    "━━━ 이번 항목의 조건 ━━━",
    `소속 국   : ${input.bureau}`,
    `담당과    : ${input.dept}`,
    `업무 유형 : ${type}`,
    `항목 번호 : ${number}`,
    `진행 태그 : [${tag}]`,
    "",
    "[국 관행]",
    `- 항목번호 기호: ${style.numbers}`,
    `- 기본 라벨 구성: ${style.labels.join(" → ")}`,
    `- 각주 머리기호: ${style.note}`,
    style.hint ? `- ${style.hint}` : "",
    "",
    "[유형별 라벨 구성]",
    spec.labels,
    "",
    "[유형별 작성 규칙]",
    spec.rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n"),
    "",
    "━━━ 분량 제한 (표시폭 = 한글 2, 영문·숫자 1) ━━━",
    ...budgetLines(SHAPE_OF[type]),
    "",
    "━━━ 참고 예시 ━━━",
    spec.shots.map((shot, index) => `[예시 ${index + 1}]\n${shot}`).join("\n\n"),
    "",
    "━━━ 작성 대상 ━━━",
    `제목 소재: ${input.titleSeed}`,
    "",
    "사실관계:",
    input.facts,
    "",
    "위 사실관계만 사용해 항목 1개를 작성하시오. 없는 수치나 일정을 지어내지 마시오.",
    "출력은 형식 라인만. 다른 말은 한 글자도 쓰지 마시오.",
  ].filter((line) => line !== "").join("\n");
}

/** 서식마다 지켜야 할 분량이 다르다. 업무계획 기준을 업무성과에 대면 안 된다. */
function budgetLines(shape: PlanShape): string[] {
  if (shape === "schedule") {
    return [
      `- 제목라인 : ${BUDGET.title.max}폭 이하. 반드시 1줄.`,
      `- 각주라인 : ${BUDGET.note.max}폭 이하. 0개 또는 1개만.`,
      "- 본문(-) 라인을 쓰지 않는다.",
    ];
  }
  return [
    `- 제목라인 : ${BUDGET.title.max}폭 이하 (한글 약 40자). 반드시 1줄.`,
    "- 본문라인 : 다음 둘 중 하나만 허용",
    `    · 짧은형: ${BUDGET.body1.max}폭 이하 (한글 약 39자)`,
    `    · 표준형: ${BUDGET.body2.min}~${BUDGET.body2.max}폭 (한글 50~71자)`,
    `  ※ ${BODY_DEAD_ZONE[0]}~${BODY_DEAD_ZONE[1]}폭은 금지 구간. 이 범위에 걸리면 늘리거나 줄여서 벗어날 것.`,
    `- 각주라인 : ${BUDGET.note.max}폭 이하 (한글 약 47자). 반드시 1줄.`,
    "- 항목 전체: 본문 1~3개 + 각주 1~2개, 총 200~300자.",
  ];
}

/**
 * 재생성 프롬프트.
 *
 * **"줄여라"가 아니라 "현재 N폭 → 목표 M폭, 몇 폭 초과"를 숫자로 알려준다.**
 * 소형 모델은 표시폭을 세지 못하므로 막연히 줄이라고 하면 엉뚱한 줄을 건드린다.
 */
export function buildRetryPrompt(previous: string, errors: string[]): string {
  return [
    "아래 초안이 분량 규정을 위반했습니다.",
    "",
    "[이전 초안]",
    previous,
    "",
    "[위반 내역]",
    errors.map((error) => `- ${error}`).join("\n"),
    "",
    "내용과 라벨 구성은 그대로 두고, 위반한 라인만 고쳐서 전체를 다시 출력하시오.",
    "줄이라고 표시된 라인은 수식어와 부연 설명을 먼저 덜어내시오.",
    "늘리라고 표시된 라인은 근거·대상·범위를 한 항목 더 추가하시오.",
    "출력은 형식 라인만. 설명을 붙이지 마시오.",
  ].join("\n");
}

/* ── 6. 검증기 ──────────────────────────────────────────── */

const NUM_MARKS = "①②③④⑤⑥⑦➀➁➂➃➄";

export type PlanStats = {
  title: number;
  body: number;
  note: number;
  /** 렌더링 줄 수(2줄짜리 본문은 2로 센다) */
  lines: number;
  chars: number;
};

export type PlanCheck = { ok: boolean; errors: string[]; warnings: string[]; stats: PlanStats };

/**
 * 분량·형식·문체 검증.
 *
 * 원문 87개 항목에 그대로 적용했을 때 71% 통과였다. 실패한 25건은 대부분 실제 예외
 * 사례(표로 뺐어야 할 내용 등)다. **즉 이 검증기는 실제 문서보다 약간 엄격하다** —
 * 생성물은 늘 원문보다 느슨하게 나오므로 초안 가이드로는 이 정도가 맞다.
 */
export function validateItem(text: string, type: PlanTypeId = "T1_계획수립"): PlanCheck {
  const shape = SHAPE_OF[type];
  const budget = SHAPE_BUDGET[shape];
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = String(text ?? "").trim().split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());

  const stats: PlanStats = { title: 0, body: 0, note: 0, lines: 0, chars: 0 };
  if (!lines.length) return { ok: false, errors: ["빈 출력"], warnings, stats };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    const w = width(line);
    const row = index + 1;

    if (NUM_MARKS.includes(line[0])) {
      stats.title += 1;
      stats.lines += 1;
      const titleMax = BUDGET.title.max;
      const titleHard = BUDGET.title.hard;
      if (w > titleHard) errors.push(`${row}행 제목 ${w}폭 → ${titleMax}폭 이하로 ${w - titleMax}폭 줄일 것`);
      else if (w > titleMax) warnings.push(`${row}행 제목 ${w}폭 — 권장 ${titleMax}폭 이하`);
      // 업무성과·기타일정에는 (담당과)를 붙이지 않는다
      if (shape === "plan" && !/\([^()]{2,8}\)\s*$/.test(line) && stats.title === 1) {
        warnings.push(`${row}행 제목 끝에 (담당과) 표기 없음 — 단(團)·상황실은 생략 가능`);
      }
      if (shape === "plan" && !/[[(](신규|진행|완료)[\])]/.test(line)) {
        warnings.push(`${row}행 제목에 [신규]/[진행] 태그 없음`);
      }
      return;
    }

    if (line.startsWith("-") || line.startsWith("–")) {
      stats.body += 1;
      if (!/^[-–]\s*(\([^)]{2,12}\)|\S)/.test(line)) errors.push(`${row}행 본문 형식 오류 — "- (라벨) 내용" 이어야 함`);

      if (w <= BUDGET.body1.hard) {
        stats.lines += 1;
      } else if (w >= BODY_DEAD_ZONE[0] && w <= BODY_DEAD_ZONE[1]) {
        errors.push(`${row}행 본문 ${w}폭 — 금지구간(${BODY_DEAD_ZONE[0]}~${BODY_DEAD_ZONE[1]}). ${w - BUDGET.body1.max}폭 줄이거나 ${BUDGET.body2.min - w}폭 늘릴 것`);
        stats.lines += 2;
      } else if (w <= BUDGET.body2.hard) {
        stats.lines += 2;
        if (w > BUDGET.body2.max) errors.push(`${row}행 본문 ${w}폭 → ${BUDGET.body2.max}폭 이하로 ${w - BUDGET.body2.max}폭 줄일 것`);
      } else {
        errors.push(`${row}행 본문 ${w}폭 → 3줄 초과. ${BUDGET.body2.max}폭 이하로 ${w - BUDGET.body2.max}폭 줄일 것`);
        stats.lines += 3;
      }
      return;
    }

    if (/^[*※]/.test(line)) {
      stats.note += 1;
      stats.lines += 1;
      if (w > BUDGET.note.hard) errors.push(`${row}행 각주 ${w}폭 → ${BUDGET.note.max}폭 이하로 ${w - BUDGET.note.max}폭 줄일 것`);
      return;
    }

    errors.push(`${row}행 형식 불명 — 제목/본문(-)/각주(*※) 중 하나여야 함: ${line.slice(0, 30)}`);
  });

  if (stats.title !== 1) errors.push(`제목 라인이 ${stats.title}개 (1개여야 함)`);

  if (stats.body < budget.body[0]) {
    errors.push(budget.body[1] === 0 ? "본문(-) 라인을 쓰지 않는 서식" : "본문 라인 없음 (최소 1개)");
  }
  if (stats.body > budget.body[1]) {
    errors.push(budget.body[1] === 0
      ? `본문(-) 라인 ${stats.body}개 — 이 서식은 제목${budget.note[1] ? "과 각주만" : "만"} 쓴다`
      : `본문 라인 ${stats.body}개 (최대 ${budget.body[1]}개)`);
  }
  if (stats.note > budget.note[1]) {
    errors.push(`각주 라인 ${stats.note}개 (최대 ${budget.note[1]}개)`);
  }
  if (stats.lines < budget.lines[0] || stats.lines > budget.lines[1]) {
    errors.push(`항목 총 ${stats.lines}줄 (허용 ${budget.lines[0]}~${budget.lines[1]}줄)`);
  }

  stats.chars = lines.reduce((sum, line) => sum + line.trim().length, 0);
  if (stats.chars < budget.chars[0] || stats.chars > budget.chars[1]) {
    errors.push(`항목 총 ${stats.chars}자 (허용 ${budget.chars[0]}~${budget.chars[1]}자)`);
  }

  if (/(습니다|입니다|합니다)/.test(text)) errors.push("서술형 종결어미 사용 — 개조식 명사형으로 바꿀 것");
  if (/^\s*[-–]\s*\([^)]+\).*\.\s*$/m.test(text)) errors.push("본문 끝에 마침표 사용");

  return { ok: errors.length === 0, errors, warnings, stats };
}

/* ── 7. 후처리 — 기호 강제 ──────────────────────────────── */

/**
 * `➊➋➌` · `→` · `’26년`은 모델이 자주 틀린다. 프롬프트로 부탁하는 것보다
 * 생성 후 치환하는 편이 확실하다.
 */
export function normalize(text: string): string {
  let out = asText(text);
  out = out.replace(/^\s*```.*$/gm, "");
  out = out.replace(/->|=>|⇒/g, "→");
  out = out.replace(/'(\d\d)년/g, "’$1년");
  out = out.replace(/\b20(\d\d)년/g, "’$1년");

  // 줄 맨 앞의 번호는 **항목 번호**다. 원문자(①)로 바꿔야 한다.
  // 여기서 불릿(➊)으로 바꾸면 제목 라인이 통째로 형식을 벗어난다 —
  // 실제로 qwen3:8b가 "1) [신규] …"로 시작하는 출력을 내서 잡힌 문제다.
  out = out.replace(/^\s*([1-5])[).]\s+/gm, (_, digit: string) => `${"①②③④⑤"[Number(digit) - 1]} `);
  // 줄 중간의 나열은 불릿으로 바꾼다.
  ["➊", "➋", "➌", "➍", "➎"].forEach((mark, index) => {
    out = out.replace(new RegExp(`(?<=\\S[^\\n]*?)(?<![\\d.])${index + 1}\\)\\s*`, "g"), mark);
  });
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n");
  return out.trim();
}

/* ── 8. 등록된 업무 → 항목 입력 ─────────────────────────── */

/**
 * 이미 등록된 업무를 서식 입력으로 바꾼다.
 *
 * 이 화면에 빈 폼을 두고 사실관계를 손으로 옮겨 적게 하면, 업무트리에 이미 있는
 * 내용을 두 번 쓰게 된다. **보고사항은 앱 안에 이미 있으니 그것을 그대로 재료로 쓴다.**
 *
 * 사실관계는 전부 **등록된 값과 이력에서만** 뽑는다. 모델은 여기 없는 수치를 쓰지
 * 못한다 — 그러라고 프롬프트에도 못 박혀 있다.
 */
export function taskToPlanInput(
  task: MyTask,
  options: {
    bureau: string;
    dept: string;
    today: string;
    events?: TaskEvent[];
    holidays?: Holidays;
    tag?: "신규" | "진행";
  },
): PlanInput {
  const { bureau, dept, today, events = [], holidays = NO_HOLIDAYS } = options;
  const signals = deriveSignals(events, task.id, today, holidays);
  const facts: string[] = [];

  const org = task.org || (task.orgId ? orgName(task.orgId) : "");
  if (org) facts.push(`- 대상기관 ${org}`);
  facts.push(`- 업무영역 ${categoryTitle(task.categoryId)}`);
  facts.push(`- 현재상태 ${task.status}`);
  if (task.due) facts.push(`- 기한 ${formatKoreanDate(task.due)}`);
  else if (task.dueNote) facts.push(`- 기한 ${task.dueNote}`);

  // 이력에 남은 것만 적는다. 없는 경위를 지어내지 않는다.
  if (signals.postponeCount > 0 && signals.originalDue && signals.currentDue) {
    facts.push(`- 기한 변경 당초 ${formatKoreanDate(signals.originalDue)} → 현재 ${formatKoreanDate(signals.currentDue)} (${signals.postponeCount}회)`);
  }
  for (const note of signals.postponeNotes) facts.push(`- 연기 사유 ${note}`);
  if (signals.awaitingReply && signals.lastContact) {
    facts.push(`- 회신 대기 ${formatKoreanDate(signals.lastContact)} 요청${signals.daysSinceContact != null ? `, ${signals.daysSinceContact}영업일 경과` : ""}`);
  }

  const memo = (task.note || "").replace(/\s+/g, " ").trim();
  if (memo && memo !== task.title) facts.push(`- 등록 원문 ${memo}`);

  return {
    bureau,
    dept,
    titleSeed: task.title,
    facts: facts.join("\n"),
    // 이미 굴러가던 일이면 [진행], 이번에 새로 잡힌 일이면 [신규]
    tag: options.tag ?? (signals.postponeCount > 0 || signals.reminderStage > 0 ? "진행" : "신규"),
  };
}

/* ── 9. 생성 루프 ───────────────────────────────────────── */

export type PlanResult = {
  text: string;
  type: PlanTypeId;
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: PlanStats;
  /** 몇 번 다시 만들었나. 화면에 띄워 모델 교체 판단에 쓴다. */
  attempts: number;
  note?: string;
};

/** 이 기능에 맞는 호출 설정. 형식이 반복되는 문서라 반복 억제를 조금 건다. */
export const WEEKLY_LLM_OPTIONS: Partial<LlmConfig> = {
  temperature: 0.3,
  repeatPenalty: 1.05,
  numPredict: 700,
};

export const MAX_RETRY = 3;

/**
 * 초안 한 건을 만든다.
 *
 * **길이 초과가 기본값이라고 가정한다.** 초안은 길게 나오는 게 정상이라, 검증에
 * 걸리면 위반 폭을 숫자로 알려주고 다시 만든다. 3회까지 시도하고 그래도 안 맞으면
 * 마지막 결과와 위반 목록을 함께 돌려준다 — 사람이 고칠 수 있게.
 */
export async function generatePlanItem(
  input: PlanInput,
  call: LlmCall | null,
  maxRetry = MAX_RETRY,
): Promise<PlanResult> {
  const type = input.forceType ?? classifyPlanType(input.titleSeed);
  if (!call) {
    return { text: "", type, ok: false, errors: [], warnings: [], stats: emptyStats(), attempts: 0, note: "모델에 연결되지 않았습니다." };
  }

  try {
    // buildPlanPrompt가 이미 규칙을 앞에 담고 있다. system으로 한 번 더 보내면
    // 같은 지시가 두 벌 들어가 소형 모델이 오히려 헷갈린다.
    let text = normalize(await call(buildPlanPrompt(input)));
    let check = validateItem(text, type);
    let attempts = 1;

    while (!check.ok && attempts <= maxRetry) {
      text = normalize(await call(buildRetryPrompt(text, check.errors), WEEKLY_SYSTEM));
      check = validateItem(text, type);
      attempts += 1;
    }

    return { text, type, ok: check.ok, errors: check.errors, warnings: check.warnings, stats: check.stats, attempts };
  } catch (cause) {
    return {
      text: "", type, ok: false, errors: [], warnings: [], stats: emptyStats(), attempts: 0,
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

function emptyStats(): PlanStats {
  return { title: 0, body: 0, note: 0, lines: 0, chars: 0 };
}
