// GET /control/flight (simulator-beacon.md 5): the per-year series the page
// charts and scrubs. Speed derivation with haversine when the recording has
// no speedMps; hasAltitude and speedSource per the brief; 400 for an unknown
// year; 502 when the cache load fails upstream.

import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createAdminAuth } from "../src/control/auth.js";
import { buildControlServer } from "../src/control/routes.js";
import type { Db, SimRun, SimRunUpdate } from "../src/db.js";
import type { CachedFlight, FlightsCache } from "../src/flights/cache.js";
import type { LocationRow } from "../src/flights/api.js";
import { buildFlightSeries, haversineMeters } from "../src/flights/series.js";

type Key = Awaited<ReturnType<typeof generateKeyPair>>;

const ADMIN_ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/pool-admin";
const ADMIN_AUD = "client-admin";
let key: Key;

beforeAll(async () => {
  key = await generateKeyPair("RS256");
});

async function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setIssuer(ADMIN_ISSUER)
    .setAudience(ADMIN_AUD)
    .sign(key.privateKey);
}

function makeFakeDb(): Db {
  let row: SimRun = {
    status: "stopped",
    year: null,
    speed: 1,
    loop: true,
    cycles: 0,
    index: 0,
    total: 0,
    nextFixInMs: null,
    startedAt: null,
    lastFixAt: null,
    lastError: null,
    requestedBy: null,
    seekTo: null,
    seekAt: null,
    leaderState: null,
    leaderAt: null,
    updatedAt: new Date().toISOString(),
  };
  return {
    async init() {},
    async read() {
      return { ...row };
    },
    async update(patch: SimRunUpdate) {
      row = { ...row, ...patch, updatedAt: new Date().toISOString() } as SimRun;
      return { ...row };
    },
    async writeLeaderState() {},
    async clearSeekAndSetIndex() {},
    async dropSeek() {},
    async close() {},
  };
}

function makeCache(entries: Map<number, CachedFlight>, opts: { throwOnLoad?: Error } = {}): FlightsCache {
  return {
    async listYears() {
      return Array.from(entries.values()).map((e) => ({
        year: e.year,
        eventId: e.eventId,
        name: e.name,
        pointCount: e.points.length,
      }));
    },
    async loadYear(year: number) {
      if (opts.throwOnLoad) throw opts.throwOnLoad;
      const e = entries.get(year);
      if (!e) {
        const err = new Error(`unknown year ${year}`) as Error & { code?: string };
        err.code = "unknown_year";
        throw err;
      }
      return e;
    },
    async getOrLoadYear(year: number) {
      if (opts.throwOnLoad) throw opts.throwOnLoad;
      const e = entries.get(year);
      if (!e) {
        const err = new Error(`unknown year ${year}`) as Error & { code?: string };
        err.code = "unknown_year";
        throw err;
      }
      return e;
    },
    getCached: (year: number) => entries.get(year),
    async refresh() {},
    cachedYears: () => Array.from(entries.keys()),
    lastLoad: () => ({ at: null, ms: null }),
  };
}

function fakeFlight(year: number, points: LocationRow[], name = "x"): CachedFlight {
  return {
    year,
    eventId: 42,
    name,
    points,
    series: buildFlightSeries(points),
    loadedAt: new Date().toISOString(),
    loadMs: 0,
  };
}

async function buildServer(cache: FlightsCache) {
  const auth = createAdminAuth({
    issuer: ADMIN_ISSUER,
    audiences: [ADMIN_AUD],
    adminGroup: "admin",
    jwks: async () => key.publicKey,
  });
  return buildControlServer({
    db: makeFakeDb(),
    cache,
    auth,
    corsOrigins: ["http://localhost:5175"],
    probe: () => ({ configLoaded: true, leaderPolledOnce: true, isLeader: true }),
    buildBeaconState: () => ({}),
    instance: null,
  });
}

describe("GET /control/flight (simulator-beacon.md 5)", () => {
  it("derives speed with haversine within 1% of hand-computed values when speedMps is null", async () => {
    // Three points along a rough east/west line, 10 s apart, with null recorded
    // speeds. The middle and last emit rows carry the derived speed.
    const t0 = Date.parse("2025-01-01T00:00:00.000Z");
    const points: LocationRow[] = [
      {
        seq: 1,
        recordedAt: new Date(t0).toISOString(),
        lat: 46.0,
        lng: -114.0,
        speedMps: null,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
      {
        seq: 2,
        recordedAt: new Date(t0 + 10_000).toISOString(),
        lat: 46.001,
        lng: -114.0,
        speedMps: null,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
      {
        seq: 3,
        recordedAt: new Date(t0 + 20_000).toISOString(),
        lat: 46.003,
        lng: -114.0,
        speedMps: null,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
    ];
    const cache = makeCache(new Map([[2025, fakeFlight(2025, points, "Santa 2025")]]));
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2025",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.year).toBe(2025);
    expect(body.eventId).toBe(42);
    expect(body.name).toBe("Santa 2025");
    expect(body.pointCount).toBe(3);
    expect(body.durationMs).toBe(20_000);
    expect(body.hasAltitude).toBe(false);
    expect(body.speedSource).toBe("derived");
    // First point speed is null.
    expect(body.points[0].speedMps).toBeNull();
    // Hand-computed derived speeds:
    const dExpected1 = haversineMeters(46.0, -114.0, 46.001, -114.0) / 10;
    const dExpected2 = haversineMeters(46.001, -114.0, 46.003, -114.0) / 10;
    const gotA = body.points[1].speedMps as number;
    const gotB = body.points[2].speedMps as number;
    expect(Math.abs(gotA - dExpected1) / dExpected1).toBeLessThan(0.01);
    expect(Math.abs(gotB - dExpected2) / dExpected2).toBeLessThan(0.01);
    // t is milliseconds from the first point's recordedAt.
    expect(body.points[0].t).toBe(0);
    expect(body.points[1].t).toBe(10_000);
    expect(body.points[2].t).toBe(20_000);
    await server.close();
  });

  it("passes through recorded speedMps and reports speedSource=recorded", async () => {
    const t0 = Date.parse("2025-01-01T00:00:00.000Z");
    const points: LocationRow[] = [
      {
        seq: 1,
        recordedAt: new Date(t0).toISOString(),
        lat: 46.0,
        lng: -114.0,
        speedMps: 12.5,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
      {
        seq: 2,
        recordedAt: new Date(t0 + 5_000).toISOString(),
        lat: 46.001,
        lng: -114.0,
        speedMps: 14.7,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
    ];
    const cache = makeCache(new Map([[2025, fakeFlight(2025, points)]]));
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2025",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.speedSource).toBe("recorded");
    expect(body.points[0].speedMps).toBe(12.5);
    expect(body.points[1].speedMps).toBe(14.7);
    await server.close();
  });

  it("reports hasAltitude=false when every altitude is null", async () => {
    const t0 = Date.parse("2025-01-01T00:00:00.000Z");
    const points: LocationRow[] = [
      {
        seq: 1,
        recordedAt: new Date(t0).toISOString(),
        lat: 46,
        lng: -114,
        speedMps: 1,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
    ];
    const cache = makeCache(new Map([[2025, fakeFlight(2025, points)]]));
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2025",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasAltitude).toBe(false);
    await server.close();
  });

  it("reports hasAltitude=true when at least one point has an altitude", async () => {
    const t0 = Date.parse("2025-01-01T00:00:00.000Z");
    const points: LocationRow[] = [
      {
        seq: 1,
        recordedAt: new Date(t0).toISOString(),
        lat: 46,
        lng: -114,
        speedMps: 1,
        altitudeM: null,
        headingDeg: null,
        accuracyM: null,
      },
      {
        seq: 2,
        recordedAt: new Date(t0 + 1000).toISOString(),
        lat: 46.0001,
        lng: -114,
        speedMps: 1,
        altitudeM: 1024,
        headingDeg: null,
        accuracyM: null,
      },
    ];
    const cache = makeCache(new Map([[2025, fakeFlight(2025, points)]]));
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2025",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasAltitude).toBe(true);
    await server.close();
  });

  it("returns 400 validation_failed for an unknown year", async () => {
    const cache = makeCache(new Map());
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2099",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    await server.close();
  });

  it("returns 502 upstream_unavailable when the cache load fails", async () => {
    const cache = makeCache(new Map(), { throwOnLoad: new Error("api boom") });
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight?year=2025",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("upstream_unavailable");
    await server.close();
  });

  it("returns 400 when year is missing or not an integer", async () => {
    const cache = makeCache(new Map());
    const server = await buildServer(cache);
    const token = await mint({ token_use: "id", "cognito:groups": ["admin"] });
    const res = await server.inject({
      method: "GET",
      url: "/control/flight",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    await server.close();
  });
});
