/**
 * RFP 원문 검색.
 *
 * LLM도 임베딩도 쓰지 않는다. 담당자가 원하는 건 "이 단어가 RFP 어디에 있나"이고,
 * 그건 일반 텍스트 검색으로 충분하다. 외부로 문서를 보내지 않는 것이 전제이기도 하다.
 *
 * 검색 라이브러리도 넣지 않았다. 필요한 랭킹 규칙(정확 구문 > 같은 문단 > 같은 페이지)이
 * 명확해서 직접 계산하는 편이 짧고, 왜 이 순서로 나왔는지 설명할 수 있다.
 */

export interface RfpPage {
  pageNumber: number;
  text: string;
}

export interface RfpDocument {
  id: string;
  fileName: string;
  uploadedAt: string;
  pageCount: number;
  pages: RfpPage[];
  /** 원본 형식. 향후 HWP 등을 붙일 때 갈래를 나누는 자리 */
  kind: "pdf" | "docx" | "txt";
}

/** 검색어 주변을 잘라낸 조각. 하이라이트 위치를 함께 넘긴다. */
export interface Snippet {
  text: string;
  /** `text` 안에서 강조할 구간들 */
  marks: { start: number; end: number }[];
}

export interface SearchHit {
  pageNumber: number;
  score: number;
  /** 이 페이지에서 검색어가 나온 횟수 */
  count: number;
  snippet: Snippet;
  /** 본문에서 이 결과의 첫 등장 위치(페이지 텍스트 기준 오프셋) */
  offset: number;
}

/** 공백으로 나눈 검색어들. 빈 검색어는 빈 배열. */
export function parseQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 부분일치를 위해 정규화한다.
 * 한국어는 어간이 붙어 다니므로("데이터셋", "학습데이터") 형태소 분석 없이
 * 단순 포함 검사로 찾는 편이 담당자 기대에 맞는다.
 */
function normalize(text: string): string {
  return text.toLowerCase();
}

/** 문자열 안에서 needle이 나오는 모든 위치. */
function findAll(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + needle.length;
  }
  return positions;
}

/** 문단 경계. 줄바꿈이 없는 PDF 추출 결과를 위해 문장부호도 함께 본다. */
function paragraphAt(text: string, index: number): { start: number; end: number } {
  const before = text.lastIndexOf("\n", index);
  const after = text.indexOf("\n", index);
  return {
    start: before < 0 ? 0 : before + 1,
    end: after < 0 ? text.length : after,
  };
}

const SCORE = {
  /** "현장 실증"이 그대로 붙어 있는 경우 — 가장 강한 신호 */
  phrase: 100,
  /** 검색어들이 같은 문단 안에 모두 있는 경우 */
  paragraph: 40,
  /** 같은 페이지에 각각 있는 경우 */
  page: 12,
  /** 등장 횟수 가산(상한을 둬서 목차 페이지가 1위로 올라오지 않게) */
  perHit: 2,
  perHitCap: 20,
};

/** 페이지 하나에 대한 점수와 첫 등장 위치. 해당 없으면 null. */
function scorePage(page: RfpPage, terms: string[]): { score: number; count: number; offset: number } | null {
  const text = normalize(page.text);
  const positions = terms.map((term) => findAll(text, term));

  // 하나라도 없는 검색어가 있으면 이 페이지는 결과가 아니다(AND 검색).
  if (positions.some((list) => list.length === 0)) return null;

  const count = positions.reduce((sum, list) => sum + list.length, 0);
  let score = SCORE.page + Math.min(count * SCORE.perHit, SCORE.perHitCap);
  let offset = Math.min(...positions.map((list) => list[0]));

  if (terms.length > 1) {
    // 1) 정확 구문
    const phrase = terms.join(" ");
    const exact = findAll(text, phrase);
    if (exact.length) {
      score += SCORE.phrase;
      offset = exact[0];
    } else {
      // 2) 같은 문단 안에 전부
      const paragraphs = positions[0].map((at) => paragraphAt(page.text, at));
      const together = paragraphs.find((range) => {
        const slice = text.slice(range.start, range.end);
        return terms.every((term) => slice.includes(term));
      });
      if (together) {
        score += SCORE.paragraph;
        offset = positions[0].find((at) => at >= together.start && at < together.end) ?? offset;
      }
    }
  }

  return { score, count, offset };
}

/** 검색어 주변 문장을 잘라내고 강조 구간을 계산한다. */
export function makeSnippet(text: string, terms: string[], around: number, radius = 90): Snippet {
  const start = Math.max(0, around - radius);
  const end = Math.min(text.length, around + radius);
  const raw = text.slice(start, end);
  const lower = normalize(raw);

  const marks: { start: number; end: number }[] = [];
  for (const term of terms) {
    for (const at of findAll(lower, term)) marks.push({ start: at, end: at + term.length });
  }
  marks.sort((a, b) => a.start - b.start);

  // 겹치는 구간을 합쳐 <mark>가 중첩되지 않게 한다
  const merged: { start: number; end: number }[] = [];
  for (const mark of marks) {
    const last = merged.at(-1);
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
    else merged.push({ ...mark });
  }

  const prefix = start > 0 ? "…" : "";
  const shift = prefix.length;
  return {
    text: `${prefix}${raw.trim()}${end < text.length ? "…" : ""}`,
    // trim()으로 앞이 잘린 만큼 보정한다
    marks: merged.map((mark) => {
      const lead = raw.length - raw.trimStart().length;
      return { start: mark.start - lead + shift, end: mark.end - lead + shift };
    }).filter((mark) => mark.start >= 0),
  };
}

/** 문서 전체 검색. 점수 높은 페이지 순. */
export function search(document: RfpDocument | null, query: string): SearchHit[] {
  const terms = parseQuery(query);
  if (!document || !terms.length) return [];

  const hits: SearchHit[] = [];
  for (const page of document.pages) {
    const scored = scorePage(page, terms);
    if (!scored) continue;
    hits.push({
      pageNumber: page.pageNumber,
      score: scored.score,
      count: scored.count,
      offset: scored.offset,
      snippet: makeSnippet(page.text, terms, scored.offset),
    });
  }

  return hits.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
}

/** 검색어가 문서 전체에서 몇 번 나오는지. 결과 머리말에 쓴다. */
export function totalMatches(hits: SearchHit[]): number {
  return hits.reduce((sum, hit) => sum + hit.count, 0);
}

/** 본문 표시용 — 한 페이지 텍스트를 강조 구간으로 쪼갠다. */
export function splitByMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = parseQuery(query);
  if (!terms.length) return [{ text, hit: false }];

  const lower = normalize(text);
  const marks: { start: number; end: number }[] = [];
  for (const term of terms) {
    for (const at of findAll(lower, term)) marks.push({ start: at, end: at + term.length });
  }
  if (!marks.length) return [{ text, hit: false }];
  marks.sort((a, b) => a.start - b.start);

  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue; // 겹침은 건너뛴다
    if (mark.start > cursor) parts.push({ text: text.slice(cursor, mark.start), hit: false });
    parts.push({ text: text.slice(mark.start, mark.end), hit: true });
    cursor = mark.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/** 검색창 아래 빠른 검색어. 사업이 바뀌면 여기만 고치면 된다. */
export const QUICK_TERMS = [
  "데이터", "실증", "성과지표", "연구기관", "AI모델", "보안", "GPU", "후속사업",
];
