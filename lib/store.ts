import type { MyTask } from "./mytask";
import type { TaskEvent } from "./history";
import type { RfpDocument } from "./rfp";

/**
 * 로컬 저장소.
 *
 * 서버가 없는 건 데모라서가 아니라, 사업자료가 브라우저를 벗어나지 않는 것이
 * 이 도구를 실제 업무에 쓰기 위한 최소 조건이기 때문이다.
 */

const KEY = "aidata-rnd-flow:v1";

export type Workspace = {
  projectName: string;
  department: string;
  /** 내가 해야 하는 업무 */
  tasks: MyTask[];
  /**
   * 업무에 일어난 사건. append-only이며 업무를 지워도 남는다.
   * 인수인계와 리마인드가 전부 이 위에 얹힌다.
   */
  events: TaskEvent[];
  /** 마지막으로 읽은 WBS 파일명 */
  wbsName: string;
  /** 검색용 RFP 원문. 추출한 텍스트만 담는다(원본 파일은 보관하지 않음) */
  rfp: RfpDocument | null;
  updatedAt: string;
};

export function emptyWorkspace(): Workspace {
  return { projectName: "CDX 연구개발사업", department: "", tasks: [], events: [], wbsName: "", rfp: null, updatedAt: "" };
}

export function load(): Workspace | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Workspace;
    // 이벤트 로그가 없던 시절에 저장된 자료도 그대로 연다 — 빈 배열로 시작한다.
    return Array.isArray(parsed.tasks) ? { ...parsed, events: parsed.events ?? [] } : null;
  } catch {
    return null; // 저장 형식이 바뀌었으면 조용히 초기 상태로 시작한다
  }
}

export function save(workspace: Workspace): void {
  if (typeof window === "undefined") return;
  const payload = { ...workspace, updatedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 긴 RFP를 넣으면 localStorage 한도를 넘을 수 있다.
    // 그때는 업무만이라도 지켜야 하므로 RFP를 빼고 다시 시도한다.
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ ...payload, rfp: null }));
    } catch {
      // 그래도 안 되면 저장을 포기한다 — 작업 자체를 막지는 않는다
    }
  }
}

export function clear(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

function download(content: string, fileName: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportWorkspace(workspace: Workspace): void {
  download(
    JSON.stringify(workspace, null, 2),
    `rnd-flow_${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
  );
}

/** 백업 파일에서 되돌리기. 형식이 맞지 않으면 null. */
export async function importWorkspace(file: File): Promise<Workspace | null> {
  try {
    const parsed = JSON.parse(await file.text()) as Workspace;
    return Array.isArray(parsed.tasks) ? { ...parsed, events: parsed.events ?? [] } : null;
  } catch {
    return null;
  }
}
