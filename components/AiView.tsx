"use client";

import { useCallback, useEffect, useState } from "react";
import AiDailyReport from "./AiDailyReport";
import AiEmail from "./AiEmail";
import AiMinutes from "./AiMinutes";
import AiReminder from "./AiReminder";
import AiHandover from "./AiHandover";
import AiWeekly from "./AiWeekly";
import {
  checkOllama,
  connectionHint,
  DEFAULT_LLM_CONFIG,
  loadLlmConfig,
  makeCall,
  saveLlmConfig,
  SUGGESTED_MODELS,
  type LlmConfig,
} from "@/lib/llm";
import type { MyTask } from "@/lib/mytask";
import type { TaskEvent, TaskSignals } from "@/lib/history";
import type { WbsStatus } from "@/lib/wbsStatus";
import type { WbsTask } from "@/lib/types";

type TabId = "daily" | "email" | "reminder" | "minutes" | "handover" | "weekly";

const TABS: { id: TabId; label: string; sub: string }[] = [
  { id: "daily", label: "일일 업무보고", sub: "오늘 보고할 것을 골라 문장으로" },
  { id: "email", label: "이메일 초안", sub: "요청사항을 발송용 메일로" },
  { id: "reminder", label: "재촉", sub: "회신 임계일을 넘긴 요청" },
  { id: "minutes", label: "회의록", sub: "쟁점·결정·후속조치와 1페이지 보고서" },
  { id: "handover", label: "인수인계", sub: "왜 이 상태인지를 남기는 문서" },
  { id: "weekly", label: "주간업무계획", sub: "사업 주간보고 · 항목 단위" },
];

/**
 * 보고 생성 — LLM을 쓰는 화면 전부.
 *
 * 세 가지를 지킨다.
 *   - **자동 호출 없음.** 버튼을 누를 때만 모델이 돈다.
 *   - **로컬만.** 주소는 localhost 기본값이고 클라우드 API는 붙이지 않는다.
 *   - **모델이 없어도 동작한다.** 연결이 안 되면 규칙 기반 결과로 떨어진다.
 */
export default function AiView({
  today,
  tasks,
  signals,
  events,
  status,
  wbsTasks,
  projectName,
  department,
  onAdd,
  onRecord,
  notify,
}: {
  today: string;
  tasks: MyTask[];
  signals?: Map<string, TaskSignals>;
  events: TaskEvent[];
  status: WbsStatus | null;
  wbsTasks: WbsTask[];
  projectName: string;
  department: string;
  onAdd: (tasks: MyTask[]) => void;
  onRecord: (event: TaskEvent) => void;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<TabId>("daily");
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const [models, setModels] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 배포된 주소에서는 연결 실패의 원인이 달라진다 — 안내를 바꾸기 위해 들고 있는다. */
  const [pageOrigin, setPageOrigin] = useState("");

  useEffect(() => {
    setConfig(loadLlmConfig());
    setPageOrigin(window.location.origin);
  }, []);

  const check = useCallback(async (target: LlmConfig) => {
    setChecking(true);
    const status = await checkOllama(target);
    setModels(status.ok ? status.models : null);
    setChecking(false);
    return status.ok;
  }, []);

  useEffect(() => {
    // 화면에 들어올 때 연결만 확인한다. 모델을 돌리지는 않는다.
    void check(loadLlmConfig());
  }, [check]);

  const update = (patch: Partial<LlmConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  };

  const connected = models !== null;
  const ready = connected && models.some((name) => name === config.model || name.startsWith(`${config.model.split(":")[0]}:`));

  /** 각 패널이 호출할 때 부르는 함수. 연결이 없으면 null을 줘서 규칙 결과로 떨어뜨린다. */
  const call = () => (connected ? makeCall(config) : null);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${label}을 복사했습니다`);
    } catch {
      notify("복사하지 못했습니다");
    }
  };

  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">보고 생성</h1>
        <p className="view__sub">
          로컬 모델로 문장만 만듭니다 · 무엇을 보고할지 고르는 일은 규칙이 합니다
        </p>
      </div>

      <section className="card ollama">
        <div className="ollama__row">
          <span className={`dot ${connected ? (ready ? "dot--ok" : "dot--warn") : "dot--off"}`} aria-hidden />
          <div className="ollama__state">
            <b>
              {checking ? "확인 중…"
                : !connected ? "Ollama에 연결되지 않음"
                : ready ? `${config.model} 사용 가능`
                : `${config.model}을(를) 찾지 못함`}
            </b>
            <small>
              {!connected ? `${connectionHint(pageOrigin)} 연결 없이도 규칙 기반 결과는 나옵니다.`
                : ready ? `${config.endpoint} · 컨텍스트 ${config.numCtx.toLocaleString()} 토큰`
                : `받아 둔 모델: ${models?.join(", ") || "없음"} · \`ollama pull ${config.model}\``}
            </small>
          </div>
          <button className="btn btn--sm" onClick={() => check(config)} disabled={checking}>연결 확인</button>
          <button className="btn btn--sm btn--ghost" onClick={() => setSettingsOpen((open) => !open)}>
            {settingsOpen ? "설정 닫기" : "설정"}
          </button>
        </div>

        {settingsOpen && (
          <div className="quick__preview">
            <label className="field">
              <span>모델</span>
              <input
                className="input" list="ollama-models" value={config.model}
                onChange={(event) => update({ model: event.target.value })}
              />
              <datalist id="ollama-models">
                {(models ?? SUGGESTED_MODELS).map((name) => <option key={name} value={name} />)}
              </datalist>
              <small>모델 태그는 자주 바뀝니다 — 받기 전 ollama.com/library에서 확인하세요.</small>
            </label>
            <label className="field">
              <span>주소</span>
              <input className="input" value={config.endpoint} onChange={(event) => update({ endpoint: event.target.value })} />
              <small>로컬 고정. 외부 API는 붙이지 않습니다.</small>
            </label>
            <label className="field">
              <span>컨텍스트(num_ctx)</span>
              <input
                className="input" type="number" min={4096} step={4096} value={config.numCtx}
                onChange={(event) => update({ numCtx: Number(event.target.value) || DEFAULT_LLM_CONFIG.numCtx })}
              />
              <small>기본값 4096으로 두면 긴 회의록의 뒷부분이 조용히 잘립니다.</small>
            </label>
            <label className="field">
              <span>temperature</span>
              <input
                className="input" type="number" min={0} max={1} step={0.1} value={config.temperature}
                onChange={(event) => update({ temperature: Number(event.target.value) })}
              />
              <small>사실 추출 작업이라 낮게 둡니다.</small>
            </label>
          </div>
        )}
      </section>

      <div className="tabs">
        {TABS.map((item) => (
          <button key={item.id} className="tabs__item" aria-current={tab === item.id} onClick={() => setTab(item.id)}>
            <b>{item.label}</b>
            <small>{item.sub}</small>
          </button>
        ))}
      </div>

      {tab === "daily" && <AiDailyReport today={today} tasks={tasks} signals={signals} makeCall={call} onCopy={copy} />}
      {tab === "email" && (
        <AiEmail today={today} tasks={tasks} projectName={projectName} department={department} makeCall={call} onCopy={copy} />
      )}
      {tab === "reminder" && (
        <AiReminder
          today={today} tasks={tasks} events={events}
          projectName={projectName} department={department}
          makeCall={call} onRecord={onRecord} onCopy={copy}
        />
      )}
      {tab === "minutes" && <AiMinutes today={today} makeCall={call} onAdd={onAdd} onCopy={copy} />}
      {tab === "handover" && (
        <AiHandover
          today={today} projectName={projectName} tasks={tasks} events={events}
          status={status} wbsTasks={wbsTasks} llmReady={connected} onCopy={copy}
        />
      )}
      {tab === "weekly" && (
        <AiWeekly
          today={today} projectName={projectName} department={department}
          tasks={tasks} events={events} status={status} wbsTasks={wbsTasks}
          llmReady={connected} onCopy={copy}
        />
      )}
    </div>
  );
}
