import type { RfpDocument, RfpPage } from "./rfp";

/**
 * RFP 파일 → 페이지 단위 텍스트.
 *
 * 전부 브라우저 안에서 처리한다. 파일이 서버로 나가지 않는 것이 이 앱의 전제다.
 * 페이지 구조를 유지하는 이유는 검색결과에서 "p.24"로 원문을 짚어야 하고,
 * 나중에 페이지별 인용이나 원문 뷰어를 붙일 때 그대로 쓰기 위해서다.
 */

export class RfpParseError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

function makeId(): string {
  return `rfp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 확장자로 형식을 정한다. HWP는 아직 읽지 못하므로 명확히 알린다. */
function kindOf(fileName: string): RfpDocument["kind"] {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "md") return "txt";
  if (ext === "hwp" || ext === "hwpx") {
    throw new RfpParseError(
      "한글 문서(HWP)는 아직 지원하지 않습니다.",
      "한글에서 PDF로 저장한 뒤 넣어 주세요.",
    );
  }
  throw new RfpParseError("지원하지 않는 형식입니다.", "PDF · DOCX · TXT를 넣어 주세요.");
}

/** PDF는 페이지가 원래 있으므로 그대로 쓴다. */
async function readPdf(buffer: ArrayBuffer): Promise<RfpPage[]> {
  const pdfjs = await import("pdfjs-dist");
  // pdf.js는 workerSrc가 반드시 있어야 한다. 번들러가 알아서 해 주길 기대하면
  // dev/prod에서 다르게 깨지므로, 설치 시 public/에 복사해 둔 파일을 가리킨다.
  // (scripts/copy-pdf-worker.mjs)
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false });
  const pdf = await task.promise;

  const pages: RfpPage[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    // 항목 사이에 공백을 넣고, 줄바꿈 표시(hasEOL)는 개행으로 살린다 —
    // 문단 판정에 쓰이므로 여기서 뭉개면 검색 랭킹이 나빠진다.
    const text = content.items
      .map((item) => {
        const cell = item as { str?: string; hasEOL?: boolean };
        return (cell.str ?? "") + (cell.hasEOL ? "\n" : " ");
      })
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n");
    pages.push({ pageNumber: number, text: text.trim() });
    page.cleanup();
  }
  await pdf.destroy();
  return pages;
}

/** 한 페이지에 담을 대략적인 글자 수. 페이지 개념이 없는 형식을 나눌 때 쓴다. */
const CHARS_PER_PAGE = 1800;

/**
 * DOCX·TXT는 페이지 개념이 없다. 문단 경계를 지키면서 잘라 가짜 페이지를 만든다.
 * 문단 중간에서 자르면 검색 조각이 어색해지고 문단 점수도 틀어진다.
 */
function paginate(text: string): RfpPage[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const pages: RfpPage[] = [];
  let buffer = "";

  const flush = () => {
    if (!buffer.trim()) return;
    pages.push({ pageNumber: pages.length + 1, text: buffer.trim() });
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length > CHARS_PER_PAGE) flush();
    buffer += (buffer ? "\n\n" : "") + paragraph;
  }
  flush();

  return pages.length ? pages : [{ pageNumber: 1, text: text.trim() }];
}

async function readDocx(buffer: ArrayBuffer): Promise<RfpPage[]> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: buffer });
  return paginate(value);
}

/** 파일 하나를 읽어 검색 가능한 문서로 만든다. */
export async function readRfpFile(file: File): Promise<RfpDocument> {
  const kind = kindOf(file.name);
  const buffer = await file.arrayBuffer();

  const pages =
    kind === "pdf" ? await readPdf(buffer)
    : kind === "docx" ? await readDocx(buffer)
    : paginate(new TextDecoder().decode(buffer));

  const filled = pages.filter((page) => page.text.length > 0);
  if (!filled.length) {
    throw new RfpParseError(
      "문서에서 글자를 찾지 못했습니다.",
      "스캔한 이미지 PDF일 수 있습니다. 텍스트가 선택되는 PDF가 필요합니다.",
    );
  }

  return {
    id: makeId(),
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
    kind,
  };
}

/** 문서 분량 표시용. */
export function charCount(document: RfpDocument): number {
  return document.pages.reduce((sum, page) => sum + page.text.length, 0);
}
