/**
 * 회의록 → 쟁점·결정·액션 추출 및 1페이지 보고서.
 *
 * 8B급 모델의 최대 약점은 긴 입력의 뒷부분을 조용히 흘리는 것이다. 2만 자를 한 번에
 * 던지면 마지막 안건이 통째로 사라지는데 결과는 멀쩡해 보인다. 그래서
 *
 *   회의록 → [룰] 안건 경계로 분할 → [LLM] 안건마다 개별 호출 → [룰] 병합·1p 구성
 *
 * 으로 간다. 호출이 5~10회로 늘어 30초~1분 걸리지만 실시간 작업이 아니다.
 *
 * `sourceSegment`는 이 기능의 핵심이다. RFP 검색의 "몇 쪽에 있는지"와 같은 철학으로,
 * 어느 발언에서 나온 결론인지 되짚을 수 있어야 한다. 그래서 세그먼트 번호는 모델
 * 출력에서 받지 않고 **호출한 쪽이 붙인다** — 모델이 번호를 지어낼 여지를 없앤다.
 */

import { capture, type Draft } from "./capture";
import { asText, asTextList, isRecord, oneLine, parseResponse, type LlmCall } from "./llm";
import { parseCellDate } from "./text";

/** 회의록을 안건 단위로 자른 한 조각. */
export type Segment = {
  /** 1부터. 화면과 보고서가 이 번호로 원문을 되짚는다. */
  index: number;
  /** 안건 제목(경계로 잡힌 줄). 못 찾으면 빈 문자열 */
  heading: string;
  text: string;
};

/**
 * 안건 경계로 쓰는 표기들.
 *
 * 공공 회의록은 서식이 제각각이라 한 가지 규칙으로는 못 자른다. 실제로 섞여 나오는
 * 번호·기호를 모아 뒀고, 어느 것도 안 걸리면 문단 단위로 떨어진다.
 */
const HEADING_PATTERNS: RegExp[] = [
  /^\s*(?:안건|의제|논의\s*사항|토의\s*안건)\s*(?:\d+)?\s*[.:)\]]?\s*/,
  /^\s*\d{1,2}\s*[.)]\s+\S/,
  /^\s*[가나다라마바사아자차카타파하]\s*[.)]\s+\S/,
  /^\s*[○◯□■▶◆●▪·]\s+\S/,
  /^\s*\[[^\]]{1,30}\]\s*$/,
];

/** 제목 줄은 짧다. 긴 문장이 번호로 시작했다고 해서 안건 제목은 아니다. */
const MAX_HEADING_LENGTH = 60;

/** 한 세그먼트가 이보다 길면 모델이 뒷부분을 흘린다. 문단 경계로 한 번 더 자른다. */
export const MAX_SEGMENT_CHARS = 2500;

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return false;
  return HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 안건 경계로 회의록을 나눈다. LLM을 쓰지 않는다 — 경계는 서식이 알려 준다. */
export function splitAgenda(text: string): Segment[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks: { heading: string; lines: string[] }[] = [];

  for (const line of lines) {
    if (isHeading(line)) {
      blocks.push({ heading: line.trim(), lines: [line] });
      continue;
    }
    if (!blocks.length) {
      if (!line.trim()) continue;
      blocks.push({ heading: "", lines: [line] });
      continue;
    }
    blocks[blocks.length - 1].lines.push(line);
  }

  const merged = blocks
    .map((block) => ({ heading: block.heading, text: block.lines.join("\n").trim() }))
    .filter((block) => block.text.length > 0);

  // 경계를 하나도 못 찾았으면 문단으로라도 나눈다. 통째로 던지는 것보다 늘 낫다.
  const source = merged.length > 1 ? merged : splitByParagraph(merged[0]?.text ?? String(text ?? ""));

  const segments: Segment[] = [];
  for (const block of source) {
    // 길어서 다시 잘린 조각은 제목을 물려받지 않는다 — 같은 제목이 여러 번 나오면
    // 화면에서 어느 쪽을 되짚어야 할지 알 수 없게 된다.
    capSegment(block.text).forEach((piece, order) => {
      segments.push({ index: segments.length + 1, heading: order === 0 ? block.heading : "", text: piece });
    });
  }
  return segments.filter((segment) => segment.text.replace(/\s/g, "").length >= 10);
}

function splitByParagraph(text: string): { heading: string; text: string }[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ heading: "", text: part }));
}

/**
 * 너무 긴 조각을 다시 자른다.
 *
 * 줄 경계 → 문장 경계 → 글자 수 순으로 물러선다. 녹취를 그대로 붙여넣으면 줄바꿈
 * 없는 1만 자 한 덩어리가 들어오는데, 줄 경계만 보고 포기하면 그때 뒷부분이 잘린다.
 */
function capSegment(text: string): string[] {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];

  const pieces: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim()) pieces.push(buffer.trim());
    buffer = "";
  };

  for (const line of text.split(/\r?\n/)) {
    for (const chunk of splitLongLine(line)) {
      if (buffer && buffer.length + chunk.length > MAX_SEGMENT_CHARS) flush();
      buffer += (buffer ? "\n" : "") + chunk;
    }
  }
  flush();
  return pieces.length ? pieces : [text];
}

/** 한 줄 자체가 한도를 넘으면 문장 끝에서, 그래도 안 되면 글자 수로 자른다. */
function splitLongLine(line: string): string[] {
  if (line.length <= MAX_SEGMENT_CHARS) return [line];
  const sentences = line.match(/[^.!?。]*[.!?。]+\s*|[^.!?。]+$/g) ?? [line];
  const chunks: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    for (let start = 0; start < sentence.length; start += MAX_SEGMENT_CHARS) {
      const part = sentence.slice(start, start + MAX_SEGMENT_CHARS);
      if (buffer && buffer.length + part.length > MAX_SEGMENT_CHARS) {
        chunks.push(buffer);
        buffer = "";
      }
      buffer += part;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/* ── 회의 정보 ──────────────────────────────────────────── */

export type MeetingMeta = { title: string; date: string; attendees: string[] };

/**
 * 제목·일시·참석자는 규칙으로 뽑는다.
 *
 * 회의록 머리에 정해진 자리로 적혀 있는 값이라 모델을 쓸 이유가 없고,
 * 모델에 맡기면 참석자 이름을 가장 먼저 지어낸다.
 */
export function parseMeetingMeta(text: string, fallbackDate: string): MeetingMeta {
  const head = String(text ?? "").split(/\r?\n/).slice(0, 25);
  const find = (pattern: RegExp) => {
    for (const line of head) {
      const match = line.match(pattern);
      if (match) return (match[1] ?? "").trim();
    }
    return "";
  };

  const title =
    find(/^\s*(?:회의\s*명|제\s*목|건\s*명)\s*[:：]\s*(.+)$/) ||
    head.map((line) => line.trim()).find((line) => /회의|간담회|워크숍|보고회/.test(line) && line.length <= 60) ||
    "회의";

  const rawDate = find(/^\s*(?:일\s*시|일\s*자|날\s*짜)\s*[:：]\s*(.+)$/);
  const date = parseCellDate(rawDate) || parseCellDate(head.join(" ")) || fallbackDate;

  const attendeeLine = find(/^\s*(?:참\s*석\s*자?|참\s*여\s*자|배\s*석)\s*[:：]\s*(.+)$/);
  const attendees = attendeeLine
    ? attendeeLine.split(/[,、·/]|\s{2,}/).map((name) => name.trim()).filter((name) => name.length >= 2 && name.length <= 30)
    : [];

  return { title: title.replace(/^[[［]|[\]］]$/g, "").trim(), date, attendees };
}

/* ── LLM 입출력 ──────────────────────────────────────────── */

export const MINUTES_SYSTEM = [
  "당신은 공공 R&D 사업 회의록에서 사실만 뽑아내는 보조자입니다.",
  "주어진 안건 한 건의 원문에서 쟁점·결정사항·후속조치를 추출합니다.",
  "다음을 반드시 지킵니다.",
  "- 원문에 없는 내용을 만들지 않습니다. 기관명·날짜·수치·발언자는 원문에 적힌 것만 씁니다.",
  "- 원문에 없는 항목은 빈 배열로 둡니다. 억지로 채우지 않습니다.",
  "- 쟁점(issues)은 의견이 갈린 사안이고, 결정(decisions)은 확정된 사항이며, 후속조치(actions)는 누가 언제까지 할 일입니다.",
  "- owner와 due는 원문에 있을 때만 채우고, 없으면 빈 문자열로 둡니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

const SEGMENT_EXAMPLE = `{"issues":[{"topic":"실증 대상지 선정","positions":["A기관은 상반기 내 확정을 요청","B기관은 데이터 확보 이후 검토가 필요하다는 입장"]}],"decisions":[{"text":"실증 대상지는 다음 월간회의에서 확정하기로 함"}],"actions":[{"text":"후보지 3곳 비교표 작성","owner":"A기관","due":"2026-08-20"}]}`;

export function buildSegmentPrompt(segment: Segment, meta: MeetingMeta): string {
  return [
    `회의명: ${meta.title}`,
    `회의일: ${meta.date}`,
    `안건 ${segment.index}${segment.heading ? ` — ${segment.heading}` : ""}`,
    "",
    "[안건 원문]",
    segment.text,
    "",
    "위 안건에서 쟁점·결정사항·후속조치를 뽑아내세요.",
    "[출력 형식 예시]",
    SEGMENT_EXAMPLE,
    "",
    "위 형식의 JSON만 출력하세요.",
  ].join("\n");
}

export type Issue = { topic: string; positions: string[]; sourceSegment: number };
export type Decision = { text: string; sourceSegment: number };
export type Action = { text: string; owner: string; due: string; sourceSegment: number };

export type SegmentResult = {
  issues: Omit<Issue, "sourceSegment">[];
  decisions: Omit<Decision, "sourceSegment">[];
  actions: Omit<Action, "sourceSegment">[];
};

/** 세 배열 중 하나라도 배열로 오면 받아들인다. 셋 다 아니면 형식 위반으로 본다. */
export function validateSegmentOutput(value: unknown): SegmentResult | null {
  if (!isRecord(value)) return null;
  const hasAny = ["issues", "decisions", "actions"].some((key) => Array.isArray(value[key]));
  if (!hasAny) return null;

  return {
    issues: toArray(value.issues)
      .map((entry) => {
        if (!isRecord(entry)) {
          const text = oneLine(entry);
          return text ? { topic: text, positions: [] } : null;
        }
        const topic = oneLine(entry.topic ?? entry.issue ?? entry.text);
        return topic ? { topic, positions: asTextList(entry.positions).map(oneLine).filter(Boolean) } : null;
      })
      .filter((entry): entry is Omit<Issue, "sourceSegment"> => entry !== null),

    decisions: toArray(value.decisions)
      .map((entry) => oneLine(isRecord(entry) ? entry.text ?? entry.decision : entry))
      .filter(Boolean)
      .map((text) => ({ text })),

    actions: toArray(value.actions)
      .map((entry) => {
        if (!isRecord(entry)) {
          const text = oneLine(entry);
          return text ? { text, owner: "", due: "" } : null;
        }
        const text = oneLine(entry.text ?? entry.action ?? entry.task);
        if (!text) return null;
        return {
          text,
          owner: oneLine(entry.owner ?? entry.assignee ?? entry.기관),
          // 날짜는 형식이 맞을 때만 받는다. "다음 주"처럼 온 값은 버리고 비워 둔다.
          due: parseCellDate(asText(entry.due ?? entry.deadline)),
        };
      })
      .filter((entry): entry is Omit<Action, "sourceSegment"> => entry !== null),
  };
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ── 결과 조립 ──────────────────────────────────────────── */

export type MinutesReport = {
  meeting: MeetingMeta;
  issues: Issue[];
  decisions: Decision[];
  actions: Action[];
  segments: Segment[];
  /** 모델이 실패한 안건 번호. 화면에 그대로 알려 준다 — 조용히 빠지는 게 가장 나쁘다. */
  failedSegments: number[];
};

/** 안건별 결과를 하나로 합친다. 여기서 `sourceSegment`가 붙는다. */
export function mergeMinutes(
  meta: MeetingMeta,
  segments: Segment[],
  results: (SegmentResult | null)[],
): MinutesReport {
  const report: MinutesReport = { meeting: meta, issues: [], decisions: [], actions: [], segments, failedSegments: [] };

  segments.forEach((segment, order) => {
    const result = results[order];
    if (!result) {
      report.failedSegments.push(segment.index);
      return;
    }
    for (const issue of result.issues) report.issues.push({ ...issue, sourceSegment: segment.index });
    for (const decision of result.decisions) report.decisions.push({ ...decision, sourceSegment: segment.index });
    for (const action of result.actions) report.actions.push({ ...action, sourceSegment: segment.index });
  });

  return report;
}

export type MinutesProgress = { done: number; total: number; segment: number };

/**
 * 회의록 한 건을 처리한다.
 *
 * 안건마다 순차로 호출한다. 팬 없는 맥북에어에서 병렬로 돌리면 3~4분째부터
 * 클럭이 떨어져 전체가 더 느려진다. 대신 `onProgress`로 진행률을 알린다.
 */
export async function generateMinutes(
  text: string,
  today: string,
  call: LlmCall | null,
  options: { onProgress?: (progress: MinutesProgress) => void; signal?: AbortSignal } = {},
): Promise<MinutesReport> {
  const meta = parseMeetingMeta(text, today);
  const segments = splitAgenda(text);
  if (!call) return mergeMinutes(meta, segments, segments.map(() => null));

  const results: (SegmentResult | null)[] = [];
  for (const segment of segments) {
    if (options.signal?.aborted) break;
    try {
      const raw = await call(buildSegmentPrompt(segment, meta), MINUTES_SYSTEM);
      results.push(parseResponse(raw, validateSegmentOutput));
    } catch {
      // 한 안건이 실패해도 나머지는 계속한다. 실패한 번호는 결과에 남는다.
      results.push(null);
    }
    options.onProgress?.({ done: results.length, total: segments.length, segment: segment.index });
  }

  // 중단된 경우 남은 안건은 실패로 채워 개수를 맞춘다
  while (results.length < segments.length) results.push(null);

  return mergeMinutes(meta, segments, results);
}

/**
 * 1페이지 보고서.
 *
 * 여기에는 LLM을 쓰지 않는다. 이미 뽑아낸 사실을 정해진 순서로 늘어놓는 일이라
 * 템플릿이면 충분하고, 매번 같은 모양으로 나오는 편이 결재선에서 읽기 좋다.
 */
export function renderOnePager(report: MinutesReport): string {
  const lines: string[] = [
    `${report.meeting.title} 개최 결과`,
    "",
    `□ 일시: ${report.meeting.date}`,
    `□ 참석: ${report.meeting.attendees.join(", ") || "(미기재)"}`,
    `□ 안건: ${report.segments.length}건`,
    "",
  ];

  const section = (title: string, body: string[]) => {
    lines.push(`□ ${title}`);
    lines.push(...(body.length ? body : ["  - 해당 없음"]));
    lines.push("");
  };

  section("주요 쟁점", report.issues.map((issue) =>
    [`  - ${issue.topic} (안건 ${issue.sourceSegment})`, ...issue.positions.map((position) => `    · ${position}`)].join("\n"),
  ));
  section("결정사항", report.decisions.map((decision) => `  - ${decision.text} (안건 ${decision.sourceSegment})`));
  section("후속조치", report.actions.map((action) =>
    `  - ${action.text}${action.owner ? ` [${action.owner}]` : ""}${action.due ? ` ~${action.due}` : ""} (안건 ${action.sourceSegment})`,
  ));

  if (report.failedSegments.length) {
    lines.push(`※ 안건 ${report.failedSegments.join(", ")}번은 자동 추출에 실패했습니다. 원문을 직접 확인해 주세요.`);
  }

  return lines.join("\n").trimEnd();
}

/**
 * 후속조치 → 업무 초안.
 *
 * 회의록에서 업무가 바로 등록되는 것이 이 기능의 진짜 값어치다. 문장 해석은
 * 기존 빠른 입력(`capture`)이 그대로 하고, 회의록이 더 잘 아는 담당기관·기한만 덮어쓴다.
 */
export function actionsToDrafts(actions: Action[], today: string): Draft[] {
  return actions.map((action) => {
    const draft = capture(action.text, today);
    return {
      ...draft,
      org: action.owner || draft.org,
      due: action.due || draft.due,
      dueNote: action.due ? "" : draft.dueNote,
      note: `${action.text}${action.owner ? ` [${action.owner}]` : ""} (회의록 안건 ${action.sourceSegment})`,
    };
  });
}
