"use client";

import { useMemo, useState } from "react";
import { capture, captureMany, type Draft } from "@/lib/capture";
import { CATEGORIES, categoryTitle } from "@/lib/worktree";
import type { MyTask } from "@/lib/mytask";

/**
 * 한 줄 입력으로 업무를 등록한다.
 *
 * 폼을 여러 개 채우게 만들지 않는 것이 전부다. 입력하는 동안 분류 결과를
 * 미리 보여주고, 틀린 것만 고쳐서 저장한다.
 */
export default function QuickAdd({ today, onAdd }: { today: string; onAdd: (tasks: MyTask[]) => void }) {
  const [text, setText] = useState("");
  const [edit, setEdit] = useState<Partial<Draft>>({});
  const [saved, setSaved] = useState(0);

  const multiline = text.includes("\n");
  const preview = useMemo(() => (text.trim() ? capture(text, today) : null), [text, today]);
  const draft = preview ? { ...preview, ...edit } : null;

  const submit = () => {
    if (!text.trim()) return;
    const drafts = multiline
      ? captureMany(text, today)
      : draft ? [draft as Draft] : [];
    if (!drafts.length) return;
    onAdd(drafts as MyTask[]);
    setSaved(drafts.length);
    setText("");
    setEdit({});
    window.setTimeout(() => setSaved(0), 2400);
  };

  return (
    <div className="card quick">
      <div className="quick__row">
        <textarea
          className="quick__input"
          rows={text.includes("\n") ? 4 : 1}
          value={text}
          onChange={(event) => { setText(event.target.value); setEdit({}); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
          }}
          placeholder="업무나 요청사항을 한 줄로 적으세요 — 예: A기관에 GPU 사용계획 이번 주까지 요청"
          aria-label="업무 빠른 추가"
        />
        <button className="btn btn--primary" onClick={submit} disabled={!text.trim()}>추가</button>
      </div>

      {saved > 0 && <p className="quick__saved">{saved}건을 업무트리에 넣었습니다.</p>}

      {draft && !multiline && (
        <div className="quick__preview">
          <label className="field">
            <span>분류</span>
            <select
              className="select"
              value={draft.categoryId}
              onChange={(event) => setEdit((current) => ({ ...current, categoryId: event.target.value as Draft["categoryId"] }))}
            >
              {CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.title}</option>)}
            </select>
          </label>
          <label className="field">
            <span>대상기관</span>
            <input
              className="input" value={draft.org}
              onChange={(event) => setEdit((current) => ({ ...current, org: event.target.value }))}
              placeholder="미지정"
            />
          </label>
          <label className="field">
            <span>기한</span>
            <input
              className="input" type="date" value={draft.due}
              onChange={(event) => setEdit((current) => ({ ...current, due: event.target.value, dueNote: "" }))}
            />
            <small>{draft.due ? "문장에서 찾음" : draft.dueNote || "문장에 날짜 없음"}</small>
          </label>
          <label className="field">
            <span>상태</span>
            <select
              className="select" value={draft.status}
              onChange={(event) => setEdit((current) => ({ ...current, status: event.target.value as Draft["status"] }))}
            >
              {["확인 필요", "요청 필요", "회신 대기", "작성 중", "진행"].map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {multiline && text.trim() && (
        <p className="quick__hint">
          줄마다 한 건씩 등록됩니다. 분류는 저장 후 업무트리에서 바꿀 수 있습니다.
        </p>
      )}

      {draft && !multiline && (
        <p className="quick__hint">
          <b>{categoryTitle(draft.categoryId)}</b>
          {draft.org && <> · {draft.org}</>}
          {" · "}{draft.due || draft.dueNote || "기한 미정"}
          {" · "}{draft.status}
        </p>
      )}
    </div>
  );
}
