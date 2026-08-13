"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  buildSectionPrompt,
  generateHandover,
  renderHandoverText,
  SECTION_TITLE,
  selectHandover,
  type Handover,
  type HandoverEntry,
  type SectionId,
} from "@/lib/handover";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { LlmCall } from "@/lib/llm";

const SECTIONS: SectionId[] = ["ongoing", "awaiting", "delayed"];

/**
 * 인수인계서.
 *
 * 담당자가 바뀔 때 유실되는 건 과업 목록이 아니라 **"왜 이 상태인지"** 다.
 * 그래서 화면도 경위를 앞세우고, 각 문장 밑에 그 근거가 된 사실을 그대로 붙인다.
 */
export default function AiHandover({
  today,
  tasks,
  events,
  makeCall,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  events: TaskEvent[];
  makeCall: () => LlmCall | null;
  onCopy: (text: string, label: string) => void;
}) {
  const [handover, setHandover] = useState<Handover | null>(null);
  const [busy, setBusy] = useState(false);

  const facts = useMemo(() => selectHandover(tasks, events, today), [tasks, events, today]);
  const total = facts.ongoing.length + facts.awaiting.length + facts.delayed.length;

  const run = async () => {
    setBusy(true);
    try {
      setHandover(await generateHandover(tasks, events, today, makeCall()));
    } finally {
      setBusy(false);
    }
  };

  if (!total) {
    return (
      <div className="card">
        <div className="card__body empty">
          <p className="empty__title">인계할 항목이 없습니다</p>
          <p className="empty__body">진행 중인 업무가 등록되면 여기에 정리됩니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">인수인계 대상 {total}건</div>
            <div className="card__sub">
              진행 중 {facts.ongoing.length} · 미결 요청 {facts.awaiting.length} · 지연 이력 {facts.delayed.length}
              {" — 선별과 사실 조립은 규칙이 합니다"}
            </div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy}>
            {busy ? "생성 중…" : handover ? "다시 생성" : "인수인계서 생성"}
          </button>
        </div>
        <div className="card__body stack">
          {SECTIONS.filter((section) => facts[section].length > 0).map((section) => (
            <PromptPeek
              key={section}
              label={`${SECTION_TITLE[section]} — 모델에 보낼 원문 보기`}
              text={buildSectionPrompt(section, facts[section], today)}
            />
          ))}
        </div>
      </section>

      {handover && (
        <>
          {handover.notes.length > 0 && (
            <p className="notice notice--warn">
              일부 섹션은 규칙 문장으로 작성했습니다 ({handover.notes.join("; ")})
            </p>
          )}

          {SECTIONS.map((section) => (
            <Section key={section} title={SECTION_TITLE[section]} entries={handover.sections[section]} />
          ))}

          <section className="card">
            <div className="card__head">
              <div>
                <div className="card__title">기관별 접촉 이력</div>
                <div className="card__sub">숫자와 날짜뿐이라 모델을 태우지 않습니다</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>기관</th><th className="table__num">진행 중</th>
                    <th className="table__num">미결</th><th>최종 접촉</th>
                  </tr>
                </thead>
                <tbody>
                  {handover.byOrg.map((row) => (
                    <tr key={row.orgId}>
                      <td className="table__name">{row.name}</td>
                      <td className="table__num">{row.openCount}</td>
                      <td className="table__num">{row.awaitingCount}</td>
                      <td>{row.lastContact || <span className="muted">기록 없음</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="tree-actions">
            <button className="btn btn--sm" onClick={() => onCopy(renderHandoverText(handover), "인수인계서")}>
              전체 복사
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, entries }: { title: string; entries: HandoverEntry[] }) {
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
          <div key={`${title}-${entry.item.id}`} className="line">
            <p className="line__text">{entry.line}</p>
            {/* 문장 밑에 근거가 된 사실을 그대로 붙인다 */}
            <p className="line__source">
              <span className={`tag ${entry.fromLlm ? "" : "tag--warn"}`}>{entry.fromLlm ? "LLM" : "규칙"}</span>
              {entry.item.orgLabel} · {entry.item.category}
              {entry.item.facts.length > 0 && ` · ${entry.item.facts.join(" · ")}`}
            </p>
          </div>
        ))}
        {!entries.length && <p className="bucket__empty">해당 없음</p>}
      </div>
    </section>
  );
}
