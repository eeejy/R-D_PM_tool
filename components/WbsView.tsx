"use client";

import { useRef, useState, type DragEvent } from "react";
import { parseWbsBuffer, readWbsFile, type WbsFile } from "@/lib/parseFile";
import { VARIANCE_TONE } from "@/lib/variance";
import type { WbsItem, WbsStatus } from "@/lib/wbsStatus";

/**
 * 연구개발 현황 — 지금 시점의 WBS를 읽어 상태만 요약한다.
 * 회차 간 비교는 하지 않는다. 담당자가 알아야 하는 건 "지금 어떤 상태인가"다.
 */
export default function WbsView({
  status,
  file,
  fileName,
  onLoad,
}: {
  status: WbsStatus | null;
  file: WbsFile | null;
  fileName: string;
  onLoad: (file: WbsFile, name: string) => void;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const accept = async (picked: File | undefined) => {
    if (!picked) return;
    setError("");
    setBusy(true);
    try {
      onLoad(await readWbsFile(picked), picked.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "파일을 읽지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const loadSample = async () => {
    setBusy(true);
    setError("");
    try {
      const name = "WBS_20260812.xlsx";
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error("샘플을 불러오지 못했습니다.");
      onLoad(parseWbsBuffer(await response.arrayBuffer(), name), name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "샘플을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const dropzone = (
    <button
      className={`dropzone ${over ? "is-over" : ""} ${fileName ? "is-filled" : ""}`}
      onClick={() => input.current?.click()}
      onDragOver={(event: DragEvent) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setOver(false); accept(event.dataTransfer.files?.[0]); }}
    >
      <span style={{ minWidth: 0 }}>
        <span className="dropzone__name">{fileName || "WBS 엑셀 파일 선택 또는 끌어놓기"}</span>
        <span className="dropzone__hint">
          {file ? `${file.sheets.filter((sheet) => sheet.rows).length}개 탭 · 항목 ${file.tasks.length}건` : "xlsx · xls · csv"}
        </span>
      </span>
      {fileName && <span className="dropzone__swap">교체</span>}
    </button>
  );

  if (!status) {
    return (
      <div className="view">
        <div className="view__head">
          <h1 className="view__title">연구개발 현황</h1>
          <p className="view__sub">기관에서 받은 WBS를 넣으면 현재 상태를 요약합니다.</p>
        </div>
        <div className="card">
          <div className="card__body stack" style={{ maxWidth: 520 }}>
            <input ref={input} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(event) => accept(event.target.files?.[0])} />
            {dropzone}
            <button className="btn btn--block" onClick={loadSample} disabled={busy}>
              {busy ? "읽는 중…" : "샘플 데이터로 보기"}
            </button>
            {error && <p style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</p>}
            <p style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.7 }}>
              기관별로 탭이 나뉜 통합 WBS를 그대로 넣으면 됩니다. 파일은 브라우저에서만 열리고 서버로 전송되지 않습니다.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">연구개발 현황</h1>
        <p className="view__sub">
          {fileName} · 항목 {status.total}건(말단 {status.leaves}) · 기관 {status.institutions.length}곳
        </p>
      </div>

      <div className="metrics">
        <div className="card metric">
          <div className="metric__label">실적 진행률</div>
          <div className="metric__value">{status.overall.progress}%</div>
          <div className={`metric__delta ${status.overall.variance >= 0 ? "is-up" : "is-down"}`}>
            계획 {status.overall.planned}% · {status.overall.variance > 0 ? "+" : ""}{status.overall.variance}%p
          </div>
        </div>
        <div className="card metric">
          <div className="metric__label">지연·확인 필요</div>
          <div className="metric__value" style={{ color: status.delayed.length ? "var(--danger)" : undefined }}>{status.delayed.length}</div>
          <div className="metric__delta">종료일 경과 또는 계획 대비 5%p 이상 미달</div>
        </div>
        <div className="card metric">
          <div className="metric__label">주의</div>
          <div className="metric__value" style={{ color: status.watch.length ? "var(--warn)" : undefined }}>{status.watch.length}</div>
          <div className="metric__delta">계획 미달 또는 14일 내 종료</div>
        </div>
        <div className="card metric">
          <div className="metric__label">완료</div>
          <div className="metric__value">{status.completed.length}</div>
          <div className="metric__delta">진척 100% 과업</div>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <ItemCard title="지연 중인 항목" sub="담당기관에 사유와 회복일정을 확인해야 합니다" items={status.delayed} tone="danger" />
          <ItemCard title="주의가 필요한 항목" sub="아직 지연은 아니지만 이대로면 밀립니다" items={status.watch} tone="warn" />
          <ItemCard title="현재 진행 중" sub="종료가 가까운 순" items={status.running} tone="" />
          <ItemCard title="완료된 과업" sub="산출물·증빙 확인 대상" items={status.completed} tone="ok" />
        </div>

        <div className="stack">
          <div className="card">
            <div className="card__head"><div><div className="card__title">기관별 상태</div><div className="card__sub">뒤처진 순</div></div></div>
            <div className="card__body stack">
              {status.institutions.map((org) => (
                <div key={org.name}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 550 }}>{org.name}</span>
                    <span className={`tag tag--${VARIANCE_TONE[org.status]}`}>{org.status}</span>
                    <span style={{ marginLeft: "auto", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
                      <span className="muted">{org.planned}%</span>{" → "}<b>{org.progress}%</b>
                    </span>
                  </div>
                  <div className="bar bar--plan">
                    <i className={org.variance >= 0 ? "is-ok" : org.status === "지연" ? "is-danger" : "is-warn"} style={{ width: `${org.progress}%` }} />
                    <u style={{ left: `${org.planned}%` }} aria-hidden />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {status.checks.length > 0 && (
            <div className="card">
              <div className="card__head"><div><div className="card__title">확인해야 할 사항</div><div className="card__sub">수치를 믿기 전에 볼 것</div></div></div>
              <div className="card__body stack" style={{ gap: "var(--s3)" }}>
                {status.checks.map((check) => (
                  <div key={check.label} style={{ display: "flex", gap: "var(--s3)", alignItems: "baseline" }}>
                    <b style={{ fontSize: 18, fontVariantNumeric: "tabular-nums", minWidth: 28 }}>{check.count}</b>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 550 }}>{check.label}</div>
                      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{check.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card__head"><div className="card__title">WBS 파일</div></div>
            <div className="card__body stack">
              <input ref={input} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(event) => accept(event.target.files?.[0])} />
              {dropzone}
              {error && <p style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</p>}
              {file && (
                <div className="stack" style={{ gap: "var(--s1)", fontSize: 12 }}>
                  {file.sheets.map((sheet) => (
                    <div key={sheet.name} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span className={sheet.rows ? "" : "muted"}>{sheet.name}</span>
                      <span className="muted">{sheet.rows ? `${sheet.rows}건` : sheet.skipped}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemCard({ title, sub, items, tone }: { title: string; sub: string; items: WbsItem[]; tone: string }) {
  return (
    <div className="card">
      <div className="card__head">
        <div><div className="card__title">{title}</div><div className="card__sub">{sub}</div></div>
        <span className={`tag ${tone ? `tag--${tone}` : ""}`}>{items.length}</span>
      </div>
      {items.length ? (
        <div className="wbs-list">
          {items.map((item) => (
            <div key={item.code || item.title} className="wbs-item">
              <div>
                <div className="wbs-item__title">{item.title}</div>
                <div className="wbs-item__meta">
                  <span>{item.org}</span>
                  {item.assignee && <span>{item.assignee}</span>}
                  <span>{item.dueLabel}</span>
                  {item.deliverable && <span title={item.deliverable}>산출물</span>}
                </div>
              </div>
              <div className="wbs-item__nums">
                <span className="muted">{item.planned ?? "—"}%</span>
                <b>{item.progress}%</b>
                {item.variance != null && (
                  <em style={{ color: item.variance < 0 ? "var(--danger)" : "var(--ok)" }}>
                    {item.variance > 0 ? "+" : ""}{item.variance}
                  </em>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card__body"><p className="muted" style={{ fontSize: 12.5 }}>해당 항목이 없습니다.</p></div>
      )}
    </div>
  );
}
