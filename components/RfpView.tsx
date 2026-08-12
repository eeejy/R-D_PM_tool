"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { QUICK_TERMS, search, splitByMatches, totalMatches, type RfpDocument } from "@/lib/rfp";
import { charCount, readRfpFile, RfpParseError } from "@/lib/rfpParse";

/**
 * RFP 원문 검색.
 *
 * 왼쪽에 검색결과, 오른쪽에 본문. 결과를 누르면 그 페이지로 넘어가고 검색어가 강조된다.
 * 챗봇도 요약도 없다 — 담당자가 원하는 건 "그 문구가 RFP 어디에 있나"이기 때문이다.
 */
export default function RfpView({
  document: doc,
  initialQuery,
  onLoad,
  onRemove,
}: {
  document: RfpDocument | null;
  /** 다른 화면에서 넘어올 때 미리 채워진 검색어 (?q=) */
  initialQuery?: string;
  onLoad: (document: RfpDocument) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => search(doc, query), [doc, query]);
  const current = doc?.pages.find((item) => item.pageNumber === page) ?? doc?.pages[0] ?? null;

  // 검색어가 바뀌면 첫 결과로 이동한다
  useEffect(() => {
    if (!hits.length) return;
    setCursor(0);
    setPage(hits[0].pageNumber);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  const goto = (index: number) => {
    if (!hits.length) return;
    const next = (index + hits.length) % hits.length;
    setCursor(next);
    setPage(hits[next].pageNumber);
    bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const accept = async (picked: File | undefined) => {
    if (!picked) return;
    setError(null);
    setBusy(true);
    try {
      const next = await readRfpFile(picked);
      onLoad(next);
      setPage(1);
      setCursor(0);
    } catch (cause) {
      if (cause instanceof RfpParseError) setError({ message: cause.message, hint: cause.hint });
      else setError({ message: cause instanceof Error ? cause.message : "문서를 읽지 못했습니다." });
    } finally {
      setBusy(false);
    }
  };

  const dropzone = (
    <button
      className={`dropzone ${over ? "is-over" : ""}`}
      onClick={() => fileInput.current?.click()}
      onDragOver={(event: DragEvent) => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setOver(false); accept(event.dataTransfer.files?.[0]); }}
    >
      <span style={{ minWidth: 0 }}>
        <span className="dropzone__name">{busy ? "읽는 중…" : "RFP 파일 선택 또는 끌어놓기"}</span>
        <span className="dropzone__hint">PDF · DOCX · TXT</span>
      </span>
    </button>
  );

  if (!doc) {
    return (
      <div className="view">
        <div className="view__head">
          <h1 className="view__title">RFP 검색</h1>
          <p className="view__sub">RFP 원문을 넣고 필요한 문구가 몇 쪽에 있는지 바로 찾습니다.</p>
        </div>
        <div className="card">
          <div className="card__body stack" style={{ maxWidth: 520 }}>
            <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(event) => accept(event.target.files?.[0])} />
            {dropzone}
            {error && (
              <div style={{ padding: "var(--s3)", background: "var(--danger-soft)", borderRadius: "var(--r2)" }}>
                <p style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 600 }}>{error.message}</p>
                {error.hint && <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>{error.hint}</p>}
              </div>
            )}
            <p style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.7 }}>
              문서는 브라우저 안에서만 열립니다. 외부 서버나 AI로 전송하지 않습니다.
              한글(HWP) 문서는 PDF로 저장한 뒤 넣어 주세요.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view rfp">
      <div className="rfp__head">
        <div className="rfp__file">
          <div>
            <div className="rfp__name">{doc.fileName}</div>
            <div className="rfp__meta">
              {doc.pageCount}쪽 · {charCount(doc).toLocaleString()}자 ·{" "}
              {new Date(doc.uploadedAt).toLocaleDateString("ko-KR")} 등록
            </div>
          </div>
          <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={(event) => accept(event.target.files?.[0])} />
          <button className="btn btn--sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            {busy ? "읽는 중…" : "교체"}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={onRemove}>삭제</button>
        </div>

        <div className="rfp__search">
          <input
            className="input rfp__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="RFP에서 검색... 예: 실증, 데이터, VLM, 성과지표"
            aria-label="RFP 검색"
          />
          {hits.length > 0 && (
            <div className="rfp__nav">
              <button onClick={() => goto(cursor - 1)} aria-label="이전 결과">▲</button>
              <span>{cursor + 1} / {hits.length}</span>
              <button onClick={() => goto(cursor + 1)} aria-label="다음 결과">▼</button>
            </div>
          )}
        </div>

        <div className="rfp__quick">
          {QUICK_TERMS.map((term) => (
            <button key={term} className={query === term ? "is-on" : ""} onClick={() => setQuery(term)}>{term}</button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ padding: "var(--s3) var(--s4)", background: "var(--danger-soft)", borderRadius: "var(--r2)", marginBottom: "var(--s3)" }}>
          <p style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 600 }}>{error.message}</p>
          {error.hint && <p style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>{error.hint}</p>}
        </div>
      )}

      <div className="rfp__layout">
        <aside className="card rfp__results">
          <div className="card__head">
            <div>
              <div className="card__title">
                {query.trim() ? `“${query.trim()}” 검색 결과 ${totalMatches(hits)}건` : "검색 결과"}
              </div>
              <div className="card__sub">
                {query.trim() ? `${hits.length}개 쪽 · 관련도 순` : "검색어를 입력하세요"}
              </div>
            </div>
          </div>

          <div className="rfp__hits">
            {hits.map((hit, index) => (
              <button
                key={hit.pageNumber}
                className={`rfp__hit ${index === cursor ? "is-current" : ""}`}
                onClick={() => goto(index)}
              >
                <div className="rfp__hit-page">
                  p.{hit.pageNumber}
                  {hit.count > 1 && <em>{hit.count}회</em>}
                </div>
                <p className="rfp__hit-text">
                  {renderSnippet(hit.snippet.text, hit.snippet.marks)}
                </p>
              </button>
            ))}

            {query.trim() && !hits.length && (
              <div className="empty">
                <p className="empty__title">찾지 못했습니다</p>
                <p className="empty__body">여러 단어를 넣으면 모두 포함된 쪽만 찾습니다. 단어를 줄여 보세요.</p>
              </div>
            )}
            {!query.trim() && (
              <div className="empty">
                <p className="empty__body">검색어를 넣으면 관련도 순으로 쪽을 찾아 줍니다.</p>
              </div>
            )}
          </div>
        </aside>

        <section className="card rfp__body">
          <div className="card__head">
            <div className="rfp__pager">
              <button className="btn btn--sm" onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page <= 1}>이전 쪽</button>
              <span className="rfp__pageno">{page} / {doc.pageCount}</span>
              <button className="btn btn--sm" onClick={() => setPage((n) => Math.min(doc.pageCount, n + 1))} disabled={page >= doc.pageCount}>다음 쪽</button>
            </div>
          </div>
          <div className="rfp__text" ref={bodyRef}>
            {current ? (
              splitByMatches(current.text, query).map((part, index) =>
                part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
              )
            ) : (
              <p className="muted">본문이 없습니다.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 조각 안의 강조 구간을 <mark>로 바꾼다. */
function renderSnippet(text: string, marks: { start: number; end: number }[]) {
  if (!marks.length) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  marks.forEach((mark, index) => {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(<mark key={index}>{text.slice(mark.start, mark.end)}</mark>);
    cursor = mark.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
