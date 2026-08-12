/**
 * 사업담당자의 업무체계.
 *
 * 연구기관의 WBS가 아니라 **내가 해야 하는 일**의 구조다. WBS는 상황 파악에 쓰고,
 * 여기에는 그 상황을 보고 내가 움직여야 하는 것만 담는다.
 *
 * 카테고리는 고정이다. 자연어 입력이 들어올 때 새 카테고리를 만들지 않고,
 * 애매하면 '기타 / 미분류'로 보낸다 — 분류 체계가 늘어나면 그때부터 안 쓰이게 된다.
 */

export type CategoryId =
  | "progress" | "data" | "meeting" | "report"
  | "milestone" | "pilot" | "budget" | "etc";

export type Category = {
  id: CategoryId;
  title: string;
  /** 화면에서 카테고리를 구분하는 한 글자 */
  mark: string;
  /** 이 카테고리가 다루는 일들 — 업무트리의 기본 가지 */
  items: string[];
  /** 자연어 분류용 키워드. 앞 카테고리부터 검사한다. */
  keywords: RegExp;
};

export const CATEGORIES: Category[] = [
  {
    id: "data",
    title: "데이터 제공·수급 관리",
    mark: "D",
    items: [
      "기관별 필요 데이터 목록 관리",
      "데이터 제공 요청·제출기한 지정",
      "미제공·부분제공 데이터 확인",
      "제공기관 후속 연락 및 기관 간 협의",
      "데이터 품질·형식·범위 확인",
      "데이터 지연이 모델개발·실증에 미치는 영향 파악",
      "수급 일정 변경 시 관련 기관 공유",
      "협의사항과 결정 근거 기록",
    ],
    keywords: /데이터|자료\s*제공|원천|수급|정합|데이터셋|비식별|개인정보|제공\s*요청|미제공|반출/,
  },
  {
    id: "meeting",
    title: "회의 운영 및 후속조치",
    mark: "M",
    items: [
      "월간회의·실무회의 일정 관리",
      "기관별 발표자료·현황자료 요청",
      "회의 안건 구성(지연·쟁점·결정필요 사전 선별)",
      "회의자료 취합 및 수치 정합성 확인",
      "회의록 작성·확인, 결정사항 정리",
      "기관별 할 일 추출과 담당자·기한 관리",
      "회의 후 미이행 항목 추적",
    ],
    keywords: /회의|미팅|안건|회의록|간담|워크숍|발표자료|현황자료|월간|실무회의|킥오프/,
  },
  {
    id: "progress",
    title: "연구기관 진도관리",
    mark: "P",
    items: [
      "기관별 WBS 주 1회 수령",
      "연구개발 진행상태 확인",
      "신규 완료 과업 확인",
      "지연 과업·일정 순연 여부 확인",
      "지연 사유 확인 및 회복 일정 요청",
      "완료 과업의 산출물·증빙 확인",
      "RFP 방향과 연구내용의 부합 여부 확인",
    ],
    keywords: /WBS|진도|진척|지연|순연|회복\s*일정|산출물|증빙|RFP|과업|수행기관|진행상태/i,
  },
  {
    id: "pilot",
    title: "실증·성과관리",
    mark: "V",
    items: [
      "실증 후보지·수요기관 협의",
      "실증 시나리오·대상 기능 확정",
      "시제품·프로토타입 준비상태 확인",
      "성과지표 달성 가능성 점검",
      "논문·특허·시제품 등 성과물 확인",
      "성과와 증빙자료 연결",
      "후속사업 후보와 발전방향 축적",
    ],
    keywords: /실증|시나리오|수요기관|후보지|시제품|프로토타입|성과지표|논문|특허|성과물|후속사업/,
  },
  {
    id: "milestone",
    title: "마일스톤·공식 일정 관리",
    mark: "S",
    items: [
      "월간·분기 연구현황 일정 관리",
      "전문가위원회 준비",
      "중간보고회 준비",
      "연차보고·결과보고 일정 관리",
      "GPU 지원사업 결과보고 관리",
      "실증계획 관리 및 실증기관 협의",
    ],
    keywords: /마일스톤|전문가위원회|중간보고|연차보고|결과보고|분기|GPU|착수보고|점검회의/,
  },
  {
    id: "budget",
    title: "예산 대응",
    mark: "B",
    items: [
      "과기부·기재부·국회 예산 대응",
      "예산 관련 자료 작성",
      "사업설명자료 작성",
      "사업 필요성 및 추진성과 정리",
    ],
    keywords: /예산|과기부|기재부|국회|사업설명|증액|삭감|재정/,
  },
  {
    id: "report",
    title: "보고자료 작성",
    mark: "R",
    items: [
      "간부보고용 핵심 현황 작성",
      "CDX 연구개발 추진현황 작성",
      "예산 설명용 추진성과 정리",
      "중간·최종보고회 자료 작성",
      "시연 설명문 작성",
      "주요 성과 정리",
    ],
    keywords: /보고자료|간부보고|보고서|추진현황|시연|설명문|발표|자료\s*작성/,
  },
  {
    id: "etc",
    title: "기타 / 미분류 업무",
    mark: "·",
    items: [
      "오늘 연락할 기관",
      "이번 주 받아야 할 자료",
      "답변이 오지 않은 요청",
      "다음 회의 전에 확정할 사항",
      "직접 작성해야 할 보고자료",
      "담당자가 정해지지 않은 사항",
      "기한이 정해지지 않은 사항",
      "반복적으로 지연되는 기관·업무",
    ],
    keywords: /.*/,
  },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

export function categoryTitle(id: CategoryId): string {
  return CATEGORY_BY_ID.get(id)?.title ?? "기타 / 미분류 업무";
}

/**
 * 문장을 카테고리로 보낸다.
 *
 * '기타'는 키워드가 전부라 항상 마지막에 걸린다 — 애매한 건 새 카테고리를
 * 만들지 않고 여기로 모은다.
 */
export function classify(text: string): Category {
  return CATEGORIES.find((category) => category.id !== "etc" && category.keywords.test(text))
    ?? CATEGORY_BY_ID.get("etc")!;
}

/** 카테고리 안에서 가장 가까운 기본 업무를 찾는다. 없으면 빈 문자열. */
export function matchItem(category: Category, text: string): string {
  const words = text.replace(/\s+/g, "");
  let best = "";
  let bestScore = 0;
  for (const item of category.items) {
    const tokens = item.split(/[\s·,()]+/).filter((token) => token.length >= 2);
    const score = tokens.filter((token) => words.includes(token)).length;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 1 ? best : "";
}
