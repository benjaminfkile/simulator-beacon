import { describe, it, expect } from "vitest";
import { createApiClient, ApiError } from "../src/api.js";
import type { ControlState } from "../src/types.js";
import { STATE_FIXTURE } from "./state.fixture.js";

interface Recorded {
  url: string;
  init: RequestInit;
}

function makeFetchStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const i = init ?? {};
    calls.push({ url, init: i });
    return await handler(url, i);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  it("carries the ID token as Authorization: Bearer <token>", async () => {
    const { impl, calls } = makeFetchStub(async () => jsonResponse(STATE_FIXTURE));
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "TOKEN",
      fetchImpl: impl,
    });
    await api.getState();
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer TOKEN");
    expect(calls[0]!.url).toBe("https://example.test/control/state");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("sends { year, speed } to POST /control/start (the documented body)", async () => {
    const { impl, calls } = makeFetchStub(async () => jsonResponse(STATE_FIXTURE));
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "T",
      fetchImpl: impl,
    });
    await api.start({ year: 2025, speed: 60 });
    expect(calls[0]!.url).toBe("https://example.test/control/start");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      year: 2025,
      speed: 60,
    });
  });

  it("sends no body to POST /control/stop and POST /control/restart (the documented bodies)", async () => {
    const { impl, calls } = makeFetchStub(async () => jsonResponse(STATE_FIXTURE));
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "T",
      fetchImpl: impl,
    });
    await api.stop();
    await api.restart();
    expect(calls[0]!.url).toBe("https://example.test/control/stop");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[1]!.url).toBe("https://example.test/control/restart");
    expect(calls[1]!.init.method).toBe("POST");
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("throws ApiError { status:409, code:'already_running' } on 409 already_running", async () => {
    const body = {
      code: "already_running",
      message: "a run is already active",
      details: null,
      requestId: "abc",
    };
    const { impl } = makeFetchStub(async () => jsonResponse(body, 409));
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "T",
      fetchImpl: impl,
    });
    await expect(api.start({ year: 2025, speed: 60 })).rejects.toMatchObject({
      status: 409,
      code: "already_running",
    });
  });

  it("parses a state response as ControlState", async () => {
    const { impl } = makeFetchStub(async () => jsonResponse(STATE_FIXTURE));
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "T",
      fetchImpl: impl,
    });
    const state: ControlState = await api.getState();
    expect(state.run.status).toBe("running");
    expect(state.beacon?.name).toBe("simulator");
  });

  it("returns ApiError with a helpful code when the body is not JSON", async () => {
    const impl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: "https://example.test",
      getIdToken: () => "T",
      fetchImpl: impl,
    });
    await expect(api.getState()).rejects.toBeInstanceOf(ApiError);
    await expect(api.getState()).rejects.toMatchObject({
      status: 500,
      code: "http_500",
    });
  });
});
