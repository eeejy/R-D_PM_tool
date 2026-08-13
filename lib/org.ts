/**
 * 기관 마스터.
 *
 * 업무 분류를 8개 영역으로 고정한 것과 같은 이유로 **기관도 11개에서 늘리지 않는다.**
 * 자유 입력을 허용하면 "지엠티", "㈜지엠티", "GMT"가 각각 다른 기관으로 쌓여
 * 기관별 집계가 조용히 무너진다. 화면에서 기관을 추가하는 UI도 만들지 않는다 —
 * 기관 추가는 코드 수정 사항으로 둔다.
 *
 * 2~9번은 통합 WBS(`CDX_2026_WBS_260806.xlsx`)의 기관별 시트명에서 그대로 가져왔고,
 * 총괄시트의 기관별 진척 표와 일치한다. **여기에 상수로 고정하고 매번 파일에서 읽지
 * 않는다** — 파일이 바뀌면 기관이 조용히 늘어나기 때문이다.
 *
 * React를 import하지 않는다.
 */

export type OrgRole = "주관" | "공동" | "전문" | "기타";

export type OrgId =
  | "gmt" | "uwon" | "semyung" | "greenblue" | "exem"
  | "mit" | "dongguk" | "t3q" | "surromind"
  | "kimst" | "etc";

export interface Org {
  id: OrgId;
  /** 화면 표기명. WBS 시트명과 같게 둬서 집계를 맞춘다. */
  name: string;
  role: OrgRole;
  /** 매칭용 표기 변형. 실제 문서·메일에 나타나는 형태를 넣는다. */
  aliases: string[];
  /**
   * 회신 대기 임계일(영업일).
   * 주관은 짧게, 전문기관은 길게 둔다 — 실제 회신 관행이 다르기 때문이다.
   */
  replyDays: number;
}

/** 역할별 기본 임계일. 개별 기관에서 덮어쓸 수 있다. */
const REPLY_DAYS: Record<OrgRole, number> = { 주관: 3, 공동: 5, 전문: 7, 기타: 5 };

export const ORGS: Org[] = [
  {
    id: "gmt", name: "지엠티", role: "주관",
    aliases: ["지엠티", "㈜지엠티", "(주)지엠티", "지엠티(주)", "GMT"],
    replyDays: REPLY_DAYS.주관,
  },
  {
    id: "uwon", name: "유원GIS", role: "공동",
    aliases: ["유원GIS", "유원지아이에스", "유원", "UWON"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "semyung", name: "세명소프트", role: "공동",
    aliases: ["세명소프트", "㈜세명소프트", "세명"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "greenblue", name: "그린블루", role: "공동",
    aliases: ["그린블루", "㈜그린블루", "GreenBlue", "Green Blue"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "exem", name: "엑셈", role: "공동",
    aliases: ["엑셈", "㈜엑셈", "EXEM"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "mit", name: "MIT", role: "공동",
    // 짧은 영문 약칭이라 부분일치로 잡으면 submit·limit 같은 단어에 걸린다.
    // 아래 매칭이 영문 별칭에 단어 경계를 요구하는 이유가 이것이다.
    aliases: ["MIT", "엠아이티"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "dongguk", name: "동국대", role: "공동",
    aliases: ["동국대", "동국대학교", "동국대 산학협력단", "동국대학교 산학협력단"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "t3q", name: "T3Q", role: "공동",
    aliases: ["T3Q", "㈜T3Q", "티쓰리큐"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "surromind", name: "써로마인드", role: "공동",
    aliases: ["써로마인드", "㈜써로마인드", "Surromind", "서로마인드"],
    replyDays: REPLY_DAYS.공동,
  },
  {
    id: "kimst", name: "KIMST", role: "전문",
    aliases: ["KIMST", "해양수산과학기술진흥원", "과학기술진흥원", "진흥원", "전문기관"],
    replyDays: REPLY_DAYS.전문,
  },
  {
    id: "etc", name: "기타 / 미분류", role: "기타",
    // 폴백이라 별칭이 없다. 여기에 항목이 쌓이면 위 별칭을 보강하라는 신호다.
    aliases: [],
    replyDays: REPLY_DAYS.기타,
  },
];

export const ORG_BY_ID = new Map<OrgId, Org>(ORGS.map((org) => [org.id, org]));
export const ETC: Org = ORG_BY_ID.get("etc")!;

/** WBS 시트가 있는 기관. KIMST와 기타는 진척 집계 대상이 아니다. */
export const WBS_ORGS: Org[] = ORGS.filter((org) => org.role === "주관" || org.role === "공동");

export function orgName(id: OrgId | undefined): string {
  return (id && ORG_BY_ID.get(id)?.name) ?? ETC.name;
}

export function orgRole(id: OrgId | undefined): OrgRole {
  return (id && ORG_BY_ID.get(id)?.role) ?? "기타";
}

export function replyDaysOf(id: OrgId | undefined): number {
  return (id && ORG_BY_ID.get(id)?.replyDays) ?? ETC.replyDays;
}

/**
 * 비교용 정규화. 공백·법인 표기·구두점을 걷어낸다.
 * "㈜ 지엠티(주)"와 "지엠티"가 같은 문자열이 되어야 한다.
 */
export function normalizeOrg(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/㈜|\(주\)|주식회사|\(재\)|재단법인/g, "")
    .replace(/[\s·・.,/\\|~\-_'"“”‘’()[\]{}]/g, "")
    .toLowerCase();
}

/** 영문·숫자로만 이뤄진 별칭인가. 단어 경계를 요구할지 정하는 기준이다. */
function isLatin(alias: string): boolean {
  return /^[A-Za-z0-9]+$/.test(alias);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 별칭 하나가 문장에 나타나는가.
 *
 * 한글 별칭은 정규화 후 부분일치로 충분하다. 반면 영문 약칭(MIT, GMT, T3Q)을
 * 부분일치로 잡으면 `submit`, `limit` 같은 평범한 단어에 걸려 엉뚱한 기관이 붙는다.
 * 그래서 영문 별칭에만 앞뒤 글자 조건을 건다.
 */
function aliasHits(alias: string, raw: string, normalized: string): boolean {
  if (isLatin(alias)) {
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(alias)}([^A-Za-z0-9]|$)`, "i").test(raw);
  }
  const target = normalizeOrg(alias);
  return target.length > 0 && normalized.includes(target);
}

export type OrgMatch = {
  org: Org;
  /** 후보가 둘 이상이면 '기타'로 보내고 여기에 후보를 담는다. 화면에 함께 띄운다. */
  candidates: Org[];
};

/**
 * 문장에서 기관을 찾는다.
 *
 * **LLM에는 기관을 추론시키지 않는다.** 8B 모델은 처음 보는 기관명을 그럴듯하게
 * 지어내기 때문에, 문장에서 기관을 뽑는 일은 전부 이 별칭 매칭이 한다.
 *
 * 후보가 둘이면 고르지 않고 '기타'로 보낸다. 반반 확률로 찍는 것보다 사람이
 * 고치게 하는 편이 낫고, 무엇과 무엇 사이에서 헷갈렸는지도 함께 돌려준다.
 */
export function matchOrg(text: string): OrgMatch {
  const raw = String(text ?? "");
  const normalized = normalizeOrg(raw);
  if (!normalized) return { org: ETC, candidates: [] };

  const hits = ORGS.filter(
    (org) => org.id !== "etc" && org.aliases.some((alias) => aliasHits(alias, raw, normalized)),
  );

  if (hits.length === 1) return { org: hits[0], candidates: [] };
  if (hits.length > 1) return { org: ETC, candidates: hits };
  return { org: ETC, candidates: [] };
}

/** 화면·스키마에서 쓰는 id 목록. LLM 스키마의 enum도 이 값으로 고정한다. */
export const ORG_IDS: OrgId[] = ORGS.map((org) => org.id);

/** 문자열이 기관 id인지. 저장된 자료나 모델 응답을 받아들일 때 쓴다. */
export function isOrgId(value: unknown): value is OrgId {
  return typeof value === "string" && ORG_BY_ID.has(value as OrgId);
}
