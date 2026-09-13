// Thin fetch wrapper for the control API surface (simulator-beacon.md 5).
// Every request carries the ID token as `Authorization: Bearer <token>`; a
// non-2xx answer becomes an ApiError whose `code` is the error body's `code`
// (contracts 0.3) when the body was JSON, otherwise `network_error`.

import type { ApiErrorBody, ControlState, Speed, YearsResponse } from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: ApiErrorBody | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getIdToken: () => string | null;
  fetchImpl?: typeof fetch;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
  }
  const code = body?.code ?? `http_${res.status}`;
  const msg = body?.message ?? `${res.status} ${res.statusText}`;
  return new ApiError(res.status, code, msg, body);
}

export interface RunPatch {
  year?: number;
  speed?: Speed;
  loop?: boolean;
}

export interface ApiClient {
  getState(): Promise<ControlState>;
  getYears(): Promise<YearsResponse>;
  start(body: { year: number; speed: Speed }): Promise<ControlState>;
  stop(): Promise<ControlState>;
  restart(): Promise<ControlState>;
  patchRun(body: RunPatch): Promise<ControlState>;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/$/, "");

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = opts.getIdToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const init: RequestInit = { method, headers };
    if (payload !== undefined) init.body = payload;
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    getState: () => req<ControlState>("GET", "/control/state"),
    getYears: () => req<YearsResponse>("GET", "/control/years"),
    start: (body) => req<ControlState>("POST", "/control/start", body),
    stop: () => req<ControlState>("POST", "/control/stop"),
    restart: () => req<ControlState>("POST", "/control/restart"),
    patchRun: (body) => req<ControlState>("PATCH", "/control/run", body),
  };
}
