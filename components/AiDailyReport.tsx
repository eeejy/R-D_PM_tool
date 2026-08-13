"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  AUDIENCE_LABEL,
  buildReportInput,
  buildReportPrompt,
  generateDailyReport,
  renderReportText,
  selectReportItems,
  type DailyReport,
  type ReportEntry,
} from "@/lib/dailyReport";
import type { MyTask } from "@/lib/mytask";
import type { LlmCall } from "@/lib/llm";
import type { TaskSignals } from "@/lib/history";

/**
 * 일일 업무보고.
 *
 * 화면에 먼저 보이는 건 **룰이 고른 목록**이다. 생성 버튼을 누르기 전에 무엇이
 * 보고 대상인지, 왜 대상인지를 확인할 수 있어야 한다 — LLM은 그 다음 순서다.
 */
export default function AiDailyReport({
  today,
  tasks,
  signals,
  makeCall,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  /** 지연·회신 지표. 보고 근거에 "3회 연기", "회신 대기 5영업일 경과"로 붙는다. */
  signals?: Map<string, TaskSignals>;
  makeCall: () => LlmCall | null;
  onCopy: (text: string, label: string) => void;
}) {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => selectReportItems(tasks, today, signals), [tasks, today, signals]);
  const prompt = useMemo(
    () => (items.length ? buildReportPrompt(buildReportInput(items, today)) : ""),
    [items, today],
  );

  const run = async () => {
    setBusy(true);
    try {
      setReport(await generateDailyReport(tasks, today, makeCall(), signals));
    } finally {
      setBusy(false);
    }
  };

  if (!items.length) {
    return (
      <div className="card">
        <div className="card__body empty">
          <p className="empty__title">오늘 보고할 항목이 없습니다</p>
          <p className="empty__body">
            기한 임박·기한 초과·2회 이상 미뤄짐·회신 대기·회의 전 확정 필요 중 하나에
            해당하는 업무가 보고 대상으로 올라옵니다.
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
            <div className="card__title">보고 대상 {items.length}건</div>
            <div className="card__sub">선별은 규칙이 합니다 — 아래 근거를 보고 확인하세요</div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy}>
            {busy ? "생성 중…" : report ? "다시 생성" : "보고문 생성"}
          </button>
        </div>

        <div className="card__body stack">
          <ul className="picked">
            {items.map((item) => (
              <li key={item.id} className="picked__row">
                <span className={`tag ${item.audience === "supervisor" ? "tag--info" : item.audience === "both" ? "tag--danger" : "tag--accent"}`}>
                  {AUDIENCE_LABEL[item.audience]}
                </span>
                <span className="picked__text">{item.text}</span>
                <span className="picked__reason">{item.reason}</span>
                <span className="picked__due">{item.dueLabel}</span>
              </li>
            ))}
          </ul>
          <PromptPeek text={prompt} />
        </div>
      </section>

      {report && (
        <>
          {report.note && (
            <p className="notice notice--warn">
              모델을 쓰지 못해 규칙 문장으로 만들었습니다. ({report.note})
            </p>
          )}
          <div className="split split--even">
            <ReportCard title="상부 구두보고" entries={report.toSupervisor} />
            <ReportCard title="연구책임자 전달사항" entries={report.toPI} />
          </div>
          <div className="tree-actions">
            <button className="btn btn--sm" onClick={() => onCopy(renderReportText(report), "보고문")}>
              전체 복사
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ReportCard({ title, entries }: { title: string; entries: ReportEntry[] }) {
  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">{title}</div>
          <div className="card__sub">{entries.length}건</div>
        </div>
      </div>
      <div className="card__body stack">
        {entries.map((entry) => (
          <div key={entry.item.id} className="line">
            <p className="line__text">{entry.line}</p>
            {/* 근거를 문장 바로 밑에 둔다. 보고 중 "그거 무슨 건이냐"는 질문이 바로 온다. */}
            <p className="line__source">
              <span className={`tag ${entry.fromLlm ? "" : "tag--warn"}`}>{entry.fromLlm ? "LLM" : "규칙"}</span>
              {entry.item.category}
              {entry.item.org && ` · ${entry.item.org}`}
              {` · ${entry.item.dueLabel} · ${entry.item.reason}`}
            </p>
            <p className="line__quote">{entry.item.text}</p>
          </div>
        ))}
        {!entries.length && <p className="bucket__empty">해당 없음</p>}
      </div>
    </section>
  );
}
