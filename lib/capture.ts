import { extractOwner, parseDeadline, toTitle } from "./nlp";
import { makeId, type MyTask } from "./mytask";
import { classify, matchItem } from "./worktree";

/**
 * 자연어 한 줄 → 업무 한 건.
 *
 * 폼을 여러 개 채우게 하지 않는 것이 전부다. 규칙으로 뽑고, 확신이 없는 값은
 * 지어내지 않고 비워 둔 채 사용자가 고치게 한다. 특히 날짜를 추측하지 않는다.
 */

/** 날짜로 못 바꾸지만 기한 역할을 하는 표현들. 그대로 보존해 화면에 띄운다. */
const RELATIVE_DEADLINES: { pattern: RegExp; label: string }[] = [
  { pattern: /다음\s*월간회의\s*(전|이전|까지)/, label: "다음 월간회의 이전" },
  { pattern: /다음\s*회의\s*(전|이전|까지)/, label: "다음 회의 이전" },
  { pattern: /중간보고(회)?\s*(전|이전|까지)/, label: "중간보고회 이전" },
  { pattern: /실무회의\s*(전|이전|까지)/, label: "실무회의 이전" },
  { pattern: /보고\s*전(에)?/, label: "보고 전" },
];

/**
 * 상태 판정. **내가 할 행동이 적혀 있으면 그것이 상태다.**
 * "아직 안 왔음. 다시 확인"처럼 상태와 행동이 같이 있으면 행동이 이긴다 —
 * 담당자가 보고 싶은 건 다음에 뭘 할지이지 지금 무슨 상태인지가 아니다.
 */
const STATUS_RULES: { pattern: RegExp; status: MyTask["status"] }[] = [
  { pattern: /요청|받아야|달라고|보내달라|요구/, status: "요청 필요" },
  { pattern: /확인|점검|체크|파악/, status: "확인 필요" },
  { pattern: /작성|정리|초안|만들/, status: "작성 중" },
  { pattern: /회신\s*없|답변\s*없|아직\s*(안|못)|무응답|대기\s*중/, status: "회신 대기" },
];

export type Draft = Omit<MyTask, "id" | "createdAt"> & { id: string; createdAt: string };

/** 한 문장을 업무 초안으로 바꾼다. */
export function capture(text: string, today: string): Draft {
  const clean = text.trim();
  const category = classify(clean);
  const org = extractOwner(clean);
  const relative = RELATIVE_DEADLINES.find((rule) => rule.pattern.test(clean));
  const due = parseDeadline(clean, today);

  const item = matchItem(category, clean);
  const title = toTitle(clean) || item || "새 업무";

  return {
    id: makeId(),
    title,
    categoryId: category.id,
    org: org === "내 업무" ? "" : org,
    // 상대 표현이 있으면 날짜를 억지로 만들지 않고 표현을 남긴다.
    due: relative ? "" : due,
    dueNote: relative?.label ?? "",
    status: STATUS_RULES.find((rule) => rule.pattern.test(clean))?.status ?? "확인 필요",
    awaiting: /회신|답변|아직\s*(안|못)|무응답|기다리/.test(clean),
    beforeMeeting: Boolean(relative) || /회의\s*전/.test(clean),
    blocksRnd: /지연|영향|막혀|밀려|선행|블로킹/.test(clean),
    note: clean,
    createdAt: today,
  };
}

/** 여러 줄을 한 번에 넣었을 때 줄마다 한 건씩 만든다. */
export function captureMany(text: string, today: string): Draft[] {
  return text
    .split(/\n+/)
    // 공공문서에서 붙여넣으면 □·ㅇ·○ 같은 글머리가 그대로 딸려 온다.
    // 지우지 않으면 업무 제목이 "□ 데이터 체계 구축"이 되고 분류 키워드도 밀린다.
    .map((line) => line.replace(/^[-•*○◯□■◇◆▶▪·ㆍㅇ\d.)\s]+/, "").trim())
    .filter((line) => line.replace(/\s/g, "").length >= 4)
    .map((line) => capture(line, today));
}
