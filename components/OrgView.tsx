"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildOrgPage,
  buildOrgSummaryPrompt,
  fallbackSummary,
  generateOrgSummary,
  orgSummaries,
  renderOrgPageText,
  type OrgPage,
  type OrgSummary,
} from "@/lib/orgPage";
import PromptPeek from "./PromptPeek";
import { ORGS, type OrgId } from "@/lib/org";
import { checkOllama, loadLlmConfig, makeCall } from "@/lib/llm";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { WbsStatus } from "@/lib/wbsStatus";
import type { WbsTask } from "@/lib/types";
import { VARIANCE_TONE } from "@/lib/variance";

/**
 * 기관별 원페이지 — 회의·통화 직전에 여는 화면.
 *
 * 그래서 **스크롤 없이 한 화면에 끝나야 한다.** 담을 것을 고르는 기준도 하나다:
 * 지금 통화에서 꺼낼 말인가.
 */
export default function OrgView({
  today,
  tasks,
  events,
  status,
  wbsTasks,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  events: TaskEvent[];
  status: WbsStatus | null;
  wbsTasks: WbsTask[];
  onCopy: (text: string, label: string) => void;
}) {
  const [orgId, setOrgId] = useState<OrgId>("gmt");
  const [summary, setSummary] = useState<OrgSummary | null>(null);
  const [busy, setBusy] = useState(false);
  /** 모델이 있으면 요약을 다듬을 수 있다. 없어도 규칙 요약이 나오므로 화면은 그대로다. */
  const [llmReady, setLlmReady] = useState(false);

  useEffect(() => {
    // 연결만 확인한다. 모델을 돌리지는 않는다 — 자동 호출은 없다.
    void checkOllama(loadLlmConfig()).then((state) => setLlmReady(state.ok));
  }, []);

  const input = useMemo(
    () => ({ tasks, events, status, wbsTasks, today }),
    [tasks, events, status, wbsTasks, today],
  );
  const rows = useMemo(() => orgSummaries(input), [input]);
  const page = useMemo(() => buildOrgPage(orgId, input), [orgId, input]);

  const lines = summary?.lines ?? fallbackSummary(page);

  const run = async () => {
    setBusy(true);
    try {
      setSummary(await generateOrgSummary(page, llmReady ? makeCall(loadLlmConfig()) : null));
    } finally {
      setBusy(false);
    }
  };

  const pick = (next: OrgId) => {
    setOrgId(next);
    setSummary(null); // 기관이 바뀌면 이전 요약은 남기지 않는다
  };

  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">기관별</h1>
        <p className="view__sub">회의·통화 직전에 여는 화면입니다 · {today} 기준</p>
      </div>

      {/* 어느 기관을 열지 고르는 줄. 미결 건수가 붙어 있어 여기서 이미 판단이 된다 */}
      <div className="orgbar">
        {rows.map((row) => (
          <button
            key={row.org.id}
            className="orgbar__item"
            aria-current={row.org.id === orgId}
            onClick={() => pick(row.org.id)}
          >
            <b>{row.org.name}</b>
            <small>
              {row.org.role !== "기타" && `${row.org.role} · `}
              {row.awaitingCount > 0 ? `미결 ${row.awaitingCount}` : `업무 ${row.openCount}`}
            </small>
          </button>
        ))}
      </div>

      <section className="card onepage">
        <div className="card__head">
          <div>
            <div className="card__title">
              {page.org.name}
              {page.org.role !== "기타" && <span className="tag" style={{ marginLeft: 8 }}>{page.org.role}연구기관</span>}
            </div>
            <div className="card__sub">기준일 {page.asOf}</div>
          </div>
          <button className="btn btn--sm" onClick={() => onCopy(renderOrgPageText(page, lines), "기관 원페이지")}>복사</button>
        </div>

        {/* ── 숫자 네 개. 통화 시작 전에 눈에 들어와야 하는 것만 ── */}
        <div className="onepage__stats">
          <div className="metric">
            <div className="metric__label">진척</div>
            {page.progress ? (
              <>
                <div className="metric__value">{page.progress.progress}%</div>
                <div className={`metric__delta tag tag--${VARIANCE_TONE[page.progress.status]}`}>
                  계획 {page.progress.planned}% · {page.progress.variance > 0 ? "+" : ""}{page.progress.variance}%p
                </div>
              </>
            ) : (
              // 억지로 0%를 보여주면 지연으로 오해된다
              <div className="metric__value muted" style={{ fontSize: 14 }}>WBS 시트 없음</div>
            )}
          </div>
          <div className="metric">
            <div className="metric__label">지연 과업</div>
            <div className="metric__value">{page.delayedTasks.length}</div>
          </div>
          <div className="metric">
            <div className="metric__label">미결 요청</div>
            <div className="metric__value">{page.awaitingCount}</div>
          </div>
          <div className="metric">
            <div className="metric__label">최종 접촉</div>
            <div className="metric__value" style={{ fontSize: 18 }}>
              {page.lastContact || <span className="muted" style={{ fontSize: 14 }}>기록 없음</span>}
            </div>
          </div>
        </div>

        <div className="onepage__grid">
          <Block title="지연 과업" sub="WBS">
            {page.delayedTasks.map((item) => (
              <div key={item.code} className="orow">
                <span className="orow__code">{item.code}</span>
                <span className="orow__text">{item.title}</span>
                <span className="orow__meta">{item.dueLabel}{item.variance != null && ` · ${item.variance}%p`}</span>
              </div>
            ))}
          </Block>

          <Block title="미결 요청" sub="내 업무">
            {page.openRequests.map((item) => (
              <div key={item.id} className={`orow ${item.overdue ? "is-over" : ""}`}>
                <span className="orow__text">{item.text}</span>
                <span className="orow__meta">
                  {item.sentAt || "발송 기록 없음"}
                  {item.waitingDays != null && ` · ${item.waitingDays}영업일 대기`}
                  {item.overdue && " · 임계일 초과"}
                </span>
              </div>
            ))}
          </Block>

          <Block title="다음 마일스톤" sub="WBS">
            {page.nextMilestones.map((item) => (
              <div key={item.code} className="orow">
                <span className="orow__code">{item.dueLabel}</span>
                <span className="orow__text">{item.title}</span>
                {item.deliverable && <span className="orow__meta">{item.deliverable}</span>}
              </div>
            ))}
          </Block>

          <Block title="최근 이력" sub={`최근 ${page.recent.length}건`}>
            {page.recent.map((item, index) => (
              <div key={`${item.at}-${index}`} className="orow">
                <span className="orow__code">{item.at.slice(5)}</span>
                <span className="orow__text">{item.label}</span>
                {item.note && <span className="orow__meta">{item.note}</span>}
              </div>
            ))}
          </Block>
        </div>

        <div className="onepage__summary">
          <div className="card__head" style={{ padding: 0, border: 0 }}>
            <div>
              <div className="card__title">요약</div>
              <div className="card__sub">
                {summary?.fromLlm ? "LLM · 집계값만 넘겼습니다" : "규칙 — 집계값을 그대로 인용합니다"}
              </div>
            </div>
            <button className="btn btn--sm" onClick={run} disabled={busy || !llmReady}>
              {busy ? "생성 중…" : llmReady ? "LLM으로 다듬기" : "모델 없음"}
            </button>
          </div>
          {summary?.note && <p className="notice notice--warn">{summary.note}</p>}
          <p className="onepage__text">{lines.join(" ")}</p>
          <PromptPeek label="모델에 보낼 집계값 보기" text={buildOrgSummaryPrompt(page)} />
        </div>
      </section>
    </div>
  );
}

function Block({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  const rows = Array.isArray(children) ? children : [children];
  const empty = rows.every((row) => !row);
  return (
    <section className="oblock">
      <div className="oblock__head">
        <b>{title}</b>
        <small>{sub}</small>
      </div>
      {empty || !rows.length ? <p className="bucket__empty">해당 없음</p> : children}
    </section>
  );
}
