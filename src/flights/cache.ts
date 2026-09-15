// Per-year point cache (simulator-beacon.md 4). Loaded on start and refreshed
// when a run starts for a year; the listing call refreshes the whole cache
// when the last refresh is older than a minute. `GET /control/years` reads
// straight off the cache, so `pointCount` is the true count of published
// locations for the year and a year with no published locations is omitted.

import type { EventItem, FlightsApi, LocationRow } from "./api.js";
import { buildFlightSeries, type FlightSeries } from "./series.js";

export interface CachedFlight {
  year: number;
  eventId: number;
  name: string;
  points: LocationRow[];
  series: FlightSeries;
  loadedAt: string;
  loadMs: number;
}

export interface FlightsCache {
  listYears(): Promise<
    Array<{ year: number; eventId: number; name: string; pointCount: number }>
  >;
  loadYear(year: number): Promise<CachedFlight>;
  // Return the cached entry if present, else load it through the API. Used by
  // GET /control/flight (avoids a refetch when the year is already cached) and
  // by the worker's peek path.
  getOrLoadYear(year: number): Promise<CachedFlight>;
  getCached(year: number): CachedFlight | undefined;
  refresh(): Promise<void>;
  cachedYears(): number[];
  lastLoad(): { at: string | null; ms: number | null };
}

export interface FlightsCacheOptions {
  api: FlightsApi;
  now?: () => number;
  // How stale the last full refresh may be before `listYears()` triggers a
  // fresh one. Default 60 s per simulator-beacon.md 4.
  refreshTtlMs?: number;
}

function primaryEvents(events: EventItem[]): Array<{ year: number; event: EventItem }> {
  const grouped = new Map<number, EventItem[]>();
  for (const e of events) {
    const list = grouped.get(e.year) ?? [];
    list.push(e);
    grouped.set(e.year, list);
  }
  const out: Array<{ year: number; event: EventItem }> = [];
  for (const [year, list] of grouped) {
    // The primary event for a year is the highest id, the latest creation,
    // with any migration re-run overriding an earlier import.
    const primary = list.slice().sort((a, b) => b.id - a.id)[0]!;
    out.push({ year, event: primary });
  }
  return out;
}

export function createFlightsCache(opts: FlightsCacheOptions): FlightsCache {
  const now = opts.now ?? (() => Date.now());
  const refreshTtlMs = opts.refreshTtlMs ?? 60_000;
  const cache = new Map<number, CachedFlight>();
  let lastLoadAt: string | null = null;
  let lastLoadMs: number | null = null;
  let lastRefreshMs: number | null = null;
  let refreshInFlight: Promise<void> | null = null;

  async function loadPoints(year: number, event: EventItem): Promise<CachedFlight> {
    const started = now();
    const points = await opts.api.listPublishedLocations(event.id);
    points.sort((a, b) => a.seq - b.seq);
    const took = now() - started;
    const cached: CachedFlight = {
      year,
      eventId: event.id,
      name: event.name,
      points,
      series: buildFlightSeries(points),
      loadedAt: new Date(now()).toISOString(),
      loadMs: took,
    };
    cache.set(year, cached);
    lastLoadAt = cached.loadedAt;
    lastLoadMs = took;
    return cached;
  }

  async function doRefresh(): Promise<void> {
    const events = await opts.api.listEvents();
    const primaries = primaryEvents(events);
    const currentYears = new Set(primaries.map((p) => p.year));
    for (const y of Array.from(cache.keys())) {
      if (!currentYears.has(y)) cache.delete(y);
    }
    // Load each year's locations. Serial keeps the API load predictable and
    // matches the loadYear path; the six migrated years today are a few
    // seconds total.
    for (const { year, event } of primaries) {
      await loadPoints(year, event);
    }
    lastRefreshMs = now();
  }

  function refresh(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function listYears(): Promise<
    Array<{ year: number; eventId: number; name: string; pointCount: number }>
  > {
    const stale =
      lastRefreshMs === null || now() - lastRefreshMs > refreshTtlMs;
    if (stale) {
      try {
        await refresh();
      } catch (err) {
        // If we have never successfully refreshed the caller must see the
        // failure so the route can answer 502; otherwise fall through and
        // serve the (stale) cached listing.
        if (lastRefreshMs === null) throw err;
      }
    }
    const out: Array<{
      year: number;
      eventId: number;
      name: string;
      pointCount: number;
    }> = [];
    for (const [year, entry] of cache) {
      if (entry.points.length === 0) continue;
      out.push({
        year,
        eventId: entry.eventId,
        name: entry.name,
        pointCount: entry.points.length,
      });
    }
    out.sort((a, b) => b.year - a.year);
    return out;
  }

  async function loadYear(year: number): Promise<CachedFlight> {
    const events = await opts.api.listEvents();
    const primaries = primaryEvents(events);
    const match = primaries.find((p) => p.year === year);
    if (!match) {
      const err = new Error(`unknown year ${year}`) as Error & { code?: string };
      err.code = "unknown_year";
      throw err;
    }
    return loadPoints(year, match.event);
  }

  async function getOrLoadYear(year: number): Promise<CachedFlight> {
    const existing = cache.get(year);
    if (existing) return existing;
    return loadYear(year);
  }

  return {
    listYears,
    loadYear,
    getOrLoadYear,
    getCached: (year) => cache.get(year),
    refresh,
    cachedYears: () => Array.from(cache.keys()).sort((a, b) => b - a),
    lastLoad: () => ({ at: lastLoadAt, ms: lastLoadMs }),
  };
}
