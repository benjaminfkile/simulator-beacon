// The worker's hand-off: a new leader reads the row that a previous leader
// persisted with an intermediate index and resumes from there. Also covers
// index persistence every ten fixes and the run-failed path when the flights
// API refuses.

import { describe, expect, it, vi } from "vitest";
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
    async clearSeekAndSetIndex(index: number) {
      if (state.row.seekTo === index) {
        state.row = {
          ...state.row,
          seekTo: null,
          index,
          updatedAt: new Date().toISOString(),
        } as SimRun;
      }
    },
    async dropSeek(index: number) {
      if (state.row.seekTo === index) {
        state.row = {
          ...state.row,
          seekTo: null,
          updatedAt: new Date().toISOString(),
        } as SimRun;
      }
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
        series: {
          pointCount: points.length,
          firstRecordedAt: points[0]?.recordedAt ?? "",
          lastRecordedAt: points.at(-1)?.recordedAt ?? "",
          durationMs: 0,
          hasAltitude: false,
          speedSource: "recorded",
          points: [],
        },
        loadedAt: new Date().toISOString(),
        loadMs: 0,
      };
    },
    async getOrLoadYear(year) {
      return this.loadYear(year);
    },
    getCached: () => undefined,
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
      async getOrLoadYear() {
        throw new ApiError(401, "unauthenticated", "key revoked");
      },
      getCached: () => undefined,
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

  it("writes leader_state on every fourth tick (about once a second at tickMs=250)", async () => {
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
    await worker.tick();
    // Three ticks: no leader_state write yet (persist every 4th).
    expect(db.row.leaderAt).toBeNull();
    await worker.tick();
    // The fourth tick writes it.
    expect(db.row.leaderAt).not.toBeNull();
    expect(build).toBeGreaterThanOrEqual(1);
    const buildAfterFour = build;
    // Three more ticks: still the same write.
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(build).toBe(buildAfterFour);
    // The eighth tick writes again.
    await worker.tick();
    expect(build).toBe(buildAfterFour + 1);
    await worker.stop();
  });

  it("writes leader_state immediately after a status change the worker made", async () => {
    // A stopped row plus a Start (loading -> running) is a worker-made
    // status change; the write happens inline rather than waiting for the
    // fourth tick.
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      index: 0,
      total: 0,
    });
    const cache = makeCache(makePoints(5));
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
    // loadAndStart moved status loading -> running; leader_state was written
    // immediately (not after four ticks).
    expect(db.row.leaderAt).not.toBeNull();
    expect(db.row.status).toBe("running");
    await worker.stop();
  });

  it("carries the live index and cycles after a loop restart in leader_state.run", async () => {
    // Use persistLeaderStateEveryTicks=1 so each tick writes leader_state and
    // the test doesn't need to wait through the 4-tick cadence.
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
      persistLeaderStateEveryTicks: 1,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    stub.emitOne();
    stub.emitOne();
    stub.emitOne();
    stub.emitEnd();
    // Loop restart bumped cycles on the row; a subsequent tick reads the row
    // and writes leader_state with the live cycles.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await worker.tick();
    expect(db.row.leaderState).not.toBeNull();
    const run = (db.row.leaderState as Record<string, unknown>).run as
      | Record<string, unknown>
      | undefined;
    // After the loop the run resumed at index 0 with cycles bumped to 1.
    expect(run?.cycles).toBe(1);
    expect(run?.index).toBe(0);
    await worker.stop();
  });

  it("Stop during the end-of-run await does not throw and the row ends stopped", async () => {
    // The end-of-run race: handleEnd captures `active` at the top, so a Stop
    // pressed as the last point goes out never touches a nulled scheduler.
    const resolveUpdateRef: { fn: (() => void) | null } = { fn: null };
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: false,
      cycles: 0,
      index: 0,
    });
    const cache = makeCache(makePoints(2));
    const stub = makeSyncScheduler();
    const errors: Array<Record<string, unknown>> = [];
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: () => undefined,
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
      log: { error: (obj) => errors.push(obj) },
    });
    // Swap the db.update() with one whose end-of-run write hangs until we
    // resolve it, so we can drop Stop into the await window.
    const realUpdate = db.update.bind(db);
    let seenStoppedUpdate = false;
    db.update = async (patch) => {
      if (patch.status === "stopped") {
        seenStoppedUpdate = true;
        await new Promise<void>((r) => {
          resolveUpdateRef.fn = r;
        });
      }
      return realUpdate(patch);
    };
    await worker.tick();
    stub.emitOne();
    stub.emitOne();
    stub.emitEnd();
    // The stopped update is in flight; call Stop, which nulls active. If the
    // capture-run-at-top fix isn't in place, handleEnd would try to touch a
    // nulled active after the update resolves and throw.
    await new Promise((r) => setTimeout(r, 0));
    expect(seenStoppedUpdate).toBe(true);
    await worker.stop();
    // Now resolve the hanging update to let handleEnd finish.
    resolveUpdateRef.fn?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // No thrown-through error should have been logged from the handler.
    const emitOrEndErrors = errors.filter((e) =>
      typeof e === "object" &&
      typeof (e as { err?: unknown }).err === "string",
    );
    expect(emitOrEndErrors).toEqual([]);
    expect(db.row.status).toBe("stopped");
  });

  it("seek while running re-arms the scheduler at the index and emits the point at once", async () => {
    // A running row with a queued seek re-arms scheduler.start(index) (which
    // emits at once) and the conditional clear-and-set-index runs so the row's
    // index catches up.
    const points = makePoints(50);
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
      total: 0,
    });
    const cache = makeCache(points);
    const stub = makeSyncScheduler();
    const emits: Array<{ index: number }> = [];
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: (fix) => {
        emits.push({ index: fix.point.seq - 1 });
      },
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    // Load the flight and flip to running.
    await worker.tick();
    expect(db.row.status).toBe("running");
    // Emit a few points as if the scheduler had been running.
    stub.emitOne();
    stub.emitOne();
    stub.emitOne();
    // Operator drops a seek to index 30 on the row.
    await db.update({ seekTo: 30, seekAt: new Date().toISOString() });
    // Next tick: the worker re-arms at 30 and the conditional clear runs.
    await worker.tick();
    // seek_to cleared and index moved.
    expect(db.row.seekTo).toBeNull();
    expect(db.row.index).toBe(30);
    // The scheduler is running at index 30; a following emit is index 30.
    stub.emitOne();
    expect(emits.at(-1)?.index).toBe(30);
    await worker.stop();
  });

  it("seek while stopped emits exactly one point, stays stopped, clears seek_to and persists index", async () => {
    // A stopped run with a year on the row peeks at the seek's index through
    // onEmit and persists the row's index; status stays stopped so Start
    // resumes from there.
    const points = makePoints(20);
    const db = makeDb({
      status: "stopped",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
      total: 0,
      seekTo: 12,
      seekAt: new Date().toISOString(),
    });
    const cache = makeCache(points);
    const stub = makeSyncScheduler();
    const emits: Array<{ index: number }> = [];
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: (fix) => {
        emits.push({ index: fix.point.seq - 1 });
      },
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    // Exactly one peek emit happened.
    expect(emits.length).toBe(1);
    expect(emits[0]!.index).toBe(12);
    // Row still stopped.
    expect(db.row.status).toBe("stopped");
    // seek_to cleared and index persisted.
    expect(db.row.seekTo).toBeNull();
    expect(db.row.index).toBe(12);
    await worker.stop();
  });

  it("the latest of three quick seeks wins", async () => {
    // A drag: the API stamps seek_to three times before the worker tick fires.
    // The worker sees the latest value and acts on it; the conditional clear
    // keys on the value the worker acted on so an even newer one would stay.
    const points = makePoints(50);
    const db = makeDb({
      status: "loading",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
      total: 0,
    });
    const cache = makeCache(points);
    const stub = makeSyncScheduler();
    const emits: Array<{ index: number }> = [];
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: (fix) => {
        emits.push({ index: fix.point.seq - 1 });
      },
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    expect(db.row.status).toBe("running");
    // Three seeks in a row: the last one wins.
    await db.update({ seekTo: 5, seekAt: new Date().toISOString() });
    await db.update({ seekTo: 12, seekAt: new Date().toISOString() });
    await db.update({ seekTo: 25, seekAt: new Date().toISOString() });
    await worker.tick();
    expect(db.row.seekTo).toBeNull();
    expect(db.row.index).toBe(25);
    stub.emitOne();
    expect(emits.at(-1)?.index).toBe(25);
    await worker.stop();
  });

  it("seek while failed is cleared without an emit", async () => {
    const points = makePoints(10);
    const db = makeDb({
      status: "failed",
      year: 2025,
      speed: 20,
      loop: true,
      cycles: 0,
      index: 0,
      lastError: "boom",
      seekTo: 4,
      seekAt: new Date().toISOString(),
    });
    const cache = makeCache(points);
    const stub = makeSyncScheduler();
    const emits: Array<{ index: number }> = [];
    const worker = startWorker({
      db,
      cache,
      buildLeaderState: () => ({}),
      onEmit: (fix) => {
        emits.push({ index: fix.point.seq - 1 });
      },
      onStop: () => undefined,
      tickMs: 60_000,
      startScheduler: stub.runningFactory,
    });
    await worker.tick();
    // No emit; seek_to cleared; index untouched.
    expect(emits.length).toBe(0);
    expect(db.row.seekTo).toBeNull();
    expect(db.row.index).toBe(0);
    expect(db.row.status).toBe("failed");
    await worker.stop();
  });

  it("the tickMs defaults to 250 ms so a control change lands within a quarter second", async () => {
    // Fake timers verify the recurring cadence: each 250 ms elapses one tick.
    vi.useFakeTimers();
    try {
      const db = makeDb({ status: "stopped" });
      const cache = makeCache([]);
      const stub = makeSyncScheduler();
      let readCount = 0;
      const originalRead = db.read;
      db.read = async () => {
        readCount += 1;
        return originalRead();
      };
      const worker = startWorker({
        db,
        cache,
        buildLeaderState: () => ({}),
        onEmit: () => undefined,
        onStop: () => undefined,
        startScheduler: stub.runningFactory,
      });
      // Advance one tick's worth: exactly one read.
      await vi.advanceTimersByTimeAsync(250);
      expect(readCount).toBe(1);
      // Three more ticks: four reads total.
      await vi.advanceTimersByTimeAsync(750);
      expect(readCount).toBe(4);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
