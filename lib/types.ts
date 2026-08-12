/** 앱 전체가 공유하는 도메인 타입. UI가 아니라 데이터가 먼저다. */

/** WBS 한 줄. 파일에서 읽어 표준화한 결과. */
export type WbsTask = {
  /** WBS 코드(1.2.3 등). 파일에 없으면 빈 문자열 */
  code: string;
  title: string;
  /** 수행기관. 기관별 시트 파일이면 시트명이 들어간다. */
  owner: string;
  /** 담당자 개인명(있으면) */
  assignee: string;
  /** ISO yyyy-mm-dd. 파싱 실패 시 빈 문자열 */
  start: string;
  end: string;
  /** 기준일 기준 계획 진척률 0–100. 없으면 null */
  planned: number | null;
  /** 실제 진척률 0–100. 없으면 null */
  progress: number | null;
  /** 가중치(기관이 부여한 상대 비중). 없으면 null */
  weight: number | null;
  status: string;
  /** 선행과업 코드들. 후행 차단 판정에 쓴다. */
  predecessors: string[];
  /** 산출물명. 있으면 협약 성과물로 본다. */
  deliverable: string;
  /** 마일스톤 항목 여부 */
  milestone: boolean;
  /** 코드 계층 깊이(1.2.3 → 3). 코드가 없으면 1 */
  depth: number;
  /** 하위 과업이 없는 말단 항목. 집계는 말단만 센다. */
  isLeaf: boolean;
  /** 원본 시트명 */
  sheet: string;
  /** 원본 행 번호(1-based, 헤더 제외). 근거 추적용 */
  row: number;
};

/** 계획 대비 실적 상태. 기관 WBS 총괄시트가 쓰는 3단계와 같다. */
export type Variance = "정상" | "주의" | "지연";
