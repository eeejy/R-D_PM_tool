"use client";

import { useState } from "react";
import QuickAdd from "./QuickAdd";
import TaskRow from "./TaskRow";
import { bucket, type MyTask } from "@/lib/mytask";
import type { TaskSignals } from "@/lib/history";
import { openIssues, type TrackItem } from "@/lib/track";
import { orgName } from "@/lib/org";
import type { WbsStatus } from "@/lib/wbsStatus";
import { VARIANCE_TONE } from "@/lib/variance";

/**
 * 개요 — 이 서비스에서 가장 중요한 화면.
 *
 * 두 가지 질문에만 답한다.
 *   1) 지금 사업 상태가 어떤가 (WBS 요약, 아주 짧게)
 *   2) 오늘과 이번 주에 내가 무엇을 해야 하는가 (여기가 화면의 주인공)
 *
 * 그래서 월 단위는 접어 두고, 상세 WBS는 여기서 펼치지 않는다.
 */
export default function OverviewView({
  today,
  status,
  tasks,
  signals,
  track = [],
  onCloseIssue,
  onAdd,
  onDone,
  onDefer,
  onGoWbs,
  onGoTree,
}: {
  today: string;
  status: WbsStatus | null;
  tasks: MyTask[];
  /** 지연·회신 지표. 이벤트 로그에서 계산해 넘어온다. */
  signals?: Map<string, TaskSignals>;
  /** 쟁점·결정. 업무 목록과 섞지 않고 배지로만 노출한다. */
  track?: TrackItem[];
  onCloseIssue?: (id: string) => void;
  onAdd: (tasks: MyTask[]) => void;
  onDone: (id: string) => void;
  onDefer: (id: string) => void;
  onGoWbs: () => void;
  onGoTree: () => void;
}) {
  const [monthOpen, setMonthOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const issues = openIssues(track);
  const buckets = bucket(tasks, today, signals);

  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">개요</h1>
        <p className="view__sub">{today} 기준 · 오늘과 이번 주에 처리할 일부터 봅니다</p>
      </div>

      {/* ── 1. 현재 연구개발 현황 — 짧게만 ─────────────────────── */}
      {status ? (
        <section className="status-strip card">
          <div className="status-strip__main">
            <div>
              <div className="metric__label">전체 진행</div>
              <div className="status-strip__value">
                {status.overall.progress}%
                <em className={status.overall.variance >= 0 ? "is-up" : "is-down"}>
                  계획 {status.overall.planned}% · {status.overall.variance > 0 ? "+" : ""}{status.overall.variance}%p
                </em>
              </div>
            </div>
            <div className="status-strip__counts">
              <span><b>{status.delayed.length}</b>지연·확인</span>
              <span><b>{status.watch.length}</b>주의</span>
              <span><b>{status.institutions.filter((item) => item.status === "지연").length}</b>지연 기관</span>
            </div>
          </div>

          <div className="status-strip__orgs">
            {status.institutions.slice(0, 6).map((org) => (
              <span key={org.name} className={`tag tag--${VARIANCE_TONE[org.status]}`} title={`계획 ${org.planned}% / 실적 ${org.progress}%`}>
                {org.name} {org.variance > 0 ? "+" : ""}{org.variance}
              </span>
            ))}
            <button className="btn btn--sm btn--ghost" onClick={onGoWbs}>연구개발 현황 →</button>
          </div>
        </section>
      ) : (
        <section className="status-strip card">
          <div className="status-strip__main">
            <p className="muted" style={{ fontSize: 13 }}>WBS 파일을 넣으면 연구개발 현황이 여기에 요약됩니다.</p>
            <button className="btn btn--sm" onClick={onGoWbs}>WBS 넣기</button>
          </div>
        </section>
      )}

      {/* ── 2. 빠른 입력 ────────────────────────────────────── */}
      <QuickAdd today={today} onAdd={onAdd} />

      {/* ── 미해결 쟁점 — 업무 목록과 섞지 않고 배지로만 ───────── */}
      {issues.length > 0 && (
        <section className="card month">
          <button className="month__head" onClick={() => setIssuesOpen((open) => !open)} aria-expanded={issuesOpen}>
            <span className="card__title">
              미해결 쟁점 <span className="tag tag--warn">{issues.length}건</span>
            </span>
            <span className="month__toggle">{issuesOpen ? "접기" : "펼치기"}</span>
          </button>
          {issuesOpen && (
            <div className="card__body stack">
              {issues.map((issue) => (
                <div key={issue.id} className="line">
                  <p className="line__text">{issue.summary}</p>
                  <p className="line__source">
                    {issue.orgId && `${orgName(issue.orgId)} · `}{issue.origin} · {issue.at}
                    {onCloseIssue && (
                      <button className="btn btn--sm btn--ghost" onClick={() => onCloseIssue(issue.id)}>해결됨</button>
                    )}
                  </p>
                  {issue.source && issue.source !== issue.summary && <p className="line__quote">{issue.source}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── 3. 내가 해야 할 업무 ─────────────────────────────── */}
      <section className="buckets">
        <div className="card bucket bucket--today">
          <div className="card__head">
            <div>
              <div className="card__title">오늘</div>
              <div className="card__sub">기한이 지났거나 오늘까지</div>
            </div>
            <span className="bucket__count">{buckets.today.length}</span>
          </div>
          <div className="bucket__list">
            {buckets.today.map((task) => <TaskRow key={task.id} task={task} onDone={onDone} onDefer={onDefer} />)}
            {!buckets.today.length && <p className="bucket__empty">오늘 마감인 업무가 없습니다.</p>}
          </div>
        </div>

        <div className="card bucket bucket--week">
          <div className="card__head">
            <div>
              <div className="card__title">이번 주</div>
              <div className="card__sub">7일 내 마감 · 회신 대기 · 회의 전 확정</div>
            </div>
            <span className="bucket__count">{buckets.week.length}</span>
          </div>
          <div className="bucket__list">
            {buckets.week.map((task) => <TaskRow key={task.id} task={task} onDone={onDone} onDefer={onDefer} />)}
            {!buckets.week.length && <p className="bucket__empty">이번 주 처리할 업무가 없습니다.</p>}
          </div>
        </div>
      </section>

      {/* ── 4. 이번 달은 접어 둔다 ───────────────────────────── */}
      <section className="card month">
        <button className="month__head" onClick={() => setMonthOpen((open) => !open)} aria-expanded={monthOpen}>
          <span className="card__title">이번 달 주요 일정 {buckets.month.length}건</span>
          <span className="month__toggle">{monthOpen ? "접기" : "이번 달 전체 보기"}</span>
        </button>
        {monthOpen && (
          <div className="bucket__list">
            {buckets.month.map((task) => <TaskRow key={task.id} task={task} onDone={onDone} onDefer={onDefer} />)}
            {!buckets.month.length && <p className="bucket__empty">이번 달 예정된 업무가 없습니다.</p>}
          </div>
        )}
      </section>

      {buckets.undated.length > 0 && (
        <section className="card month">
          <button className="month__head" onClick={onGoTree}>
            <span className="card__title">기한이 없는 업무 {buckets.undated.length}건</span>
            <span className="month__toggle">업무트리에서 정리 →</span>
          </button>
        </section>
      )}
    </div>
  );
}
