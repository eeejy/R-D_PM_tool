"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BrandMark from "@/components/BrandMark";
import OverviewView from "@/components/OverviewView";
import WorkTreeView from "@/components/WorkTreeView";
import WbsView from "@/components/WbsView";
import RfpView from "@/components/RfpView";
import AiView from "@/components/AiView";
import OrgView from "@/components/OrgView";
import { todayISO } from "@/lib/date";
import { makeId, type MyTask } from "@/lib/mytask";
import { deriveAll, event as makeEvent, type TaskEvent } from "@/lib/history";
import { closeIssue, openIssues, reopenIssue, type TrackItem } from "@/lib/track";
import { summarize, type WbsStatus } from "@/lib/wbsStatus";
import type { WbsFile } from "@/lib/parseFile";
import type { RfpDocument } from "@/lib/rfp";
import * as store from "@/lib/store";

type ViewId = "overview" | "tree" | "wbs" | "rfp" | "org" | "ai";

const NAV: { id: ViewId; label: string; icon: string }[] = [
  { id: "overview", label: "개요", icon: "◱" },
  { id: "tree", label: "업무트리", icon: "☰" },
  { id: "wbs", label: "연구개발 현황", icon: "▤" },
  { id: "org", label: "기관별", icon: "◎" },
  { id: "rfp", label: "RFP 검색", icon: "⌕" },
  { id: "ai", label: "보고 생성", icon: "✎" },
];

export default function App() {
  const [view, setView] = useState<ViewId>("overview");
  const [projectName, setProjectName] = useState("CDX 연구개발사업");
  const [department, setDepartment] = useState("");
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [track, setTrack] = useState<TrackItem[]>([]);
  const [file, setFile] = useState<WbsFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [rfp, setRfp] = useState<RfpDocument | null>(null);
  const [rfpQuery, setRfpQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [toast, setToast] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const today = useMemo(() => todayISO(), []);

  useEffect(() => {
    const saved = store.load();
    if (saved) {
      setProjectName(saved.projectName || "CDX 연구개발사업");
      setDepartment(saved.department ?? "");
      setTasks(saved.tasks);
      setEvents(saved.events ?? []);
      setTrack(saved.track ?? []);
      setFileName(saved.wbsName ?? "");
      setRfp(saved.rfp ?? null);
    }

    // 다른 화면·외부 링크에서 넘어올 수 있게 ?view=rfp&q=... 를 받는다.
    // 업무트리나 WBS에서 "RFP에서 근거 찾기"를 붙일 때 이 통로를 쓴다.
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    const requested = params.get("view");
    if (q) setRfpQuery(q);
    if (requested === "rfp" || q) setView("rfp");
    else if (requested === "tree" || requested === "wbs" || requested === "overview" || requested === "ai" || requested === "org") setView(requested);
    const storedTheme = window.localStorage.getItem("rnd-flow:theme");
    if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    store.save({ projectName, department, tasks, events, track, wbsName: fileName, rfp, updatedAt: "" });
  }, [hydrated, projectName, department, tasks, events, track, fileName, rfp]);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${label}을 복사했습니다`);
    } catch {
      notify("복사하지 못했습니다");
    }
  }, [notify]);

  // WBS는 상태 파악에만 쓴다. 파일 내용은 저장하지 않고 화면에만 들고 있는다.
  const status: WbsStatus | null = useMemo(
    () => (file ? summarize(file.tasks, today, file.reported) : null),
    [file, today],
  );

  /** 이벤트는 덧붙이기만 한다. 고치거나 지우지 않는다. */
  const record = (...added: TaskEvent[]) => setEvents((current) => [...current, ...added]);

  const addTasks = (incoming: MyTask[]) => {
    const withIds = incoming.map((task) => ({ ...task, id: task.id || makeId() }));
    setTasks((current) => [...withIds, ...current]);
    record(...withIds.map((task) => makeEvent(task.id, "created", today, { to: task.due, orgId: task.orgId })));
    notify(`${incoming.length}건 등록`);
  };

  const markDone = (id: string) => {
    const target = tasks.find((task) => task.id === id);
    setTasks((current) => current.map((task) =>
      task.id === id ? { ...task, status: "완료" as const, doneAt: today } : task));
    record(
      makeEvent(id, "status_changed", today, { from: target?.status, to: "완료", orgId: target?.orgId }),
      makeEvent(id, "closed", today, { orgId: target?.orgId }),
    );
  };

  /** 미루면 기한을 일주일 밀고 그 사실을 이벤트로 남긴다 — 반복해서 밀리는 일이 드러나야 한다. */
  const defer = (id: string) => {
    const target = tasks.find((task) => task.id === id);
    if (!target) return;
    const base = new Date(`${target.due || today}T00:00:00`);
    base.setDate(base.getDate() + 7);
    const next = base.toISOString().slice(0, 10);
    setTasks((current) => current.map((task) => (
      task.id === id
        ? { ...task, due: next, dueNote: "", deferred: (task.deferred ?? 0) + 1 }
        : task
    )));
    record(makeEvent(id, "due_changed", today, { from: target.due || today, to: next, orgId: target.orgId }));
  };

  const move = (id: string, categoryId: MyTask["categoryId"]) =>
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, categoryId } : task)));

  /** 업무는 지워도 이벤트는 남긴다. 인수인계의 값어치가 거기서 나온다. */
  const remove = (id: string) => {
    const target = tasks.find((task) => task.id === id);
    setTasks((current) => current.filter((task) => task.id !== id));
    record(makeEvent(id, "closed", today, { note: "삭제", orgId: target?.orgId }));
  };

  const loadWbs = (next: WbsFile, name: string) => {
    setFile(next);
    setFileName(name);
    notify(`WBS ${next.tasks.length}건 읽음`);
    setView("wbs");
  };

  const importBackup = async (picked: File | undefined) => {
    if (!picked) return;
    const restored = await store.importWorkspace(picked);
    if (!restored) return notify("백업 파일을 읽지 못했습니다");
    setProjectName(restored.projectName);
    setDepartment(restored.department ?? "");
    setTasks(restored.tasks);
    setEvents(restored.events ?? []);
    setTrack(restored.track ?? []);
    notify("백업을 불러왔습니다");
  };

  const reset = () => {
    if (!window.confirm("등록한 업무를 모두 지웁니다. 계속할까요?")) return;
    store.clear();
    setTasks([]);
    setEvents([]);
    setTrack([]);
    setFile(null);
    setFileName("");
    setRfp(null);
    notify("초기화했습니다");
  };

  const openCount = tasks.filter((task) => task.status !== "완료").length;
  const issueCount = openIssues(track).length;

  /** 쟁점·결정은 덧붙이기만 한다. 닫아도 지우지 않는다 — 인수인계의 재료다. */
  const addTrack = (items: TrackItem[]) => {
    if (!items.length) return;
    setTrack((current) => [...items, ...current]);
    notify(`쟁점·결정 ${items.length}건 기록`);
  };

  // 화면에 쓰는 지연·회신 지표는 전부 이벤트에서 계산한다. 저장하지 않는다.
  const signals = useMemo(
    () => deriveAll(events, tasks.map((task) => task.id), today),
    [events, tasks, today],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark size={42} />
          <span className="brand__text">
            <span className="brand__name">AI·Data R&amp;D Flow</span>
            <span className="brand__meta">사업관리 워크스페이스</span>
          </span>
        </div>

        <nav className="nav" aria-label="주요 메뉴">
          {NAV.map((item) => (
            <button key={item.id} className="nav__item" aria-current={view === item.id} onClick={() => setView(item.id)}>
              <span className="nav__icon" aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "tree" && openCount > 0 && <span className="nav__count">{openCount}</span>}
              {item.id === "overview" && issueCount > 0 && <span className="nav__count">{issueCount}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          <input ref={importInput} type="file" hidden accept=".json" onChange={(event) => importBackup(event.target.files?.[0])} />
          <button className="nav__item" onClick={() => store.exportWorkspace({ projectName, department, tasks, events, track, wbsName: fileName, rfp, updatedAt: "" })}>
            <span className="nav__icon" aria-hidden>↓</span><span>내보내기</span>
          </button>
          <button className="nav__item" onClick={() => importInput.current?.click()}>
            <span className="nav__icon" aria-hidden>↑</span><span>불러오기</span>
          </button>
          <button className="nav__item" onClick={reset}>
            <span className="nav__icon" aria-hidden>⟲</span><span>초기화</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0 }}>
            <input
              className="input topbar__name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="사업명"
              aria-label="사업명"
            />
            <span className="topbar__meta">{department || "부서 미설정"} · {today}</span>
          </div>
          <div className="topbar__actions">
            <input
              className="input" style={{ width: 140, height: 30 }}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="담당부서"
              aria-label="담당부서"
            />
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                setTheme(next);
                window.localStorage.setItem("rnd-flow:theme", next);
              }}
              aria-label="테마 전환"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </header>

        {view === "overview" && (
          <OverviewView
            today={today}
            status={status}
            tasks={tasks}
            signals={signals}
            track={track}
            onCloseIssue={(id) => setTrack((current) => closeIssue(current, id, today))}
            onAdd={addTasks}
            onDone={markDone}
            onDefer={defer}
            onGoWbs={() => setView("wbs")}
            onGoTree={() => setView("tree")}
          />
        )}
        {view === "tree" && (
          <WorkTreeView
            today={today}
            tasks={tasks}
            signals={signals}
            onAdd={addTasks}
            onDone={markDone}
            onDefer={defer}
            onMove={move}
            onRemove={remove}
          />
        )}
        {view === "wbs" && (
          <WbsView status={status} file={file} fileName={fileName} onLoad={loadWbs} />
        )}
        {view === "org" && (
          <OrgView
            today={today}
            tasks={tasks}
            events={events}
            status={status}
            wbsTasks={file?.tasks ?? []}
            onCopy={copy}
          />
        )}
        {view === "ai" && (
          <AiView
            today={today}
            tasks={tasks}
            signals={signals}
            events={events}
            status={status}
            wbsTasks={file?.tasks ?? []}
            projectName={projectName}
            department={department}
            onAdd={addTasks}
            onRecord={record}
            onTrack={addTrack}
            notify={notify}
          />
        )}
        {view === "rfp" && (
          <RfpView
            document={rfp}
            initialQuery={rfpQuery}
            onLoad={(next) => { setRfp(next); notify(`RFP ${next.pageCount}쪽 읽음`); }}
            onRemove={() => { setRfp(null); notify("RFP를 삭제했습니다"); }}
          />
        )}
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
