"use client";

import { useMemo, useRef, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  generateWeeklyReport,
  hasAllSections,
  REPORT_LLM_OPTIONS,
  SECTION_GUIDE,
  SECTIONS,
  type WeeklyReport,
} from "@/lib/weeklyReport";
import { buildWeeklyContext, CONTEXT_EXCLUDED, CONTEXT_TOKEN_LIMIT, estimateTokens, weekLabel, weekRange } from "@/lib/llmContext";
import { loadLlmConfig, makeCall } from "@/lib/llm";
import { downloadText } from "@/lib/store";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { WbsStatus } from "@/lib/wbsStatus";
import type { WbsTask } from "@/lib/types";

type Phase = "idle" | "streaming" | "done" | "error";

/**
 * 사업 주간보고서 — 4개 요소 고정 양식.
 *
 * **골격은 코드가 만든다.** 타이틀·섹션 헤더·말미 안내문은 고정 문자열이고 LLM은
 * `○` 항목 내용만 만든다. 그래서 모델이 죽어도 네 요소가 그대로 나온다.
 *
 * 모델에는 요약 컨텍스트만 넘긴다 — 무엇이 들어가고 무엇이 빠졌는지 화면에 적어 둔다.
 */
export default function AiWeeklyReport({
  today,
  projectName,
  tasks,
  events,
  status,
  wbsTasks,
  llmReady,
  onCopy,
}: {
  today: string;
  projectName: string;
  tasks: MyTask[];
  events: TaskEvent[];
  status: WbsStatus | null;
  wbsTasks: WbsTask[];
  llmReady: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const [asOf, setAsOf] = useState(today);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [edited, setEdited] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  const input = useMemo(
    () => ({ projectName, today: asOf, tasks, events, status, wbsTasks }),
    [projectName, asOf, tasks, events, status, wbsTasks],
  );
  const context = useMemo(() => buildWeeklyContext(input), [input]);
  const tokens = estimateTokens(context);
  const range = weekRange(asOf);

  const run = async () => {
    // 중복 클릭 차단 — 같은 요청이 두 번 나가면 모델이 두 배로 돈다
    if (phase === "streaming") return;
    const controller = new AbortController();
    abort.current = controller;
    setPhase("streaming");
    setError("");
    try {
      const next = await generateWeeklyReport(
        input,
        llmReady
          ? makeCall({ ...loadLlmConfig(), ...REPORT_LLM_OPTIONS }, { signal: controller.signal })
          : null,
      );
      setReport(next);
      setEdited(next.text);
      // 모델이 실패해도 골격은 나온다. 그 사실을 상태로 구분해 알린다.
      if (next.note) { setPhase("error"); setError(next.note); }
      else setPhase("done");
    } catch (cause) {
      // generateWeeklyReport가 삼키지만, 여기까지 온 예외도 로딩을 잡아두지 않는다
      setPhase("error");
      setError(cause instanceof Error ? cause.message : "알 수 없는 오류");
    } finally {
      // 어떤 경로로 빠져나가도 로딩은 반드시 풀린다
      abort.current = null;
    }
  };

  const fileName = `주간업무계획_${range.start.replace(/-/g, "")}.txt`;

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">사업 주간보고서</div>
            <div className="card__sub">
              추진배경 · 주요내용 · 향후계획 — 네 요소는 어떤 경우에도 빠지지 않습니다
            </div>
          </div>
          <div className="tree-actions">
            {phase === "streaming" && (
              <button className="btn btn--sm btn--ghost" onClick={() => abort.current?.abort()}>중단</button>
            )}
            <button className="btn btn--primary" onClick={run} disabled={phase === "streaming"}>
              {phase === "streaming" ? "생성 중…" : report ? "다시 생성" : "보고서 생성"}
            </button>
          </div>
        </div>

        <div className="card__body stack">
          <div className="quick__preview">
            <label className="field">
              <span>기준일</span>
              <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today)} />
              <small>{weekLabel(asOf)} 주간으로 잡힙니다</small>
            </label>
            <label className="field">
              <span>요약 분량</span>
              <input className="input" value={`약 ${tokens.toLocaleString()} 토큰`} readOnly />
              <small>{tokens > CONTEXT_TOKEN_LIMIT ? "상한을 넘어 뒷부분을 생략합니다" : `상한 ${CONTEXT_TOKEN_LIMIT.toLocaleString()} 이내`}</small>
            </label>
          </div>

          {/* 원본을 통째로 넣지 않는다. 무엇을 뺐는지도 밝힌다. */}
          <p className="notice">
            <b>요약본만 모델에 넘깁니다.</b> 제외: {CONTEXT_EXCLUDED.join(" · ")}
          </p>

          <PromptPeek label="모델에 보낼 요약 자료 보기" text={context} />
        </div>
      </section>

      {report && (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">
                {report.title}
                <span className={`tag ${report.fromLlm ? "" : "tag--warn"}`} style={{ marginLeft: 8 }}>
                  {report.fromLlm ? "LLM" : "골격만"}
                </span>
              </div>
              <div className="card__sub">
                {hasAllSections(edited) ? "네 요소 모두 있음" : "요소가 빠졌습니다 — 확인하세요"}
              </div>
            </div>
            <div className="tree-actions">
              <button className="btn btn--sm" onClick={() => onCopy(edited, "주간보고서")}>복사</button>
              <button className="btn btn--sm btn--ghost" onClick={() => downloadText(edited, fileName)}>.txt 저장</button>
            </div>
          </div>

          <div className="card__body stack">
            {phase === "error" && error && (
              <p className="notice notice--warn">
                모델을 쓰지 못해 골격만 만들었습니다. 내용은 직접 채워 주세요. ({error})
              </p>
            )}

            <textarea
              className="textarea plan__text" rows={18} value={edited}
              onChange={(e) => setEdited(e.target.value)}
              aria-label="주간보고서 초안"
            />

            <div className="notice">
              <b>섹션별로 담을 것</b>
              <ul className="reasons">
                {SECTIONS.map((name) => <li key={name}>{name} — {SECTION_GUIDE[name]}</li>)}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
