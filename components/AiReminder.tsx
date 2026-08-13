"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  buildReminderPrompt,
  findReminders,
  generateReminderEmail,
  markReminded,
  markReplied,
  type Reminder,
} from "@/lib/reminder";
import { renderEmailText, type EmailDraft, type EmailSender } from "@/lib/emailDraft";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { LlmCall } from "@/lib/llm";

/**
 * 회신 대기 재촉.
 *
 * **목록은 룰이 만든다.** 기관별 임계일을 넘긴 것만 올라오고, 왜 올라왔는지가
 * 항목마다 붙는다. LLM은 본문 문장만 만든다.
 *
 * 발송 버튼은 없다. 대신 `발송함`을 눌러야 `reminded`가 기록되고 목록에서 빠진다 —
 * **기록하지 않으면 내일 같은 항목이 또 뜬다.** 실제로 보냈는지는 사람만 안다.
 */
export default function AiReminder({
  today,
  tasks,
  events,
  projectName,
  department,
  makeCall,
  onRecord,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  events: TaskEvent[];
  projectName: string;
  department: string;
  makeCall: () => LlmCall | null;
  onRecord: (event: TaskEvent) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const reminders = useMemo(() => findReminders(tasks, events, today), [tasks, events, today]);
  const current = reminders.find((item) => item.task.id === picked) ?? null;
  const sender: EmailSender = { projectName, department, name, contact };

  const run = async (reminder: Reminder) => {
    setPicked(reminder.task.id);
    setBusy(true);
    try {
      const next = await generateReminderEmail(reminder, sender, today, makeCall());
      setDraft(next);
      setBody(next.body);
    } finally {
      setBusy(false);
    }
  };

  const sent = (reminder: Reminder) => {
    onRecord(markReminded(reminder, today));
    setPicked(null);
    setDraft(null);
  };

  const replied = (reminder: Reminder) => {
    onRecord(markReplied(reminder.task.id, reminder.task.orgId, today));
    setPicked(null);
    setDraft(null);
  };

  if (!reminders.length) {
    return (
      <div className="card">
        <div className="card__body empty">
          <p className="empty__title">재촉할 항목이 없습니다</p>
          <p className="empty__body">
            요청을 보낸 뒤 기관별 회신 임계일(주관 3 · 공동 5 · 전문 7영업일)을 넘긴 건이
            여기에 올라옵니다. 요청 발송은 업무의 이력에 기록되어야 판정이 시작됩니다.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">재촉 대상 {reminders.length}건</div>
            <div className="card__sub">기관별 임계일을 넘긴 것만 — 판정은 규칙이 합니다</div>
          </div>
        </div>

        <div className="card__body stack">
          <div className="quick__preview">
            <label className="field">
              <span>보내는 사람</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="담당자명" />
            </label>
            <label className="field">
              <span>회신처</span>
              <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="이메일 또는 전화" />
            </label>
          </div>

          <ul className="picked">
            {reminders.map((reminder) => (
              <li key={reminder.task.id} className={`picked__row ${picked === reminder.task.id ? "is-on" : ""}`}>
                <span className={`tag ${reminder.stage >= 3 ? "tag--danger" : reminder.stage === 2 ? "tag--warn" : "tag--info"}`}>
                  {reminder.stage}차
                </span>
                <span className="picked__text">{reminder.task.note || reminder.task.title}</span>
                {/* 왜 올라왔는지를 그대로 띄운다 */}
                <span className="picked__reason">
                  {reminder.org.name} · {reminder.sentAt} 요청 · {reminder.waitingDays}영업일 대기
                  {` (임계 ${reminder.replyDays}일)`}
                </span>
                <span className="reminder__acts">
                  <button className="btn btn--sm" onClick={() => run(reminder)} disabled={busy}>
                    {busy && picked === reminder.task.id ? "생성 중…" : "초안"}
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => sent(reminder)}>발송함</button>
                  <button className="btn btn--sm btn--ghost" onClick={() => replied(reminder)}>회신옴</button>
                </span>
              </li>
            ))}
          </ul>

          {current && <PromptPeek text={buildReminderPrompt(current)} />}
        </div>
      </section>

      {draft && current && (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">{current.stage}차 재요청 초안 — 보내기 전에 확인하세요</div>
              <div className="card__sub">
                당초 요청일·경과 일수·기한은 이력에서 넣었습니다 · 모델이 계산하지 않습니다
              </div>
            </div>
            <button className="btn btn--sm" onClick={() => onCopy(renderEmailText({ ...draft, body }), "재촉 메일")}>복사</button>
          </div>

          <div className="card__body stack">
            {draft.note && <p className="notice notice--warn">모델을 쓰지 못해 템플릿으로 만들었습니다. ({draft.note})</p>}
            <label className="field">
              <span>받는 사람</span>
              <input className="input" value={draft.recipients.join(", ")} readOnly />
            </label>
            <label className="field">
              <span>제목</span>
              <input className="input" value={draft.subject} readOnly />
            </label>
            <label className="field">
              <span>본문</span>
              <textarea className="textarea mail__body" rows={16} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <p className="notice">
              발송은 메일 프로그램에서 직접 해 주세요. 보내신 뒤 <b>발송함</b>을 눌러야 이력에 남고
              목록에서 빠집니다 — 누르지 않으면 내일 같은 항목이 또 뜹니다.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
