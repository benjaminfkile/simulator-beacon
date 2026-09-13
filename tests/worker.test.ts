// The worker's hand-off: a new leader reads the row that a previous leader
// persisted with an intermediate index and resumes from there. Also covers
// index persistence every ten fixes and the run-failed path when the flights
// API refuses.

import { describe, expect, it } from "vitest";
import { startWorker } from "../src/worker.js";
import type { Db, SimRun, SimRunUpdate } from "../src/db.js";
import type { FlightsCache } from "../src/flights/cache.js";
import type { LocationRow } from "../src/flights/api.js";
import { ApiError } from "../src/flights/api.js";

interface FakeDbHandle extends Db {
  readonly row: SimRun;
  readonly updates: SimRunUpdate[];
}

function makeDb(initial: Partial<SimRun> = {}): FakeDbHandle {
  const state: { row: SimRun; updates: SimRunUpdate[] } = {
    row: {
      status: "stopped",
      year: null,
      speed: 1,
      index: 0,
      total: 0,
      startedAt: null,
      lastFixAt: null,
      lastError: null,
      requestedBy: null,
      leaderState: null,
      leaderAt: null,
      updatedAt: new Date().toISOString(),
      ...initial,
    },
    updates: [],
  };
  const db: Db = {
    async init() {},
    async read() {
      return { ...state.row };
    },
    async update(patch: SimRunUpdate) {
      state.updates.push(patch);
      state.row = {
        ...state.row,
        ...patch,
        updatedAt: new Date().toISOString(),
      } as SimRun;
      return { ...state.row };
    },
    async writeLeaderState(s) {
      state.row.leaderState = s;
      state.row.leaderAt = new Date().toISOString();
    },
    async close() {},
  };
  return Object.defineProperties(db as FakeDbHandle, {
    row: { get: () => state.row, enumerable: true },
    updates: { get: () => state.updates, enumerable: true },
  });
}

function makePoints(n: number): LocationRow[] {
  const out: LocationRow[] = [];
  const base = Date.parse("2025-12-22T01:00:00.000Z");
  for (let i = 0; i < n; i++) {
    out.push({
      seq: i + 1,
      recordedAt: new Date(base + i * 1000).toISOString(),
      lat: 46 + i * 0.0001,
      lng: -114 - i * 0.0001,
      speedMps: null,
      altitudeM: null,
      headingDeg: null,
      accuracyM: null,
    });
  }
  return out;
}

function makeCache(points: LocationRow[]): FlightsCache & { loadCalls: number } {
  let loadCalls = 0;
  const cache: FlightsCache = {
    async listYears() {
      return [{ year: 2025, eventId: 1, name: "2025", pointCount: points.length }];
    },
    async loadYear(year) {
      loadCalls += 1;
      return {
        year,
        eventId: 1,
        name: "2025",
        points,
        loadedAt: new Date().toISOString(),
        loadMs: 0,
      };
    },
    async refresh() {},
    cachedYears: () => [2025],
    lastLoad: () => ({ at: null, ms: null }),
  };
  return Object.assign(cache as FlightsCache & { loadCalls: number }, {
    get loadCalls() {
      return loadCalls;
    },
  });
}

// A synchronous scheduler stub: the caller can push fixes to `emitOne` in
// tests, then wait for the worker's next tick.
function makeSyncScheduler(): {
  runningFactory: typeof import("../src/flights/scheduler.js").startScheduler;
  emits: Array<{ index: number }>;
  emitOne: () => void;
  emitEnd: () => void;
} {
  let onEmit: ((e: { index: number; point: LocationRow; recordedAtNow: string; nextFixInMs: number | null }) => void) | null = null;
  let onEnd: (() => void) | null = null;
  let points: LocationRow[] = [];
  let index = 0;
  let running = false;
  const emits: Array<{ index: number }> = [];

  const startSched: typeof import("../src/flights/scheduler.js").startScheduler = (
    opts,
  ) => {
    points = opts.points;
    onEmit = opts.onEmit;
    onEnd = opts.onEnd;
    return {
      start(from) {
        index = from;
        running = true;
      },
      stop() {
        running = false;
      },
      running: () => running,
      currentIndex: () => index,
      computeIntervals: () => points.map(() => 100),
    };
  };

  return {
    runningFactory: startSched,
    emits,
    emitOne() {
      if (!onEmit || !running) return;
      const p = points[index];
      if (!p) return;
      onEmit({
        index,
        point: p,
        recordedAtNow: new Date().toISOString(),
        nextFixInMs: 100,
      });
      emits.push({ index });
      index += 1;
    },
    emitEnd() {
      if (!onEnd) return;
      running = false;
      onEnd();
    },
  };
}

describe("worker (simulator-beacon.md 2 and 4)", () => {
  it("persists index every ten fixes", async () => {
    const db = makeDb({ status: "loading", year: 2025, speed: 20, index: 0, total: 0 });
    const cache = makeCache(makePoints(50));
    const stub = makeSyncScheduler();
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: () => undefined,
      onStop: () => undefined,
      tickMs: 60_000, // Disable the recurring tick; test drives worker.tick().
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    // The tick reads `loading`, loads the flight, flips to `running`.
    expect(db.row.status).toBe("running");
    expect(db.row.total).toBe(50);
    // Emit ten fixes; only the tenth should trigger an index persistence.
    for (let i = 0; i < 9; i++) stub.emitOne();
    // Nine emits: no persistence yet.
    const persistBefore = db.updates.filter((u) => u.index !== undefined).length;
    stub.emitOne();
    // Persistence happens in a microtask chain: await one round-trip.
    await new Promise((r) => setTimeout(r, 0));
    const persistAfter = db.updates.filter((u) => u.index !== undefined).length;
    expect(persistAfter).toBe(persistBefore + 1);
    // The persisted index is 10 (the next resume point after emitting index 9).
    const lastIndexUpdate = db.updates.filter((u) => u.index !== undefined).at(-1);
    expect(lastIndexUpdate?.index).toBe(10);
    await worker.stop();
  });

  it("resumes from the persisted index on hand-off", async () => {
    // The previous leader stopped mid-run: row is `running` with index 42.
    const points = makePoints(100);
    const db = makeDb({ status: "running", year: 2025, speed: 20, index: 42, total: 100 });
    const cache = makeCache(points);
    const stub = makeSyncScheduler();
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: () => undefined,
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    // The worker reloads the year and resumes at index 42.
    expect(worker.currentIndex()).toBe(42);
    // The status write (running) preserves the index the worker resumed at.
    const lastStart = db.updates.find((u) => u.status === "running");
    expect(lastStart?.index).toBe(42);
    await worker.stop();
  });

  it("marks the row failed with lastError when the flights API refuses", async () => {
    const db = makeDb({ status: "loading", year: 2025, speed: 20, index: 0 });
    const cache: FlightsCache = {
      async listYears() {
        return [];
      },
      async loadYear() {
        throw new ApiError(401, "unauthenticated", "key revoked");
      },
      async refresh() {},
      cachedYears: () => [],
      lastLoad: () => ({ at: null, ms: null }),
    };
    const stub = makeSyncScheduler();
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: () => undefined,
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    expect(db.row.status).toBe("failed");
    expect(db.row.lastError).toContain("unauthenticated");
    await worker.stop();
  });

  it("writes leader_state and leader_at on every tick", async () => {
    const db = makeDb({ status: "stopped" });
    const cache = makeCache([]);
    const stub = makeSyncScheduler();
    let build = 0;
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({ tick: ++build }),
      onEmit: () => undefined,
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    await worker.tick();
    expect(build).toBeGreaterThanOrEqual(2);
    expect(db.row.leaderState).toEqual({ tick: build });
    expect(db.row.leaderAt).not.toBeNull();
    await worker.stop();
  });
});
