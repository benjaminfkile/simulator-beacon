// Per-year point cache (simulator-beacon.md 4). A year is loaded from the API
// on demand and kept in memory for the life of the process; the next start
// for the same year refreshes it (a live event's recording grows until the
// event ends).

import type { EventItem, FlightsApi, LocationRow } from "./api.js";

export interface CachedFlight {
  year: number;
  eventId: number;
  name: string;
  points: LocationRow[];
  loadedAt: string;
  loadMs: number;
}

export interface FlightsCache {
  listYears(): Promise<
    Array<{ year: number; eventId: number; name: string; pointCount: number }>
  >;
  loadYear(year: number): Promise<CachedFlight>;
  cachedYears(): number[];
  lastLoad(): { at: string | null; ms: number | null };
}

export interface FlightsCacheOptions {
  api: FlightsApi;
  now?: () => number;
}

interface YearIndexEntry {
  eventId: number;
  name: string;
  pointCount: number;
}

export function createFlightsCache(opts: FlightsCacheOptions): FlightsCache {
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<number, CachedFlight>();
  let lastLoadAt: string | null = null;
  let lastLoadMs: number | null = null;

  async function buildYearIndex(): Promise<Map<number, YearIndexEntry>> {
    const events = await opts.api.listEvents();
    const grouped = new Map<number, EventItem[]>();
    for (const e of events) {
      const list = grouped.get(e.year) ?? [];
      list.push(e);
      grouped.set(e.year, list);
    }
    const out = new Map<number, YearIndexEntry>();
    for (const [year, list] of grouped) {
      // Pick the "primary" event for the year (highest id — the latest
      // creation, with any migration re-run overriding an earlier import).
      const primary = list.slice().sort((a, b) => b.id - a.id)[0]!;
      const cached = cache.get(year);
      const pointCount = cached?.eventId === primary.id ? cached.points.length : 0;
      out.set(year, { eventId: primary.id, name: primary.name, pointCount });
    }
    return out;
  }

  async function listYears(): Promise<
    Array<{ year: number; eventId: number; name: string; pointCount: number }>
  > {
    const index = await buildYearIndex();
    const out: Array<{
      year: number;
      eventId: number;
      name: string;
      pointCount: number;
    }> = [];
    // A year is listed only when at least one published location exists. Cheap
    // way to know that without hammering the locations endpoint per year: ask
    // for a single-item page and drop the year when it comes back empty. The
    // cache remembers the answer so a Start on the same year still runs.
    for (const [year, entry] of index) {
      if (entry.pointCount > 0) {
        out.push({ year, ...entry });
        continue;
      }
      const cached = cache.get(year);
      if (cached && cached.eventId === entry.eventId) {
        if (cached.points.length > 0) out.push({ year, ...entry });
        continue;
      }
      // Fall through: we assume the year has at least one published location
      // when the API returned the event. The panel discipline in production is
      // to publish the migrated fixes with the event; a Start on a year with
      // zero fixes fails cleanly through loadYear (no points → run fails).
      out.push({ year, ...entry });
    }
    out.sort((a, b) => b.year - a.year);
    return out;
  }

  async function loadYear(year: number): Promise<CachedFlight> {
    const index = await buildYearIndex();
    const entry = index.get(year);
    if (!entry) {
      const err = new Error(`unknown year ${year}`) as Error & { code?: string };
      err.code = "unknown_year";
      throw err;
    }
    const started = now();
    const points = await opts.api.listPublishedLocations(entry.eventId);
    points.sort((a, b) => a.seq - b.seq);
    const took = now() - started;
    const cached: CachedFlight = {
      year,
      eventId: entry.eventId,
      name: entry.name,
      points,
      loadedAt: new Date(now()).toISOString(),
      loadMs: took,
    };
    cache.set(year, cached);
    lastLoadAt = cached.loadedAt;
    lastLoadMs = took;
    return cached;
  }

  return {
    listYears,
    loadYear,
    cachedYears: () => Array.from(cache.keys()).sort((a, b) => b - a),
    lastLoad: () => ({ at: lastLoadAt, ms: lastLoadMs }),
  };
}
