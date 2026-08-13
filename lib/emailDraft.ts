/**
 * 회의·기관 요청사항 → 발송용 이메일 초안.
 *
 * **구조는 템플릿, 문장만 LLM.** 공문·요청 메일은 형식이 정해져 있어 수신·제목·
 * 인사·기한·회신처·맺음은 규칙으로 채우면 된다. 모델이 맡는 건 메모투 한 줄
 * ("데이터 3종 아직 안 옴")을 정중한 배경·요청 문장으로 바꾸는 부분뿐이다.
 *
 * 기관명·날짜는 모델 출력에서 받지 않고 **원본 업무 데이터에서 주입한다.**
 * 8B급 모델이 가장 자주 지어내는 게 이 둘이라, 아예 통로를 막아 둔다.
 */

import type { MyTask } from "./mytask";
import { daysBetween, formatKoreanDate } from "./text";
import { categoryTitle } from "./worktree";
import { asText, asTextList, isRecord, oneLine, parseResponse, type LlmCall } from "./llm";

/** 메일에 들어갈 사실 한 줄. 전부 등록된 업무에서 나온 값이다. */
export type EmailFact = {
  id: string;
  text: string;
  category: string;
  status: string;
  dueLabel: string;
};

/** 규칙으로 채운 뼈대. 여기에 LLM 문장만 얹으면 메일이 완성된다. */
export type EmailSkeleton = {
  recipients: string[];
  subject: string;
  greeting: string;
  /** ISO yyyy-mm-dd. 여러 건이면 가장 이른 기한 */
  deadline: string;
  deadlineLine: string;
  replyLine: string;
  closing: string;
  facts: EmailFact[];
  sourceIds: string[];
};

export type EmailSender = {
  projectName: string;
  department: string;
  name: string;
  contact: string;
};

export const EMPTY_SENDER: EmailSender = { projectName: "", department: "", name: "", contact: "" };

/**
 * 업무 여러 건으로 메일 한 통의 뼈대를 만든다.
 *
 * 같은 기관에 보낼 건은 한 통으로 묶는 편이 실제 업무에 맞다 — 요청 메일이
 * 하루에 세 통 가면 받는 쪽에서 우선순위를 잃는다.
 */
export function buildEmailSkeleton(tasks: MyTask[], sender: EmailSender, today: string): EmailSkeleton {
  const org = tasks.map((task) => task.org).find(Boolean) ?? "";
  const dues = tasks.map((task) => task.due).filter(Boolean).sort();
  const deadline = dues[0] ?? "";
  const dueNote = tasks.map((task) => task.dueNote).find(Boolean) ?? "";

  const subject = buildSubject(tasks, sender.projectName);
  const facts: EmailFact[] = tasks.map((task) => ({
    id: task.id,
    text: (task.note || task.title).replace(/\s+/g, " ").trim(),
    category: categoryTitle(task.categoryId),
    status: task.status,
    dueLabel: task.due ? formatKoreanDate(task.due) : task.dueNote || "기한 미정",
  }));

  // 이미 지난 기한을 그대로 "회신 기한입니다"라고 쓰면 받는 쪽이 먼저 이상하게 여긴다.
  // 경과한 사실을 밝히고 새 일정을 묻는 문장으로 바꾼다.
  const overdue = Boolean(deadline) && (daysBetween(today, deadline) ?? 0) < 0;

  return {
    recipients: org ? [org] : [],
    subject,
    greeting: `${org ? `${org} ` : ""}담당자님, 안녕하십니까.\n${sender.department || "사업 담당부서"}의 ${sender.name || "담당자"}입니다.`,
    deadline,
    deadlineLine:
      overdue ? `당초 회신 기한(${formatKoreanDate(deadline)})이 경과하여, 처리 가능한 일정을 회신하여 주시기 바랍니다.`
      : deadline ? `회신 기한은 ${formatKoreanDate(deadline)}입니다.`
      : dueNote ? `회신 기한은 ${dueNote}입니다.`
      : "회신 가능한 일정을 알려주시면 반영하겠습니다.",
    replyLine: sender.contact ? `문의사항은 ${sender.contact}로 연락 주시기 바랍니다.` : "문의사항은 본 메일로 회신 주시기 바랍니다.",
    closing: "감사합니다.",
    facts,
    sourceIds: tasks.map((task) => task.id),
  };
}

function buildSubject(tasks: MyTask[], projectName: string): string {
  const head = projectName ? `[${projectName}] ` : "";
  const first = tasks[0];
  if (!first) return `${head}업무 협조 요청`;
  const title = first.title.replace(/\s+/g, " ").trim();
  const suffix = tasks.length > 1 ? ` 외 ${tasks.length - 1}건` : "";
  const action = first.status === "회신 대기" ? "회신 요청" : first.status === "요청 필요" ? "협조 요청" : "확인 요청";
  return `${head}${title}${suffix} ${action}`;
}

/* ── LLM 입출력 ──────────────────────────────────────────── */

/**
 * few-shot 예시.
 *
 * 8B 모델의 어색한 공문체는 대부분 예시로 해결된다. **실제로 보냈던 메일 3통으로
 * 바꿔 넣으면 품질이 눈에 띄게 오른다** — 여기 있는 건 그 자리를 채운 기본값이다.
 */
export const DEFAULT_EMAIL_EXAMPLES: { memo: string; background: string; requests: string[] }[] = [
  {
    memo: "A기관 데이터 3종 아직 안 옴. 금요일까지 다시 확인",
    background: "지난 실무회의에서 협의된 데이터 3종의 제공이 아직 확인되지 않고 있습니다.",
    requests: ["해당 데이터 3종의 제공 가능 시점을 회신하여 주시기 바랍니다."],
  },
  {
    memo: "B기관 모델 성능자료 다음 월간회의 전에 받아야 함",
    background: "다음 월간회의 안건 구성을 위해 기관별 모델 성능자료를 취합하고 있습니다.",
    requests: ["모델 성능 현황자료를 회신 기한 내 송부하여 주시기 바랍니다."],
  },
  {
    memo: "C기관 WBS 지연 사유랑 회복 일정 요청",
    background: "제출해 주신 WBS 상 일부 과업의 진척이 계획 대비 지연된 것으로 확인되었습니다.",
    requests: [
      "해당 과업의 지연 사유를 회신하여 주시기 바랍니다.",
      "지연 과업의 회복 일정을 함께 제시하여 주시기 바랍니다.",
    ],
  },
];

export const EMAIL_SYSTEM = [
  "당신은 공공 R&D 사업담당자가 기관에 보내는 협조요청 메일의 본문을 다듬는 보조자입니다.",
  "담당자의 메모를 정중한 공문체 문장으로 바꾸는 일만 합니다.",
  "다음을 반드시 지킵니다.",
  "- 메모에 없는 사실을 만들지 않습니다.",
  "- 기관명, 날짜, 수치를 새로 쓰지 않습니다. 인사말·수신처·기한 문장은 이미 따로 채워집니다.",
  "- background는 2문장 이내, requests는 요청 한 건당 한 문장입니다.",
  "- '~하여 주시기 바랍니다' 형태의 공문체 존댓말을 씁니다.",
  "- JSON만 출력합니다. 설명을 덧붙이지 않습니다.",
].join("\n");

export function buildEmailPrompt(
  skeleton: EmailSkeleton,
  examples = DEFAULT_EMAIL_EXAMPLES,
): string {
  const shots = examples.map((example) =>
    [
      `메모: ${example.memo}`,
      `출력: ${JSON.stringify({ background: example.background, requests: example.requests })}`,
    ].join("\n"),
  );

  return [
    "[예시]",
    shots.join("\n\n"),
    "",
    "[이번 메모]",
    ...skeleton.facts.map((fact) => `- (${fact.category} · ${fact.status}) ${fact.text}`),
    "",
    "위 메모로 메일 본문의 background(배경)와 requests(요청사항)를 만드세요.",
    '출력 형식: {"background":"...","requests":["..."]}',
    "JSON만 출력하세요.",
  ].join("\n");
}

export type EmailBodyParts = { background: string; requests: string[] };

export function validateEmailOutput(value: unknown): EmailBodyParts | null {
  if (!isRecord(value)) return null;
  const background = oneLine(value.background ?? value.배경);
  const requests = asTextList(value.requests ?? value.요청사항).map((line) => oneLine(line)).filter(Boolean);
  if (!background && !requests.length) return null;
  return { background, requests };
}

/* ── 결과 조립 ──────────────────────────────────────────── */

/** 화면에 띄우고 편집하는 최종 초안. 발송 버튼은 만들지 않는다. */
export type EmailDraft = {
  subject: string;
  body: string;
  recipients: string[];
  /** ISO yyyy-mm-dd. 없으면 빈 문자열 */
  deadline: string;
  sourceIds: string[];
  fromLlm: boolean;
  note?: string;
};

/** 규칙만으로 만드는 배경·요청 문장. 모델이 없거나 실패했을 때 쓴다. */
export function fallbackParts(skeleton: EmailSkeleton): EmailBodyParts {
  return {
    background: `${skeleton.facts[0]?.category ?? "업무"} 관련하여 아래 사항의 확인이 필요하여 연락드립니다.`,
    requests: skeleton.facts.map((fact) => `${fact.text} — 확인 후 회신하여 주시기 바랍니다.`),
  };
}

/** 뼈대 + 문장 → 메일 한 통. 조립은 전부 여기서만 한다. */
export function renderEmail(skeleton: EmailSkeleton, parts: EmailBodyParts | null): EmailDraft {
  const filled = parts && (parts.background || parts.requests.length) ? parts : fallbackParts(skeleton);
  const requests = filled.requests.length ? filled.requests : fallbackParts(skeleton).requests;

  const body = [
    skeleton.greeting,
    "",
    filled.background,
    "",
    "[요청사항]",
    ...requests.map((line, index) => `${index + 1}. ${line}`),
    "",
    skeleton.deadlineLine,
    skeleton.replyLine,
    "",
    skeleton.closing,
  ].join("\n");

  return {
    subject: skeleton.subject,
    body,
    // 수신처와 기한은 모델 출력이 아니라 원본 업무에서 그대로 가져온다
    recipients: skeleton.recipients,
    deadline: skeleton.deadline,
    sourceIds: skeleton.sourceIds,
    fromLlm: Boolean(parts),
  };
}

/** 이메일 초안 한 통을 만든다. `call`이 없으면 템플릿만으로 만든다. */
export async function generateEmail(
  tasks: MyTask[],
  sender: EmailSender,
  today: string,
  call: LlmCall | null,
  examples = DEFAULT_EMAIL_EXAMPLES,
): Promise<EmailDraft> {
  const skeleton = buildEmailSkeleton(tasks, sender, today);
  if (!call) return renderEmail(skeleton, null);

  try {
    const raw = await call(buildEmailPrompt(skeleton, examples), EMAIL_SYSTEM);
    return renderEmail(skeleton, parseResponse(raw, validateEmailOutput));
  } catch (cause) {
    return {
      ...renderEmail(skeleton, null),
      note: cause instanceof Error ? cause.message : "모델 호출에 실패했습니다.",
    };
  }
}

/** 메일 클라이언트로 넘길 텍스트. 발송은 사람이 한다. */
export function renderEmailText(draft: EmailDraft): string {
  return [
    `받는 사람: ${draft.recipients.join(", ") || "(미지정)"}`,
    `제목: ${draft.subject}`,
    "",
    draft.body,
  ].join("\n");
}

/** 편집 화면에서 고친 값을 되돌려 받는다. 모델 출력은 항상 사람 손을 거친다. */
export function withEdits(draft: EmailDraft, edits: Partial<Pick<EmailDraft, "subject" | "body" | "recipients">>): EmailDraft {
  return {
    ...draft,
    subject: asText(edits.subject ?? draft.subject) || draft.subject,
    body: typeof edits.body === "string" ? edits.body : draft.body,
    recipients: edits.recipients ?? draft.recipients,
  };
}
