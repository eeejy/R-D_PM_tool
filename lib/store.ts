import type { MyTask } from "./mytask";

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
  /** 마지막으로 읽은 WBS 파일명 */
  wbsName: string;
  updatedAt: string;
};

export function emptyWorkspace(): Workspace {
  return { projectName: "CDX 연구개발사업", department: "", tasks: [], wbsName: "", updatedAt: "" };
}

export function load(): Workspace | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Workspace;
    return Array.isArray(parsed.tasks) ? parsed : null;
  } catch {
    return null; // 저장 형식이 바뀌었으면 조용히 초기 상태로 시작한다
  }
}

export function save(workspace: Workspace): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...workspace, updatedAt: new Date().toISOString() }));
  } catch {
    // 용량 초과 등 — 저장 실패가 작업을 막지는 않게 둔다
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
    return Array.isArray(parsed.tasks) ? parsed : null;
  } catch {
    return null;
  }
}
