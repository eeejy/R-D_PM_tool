import { describe, expect, it } from "vitest";
import {
  buildEmailPrompt,
  buildEmailSkeleton,
  fallbackParts,
  generateEmail,
  renderEmail,
  renderEmailText,
  validateEmailOutput,
  withEdits,
  type EmailSender,
} from "../lib/emailDraft";
import type { MyTask } from "../lib/mytask";

const TODAY = "2026-08-13";

const sender: EmailSender = {
  projectName: "CDX 연구개발사업",
  department: "사업총괄부",
  name: "홍길동",
  contact: "hong@example.kr",
};

const task: MyTask = {
  id: "t1", title: "데이터 3종 재확인", categoryId: "data", org: "A기관",
  due: "2026-08-14", dueNote: "", status: "회신 대기",
  note: "A기관 데이터 3종 아직 안 옴. 금요일까지 다시 확인", createdAt: TODAY,
};

describe("뼈대 — 룰이 채우는 부분", () => {
  it("수신처를 업무의 기관에서 가져온다", () => {
    expect(buildEmailSkeleton([task], sender, TODAY).recipients).toEqual(["A기관"]);
  });

  it("제목에 사업명을 붙인다", () => {
    expect(buildEmailSkeleton([task], sender, TODAY).subject).toMatch(/^\[CDX 연구개발사업\]/);
  });

  it("여러 건이면 한 통으로 묶고 제목에 건수를 적는다", () => {
    const second: MyTask = { ...task, id: "t2", title: "품질 확인", due: "2026-08-20" };
    expect(buildEmailSkeleton([task, second], sender, TODAY).subject).toMatch(/외 1건/);
  });

  it("기한은 가장 이른 것을 쓴다", () => {
    const second: MyTask = { ...task, id: "t2", due: "2026-08-20" };
    expect(buildEmailSkeleton([second, task], sender, TODAY).deadline).toBe("2026-08-14");
  });

  it("이미 지난 기한은 경과 사실을 밝힌다", () => {
    const late = buildEmailSkeleton([{ ...task, due: "2026-08-01" }], sender, TODAY);
    expect(late.deadlineLine).toMatch(/경과/);
  });

  it("날짜로 못 바꾼 기한 표현은 그대로 쓴다", () => {
    const relative = buildEmailSkeleton([{ ...task, due: "", dueNote: "다음 월간회의 이전" }], sender, TODAY);
    expect(relative.deadline).toBe("");
    expect(relative.deadlineLine).toMatch(/다음 월간회의 이전/);
  });

  it("회신처에 담당자 연락처를 넣는다", () => {
    expect(buildEmailSkeleton([task], sender, TODAY).replyLine).toMatch(/hong@example.kr/);
  });
});

describe("프롬프트", () => {
  it("few-shot 예시와 이번 메모를 함께 넣는다", () => {
    const prompt = buildEmailPrompt(buildEmailSkeleton([task], sender, TODAY));
    expect(prompt).toMatch(/\[예시\]/);
    expect(prompt).toMatch(/데이터 3종 아직 안 옴/);
  });

  it("예시를 실제로 보냈던 메일로 갈아끼울 수 있다", () => {
    const prompt = buildEmailPrompt(buildEmailSkeleton([task], sender, TODAY), [
      { memo: "우리 기관 표현", background: "우리 배경 문장입니다.", requests: ["우리 요청 문장입니다."] },
    ]);
    expect(prompt).toMatch(/우리 배경 문장입니다/);
  });
});

describe("응답 검증", () => {
  it("정상 응답을 받아들인다", () => {
    expect(validateEmailOutput({ background: "배경.", requests: ["요청."] }))
      .toEqual({ background: "배경.", requests: ["요청."] });
  });

  it("요청이 문자열 하나로 와도 받아준다", () => {
    expect(validateEmailOutput({ background: "배경.", requests: "요청." })?.requests).toEqual(["요청."]);
  });

  it("모양이 다르면 null", () => {
    expect(validateEmailOutput({ 메일: "본문" })).toBeNull();
    expect(validateEmailOutput("본문")).toBeNull();
  });
});

describe("조립", () => {
  const skeleton = buildEmailSkeleton([task], sender, TODAY);

  it("수신처와 기한은 모델이 아니라 원본 업무에서 넣는다", () => {
    // 모델이 다른 기관·날짜를 지어내도 결과에 들어갈 통로가 없다
    const draft = renderEmail(skeleton, { background: "B기관 관련 2026-01-01 건입니다.", requests: ["회신 바랍니다."] });
    expect(draft.recipients).toEqual(["A기관"]);
    expect(draft.deadline).toBe("2026-08-14");
  });

  it("템플릿 순서대로 본문을 만든다", () => {
    const body = renderEmail(skeleton, { background: "배경 문장.", requests: ["요청 문장."] }).body;
    expect(body.indexOf("안녕하십니까")).toBeLessThan(body.indexOf("배경 문장."));
    expect(body.indexOf("배경 문장.")).toBeLessThan(body.indexOf("[요청사항]"));
    expect(body.indexOf("[요청사항]")).toBeLessThan(body.indexOf("회신 기한"));
    expect(body.trimEnd().endsWith("감사합니다.")).toBe(true);
  });

  it("모델 없이도 템플릿만으로 메일이 나온다", () => {
    const draft = renderEmail(skeleton, null);
    expect(draft.fromLlm).toBe(false);
    expect(draft.body).toMatch(/요청사항/);
    expect(fallbackParts(skeleton).requests).toHaveLength(1);
  });

  it("근거 업무 id를 들고 있다", () => {
    expect(renderEmail(skeleton, null).sourceIds).toEqual(["t1"]);
  });

  it("발송용 텍스트에 수신·제목이 들어간다", () => {
    expect(renderEmailText(renderEmail(skeleton, null))).toMatch(/받는 사람: A기관/);
  });

  it("사용자 편집을 그대로 반영한다 — 모델 출력은 항상 사람 손을 거친다", () => {
    const edited = withEdits(renderEmail(skeleton, null), { subject: "직접 고친 제목", body: "직접 고친 본문" });
    expect(edited.subject).toBe("직접 고친 제목");
    expect(edited.body).toBe("직접 고친 본문");
  });
});

describe("generateEmail", () => {
  it("모델 문장을 본문에 넣는다", async () => {
    const call = async () => JSON.stringify({ background: "확인이 필요하여 연락드립니다.", requests: ["제공 시점을 회신하여 주시기 바랍니다."] });
    const draft = await generateEmail([task], sender, TODAY, call);
    expect(draft.body).toMatch(/제공 시점을 회신하여 주시기 바랍니다/);
    expect(draft.fromLlm).toBe(true);
  });

  it("모델이 실패해도 초안은 나온다", async () => {
    const call = async () => { throw new Error("연결 실패"); };
    const draft = await generateEmail([task], sender, TODAY, call);
    expect(draft.body).toMatch(/요청사항/);
    expect(draft.note).toMatch(/연결 실패/);
  });

  it("응답이 형식을 벗어나도 초안은 나온다", async () => {
    const draft = await generateEmail([task], sender, TODAY, async () => "그건 못 하겠습니다");
    expect(draft.recipients).toEqual(["A기관"]);
    expect(draft.fromLlm).toBe(false);
  });
});
