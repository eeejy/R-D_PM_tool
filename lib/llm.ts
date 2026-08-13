/**
 * 로컬 Ollama 호출 래퍼.
 *
 * 이 파일이 지키는 것 세 가지.
 *
 *   1) **`num_ctx`를 반드시 넣는다.** Ollama 기본값은 4096이고, 2만 자 회의록을
 *      넣으면 에러 없이 앞부분만 읽은 뒤 그럴듯한 요약을 돌려준다. 뒤쪽 안건이
 *      통째로 사라지는데 화면상으로는 멀쩡해 보인다 — 이 작업의 1번 함정이다.
 *   2) **JSON을 강제한다.** 8B급 소형 모델은 스키마를 강제할 때 정확도가 크게 오른다.
 *   3) **응답이 스키마를 벗어나도 앱이 죽지 않는다.** 검증에 실패하면 `LlmError`를
 *      던지고, 호출부는 규칙 기반 결과로 떨어진다.
 *
 * React를 import하지 않는다. 화면은 이 위에 얹기만 한다.
 */

export type LlmConfig = {
  /** Ollama 서버 주소. 로컬 고정 — 클라우드 API는 쓰지 않는다. */
  endpoint: string;
  model: string;
  /** 컨텍스트 창(토큰). 기본값 4096으로 두면 긴 입력의 뒷부분이 조용히 잘린다. */
  numCtx: number;
  /** 사실 추출 작업이므로 낮게 둔다. */
  temperature: number;
  /**
   * 사고 과정 출력. qwen3처럼 thinking을 지원하는 모델만 받는다.
   * 값을 정하지 않으면 요청에 넣지 않는다 — 지원하지 않는 모델은 400을 돌려주기 때문이다.
   */
  think?: boolean;
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  endpoint: "http://localhost:11434",
  model: "qwen3:8b",
  numCtx: 32768,
  temperature: 0.2,
};

/** 화면에서 고를 수 있는 모델. 태그는 바뀌므로 직접 입력도 허용한다. */
export const SUGGESTED_MODELS = ["qwen3:8b", "qwen3:14b", "gpt-oss:20b"];

export type LlmErrorKind =
  /** Ollama가 떠 있지 않거나 주소가 틀림 */
  | "offline"
  /** 서버가 응답했지만 실패 상태 */
  | "http"
  /** 응답에서 JSON을 꺼내지 못함 */
  | "parse"
  /** JSON은 나왔지만 약속한 모양이 아님 */
  | "schema"
  /** 사용자가 중단 */
  | "aborted";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    /** 화면에 같이 띄울 다음 행동 안내 */
    readonly hint?: string,
    /** 디버깅용 원문 응답(있으면) */
    readonly raw?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** 사용자에게 보여줄 안내. 기술 용어 대신 다음에 뭘 하면 되는지를 적는다. */
export const ERROR_HINT: Record<LlmErrorKind, string> = {
  offline: "터미널에서 `ollama serve`가 실행 중인지 확인해 주세요.",
  http: "모델을 내려받았는지 확인해 주세요 — `ollama pull qwen3:8b`",
  parse: "모델이 JSON이 아닌 답을 돌려줬습니다. 다시 시도하거나 더 큰 모델을 쓰세요.",
  schema: "모델 응답이 약속한 형식과 달라 규칙 기반 결과로 대체했습니다.",
  aborted: "",
};

export type LlmRequest = {
  model: string;
  prompt: string;
  system?: string;
  stream: false;
  format: "json" | object;
  options: { num_ctx: number; temperature: number };
  think?: boolean;
};

/**
 * 요청 본문을 만든다. 순수 함수라 "num_ctx가 실제로 실렸는지"를 테스트할 수 있다 —
 * 이 값이 빠지는 사고는 화면에 아무 증상이 없어서 테스트로만 잡힌다.
 */
export function buildRequest(
  prompt: string,
  options: { system?: string; config?: Partial<LlmConfig>; format?: "json" | object } = {},
): LlmRequest {
  const config = { ...DEFAULT_LLM_CONFIG, ...options.config };
  const request: LlmRequest = {
    model: config.model,
    prompt,
    stream: false,
    format: options.format ?? "json",
    options: {
      num_ctx: Math.max(4096, Math.round(config.numCtx)),
      temperature: config.temperature,
    },
  };
  if (options.system) request.system = options.system;
  if (typeof config.think === "boolean") request.think = config.think;
  return request;
}

/**
 * 모델 출력에서 JSON 본문만 꺼낸다.
 *
 * `format: "json"`을 줘도 소형 모델은 앞에 사고 과정(`<think>`)이나 코드펜스를
 * 붙여 오는 일이 있다. 여기서 걷어내지 않으면 파싱이 통째로 실패한다.
 */
export function extractJson(raw: string): string {
  let text = String(raw ?? "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 닫히지 않은 <think>는 그 뒤가 전부 사고 과정이 아니라 잘린 것이므로 앞만 버린다
  text = text.replace(/^[\s\S]*?<\/think>/i, "");
  text = text.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1");
  text = text.trim();

  const start = text.search(/[{[]/);
  if (start === -1) return text;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

/** 모델 응답 문자열 → 검증된 값. 실패는 전부 `LlmError`로 통일한다. */
export function parseResponse<T>(raw: string, validate: (value: unknown) => T | null): T {
  const body = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LlmError("parse", "모델 응답을 JSON으로 읽지 못했습니다.", ERROR_HINT.parse, raw);
  }
  const checked = validate(parsed);
  if (checked == null) {
    throw new LlmError("schema", "모델 응답이 약속한 형식과 다릅니다.", ERROR_HINT.schema, raw);
  }
  return checked;
}

/** Ollama 호출 한 번. 실제 통신은 여기서만 일어난다. */
export async function complete(
  prompt: string,
  options: {
    system?: string;
    config?: Partial<LlmConfig>;
    format?: "json" | object;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string> {
  const config = { ...DEFAULT_LLM_CONFIG, ...options.config };
  const doFetch = options.fetchImpl ?? fetch;
  const body = buildRequest(prompt, options);

  let response: Response;
  try {
    response = await doFetch(`${config.endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new LlmError("aborted", "중단했습니다.");
    }
    throw new LlmError("offline", "Ollama에 연결하지 못했습니다.", ERROR_HINT.offline);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LlmError("http", `Ollama가 오류를 돌려줬습니다 (${response.status}).`, ERROR_HINT.http, detail);
  }

  const payload = (await response.json().catch(() => null)) as { response?: string } | null;
  if (!payload || typeof payload.response !== "string") {
    throw new LlmError("parse", "Ollama 응답 형식을 읽지 못했습니다.", ERROR_HINT.parse);
  }
  return payload.response;
}

/** 호출 + 검증까지 한 번에. 각 기능은 이 함수만 쓴다. */
export async function completeJson<T>(
  prompt: string,
  validate: (value: unknown) => T | null,
  options: Parameters<typeof complete>[1] = {},
): Promise<T> {
  return parseResponse(await complete(prompt, options), validate);
}

/** 기능 모듈이 주입받는 호출 함수 타입. 테스트에서는 가짜를 넣는다. */
export type LlmCall = (prompt: string, system?: string) => Promise<string>;

/** 설정으로 고정한 호출 함수를 만든다. */
export function makeCall(
  config: Partial<LlmConfig>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): LlmCall {
  return (prompt, system) => complete(prompt, { ...options, config, system });
}

export type OllamaStatus =
  | { ok: true; models: string[] }
  | { ok: false; error: LlmError };

/** 서버가 떠 있는지, 쓰려는 모델이 받아져 있는지 확인한다. */
export async function checkOllama(
  config: Partial<LlmConfig> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaStatus> {
  const merged = { ...DEFAULT_LLM_CONFIG, ...config };
  try {
    const response = await fetchImpl(`${merged.endpoint.replace(/\/$/, "")}/api/tags`);
    if (!response.ok) {
      return { ok: false, error: new LlmError("http", `Ollama가 ${response.status}를 돌려줬습니다.`, ERROR_HINT.http) };
    }
    const payload = (await response.json()) as { models?: { name?: string }[] };
    const models = (payload.models ?? []).map((item) => String(item.name ?? "")).filter(Boolean);
    return { ok: true, models };
  } catch {
    return { ok: false, error: new LlmError("offline", "Ollama에 연결하지 못했습니다.", ERROR_HINT.offline) };
  }
}

const CONFIG_KEY = "rnd-flow:llm";

export function loadLlmConfig(): LlmConfig {
  if (typeof window === "undefined") return DEFAULT_LLM_CONFIG;
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_LLM_CONFIG;
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return { ...DEFAULT_LLM_CONFIG, ...parsed };
  } catch {
    return DEFAULT_LLM_CONFIG;
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 설정 저장 실패가 기능을 막지는 않는다
  }
}

/* ── 검증 도우미 ─────────────────────────────────────────────
 * 라이브러리를 넣지 않는다. 필요한 규칙이 몇 개 안 되고, 직접 쓰는 편이
 * 짧으면서 "왜 이 응답을 버렸는지" 설명할 수 있다.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 문자열이면 다듬어서, 아니면 빈 문자열. 모델이 숫자·null을 섞어 보내도 죽지 않는다. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 문자열 배열로. 문자열 하나만 와도 배열로 받아준다. */
export function asTextList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const single = asText(value);
  return single ? [single] : [];
}

/** 여러 줄 응답을 한 문장으로. 구두보고 한 줄이 두 문단으로 오는 걸 막는다. */
export function oneLine(value: unknown): string {
  return asText(value).replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}
