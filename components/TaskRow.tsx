"use client";

import { URGENCY_TAG, type Scored } from "@/lib/mytask";
import { categoryTitle } from "@/lib/worktree";

/** 업무 한 줄. 개요와 업무트리가 같은 모양을 쓴다. */
export default function TaskRow({
  task,
  onDone,
  onDefer,
  showCategory = true,
}: {
  task: Scored;
  onDone: (id: string) => void;
  onDefer?: (id: string) => void;
  showCategory?: boolean;
}) {
  return (
    <div className="trow">
      <button className="trow__check" onClick={() => onDone(task.id)} aria-label={`${task.title} 완료`}>✓</button>

      <div className="trow__body">
        <div className="trow__top">
          <span className={`tag ${URGENCY_TAG[task.urgency]}`}>{task.urgency}</span>
          <strong className="trow__title">{task.title}</strong>
        </div>

        <div className="trow__meta">
          {showCategory && <span>{categoryTitle(task.categoryId)}</span>}
          {task.org && <span>{task.org}</span>}
          <span>{task.status}</span>
        </div>

        {task.reasons.length > 0 && (
          <ul className="reasons">
            {task.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </div>

      <div className="trow__right">
        <span className={`trow__due ${task.dday != null && task.dday < 0 ? "is-over" : ""}`}>{task.dueLabel}</span>
        {onDefer && <button className="trow__defer" onClick={() => onDefer(task.id)} title="다음 주로 미루기">미루기</button>}
      </div>
    </div>
  );
}
