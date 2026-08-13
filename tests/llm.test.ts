import { describe, expect, it } from "vitest";
import {
  buildRequest,
  checkOllama,
  complete,
  extractJson,
  LlmError,
  parseResponse,
  DEFAULT_LLM_CONFIG,
  connectionHint,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  trimPrompt,
  isLocalOrigin,
} from "../lib/llm";

/** 응답 하나만 돌려주는 가짜 fetch. 네트워크를 타지 않는다. */
function fakeFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  return async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response;
}

describe("buildRequest", () => {
  it("num_ctx를 반드시 싣는다", () => {
    // 이 값이 빠지면 긴 입력의 뒷부분이 에러 없이 잘린다 — 화면에 증상이 없어 테스트로만 잡힌다
    expect(buildRequest("안녕").options.num_ctx).toBe(DEFAULT_LLM_CONFIG.numCtx);
  });

  it("num_ctx가 너무 작으면 최소값으로 올린다", () => {
    expect(buildRequest("안녕", { config: { numCtx: 512 } }).options.num_ctx).toBe(4096);
  });

  it("JSON 출력을 강제한다", () => {
    expect(buildRequest("안녕").format).toBe("json");
  });

  it("사실 추출용이라 temperature는 낮게 둔다", () => {
    expect(buildRequest("안녕").options.temperature).toBeLessThanOrEqual(0.3);
  });

  it("think는 정하지 않으면 요청에 넣지 않는다", () => {
    // thinking을 지원하지 않는 모델은 이 필드를 받으면 400을 돌려준다
    expect("think" in buildRequest("안녕")).toBe(false);
    expect(buildRequest("안녕", { config: { think: false } }).think).toBe(false);
  });

  it("system과 모델명을 그대로 싣는다", () => {
    const request = buildRequest("본문", { system: "규칙", config: { model: "qwen3:14b" } });
    expect(request.system).toBe("규칙");
    expect(request.model).toBe("qwen3:14b");
  });
});

describe("extractJson", () => {
  it("사고 과정(<think>)을 걷어낸다", () => {
    expect(extractJson('<think>음 이걸 어떻게...</think>{"a":1}')).toBe('{"a":1}');
  });

  it("닫히지 않은 사고 과정도 처리한다", () => {
    expect(extractJson('생각 중...</think>\n{"a":1}')).toBe('{"a":1}');
  });

  it("코드펜스를 벗긴다", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("앞뒤 설명을 버리고 본문만 남긴다", () => {
    expect(extractJson('아래와 같습니다.\n{"a":1}\n이상입니다.')).toBe('{"a":1}');
  });

  it("배열도 꺼낸다", () => {
    expect(extractJson('결과: [1,2]')).toBe("[1,2]");
  });
});

describe("parseResponse", () => {
  const validate = (value: unknown) => (typeof value === "object" && value !== null && "a" in value ? (value as { a: number }) : null);

  it("정상 응답을 검증해 돌려준다", () => {
    expect(parseResponse('{"a":1}', validate)).toEqual({ a: 1 });
  });

  it("JSON이 아니면 parse 오류", () => {
    try {
      parseResponse("죄송합니다. 답변할 수 없습니다.", validate);
      throw new Error("여기 오면 안 된다");
    } catch (cause) {
      expect(cause).toBeInstanceOf(LlmError);
      expect((cause as LlmError).kind).toBe("parse");
    }
  });

  it("형식이 다르면 schema 오류 — 앱은 이걸 받아 규칙 결과로 떨어진다", () => {
    try {
      parseResponse('{"b":2}', validate);
      throw new Error("여기 오면 안 된다");
    } catch (cause) {
      expect((cause as LlmError).kind).toBe("schema");
    }
  });
});

describe("complete", () => {
  it("Ollama 응답 본문을 돌려준다", async () => {
    const raw = await complete("안녕", { fetchImpl: fakeFetch({ response: '{"a":1}' }) });
    expect(raw).toBe('{"a":1}');
  });

  it("서버가 꺼져 있으면 offline 오류", async () => {
    const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(complete("안녕", { fetchImpl: dead })).rejects.toMatchObject({ kind: "offline" });
  });

  it("오류 상태면 http 오류", async () => {
    const failing = fakeFetch({ error: "model not found" }, { ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(complete("안녕", { fetchImpl: failing })).rejects.toMatchObject({ kind: "http" });
  });
});

describe("실제 HTTP 왕복", () => {
  /** 가짜 Ollama를 띄워 요청 본문이 실제로 어떻게 나가는지 확인한다. */
  it("Ollama가 받는 모양 그대로 나간다", async () => {
    const { createServer } = await import("node:http");
    let received: Record<string, unknown> = {};

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ response: '{"toSupervisor":[],"toPI":[]}', done: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const raw = await complete("본문", {
        system: "규칙",
        config: { endpoint: `http://127.0.0.1:${port}`, model: "qwen3:8b", numCtx: 32768 },
      });
      expect(raw).toBe('{"toSupervisor":[],"toPI":[]}');
      expect(received).toMatchObject({
        model: "qwen3:8b",
        system: "규칙",
        stream: false,
        format: "json",
        options: { num_ctx: 32768, temperature: 0.2 },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("checkOllama", () => {
  it("받아 둔 모델 목록을 돌려준다", async () => {
    const status = await checkOllama({}, fakeFetch({ models: [{ name: "qwen3:8b" }] }) as unknown as typeof fetch);
    expect(status).toEqual({ ok: true, models: ["qwen3:8b"] });
  });

  it("연결 실패를 오류로 알린다 — 예외를 던지지 않는다", async () => {
    const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const status = await checkOllama({}, dead);
    expect(status.ok).toBe(false);
  });
});

describe("connectionHint", () => {
  it("로컬에서는 서버를 띄우라고 안내한다", () => {
    expect(connectionHint("http://localhost:3000")).toMatch(/ollama serve/);
    expect(connectionHint("http://127.0.0.1:3000")).toMatch(/ollama serve/);
  });

  it("배포된 주소에서는 OLLAMA_ORIGINS를 안내한다", () => {
    // 서버가 켜져 있어도 Ollama가 출처를 보고 403을 준다. 실측으로 확인한 동작이다.
    const hint = connectionHint("https://rnd-flow.vercel.app");
    expect(hint).toMatch(/OLLAMA_ORIGINS="https:\/\/rnd-flow\.vercel\.app"/);
  });

  it("주소를 모르면 기본 안내로 둔다", () => {
    expect(connectionHint("")).toMatch(/ollama serve/);
  });

  it("로컬 주소를 구분한다", () => {
    expect(isLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOrigin("https://localhost")).toBe(true);
    expect(isLocalOrigin("https://mylocalhost.com")).toBe(false);
    expect(isLocalOrigin("https://rnd-flow.vercel.app")).toBe(false);
  });
});

describe("제한 시간", () => {
  it("응답이 오지 않으면 60초 안에 풀린다", async () => {
    // 이 장치가 없으면 화면이 "생성 중…"에서 영원히 멈춘다
    const hang = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;

    await expect(complete("안녕", { fetchImpl: hang, timeoutMs: 30 }))
      .rejects.toMatchObject({ kind: "timeout" });
  });

  it("사용자 중단은 timeout과 구분한다", async () => {
    const controller = new AbortController();
    const hang = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;

    const promise = complete("안녕", { fetchImpl: hang, signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
  });

  it("정상 응답에는 영향이 없다", async () => {
    const raw = await complete("안녕", { fetchImpl: fakeFetch({ response: "ok" }), timeoutMs: 5000 });
    expect(raw).toBe("ok");
  });

  it("기본 제한 시간이 정해져 있다", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("입력 길이 가드", () => {
  it("상한 안이면 그대로 둔다", () => {
    expect(trimPrompt("짧은 입력")).toEqual({ text: "짧은 입력", trimmed: false, dropped: 0 });
  });

  it("넘으면 자르고 잘랐다고 남긴다", () => {
    // 조용히 자르면 뒷부분이 사라진 걸 모른 채 결과를 믿게 된다
    const long = "가".repeat(MAX_PROMPT_CHARS + 500);
    const result = trimPrompt(long);
    expect(result.trimmed).toBe(true);
    expect(result.dropped).toBe(500);
    expect(result.text).toMatch(/이후 내용을 잘랐습니다/);
  });

  it("실제 호출에서도 잘라 보낸다", async () => {
    let sent = "";
    const spy = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).prompt;
      return { ok: true, status: 200, json: async () => ({ response: "ok" }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    await complete("나".repeat(MAX_PROMPT_CHARS + 1000), { fetchImpl: spy });
    expect(sent.length).toBeLessThan(MAX_PROMPT_CHARS + 100);
  });
});
