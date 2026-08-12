/** 한국어 사업자료를 비교하기 위한 문자열/날짜 유틸. 순수 함수만 둔다. */

/** 비교용 정규화: 공백·문장부호·전각문자·괄호주석을 걷어낸다. */
export function normalize(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, " ") // (2차), [수정] 같은 주석 제거
    .replace(/[\s​]+/g, "")
    .replace(/[·・.,/\\|~\-_'"“”‘’:;!?]/g, "")
    .toLowerCase();
}

/** 문자 바이그램 집합. 한국어는 형태소 분석 없이도 바이그램이 잘 먹는다. */
function bigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  if (value.length === 1) set.add(value);
  return set;
}

/**
 * Sørensen–Dice 유사도(0–1).
 * "XAI 검증" ↔ "모델 설명가능성 검증"처럼 표현만 바뀐 항목을 이어붙이는 데 쓴다.
 */
export function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const x = bigrams(left);
  const y = bigrams(right);
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

/** yyyy-mm-dd. 로컬 타임존 기준이라 UTC 변환으로 하루 밀리는 일이 없다. */
export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 엑셀 셀 값을 ISO 날짜로. 엑셀 serial, Date, 한국어 표기를 모두 받는다.
 * 판별 못 하면 ""를 돌려주고 절대 추측하지 않는다.
 */
export function parseCellDate(value: unknown, fallbackYear = new Date().getFullYear()): string {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toISODate(roundToDay(value));

  if (typeof value === "number" && Number.isFinite(value)) {
    // 엑셀 serial(1900 체계). 1..80000 밖은 날짜로 보지 않는다.
    if (value < 1 || value > 80000) return "";
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + Math.round(value) * 86400000);
    return toISODate(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  const text = String(value).trim();
  const full = text.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;

  const short = text.match(/^(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (short) return `${fallbackYear}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;

  return "";
}

/**
 * 가장 가까운 날짜로 반올림.
 *
 * 엑셀 날짜가 SheetJS를 거치면 자정에서 몇 초 어긋난 값으로 나오는 일이 잦다
 * (2026-01-01이 로컬 2025-12-31 23:59:08로). 잘라내면 하루가 통째로 밀리므로
 * 반드시 반올림해야 한다. 실제 기관 WBS에서 확인된 문제다.
 */
export function roundToDay(date: Date): Date {
  const rounded = new Date(date);
  if (rounded.getHours() >= 12) rounded.setDate(rounded.getDate() + 1);
  rounded.setHours(0, 0, 0, 0);
  return rounded;
}

/** 0–100 진행률. "80%", 0.8, "80" 을 모두 같은 값으로 본다. */
export function parseProgress(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // 0–1 스케일로 저장된 엑셀 백분율 서식
    return clampPercent(value > 0 && value <= 1 ? value * 100 : value);
  }
  const text = String(value).trim();
  if (/^완료|^종료|^done$/i.test(text)) return 100;
  if (/^미착수|^대기|^예정$/.test(text)) return 0;
  const num = text.match(/(-?\d+(?:\.\d+)?)\s*%?/);
  if (!num) return null;
  const parsed = Number(num[1]);
  if (!Number.isFinite(parsed)) return null;
  return clampPercent(text.includes("%") || parsed > 1 ? parsed : parsed * 100);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 기준일에서 목표일까지 남은 일수. 음수면 이미 지난 것. */
export function daysBetween(fromISO: string, toISO: string): number | null {
  if (!fromISO || !toISO) return null;
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

/** "8월 20일" 처럼 보고문에 넣기 좋은 표기. */
export function formatKoreanDate(iso: string): string {
  if (!iso) return "기한 미정";
  const [, month, day] = iso.split("-");
  if (!month || !day) return iso;
  return `${Number(month)}월 ${Number(day)}일`;
}
