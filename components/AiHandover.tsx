"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  assembleSections,
  buildOverviewPrompt,
  generateHandoverDoc,
  HANDOVER_LLM_OPTIONS,
  LLM_SECTION,
  SECTIONS,
  SECTION_TITLE,
  type HandoverDoc,
  type HandoverInput,
} from "@/lib/handover";
import { loadLlmConfig, makeCall } from "@/lib/llm";
import { downloadText } from "@/lib/store";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { WbsStatus } from "@/lib/wbsStatus";
import type { WbsTask } from "@/lib/types";

/**
 * 인수인계서 — 6개 절, 조립이 주(主)고 LLM은 `사업 개요` 한 단락뿐.
 *
 * 담당자가 바뀌는 날 열어보는 문서라 **모델 사정에 품질이 좌우되면 안 된다.**
 * 그래서 다섯 절은 데이터로 조립하고, 개요만 모델에 맡긴다. 실패하면 그 한 절만
 * "생성 실패 — 직접 작성"으로 남는다.
 */
export default function AiHandover({
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
  const [doc, setDoc] = useState<HandoverDoc | null>(null);
  const [edited, setEdited] = useState("");
  const [busy, setBusy] = useState(false);

  const input: HandoverInput = useMemo(
    () => ({ projectName, today, tasks, events, status, wbsTasks }),
    [projectName, today, tasks, events, status, wbsTasks],
  );
  const preview = useMemo(() => assembleSections(input), [input]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await generateHandoverDoc(
        input,
        llmReady ? makeCall({ ...loadLlmConfig(), ...HANDOVER_LLM_OPTIONS }) : null,
      );
      setDoc(next);
      setEdited(next.text);
    } finally {
      setBusy(false);
    }
  };

  const counts = SECTIONS.filter((id) => id !== LLM_SECTION)
    .map((id) => `${SECTION_TITLE[id]} ${preview.sections[id].length}`)
    .join(" · ");

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">인수인계서</div>
            <div className="card__sub">
              여섯 절 중 <b>사업 개요만</b> 모델이 씁니다 — 나머지는 등록된 데이터로 조립합니다
            </div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy}>
            {busy ? "생성 중…" : doc ? "다시 생성" : "인수인계서 생성"}
          </button>
        </div>

        <div className="card__body stack">
          <p className="notice">조립 결과 — {counts}</p>
          <PromptPeek label="사업 개요에 보낼 집계값 보기" text={buildOverviewPrompt(input, preview.signals)} />
        </div>
      </section>

      {doc && (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">
                {doc.projectName} 업무 인수인계서
                <span className={`tag ${doc.fromLlm ? "" : "tag--warn"}`} style={{ marginLeft: 8 }}>
                  {doc.fromLlm ? "개요 LLM" : "개요 미생성"}
                </span>
              </div>
              <div className="card__sub">기준일 {doc.asOf} · 플레인 텍스트</div>
            </div>
            <div className="tree-actions">
              <button className="btn btn--sm" onClick={() => onCopy(edited, "인수인계서")}>복사</button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => downloadText(edited, `인수인계서_${doc.asOf.replace(/-/g, "")}.txt`)}
              >
                .txt 저장
              </button>
            </div>
          </div>

          <div className="card__body stack">
            {doc.note && (
              <p className="notice notice--warn">
                사업 개요만 자동 생성하지 못했습니다. 나머지 다섯 절은 정상입니다. ({doc.note})
              </p>
            )}
            <textarea
              className="textarea plan__text" rows={24} value={edited}
              onChange={(event) => setEdited(event.target.value)}
              aria-label="인수인계서"
            />
          </div>
        </section>
      )}
    </div>
  );
}
