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
  MAX_MINUTES_CHARS,
  minutesTooLong,
  splitAgenda,
  type MinutesReport,
} from "@/lib/minutes";
import { readRfpFile, RfpParseError } from "@/lib/rfpParse";
import { orgName } from "@/lib/org";
import { toTrackItem, type TrackItem } from "@/lib/track";
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
  onTrack,
  onCopy,
}: {
  today: string;
  makeCall: () => LlmCall | null;
  onAdd: (tasks: MyTask[]) => void;
  /** 쟁점·결정 기록. 업무 목록과 섞지 않는다. */
  onTrack?: (items: TrackItem[]) => void;
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
  /** 통합 검토 목록에서 고른 것. 기본값은 전체 해제다. */
  const [reviewed, setReviewed] = useState<number[]>([]);
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
    // 중복 클릭 차단 — 같은 회의록이 두 번 돌면 시간이 두 배로 든다
    if (!segments.length || progress) return;
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

  /**
   * 검토에서 고른 것만 등록한다.
   *
   * **일괄 자동 등록을 하지 않는다.** 회의록 추출에는 오탐이 섞이고, 한 번 신뢰를
   * 잃으면 그다음부터 아무도 안 쓴다. 요청은 업무로, 쟁점·결정은 트랙으로 간다.
   */
  const registerReviewed = () => {
    if (!report || !reviewed.length) return;
    const picked = reviewed.map((index) => report.items[index]).filter(Boolean);
    const requests = picked.filter((item) => item.type === "request");
    const others = picked.filter((item) => item.type !== "request");

    if (requests.length) {
      onAdd(requestsToDrafts(requests.map((item) => ({
        direction: item.owner === "기관" ? "outgoing" as const : "incoming" as const,
        counterpartOrgId: item.orgId,
        text: item.summary,
        due: item.dueDate,
        categoryId: "etc" as const,
        sourceSegment: item.sourceSegment,
        confidence: item.dueDate && item.orgId !== "etc" ? "high" as const : "low" as const,
      })), today, report.meeting.title) as MyTask[]);
    }
    if (others.length && onTrack) {
      onTrack(others.map((item) => toTrackItem(item, report.meeting.title, today)));
    }
    setReviewed([]);
  };

  const registerRequests = () => {
    if (!report || !checked.length) return;
    const picked = checked.map((index) => report.requests[index]).filter(Boolean);
    onAdd(requestsToDrafts(picked, today, report.meeting.title) as MyTask[]);
    setChecked([]);
  };

  const toggleReviewed = (index: number) =>
    setReviewed((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index]);

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

          {minutesTooLong(text) && (
            <p className="notice notice--warn">
              회의록이 {text.length.toLocaleString()}자입니다 — 권장 상한 {MAX_MINUTES_CHARS.toLocaleString()}자를
              넘겨 안건이 많아지고 시간이 오래 걸립니다. 필요한 안건만 남겨 주세요.
            </p>
          )}

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

              {/* 검토 화면 — 자동 등록하지 않는다. 기본값은 전체 해제. */}
              <Section
                title="검토 후 등록"
                count={report.items.length}
                action={
                  reviewed.length > 0 && (
                    <button className="btn btn--sm btn--primary" onClick={registerReviewed}>
                      {reviewed.length}건 등록
                    </button>
                  )
                }
              >
                {report.items.map((item, index) => (
                  <div key={index} className="line">
                    <label className="req">
                      <input type="checkbox" checked={reviewed.includes(index)} onChange={() => toggleReviewed(index)} />
                      <span className="line__text">{item.summary}</span>
                    </label>
                    <p className="line__source">
                      <span className={`tag ${item.type === "request" ? "tag--info" : item.type === "issue" ? "tag--warn" : "tag--ok"}`}>
                        {item.type === "request" ? "요청 → 업무" : item.type === "issue" ? "쟁점 → 트랙" : "결정 → 기록"}
                      </span>
                      {item.orgId !== "etc" && `${orgName(item.orgId)} · `}
                      {item.dueDate || item.dueRaw || "기한 미정"}
                      {` · 담당 ${item.owner}`}
                    </p>
                    {/* 근거 문장을 함께 보여준다. 이게 있어야 취사선택이 된다. */}
                    {item.text && item.text !== item.summary && <p className="line__quote">{item.text}</p>}
                    <SourceChip segment={item.sourceSegment} onClick={setFocus} />
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
