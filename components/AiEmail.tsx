"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  buildEmailPrompt,
  buildEmailSkeleton,
  generateEmail,
  renderEmailText,
  type EmailDraft,
  type EmailSender,
} from "@/lib/emailDraft";
import { score, type MyTask } from "@/lib/mytask";
import { categoryTitle } from "@/lib/worktree";
import type { LlmCall } from "@/lib/llm";

/**
 * 이메일 초안.
 *
 * 생성 결과는 반드시 **편집 화면**을 거친다. 바로 발송하는 버튼은 만들지 않는다 —
 * 기관에 나가는 문서를 사람이 한 번 읽지 않고 보내게 하면 안 된다.
 */
export default function AiEmail({
  today,
  tasks,
  projectName,
  department,
  makeCall,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  projectName: string;
  department: string;
  makeCall: () => LlmCall | null;
  onCopy: (text: string, label: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const open = useMemo(
    () => tasks.filter((task) => task.status !== "완료").map((task) => score(task, today)).sort((a, b) => b.score - a.score),
    [tasks, today],
  );
  const chosen = useMemo(() => open.filter((task) => picked.includes(task.id)), [open, picked]);
  const sender: EmailSender = { projectName, department, name, contact };

  const prompt = useMemo(
    () => (chosen.length ? buildEmailPrompt(buildEmailSkeleton(chosen, sender, today)) : ""),
    // sender는 문장 생성에 들어가지 않고 뼈대만 채우므로 의존성에 넣지 않는다
    [chosen, today], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const run = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const next = await generateEmail(chosen, sender, today, makeCall());
      setDraft(next);
      setSubject(next.subject);
      setBody(next.body);
    } finally {
      setBusy(false);
    }
  };

  const edited: EmailDraft | null = draft ? { ...draft, subject, body } : null;

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">보낼 업무 고르기</div>
            <div className="card__sub">같은 기관 건은 한 통으로 묶는 편이 낫습니다</div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy || !chosen.length}>
            {busy ? "생성 중…" : "초안 만들기"}
          </button>
        </div>

        <div className="card__body stack">
          <div className="quick__preview">
            <label className="field">
              <span>보내는 사람</span>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="담당자명" />
            </label>
            <label className="field">
              <span>회신처</span>
              <input className="input" value={contact} onChange={(event) => setContact(event.target.value)} placeholder="이메일 또는 전화" />
            </label>
          </div>

          <ul className="picked">
            {open.map((task) => (
              <li key={task.id} className={`picked__row picked__row--pick ${picked.includes(task.id) ? "is-on" : ""}`}>
                <label className="picked__check">
                  <input type="checkbox" checked={picked.includes(task.id)} onChange={() => toggle(task.id)} />
                  <span className="picked__text">{task.title}</span>
                </label>
                <span className="picked__reason">{categoryTitle(task.categoryId)}{task.org && ` · ${task.org}`}</span>
                <span className="picked__due">{task.dueLabel}</span>
              </li>
            ))}
            {!open.length && <li className="bucket__empty">등록된 업무가 없습니다.</li>}
          </ul>

          <PromptPeek text={prompt} />
        </div>
      </section>

      {edited && (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">초안 — 보내기 전에 확인하세요</div>
              <div className="card__sub">
                수신처와 기한은 등록된 업무에서 그대로 넣었습니다 · 근거 {edited.sourceIds.length}건
              </div>
            </div>
            <button className="btn btn--sm" onClick={() => onCopy(renderEmailText(edited), "메일 초안")}>복사</button>
          </div>

          <div className="card__body stack">
            {edited.note && <p className="notice notice--warn">모델을 쓰지 못해 템플릿으로 만들었습니다. ({edited.note})</p>}
            <label className="field">
              <span>받는 사람</span>
              <input className="input" value={edited.recipients.join(", ")} readOnly />
              <small>업무에 적힌 기관입니다. 모델이 바꾸지 못합니다.</small>
            </label>
            <label className="field">
              <span>제목</span>
              <input className="input" value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <label className="field">
              <span>본문</span>
              <textarea className="textarea mail__body" value={body} onChange={(event) => setBody(event.target.value)} rows={16} />
            </label>
            <p className="notice">
              발송은 사용하시는 메일 프로그램에서 직접 해 주세요. 이 화면에는 발송 버튼을 두지 않았습니다.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
