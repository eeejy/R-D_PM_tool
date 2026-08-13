"use client";

import { useEffect, useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  BUREAUS,
  buildPlanPrompt,
  classifyPlanType,
  generatePlanItem,
  SHAPE_OF,
  taskToPlanInput,
  TYPE_ORDER,
  typeLabel,
  validateItem,
  WEEKLY_LLM_OPTIONS,
  width,
  type PlanResult,
  type PlanTypeId,
} from "@/lib/weeklyPlan";
import { loadLlmConfig, makeTextCall } from "@/lib/llm";
import type { TaskEvent } from "@/lib/history";
import { score, type MyTask } from "@/lib/mytask";
import { categoryTitle } from "@/lib/worktree";

/**
 * 주간업무계획 초안.
 *
 * **이미 등록된 보고사항을 그 서식으로 뽑는 화면이다.** 빈 폼에 사실관계를 옮겨 적게
 * 하면 업무트리에 있는 내용을 두 번 쓰게 된다 — 업무를 고르면 기관·기한·상태·지연
 * 이력이 그대로 재료가 된다.
 *
 * 다른 화면과 다른 점은 그대로다. **여기서는 분량 자체가 형식이라** 생성 뒤 표시폭을
 * 세어 검증하고, 어긋나면 몇 폭 초과인지 숫자로 알려주며 다시 만든다.
 */
export default function AiWeeklyPlan({
  today,
  tasks,
  events,
  department,
  llmReady,
  onCopy,
}: {
  today: string;
  tasks: MyTask[];
  events: TaskEvent[];
  department: string;
  llmReady: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const [bureau, setBureau] = useState(BUREAUS[7].name);
  const [dept, setDept] = useState(department);
  const [picked, setPicked] = useState<string | null>(null);
  const [forceType, setForceType] = useState<PlanTypeId | "">("");
  const [titleSeed, setTitleSeed] = useState("");
  const [facts, setFacts] = useState("");
  const [result, setResult] = useState<PlanResult | null>(null);
  const [edited, setEdited] = useState("");
  const [busy, setBusy] = useState(false);

  /** 급한 것부터 위로. 종결된 업무는 보지 않는다. */
  const candidates = useMemo(
    () => tasks
      .filter((task) => task.status !== "완료")
      .map((task) => score(task, today))
      .sort((a, b) => b.score - a.score),
    [tasks, today],
  );

  const task = candidates.find((item) => item.id === picked) ?? null;

  // 업무를 고르면 사실관계를 이력에서 조립해 채운다. 이후 손으로 고칠 수 있다.
  useEffect(() => {
    if (!task) return;
    const input = taskToPlanInput(task, { bureau, dept, today, events });
    setTitleSeed(input.titleSeed);
    setFacts(input.facts);
    setResult(null);
    setEdited("");
  }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const detected = useMemo(() => classifyPlanType(titleSeed), [titleSeed]);
  const type = forceType || detected;
  const input = useMemo(
    () => ({ bureau, dept, titleSeed, facts, ...(forceType ? { forceType } : {}) }),
    [bureau, dept, titleSeed, facts, forceType],
  );

  // 편집 중에도 규정 위반을 바로 보여준다 — 고치고 나서 다시 돌릴 필요가 없다
  const liveCheck = useMemo(() => (edited.trim() ? validateItem(edited, type) : null), [edited, type]);

  const run = async () => {
    if (!titleSeed.trim()) return;
    setBusy(true);
    try {
      const next = await generatePlanItem(
        input,
        llmReady ? makeTextCall({ ...loadLlmConfig(), ...WEEKLY_LLM_OPTIONS }) : null,
      );
      setResult(next);
      setEdited(next.text);
    } finally {
      setBusy(false);
    }
  };

  if (!candidates.length) {
    return (
      <div className="card">
        <div className="card__body empty">
          <p className="empty__title">뽑을 보고사항이 없습니다</p>
          <p className="empty__body">개요의 빠른 입력으로 업무를 등록하면 여기에서 골라 쓸 수 있습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">보고사항 고르기 {candidates.length}건</div>
            <div className="card__sub">등록된 업무에서 기관·기한·지연 이력을 그대로 가져옵니다</div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy || !titleSeed.trim()}>
            {busy ? "생성·검증 중…" : result ? "다시 생성" : "초안 생성"}
          </button>
        </div>

        <div className="card__body stack">
          <ul className="picked">
            {candidates.map((item) => (
              <li key={item.id} className={`picked__row picked__row--pick ${picked === item.id ? "is-on" : ""}`}>
                <label className="picked__check">
                  <input type="radio" name="wp-task" checked={picked === item.id} onChange={() => setPicked(item.id)} />
                  <span className="picked__text">{item.title}</span>
                </label>
                <span className="picked__reason">
                  {categoryTitle(item.categoryId)}{item.org && ` · ${item.org}`}
                </span>
                <span className="picked__due">{item.dueLabel}</span>
              </li>
            ))}
          </ul>

          {task && (
            <>
              <div className="quick__preview">
                <label className="field">
                  <span>소속 국</span>
                  <select className="select" value={bureau} onChange={(e) => setBureau(e.target.value)}>
                    {BUREAUS.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                  </select>
                  <small>{BUREAUS.find((item) => item.name === bureau)?.hint || "국별 관행을 따릅니다"}</small>
                </label>
                <label className="field">
                  <span>담당과</span>
                  <input className="input" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="예: 인공지능" />
                </label>
                <label className="field">
                  <span>업무 유형</span>
                  <select className="select" value={forceType} onChange={(e) => setForceType(e.target.value as PlanTypeId | "")}>
                    {/* 원문 빈도순. 자주 쓰는 것이 위에 있어야 한다 */}
                    <option value="">자동 판정 — {typeLabel(detected)}</option>
                    {TYPE_ORDER.map((item) => (
                      <option key={item.id} value={item.id}>{item.label} ({item.count}건)</option>
                    ))}
                  </select>
                  <small>
                    {SHAPE_OF[type] === "schedule"
                      ? "제목 + 각주 0~1개 — 본문 없음"
                      : "제목 + 본문 1~3 + 각주 0~2"}
                  </small>
                </label>
              </div>

              <label className="field">
                <span>제목 소재</span>
                <input className="input" value={titleSeed} onChange={(e) => setTitleSeed(e.target.value)} />
                <small>{titleSeed && `${width(titleSeed)}폭 · 제목 라인은 80폭 이하여야 합니다`}</small>
              </label>

              <label className="field">
                <span>사실관계</span>
                <textarea
                  className="textarea minutes__input" rows={7} value={facts}
                  onChange={(e) => setFacts(e.target.value)}
                />
                <small>등록된 업무와 이력에서 뽑았습니다. 여기 없는 수치·일정은 모델이 지어내지 못합니다.</small>
              </label>

              <p className="notice notice--warn">
                <b>이 기능은 8B급 모델로는 부족합니다.</b> 개조식 서식을 지키지 못해 재생성을
                반복합니다. <code>qwen2.5:14b-instruct</code> 이상 또는 <code>exaone3.5:7.8b</code>
                계열을 권장합니다 — <code>보고 생성</code> 설정에서 모델을 바꾸세요.
              </p>

              <PromptPeek text={buildPlanPrompt(input)} />
            </>
          )}
        </div>
      </section>

      {result && (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">
                초안
                <span className={`tag ${result.ok ? "tag--ok" : "tag--warn"}`} style={{ marginLeft: 8 }}>
                  {result.ok ? "규정 통과" : "확인 필요"}
                </span>
              </div>
              <div className="card__sub">
                {typeLabel(result.type)} · {result.attempts}회 시도
                {result.stats.lines > 0 && ` · ${result.stats.lines}줄 ${result.stats.chars}자`}
              </div>
            </div>
            <button className="btn btn--sm" onClick={() => onCopy(edited, "주간업무계획 항목")}>복사</button>
          </div>

          <div className="card__body stack">
            {result.note && <p className="notice notice--warn">{result.note}</p>}

            <textarea
              className="textarea plan__text" rows={8} value={edited}
              onChange={(e) => setEdited(e.target.value)}
              aria-label="주간업무계획 초안"
            />

            {liveCheck && (
              <div className={`notice ${liveCheck.ok ? "" : "notice--warn"}`}>
                {liveCheck.ok ? (
                  `규정 통과 — ${liveCheck.stats.lines}줄 ${liveCheck.stats.chars}자`
                ) : (
                  <>
                    <b>{liveCheck.errors.length}건 위반</b>
                    <ul className="reasons">
                      {liveCheck.errors.map((error) => <li key={error}>{error}</li>)}
                    </ul>
                  </>
                )}
                {liveCheck.warnings.length > 0 && (
                  <ul className="reasons">
                    {liveCheck.warnings.map((warn) => <li key={warn}>{warn} (권고)</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* 줄마다 표시폭을 띄운다. 분량이 곧 형식이라 눈으로 확인돼야 한다. */}
            <div className="plan__ruler">
              {edited.split("\n").filter((line) => line.trim()).map((line, index) => (
                <div key={index} className="plan__rule">
                  <span className="plan__w">{width(line.trim())}폭</span>
                  <span className="plan__line">{line.trim().slice(0, 60)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
