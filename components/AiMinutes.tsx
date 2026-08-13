"use client";

import { useMemo, useRef, useState } from "react";
import PromptPeek from "./PromptPeek";
import {
  actionsToDrafts,
  buildSegmentPrompt,
  generateMinutes,
  parseMeetingMeta,
  renderOnePager,
  requestsToDrafts,
  splitAgenda,
  type MinutesReport,
} from "@/lib/minutes";
import { readRfpFile, RfpParseError } from "@/lib/rfpParse";
import { orgName } from "@/lib/org";
import { categoryTitle } from "@/lib/worktree";
import type { MyTask } from "@/lib/mytask";
import type { LlmCall } from "@/lib/llm";

/**
 * 회의록 → 쟁점·결정·후속조치 → 1페이지 보고서.
 *
 * 안건마다 따로 호출하므로 30초~1분이 걸린다. 팬 없는 에어에서 연속 호출을 하면
 * 뒤로 갈수록 느려지기 때문에, 화면을 잠그지 않고 진행률만 보여준다.
 */
export default function AiMinutes({
  today,
  makeCall,
  onAdd,
  onCopy,
}: {
  today: string;
  makeCall: () => LlmCall | null;
  onAdd: (tasks: MyTask[]) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<MinutesReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(0);
  /** 등록할 요청사항. **기본값은 전체 해제다** — 회의록에서 뽑은 것이 전부 내 업무는 아니다. */
  const [checked, setChecked] = useState<number[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const segments = useMemo(() => splitAgenda(text), [text]);
  const meta = useMemo(() => parseMeetingMeta(text, today), [text, today]);
  const firstPrompt = useMemo(
    () => (segments.length ? buildSegmentPrompt(segments[0], meta) : ""),
    [segments, meta],
  );

  const accept = async (picked: File | undefined) => {
    if (!picked) return;
    setError("");
    try {
      const document = await readRfpFile(picked);
      setText(document.pages.map((page) => page.text).join("\n\n"));
      setFileName(picked.name);
      setReport(null);
    } catch (cause) {
      setError(cause instanceof RfpParseError ? `${cause.message} ${cause.hint ?? ""}` : "파일을 읽지 못했습니다.");
    }
  };

  const run = async () => {
    if (!segments.length) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ done: 0, total: segments.length });
    setReport(null);
    try {
      const next = await generateMinutes(text, today, makeCall(), {
        signal: controller.signal,
        onProgress: (state) => setProgress({ done: state.done, total: state.total }),
      });
      setReport(next);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const registerActions = () => {
    if (!report?.actions.length) return;
    onAdd(actionsToDrafts(report.actions, today) as MyTask[]);
  };

  const registerRequests = () => {
    if (!report || !checked.length) return;
    const picked = checked.map((index) => report.requests[index]).filter(Boolean);
    onAdd(requestsToDrafts(picked, today, report.meeting.title) as MyTask[]);
    setChecked([]);
  };

  const toggle = (index: number) =>
    setChecked((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index]);

  return (
    <div className="stack">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">회의록 넣기</div>
            <div className="card__sub">파일을 넣거나 원문을 붙여넣으세요 · PDF · DOCX · TXT</div>
          </div>
          <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(event) => accept(event.target.files?.[0])} />
          <button className="btn btn--sm" onClick={() => fileInput.current?.click()}>파일 선택</button>
        </div>

        <div className="card__body stack">
          {error && <p className="notice notice--warn">{error}</p>}
          <textarea
            className="textarea minutes__input"
            rows={10}
            value={text}
            onChange={(event) => { setText(event.target.value); setReport(null); }}
            placeholder="회의록 원문을 붙여넣으세요."
            aria-label="회의록 원문"
          />

          {segments.length > 0 && (
            <>
              <p className="notice">
                {fileName && <b>{fileName} · </b>}
                {meta.title} · {meta.date}
                {meta.attendees.length > 0 && ` · 참석 ${meta.attendees.length}명`}
                {" · "}안건 {segments.length}개로 나눴습니다
                {segments.length > 4 && ` — 호출이 ${segments.length}회라 30초~1분 걸립니다`}
              </p>

              <div className="tree-actions">
                <button className="btn btn--primary" onClick={run} disabled={Boolean(progress)}>
                  {progress ? `분석 중… ${progress.done}/${progress.total}` : "쟁점·결정 추출"}
                </button>
                {progress && (
                  <button className="btn btn--sm btn--ghost" onClick={() => abort.current?.abort()}>중단</button>
                )}
              </div>

              {progress && (
                <div className="bar bar--ok">
                  <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
              )}

              <PromptPeek label="첫 안건에 보낼 원문 보기" text={firstPrompt} />
            </>
          )}
        </div>
      </section>

      {report && (
        <>
          {report.failedSegments.length > 0 && (
            <p className="notice notice--warn">
              안건 {report.failedSegments.join(", ")}번은 추출에 실패했습니다. 아래 원문에서 직접 확인해 주세요.
            </p>
          )}

          <div className="split">
            <div className="stack">
              <Section title="주요 쟁점" count={report.issues.length}>
                {report.issues.map((issue, index) => (
                  <div key={index} className="line">
                    <p className="line__text">{issue.topic}</p>
                    {issue.positions.length > 0 && (
                      <ul className="reasons">
                        {issue.positions.map((position) => <li key={position}>{position}</li>)}
                      </ul>
                    )}
                    <SourceChip segment={issue.sourceSegment} onClick={setFocus} />
                  </div>
                ))}
              </Section>

              <Section title="결정사항" count={report.decisions.length}>
                {report.decisions.map((decision, index) => (
                  <div key={index} className="line">
                    <p className="line__text">{decision.text}</p>
                    <SourceChip segment={decision.sourceSegment} onClick={setFocus} />
                  </div>
                ))}
              </Section>

              <Section
                title="요청사항"
                count={report.requests.length}
                action={
                  checked.length > 0 && (
                    <button className="btn btn--sm btn--primary" onClick={registerRequests}>
                      {checked.length}건 업무로 등록
                    </button>
                  )
                }
              >
                {report.requests.map((request, index) => (
                  <div key={index} className={`line ${request.confidence === "low" ? "is-low" : ""}`}>
                    <label className="req">
                      {/* 확신도가 낮은 항목은 체크를 비워 둔다. 기한이나 기관이 없다는 뜻이다. */}
                      <input type="checkbox" checked={checked.includes(index)} onChange={() => toggle(index)} />
                      <span className="line__text">{request.text}</span>
                    </label>
                    <p className="line__source">
                      <span className={`tag ${request.direction === "outgoing" ? "tag--info" : "tag--accent"}`}>
                        {request.direction === "outgoing" ? "우리가 요청" : "요청받음"}
                      </span>
                      {orgName(request.counterpartOrgId)} · {categoryTitle(request.categoryId)}
                      {" · "}{request.due || "기한 미정"}
                      {request.confidence === "low" && <span className="tag tag--warn">확인 필요</span>}
                    </p>
                    <SourceChip segment={request.sourceSegment} onClick={setFocus} />
                  </div>
                ))}
              </Section>

              <Section
                title="후속조치"
                count={report.actions.length}
                action={
                  report.actions.length > 0 && (
                    <button className="btn btn--sm" onClick={registerActions}>업무로 등록</button>
                  )
                }
              >
                {report.actions.map((action, index) => (
                  <div key={index} className="line">
                    <p className="line__text">{action.text}</p>
                    <p className="line__source">
                      {action.owner || "담당 미지정"} · {action.due || "기한 미정"}
                    </p>
                    <SourceChip segment={action.sourceSegment} onClick={setFocus} />
                  </div>
                ))}
              </Section>
            </div>

            <div className="stack">
              <section className="card">
                <div className="card__head">
                  <div>
                    <div className="card__title">개최 결과 1페이지</div>
                    <div className="card__sub">템플릿으로 만듭니다 — 이 단계에는 모델을 쓰지 않습니다</div>
                  </div>
                  <button className="btn btn--sm" onClick={() => onCopy(renderOnePager(report), "1페이지 보고서")}>복사</button>
                </div>
                <pre className="paper__body onepager">{renderOnePager(report)}</pre>
              </section>

              {focus > 0 && (
                <section className="card">
                  <div className="card__head">
                    <div>
                      <div className="card__title">안건 {focus} 원문</div>
                      <div className="card__sub">{report.segments.find((segment) => segment.index === focus)?.heading || "제목 없음"}</div>
                    </div>
                    <button className="btn btn--sm btn--ghost" onClick={() => setFocus(0)}>닫기</button>
                  </div>
                  <pre className="paper__body onepager">
                    {report.segments.find((segment) => segment.index === focus)?.text}
                  </pre>
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">{title}</div>
          <div className="card__sub">{count}건</div>
        </div>
        {action}
      </div>
      <div className="card__body stack">
        {count ? children : <p className="bucket__empty">해당 없음</p>}
      </div>
    </section>
  );
}

/** 어느 발언에서 나온 결론인지 되짚는 통로. RFP 검색의 "몇 쪽에 있는지"와 같은 역할이다. */
function SourceChip({ segment, onClick }: { segment: number; onClick: (segment: number) => void }) {
  return (
    <button className="segref" onClick={() => onClick(segment)}>안건 {segment} 원문 보기</button>
  );
}
