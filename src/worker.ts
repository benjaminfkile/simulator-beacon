// The leader-only worker loop (simulator-beacon.md 2 and 4). Reads sim_run
// every second, acts on `status` changes, feeds the scheduler's fixes into
// the beacon core, and persists progress: `index` every ten fixes, and
// `leader_state` and `leader_at` every second. When the flights API refuses a
// load the row goes to `failed` with `lastError`.
//
// The worker is deliberately independent of the HTTP server: the control API
// writes the row; the worker sees the change on its next tick. A node that
// loses leadership stops the worker within one tick, and the new leader
// resumes from the persisted `index`.

import type { Db, SimRun, SimRunStatus } from "./db.js";
import type { FlightsCache } from "./flights/cache.js";
import type { LocationRow } from "./flights/api.js";
import { ApiError } from "./flights/api.js";
import {
  ALLOWED_SPEEDS,
  type Scheduler,
  type SchedulerEmit,
  type Speed,
  isSpeed,
  startScheduler,
} from "./flights/scheduler.js";

export interface WorkerEmit {
  point: LocationRow;
  recordedAtNow: string;
}

export interface WorkerOptions {
  db: Db;
  cache: FlightsCache;
  buildLeaderState: () => Record<string, unknown>;
  onEmit: (fix: WorkerEmit) => void;
  onStop: () => void;
  tickMs?: number;
  now?: () => number;
  isoNow?: () => string;
  startScheduler?: typeof startScheduler;
}

export interface WorkerHandle {
  stop(): Promise<void>;
  tick(): Promise<void>;
  runningStatus(): SimRunStatus | null;
  currentIndex(): number;
  currentTotal(): number;
  nextFixInMs(): number | null;
}

interface ActiveRun {
  year: number;
  speed: Speed;
  loop: boolean;
  cycles: number;
  points: LocationRow[];
  scheduler: Scheduler;
  emittedSinceLastPersist: number;
  nextFixInMs: number | null;
}

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const tickMs = opts.tickMs ?? 1000;
  const isoNow = opts.isoNow ?? (() => new Date().toISOString());
  const startSched = opts.startScheduler ?? startScheduler;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  let active: ActiveRun | null = null;
  let lastRunStatus: SimRunStatus | null = null;
  let lastPersistedIndex = 0;

  function persistLeaderState(): Promise<void> {
    const state = opts.buildLeaderState();
    return opts.db.writeLeaderState(state).catch(() => undefined);
  }

  async function persistIndex(index: number): Promise<void> {
    try {
      await opts.db.update({ index });
      lastPersistedIndex = index;
    } catch {
      // Persistence failures are logged upstream; the next tick will retry.
    }
  }

  async function stopActive(): Promise<void> {
    if (!active) return;
    active.scheduler.stop();
    active = null;
    opts.onStop();
  }

  async function handleEmit(e: SchedulerEmit): Promise<void> {
    if (!active) return;
    active.nextFixInMs = e.nextFixInMs;
    opts.onEmit({ point: e.point, recordedAtNow: e.recordedAtNow });
    active.emittedSinceLastPersist += 1;
    // Persist index every ten fixes: `e.index` is the emitted fix, so the
    // resume point after this one is `e.index + 1`. A hand-off during the
    // window between persists skips at most a few points.
    if (active.emittedSinceLastPersist >= 10) {
      active.emittedSinceLastPersist = 0;
      const nextIndex = e.index + 1;
      await persistIndex(nextIndex);
      await opts.db.update({ lastFixAt: e.recordedAtNow }).catch(() => undefined);
    }
  }

  async function handleEnd(): Promise<void> {
    if (!active) return;
    const total = active.points.length;
    // Loop at the end (simulator-beacon.md 4): when `loop` is true (the row's
    // current value), start again from the first point at once with the same
    // year and speed, and bump `cycles` — persisted on the row. When it is
    // false the run stops with the index at the last point.
    if (active.loop) {
      const nextCycles = active.cycles + 1;
      active.cycles = nextCycles;
      active.emittedSinceLastPersist = 0;
      lastPersistedIndex = 0;
      try {
        await opts.db.update({ index: 0, cycles: nextCycles });
      } catch {
        // The next tick will re-read; a failure here does not stop the loop.
      }
      active.scheduler.start(0);
      return;
    }
    active = null;
    try {
      await opts.db.update({ status: "stopped", index: total });
      lastPersistedIndex = total;
      lastRunStatus = "stopped";
    } catch {
      // Ignore; the next tick will re-read.
    }
    opts.onStop();
  }

  async function loadAndStart(row: SimRun): Promise<void> {
    if (row.year == null) {
      await opts.db
        .update({ status: "failed", lastError: "no year" })
        .catch(() => undefined);
      lastRunStatus = "failed";
      return;
    }
    if (!isSpeed(row.speed)) {
      await opts.db
        .update({ status: "failed", lastError: `invalid speed ${row.speed}` })
        .catch(() => undefined);
      lastRunStatus = "failed";
      return;
    }
    let flight;
    try {
      flight = await opts.cache.loadYear(row.year);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.code ?? "api_error"}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      await opts.db
        .update({ status: "failed", lastError: message })
        .catch(() => undefined);
      lastRunStatus = "failed";
      return;
    }
    if (flight.points.length === 0) {
      await opts.db
        .update({ status: "failed", lastError: "no published points" })
        .catch(() => undefined);
      lastRunStatus = "failed";
      return;
    }
    const startIndex = Math.max(0, Math.min(row.index, flight.points.length - 1));
    const scheduler = startSched({
      points: flight.points,
      speed: row.speed as Speed,
      onEmit: (e) => void handleEmit(e),
      onEnd: () => void handleEnd(),
      isoNow,
    });
    active = {
      year: row.year,
      speed: row.speed as Speed,
      loop: row.loop,
      cycles: row.cycles,
      points: flight.points,
      scheduler,
      emittedSinceLastPersist: 0,
      nextFixInMs: null,
    };
    lastPersistedIndex = startIndex;
    await opts.db
      .update({
        status: "running",
        total: flight.points.length,
        index: startIndex,
        startedAt: isoNow(),
        lastError: null,
      })
      .catch(() => undefined);
    lastRunStatus = "running";
    scheduler.start(startIndex);
  }

  function tick(): Promise<void> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
      if (stopped) return;
      let row: SimRun;
      try {
        row = await opts.db.read();
      } catch {
        return;
      }
      await persistLeaderState();
      const prev = lastRunStatus;
      lastRunStatus = row.status;
      if (row.status === "stopped" || row.status === "failed") {
        if (active) await stopActive();
        return;
      }
      if (row.status === "loading" && prev !== "loading") {
        if (active) await stopActive();
        await loadAndStart(row);
        return;
      }
      if (row.status === "running") {
        // The API writes `loading` and the worker flips to `running`; a row
        // directly at `running` on the first tick after a leader hand-off is
        // the resume case.
        if (!active) {
          const patched: SimRun = { ...row, status: "loading" };
          await loadAndStart(patched);
          return;
        }
        // Compare the row with what is running and apply per section 4:
        // a new year stops the active run and restarts from the first point;
        // a new speed re-times the next delay in place; a new loop applies at
        // the next end. Cycles is authoritative on the row so a follower
        // taking over never regresses it.
        if (row.year != null && row.year !== active.year) {
          await stopActive();
          const patched: SimRun = { ...row, index: 0, cycles: 0 };
          await opts.db.update({ index: 0, cycles: 0 }).catch(() => undefined);
          await loadAndStart(patched);
          return;
        }
        if (isSpeed(row.speed) && (row.speed as Speed) !== active.speed) {
          active.speed = row.speed as Speed;
          active.scheduler.setSpeed(row.speed as Speed);
        }
        if (row.loop !== active.loop) {
          active.loop = row.loop;
        }
        if (row.cycles !== active.cycles) {
          active.cycles = row.cycles;
        }
        return;
      }
    })().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        await tick();
        schedule();
      })();
    }, tickMs);
  }

  // The first tick fires after `tickMs`, matching the recurring cadence. A
  // hand-off gains at most a second; the resume path (running row without an
  // active scheduler) will load the flight on the first tick.
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active) {
        active.scheduler.stop();
        active = null;
      }
    },
    tick,
    runningStatus: () => lastRunStatus,
    currentIndex: () => active?.scheduler.currentIndex() ?? lastPersistedIndex,
    currentTotal: () => active?.points.length ?? 0,
    nextFixInMs: () => active?.nextFixInMs ?? null,
  };
}

export function isAllowedSpeed(v: unknown): v is Speed {
  return (
    typeof v === "number" && (ALLOWED_SPEEDS as readonly number[]).includes(v)
  );
}
