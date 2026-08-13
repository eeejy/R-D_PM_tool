"use client";

import { useState } from "react";
import AiWeeklyPlan from "./AiWeeklyPlan";
import AiWeeklyReport from "./AiWeeklyReport";
import type { TaskEvent } from "@/lib/history";
import type { MyTask } from "@/lib/mytask";
import type { WbsStatus } from "@/lib/wbsStatus";
import type { WbsTask } from "@/lib/types";

type Mode = "item" | "report";

/**
 * 주간 산출물 두 가지.
 *
 * **용도가 다르다.** 항목 단위는 청 주간업무계획 문서에 낄 항목 한 건이고(실측
 * 서식·표시폭 검증), 사업 주간보고는 사업 단위로 한 주를 정리한 문서 한 장이다.
 * 서식도 분량 규칙도 달라서 한 화면에 섞지 않고 나눠 둔다.
 */
export default function AiWeekly(props: {
  today: string;
  projectName: string;
  department: string;
  tasks: MyTask[];
  events: TaskEvent[];
  status: WbsStatus | null;
  wbsTasks: WbsTask[];
  llmReady: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("report");

  return (
    <div className="stack">
      <div className="tabs">
        <button className="tabs__item" aria-current={mode === "report"} onClick={() => setMode("report")}>
          <b>사업 주간보고</b>
          <small>한 장 · 추진배경/주요내용/향후계획</small>
        </button>
        <button className="tabs__item" aria-current={mode === "item"} onClick={() => setMode("item")}>
          <b>항목 단위</b>
          <small>청 문서에 낄 항목 1건 · 표시폭 검증</small>
        </button>
      </div>

      {mode === "report" ? (
        <AiWeeklyReport
          today={props.today} projectName={props.projectName} tasks={props.tasks}
          events={props.events} status={props.status} wbsTasks={props.wbsTasks}
          llmReady={props.llmReady} onCopy={props.onCopy}
        />
      ) : (
        <AiWeeklyPlan
          today={props.today} tasks={props.tasks} events={props.events}
          department={props.department} llmReady={props.llmReady} onCopy={props.onCopy}
        />
      )}
    </div>
  );
}
