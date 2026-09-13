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
      loop: true,
      cycles: 0,
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

interface CountedCache extends FlightsCache {
  readonly loadCalls: number;
}

function makeCache(points: LocationRow[]): CountedCache {
  const state = { loadCalls: 0 };
  const cache: FlightsCache = {
    async listYears() {
      return [{ year: 2025, eventId: 1, name: "2025", pointCount: points.length }];
    },
    async loadYear(year) {
      state.loadCalls += 1;
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
  return Object.defineProperty(cache as CountedCache, "loadCalls", {
    get: () => state.loadCalls,
    enumerable: true,
  });
}

// A synchronous scheduler stub: the caller can push fixes to `emitOne` in
// tests, then wait for the worker's next tick.
function makeSyncScheduler(): {
  runningFactory: typeof import("../src/flights/scheduler.js").startScheduler;
  emits: Array<{ index: number }>;
  emitOne: () => void;
  emitEnd: () => void;
  currentSpeed: () => import("../src/flights/scheduler.js").Speed;
  currentIndex: () => number;
} {
  let onEmit: ((e: { index: number; point: LocationRow; recordedAtNow: string; nextFixInMs: number | null }) => void) | null = null;
  let onEnd: (() => void) | null = null;
  let points: LocationRow[] = [];
  let index = 0;
  let running = false;
  const emits: Array<{ index: number }> = [];

  let speed: import("../src/flights/scheduler.js").Speed = 1;
  const startSched: typeof import("../src/flights/scheduler.js").startScheduler = (
    opts,
  ) => {
    points = opts.points;
    onEmit = opts.onEmit;
    onEnd = opts.onEnd;
    speed = opts.speed;
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
      setSpeed(next) {
        speed = next;
      },
      currentSpeed: () => speed,
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
    currentSpeed: () => speed,
    currentIndex: () => index,
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

  it("loops at the end when loop=true and bumps cycles on the row", async () => {
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
    });
    const cache = makeCache(makePoints(3));
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
    expect(db.row.status).toBe("running");
    // Drive the run to the end.
    stub.emitOne();
    stub.emitOne();
    stub.emitOne();
    stub.emitEnd();
    // Persistence is async; let one microtask round-trip land.
    await new Promise((r) => setTimeout(r, 0));
    // The row should still be running (loop restarted it) and cycles should be 1.
    expect(db.row.status).toBe("running");
    expect(db.row.cycles).toBe(1);
    expect(db.row.index).toBe(0);
    await worker.stop();
  });

  it("stops at the end when loop=false and keeps the index at the last point", async () => {
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: false,
      cycles: 0,
      index: 0,
    });
    const cache = makeCache(makePoints(3));
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
    stub.emitOne();
    stub.emitOne();
    stub.emitOne();
    stub.emitEnd();
    await new Promise((r) => setTimeout(r, 0));
    expect(db.row.status).toBe("stopped");
    expect(db.row.index).toBe(3);
    await worker.stop();
  });

  it("applies a live speed change without a restart", async () => {
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
    });
    const cache = makeCache(makePoints(50));
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
    expect(stub.currentSpeed()).toBe(20);
    // Emit a few fixes so we are past the first point.
    stub.emitOne();
    stub.emitOne();
    // Operator lowers the speed via PATCH.
    await db.update({ speed: 5 });
    const loadsBefore = cache.loadCalls;
    await worker.tick();
    expect(stub.currentSpeed()).toBe(5);
    // No reload: the year did not change.
    expect(cache.loadCalls).toBe(loadsBefore);
    // No status flip: still running.
    expect(db.row.status).toBe("running");
    await worker.stop();
  });

  it("restarts from the first point of a new year without a restart of the run", async () => {
    const db = makeDb({
      status: "loading",
      year: 2024,
      speed: 20,
      loop: true,
      cycles: 3,
      index: 5,
    });
    const cache = makeCache(makePoints(10));
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
    expect(db.row.status).toBe("running");
    expect(db.row.year).toBe(2024);
    // Operator switches to 2025 via PATCH.
    await db.update({ year: 2025 });
    const loadsBefore = cache.loadCalls;
    await worker.tick();
    // The worker stopped the active run and reloaded for the new year.
    expect(cache.loadCalls).toBeGreaterThan(loadsBefore);
    expect(db.row.year).toBe(2025);
    expect(db.row.index).toBe(0);
    expect(db.row.cycles).toBe(0);
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
