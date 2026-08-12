import { toISODate } from "./text";

/**
 * 자연어에서 마감일·기관·중요도를 뽑는 규칙 기반 추출기.
 *
 * LLM을 쓰지 않는 이유가 있다. 공공 R&D 업무에서는 "왜 이렇게 분류됐는지"를
 * 담당자가 즉시 설명할 수 있어야 하고, 날짜를 지어내면 안 된다.
 * 그래서 규칙으로 뽑고, 확신이 없으면 비워 둔 뒤 사용자에게 채우게 한다.
 */

const WEEKDAYS: Record<string, number> = { 일요일: 0, 월요일: 1, 화요일: 2, 수요일: 3, 목요일: 4, 금요일: 5, 토요일: 6, 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

/**
 * 문장에서 마감일을 뽑는다. 못 찾으면 "" — 절대 오늘로 때우지 않는다.
 * @param baseISO 기준일(yyyy-mm-dd). 테스트 가능하도록 주입받는다.
 */
export function parseDeadline(text: string, baseISO: string): string {
  const base = new Date(`${baseISO}T00:00:00`);
  if (Number.isNaN(base.getTime())) return "";
  const shift = (days: number) => {
    const date = new Date(base);
    date.setDate(date.getDate() + days);
    return toISODate(date);
  };

  const full = text.match(/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;

  // 8/20, 8.20, 8월 20일 — 이미 지난 날짜면 내년으로 넘긴다.
  const short = text.match(/(?:^|[^\d])(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?/);
  if (short) {
    const month = Number(short[1]);
    const day = Number(short[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = base.getFullYear();
      const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (candidate >= baseISO) return candidate;
      return `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const dday = text.match(/\bD\s*[-–]\s*(\d+)/i);
  if (dday) return shift(Number(dday[1]));

  if (/모레|내일모레/.test(text)) return shift(2);
  if (/내일/.test(text)) return shift(1);
  if (/오늘|금일/.test(text)) return shift(0);

  const inDays = text.match(/(\d+)\s*(?:영업)?일\s*(?:이내|안에|후)/);
  if (inDays) return shift(Number(inDays[1]));
  const inWeeks = text.match(/(\d+)\s*주\s*(?:이내|안에|후)/);
  if (inWeeks) return shift(Number(inWeeks[1]) * 7);

  if (/이번\s?달\s?말|월말/.test(text)) {
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return toISODate(last);
  }
  if (/다음\s?달\s?말/.test(text)) {
    const last = new Date(base.getFullYear(), base.getMonth() + 2, 0);
    return toISODate(last);
  }

  const weekday = text.match(/(다음\s?주|이번\s?주|차주)?\s*([일월화수목금토](?:요일)?)(?:까지|에|,|\s|$)/);
  if (weekday) {
    const target = WEEKDAYS[weekday[2].replace("요일", "")];
    if (target != null) {
      const modifier = weekday[1] ?? "";
      if (modifier) {
        // "다음 주 화요일"은 다음 주(월요일 시작)의 화요일이다.
        // 오늘로부터 며칠 뒤인지로 계산하면 요일에 따라 한 주씩 밀린다.
        const mondayOffset = -((base.getDay() + 6) % 7);
        const weekStart = mondayOffset + (/다음\s?주|차주/.test(modifier) ? 7 : 0);
        return shift(weekStart + ((target + 6) % 7));
      }
      // 수식어가 없으면 "돌아오는 그 요일" — 오늘이면 다음 주로 민다.
      const diff = (target - base.getDay() + 7) % 7;
      return shift(diff === 0 ? 7 : diff);
    }
  }

  if (/다음\s?주|차주/.test(text)) return shift(7);
  if (/이번\s?주/.test(text)) return shift((5 - base.getDay() + 7) % 7 || 5); // 금요일 기준

  return "";
}

const TYPE_RULES: { type: string; pattern: RegExp }[] = [
  { type: "자료 요청", pattern: /요청|요구|달라|받아|수급|제공\s?요/ },
  { type: "제출 의무", pattern: /제출|납품|보고서\s?작성|등록해|올려/ },
  { type: "결정사항", pattern: /결정|확정|합의|채택|승인(?!\s?요청)/ },
  { type: "일정 변경", pattern: /연기|순연|변경|미뤄|앞당|재조정/ },
  { type: "회의·일정", pattern: /회의|미팅|점검|보고회|워크숍|간담/ },
  { type: "후속 확인", pattern: /확인|점검|체크|회신|답변|팔로업|follow/i },
];

/** 조사/구두점/문장끝이 뒤따를 때만 기관명으로 인정한다. "결과보고서"의 '과'에 걸리지 않게. */
const PARTICLE_AFTER = "(?=$|[\\s,.·]|에서|에게|에|은|는|이|가|의|와|과|도|만|께|으로|로|를|을)";

/** 문장에서 담당 주체를 찾는다. 기관명 → 사람 → 기본값(내 업무). */
export function extractOwner(text: string): string {
  // '청/부/과/팀'처럼 흔한 글자는 앞에 2글자 이상이 붙어야 기관으로 본다.
  const strong = new RegExp(`([A-Za-z가-힣]{1,10}(?:기관|대학교|대학|연구원|연구소|재단|공단|공사|기업|㈜))${PARTICLE_AFTER}`);
  const weak = new RegExp(`([A-Za-z가-힣]{2,10}(?:청|부|과|팀))${PARTICLE_AFTER}`);

  const institution = text.match(strong) ?? text.match(weak);
  if (institution) return institution[1].replace(/\s+/g, "");

  const person = text.match(/([가-힣]{2,4})\s?(연구원|박사|교수|팀장|과장|주무관|담당자|님)/);
  if (person) return `${person[1]} ${person[2]}`.trim();

  if (/전체\s?기관|모든\s?기관|각\s?기관/.test(text)) return "전체기관";
  return "내 업무";
}

/** 중요도. 사업 영향이 큰 단어가 있으면 상, 미루자는 신호가 있으면 하. */
export function scoreImportance(text: string): "상" | "중" | "하" {
  if (/지연|미제출|누락|긴급|즉시|반드시|필수|평가|감사|정산|간부|국회|장관|차관|승인/.test(text)) return "상";
  if (/제출|보고|회의|마감|예산|협약|실증/.test(text)) return "상";
  if (/아이디어|참고|나중에|여유|천천히|검토만|메모/.test(text)) return "하";
  return "중";
}

/** 액션이 담긴 문장인지. 순수 서술문은 업무로 만들지 않는다. */
function isActionable(sentence: string): boolean {
  if (sentence.replace(/\s/g, "").length < 6) return false;
  return /요청|제출|확인|회신|반영|결정|준비|검토|협의|작성|공유|전달|필요|해야|하기|하자|예정|까지|바랍|주세요|요망|점검|보완|수정|등록|연기|변경/.test(sentence);
}

/**
 * 줄·글머리표 단위의 덩어리. 담당기관과 마감일은 이 범위 안에서 공유된다.
 * ("A기관에서 자료 못 받음. 8/20까지 필요." 는 한 덩어리로 읽어야 기관과 마감이 이어진다.)
 */
export function splitBlocks(memo: string): string[] {
  return memo
    .split(/\n+|(?:^|\s)[-•*]\s+/g)
    .map((part) => part.trim().replace(/^[-•*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

/** 덩어리 안을 다시 문장으로 자른다. */
export function splitSentences(memo: string): string[] {
  return splitBlocks(memo)
    .flatMap((block) => block.split(/(?<=[.!?。])\s+/g))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 업무 제목: 날짜·기관 표현을 걷어낸 뒤 42자로 줄인다. */
export function toTitle(sentence: string): string {
  const cleaned = sentence
    .replace(/(20\d{2})\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/g, "")
    .replace(/\d{1,2}\s*[/.월]\s*\d{1,2}\s*일?\s*(?:까지)?/g, "")
    .replace(/(다음\s?주|이번\s?주|차주)?\s*[일월화수목금토]요일\s*(?:까지)?/g, "")
    .replace(/\bD\s*[-–]\s*\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.,·]+$/, "");
  return cleaned.slice(0, 42) || sentence.slice(0, 42);
}
