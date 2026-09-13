// The WMSFO API calls the simulator needs (simulator-beacon.md 4):
// GET /admin/events lists the years' events; GET /admin/events/{id}/locations
// with publishedOnly=true&limit=500 following nextCursor returns the recorded
// fixes for a year. Both carry Authorization: Bearer <SIM_API_KEY>.
//
// The API answers with the shared contracts' error shape; on a non-2xx the
// caller sees an ApiError with the code and message so the run row can go to
// failed with lastError set to what the API said (a 401 from a revoked key is
// the same shape as a 404 on a deleted year: the caller does not need to know
// which happened).

export interface EventItem {
  id: number;
  year: number;
  name: string;
  statusId: number;
  scheduledAt: string | null;
  wentLiveAt: string | null;
  endedAt: string | null;
}

export interface LocationRow {
  seq: number;
  recordedAt: string;
  lat: number;
  lng: number;
  speedMps: number | null;
  altitudeM: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface FlightsApiOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageLimit?: number;
}

export interface FlightsApi {
  listEvents(): Promise<EventItem[]>;
  listPublishedLocations(eventId: number): Promise<LocationRow[]>;
}

async function callJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | { status: null; error: string }> {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    let body: unknown = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(to);
  }
}

function readErr(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const b = body as Record<string, unknown>;
  return {
    code: typeof b.code === "string" ? b.code : null,
    message: typeof b.message === "string" ? b.message : null,
  };
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  return num(v);
}

function eventFromRow(r: unknown): EventItem | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const id = numOrNull(o.id);
  const year = numOrNull(o.year);
  if (id == null || year == null) return null;
  return {
    id,
    year,
    name: typeof o.name === "string" ? o.name : "",
    statusId: num(o.statusId),
    scheduledAt: typeof o.scheduledAt === "string" ? o.scheduledAt : null,
    wentLiveAt: typeof o.wentLiveAt === "string" ? o.wentLiveAt : null,
    endedAt: typeof o.endedAt === "string" ? o.endedAt : null,
  };
}

function locationFromRow(r: unknown): LocationRow | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const seq = numOrNull(o.seq);
  const lat = numOrNull(o.lat);
  const lng = numOrNull(o.lng);
  if (seq == null || lat == null || lng == null) return null;
  const recordedAt = typeof o.recordedAt === "string" ? o.recordedAt : null;
  if (!recordedAt) return null;
  return {
    seq,
    recordedAt,
    lat,
    lng,
    speedMps: numOrNull(o.speedMps),
    altitudeM: numOrNull(o.altitudeM),
    headingDeg: numOrNull(o.headingDeg),
    accuracyM: numOrNull(o.accuracyM),
  };
}

export function createFlightsApi(opts: FlightsApiOptions): FlightsApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pageLimit = opts.pageLimit ?? 500;
  const base = opts.apiBaseUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    Accept: "application/json",
  };

  async function get(url: string): Promise<unknown> {
    const r = await callJson(fetchImpl, url, headers, timeoutMs);
    if (r.status === null) {
      throw new ApiError(null, null, `network error: ${r.error}`);
    }
    if (r.status < 200 || r.status >= 300) {
      const e = readErr(r.body);
      const msg = e.message ?? `http ${r.status}`;
      throw new ApiError(r.status, e.code, `${e.code ?? `http_${r.status}`}: ${msg}`);
    }
    return r.body;
  }

  async function listEvents(): Promise<EventItem[]> {
    const body = await get(`${base}/admin/events`);
    const items = (body && typeof body === "object"
      ? (body as { items?: unknown }).items
      : null) as unknown;
    if (!Array.isArray(items)) return [];
    const out: EventItem[] = [];
    for (const it of items) {
      const e = eventFromRow(it);
      if (e) out.push(e);
    }
    return out;
  }

  async function listPublishedLocations(eventId: number): Promise<LocationRow[]> {
    const out: LocationRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    // A recording of an entire flight fits in a few hundred pages at 500 fixes
    // each; a runaway loop that never sees `nextCursor: null` would drain
    // memory. Cap at 10,000 pages (about 5 million fixes) so a broken API
    // answer surfaces as an error rather than a hang.
    const MAX_PAGES = 10_000;
    do {
      const qs = new URLSearchParams();
      qs.set("publishedOnly", "true");
      qs.set("limit", String(pageLimit));
      if (cursor) qs.set("cursor", cursor);
      const url = `${base}/admin/events/${eventId}/locations?${qs.toString()}`;
      const body = await get(url);
      const b =
        body && typeof body === "object"
          ? (body as { items?: unknown; nextCursor?: unknown })
          : null;
      const items = b?.items;
      if (Array.isArray(items)) {
        for (const it of items) {
          const row = locationFromRow(it);
          if (row) out.push(row);
        }
      }
      cursor = typeof b?.nextCursor === "string" ? b.nextCursor : null;
      pages += 1;
      if (pages > MAX_PAGES) {
        throw new ApiError(null, "too_many_pages", "location paging exceeded limit");
      }
    } while (cursor);
    return out;
  }

  return { listEvents, listPublishedLocations };
}
