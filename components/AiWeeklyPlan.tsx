"use client";

import { useMemo, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  BUREAUS,
  buildPlanPrompt,
  classifyPlanType,
  generatePlanItem,
  SHAPE_OF,
  TYPE_ORDER,
  typeLabel,
  validateItem,
  WEEKLY_LLM_OPTIONS,
  width,
  type PlanInput,
  type PlanResult,
  type PlanTypeId,
} from "@/lib/weeklyPlan";
import { loadLlmConfig, makeTextCall } from "@/lib/llm";

/**
 * 주간업무계획 초안.
 *
 * 다른 화면과 성격이 다르다 — 여기서는 **분량 자체가 형식이다.** 한글 파일의 줄배치를
 * 실측해 만든 예산이라, 넘기면 목록 정렬이 실제로 깨진다.
 *
 * 그래서 이 화면만 생성 → 검증 → 재생성 루프를 돌고, 결과에 **위반 내역을 숫자로**
 * 함께 띄운다. 통과하지 못해도 초안과 위반 목록을 남겨 사람이 고칠 수 있게 한다.
 */
export default function AiWeeklyPlan({
  llmReady,
  onCopy,
}: {
  llmReady: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const [bureau, setBureau] = useState(BUREAUS[7].name);
  const [dept, setDept] = useState("");
  const [titleSeed, setTitleSeed] = useState("");
  const [facts, setFacts] = useState("");
  const [tag, setTag] = useState<"신규" | "진행">("신규");
  const [forceType, setForceType] = useState<PlanTypeId | "">("");
  const [result, setResult] = useState<PlanResult | null>(null);
  const [edited, setEdited] = useState("");
  const [busy, setBusy] = useState(false);

  const input: PlanInput = useMemo(
    () => ({ bureau, dept, titleSeed, facts, tag, ...(forceType ? { forceType } : {}) }),
    [bureau, dept, titleSeed, facts, tag, forceType],
  );
  const detected = useMemo(() => classifyPlanType(titleSeed), [titleSeed]);

  // 편집 중에도 규정 위반을 바로 보여준다 — 고치고 나서 다시 돌릴 필요가 없다
  const type = forceType || detected;
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

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">항목 조건</div>
            <div className="card__sub">
              유형은 제목 키워드로 정합니다 — 모델에 맡기면 라벨 조합이 매번 흔들립니다
            </div>
          </div>
          <button className="btn btn--primary" onClick={run} disabled={busy || !titleSeed.trim()}>
            {busy ? "생성·검증 중…" : result ? "다시 생성" : "초안 생성"}
          </button>
        </div>

        <div className="card__body stack">
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
              <span>진행 태그</span>
              <select className="select" value={tag} onChange={(e) => setTag(e.target.value as "신규" | "진행")}>
                <option value="신규">신규</option>
                <option value="진행">진행</option>
              </select>
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
                {SHAPE_OF[type] === "result" ? "제목 한 줄로 완결 — 본문·각주 없음"
                  : SHAPE_OF[type] === "schedule" ? "제목 + 각주 0~1개 — 본문 없음"
                  : "제목 + 본문 1~3 + 각주 0~2"}
              </small>
            </label>
          </div>

          <label className="field">
            <span>제목 소재</span>
            <input
              className="input" value={titleSeed} onChange={(e) => setTitleSeed(e.target.value)}
              placeholder="예: AI 사업 카탈로그 시스템 구축 추진"
            />
            <small>{titleSeed && `${width(titleSeed)}폭 · 제목 라인은 80폭 이하여야 합니다`}</small>
          </label>

          <label className="field">
            <span>사실관계</span>
            <textarea
              className="textarea minutes__input" rows={6} value={facts}
              onChange={(e) => setFacts(e.target.value)}
              placeholder={"- 13개 AI 사업을 웹 카탈로그로 전환\n- 기존 엑셀 관리의 갱신 지연 문제\n- 4월 프로토타입, 6월 시범운영"}
            />
            <small>여기 적힌 것만 씁니다. 없는 수치·일정은 모델이 지어내지 못하게 지시합니다.</small>
          </label>

          <p className="notice notice--warn">
            <b>이 기능은 8B급 모델로는 부족합니다.</b> 개조식 서식과 라인 형식을 지키지 못해
            재생성을 반복합니다. <code>qwen2.5:14b-instruct</code> 이상 또는 <code>exaone3.5:7.8b</code>
            계열을 권장합니다 — <code>보고 생성</code> 설정에서 모델을 바꾸세요.
          </p>
          <p className="notice">
            분량은 프롬프트만으로 맞지 않습니다. 생성 후 <b>표시폭을 세어 검증</b>하고,
            어긋나면 <b>몇 폭 초과인지 숫자로 알려주며</b> 최대 3회까지 다시 만듭니다.
          </p>

          {titleSeed.trim() && <PromptPeek text={buildPlanPrompt(input)} />}
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

            {/* 편집 중에도 규정 위반을 바로 보여준다 */}
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
