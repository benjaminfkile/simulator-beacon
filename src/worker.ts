// The leader-only worker loop (simulator-beacon.md 2 and 4). Reads sim_run on
// its tick, acts on `status` changes, feeds the scheduler's fixes into the
// beacon core, and persists progress: `index` every ten fixes (the resume
// point), `leader_state` and `leader_at` about once a second.
//
// The tick is 250 ms (simulator-beacon.md 2), so a control change lands within
// a quarter second; leader_state is written on every fourth tick (about once a
// second) and immediately after a status change the worker made. The row read
// is a single indexed select per tick.
//
// Every scheduler callback is wrapped so an exception is logged and never
// escapes — a Stop pressed while the last point goes out that races with the
// end-of-run write once nulled `active` mid-await, and the resulting
// unhandledRejection killed the process. Handlers capture the active run at
// the top and return when it has changed after any await.
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

export interface WorkerLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface WorkerOptions {
  db: Db;
  cache: FlightsCache;
  buildLeaderState: () => Record<string, unknown>;
  onEmit: (fix: WorkerEmit) => void;
  onStop: () => void;
  tickMs?: number;
  persistLeaderStateEveryTicks?: number;
  now?: () => number;
  isoNow?: () => string;
  startScheduler?: typeof startScheduler;
  log?: WorkerLogger;
}

export interface WorkerHandle {
  stop(): Promise<void>;
  tick(): Promise<void>;
  runningStatus(): SimRunStatus | null;
  currentIndex(): number;
  currentTotal(): number;
  currentCycles(): number;
  currentSpeed(): number;
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
  const tickMs = opts.tickMs ?? 250;
  const persistEvery = Math.max(1, opts.persistLeaderStateEveryTicks ?? 4);
  const isoNow = opts.isoNow ?? (() => new Date().toISOString());
  const startSched = opts.startScheduler ?? startScheduler;
  const log = opts.log;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  let active: ActiveRun | null = null;
  let lastRunStatus: SimRunStatus | null = null;
  let lastPersistedIndex = 0;
  let ticksSinceLeaderStateWrite = 0;

  function logError(err: unknown, where: string, extra: Record<string, unknown> = {}): void {
    if (!log) return;
    try {
      log.error(
        {
          ...extra,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        `worker: ${where} threw`,
      );
    } catch {
      // A logger throw must not escape into the loop.
    }
  }

  function buildLeaderPayload(): Record<string, unknown> {
    const base = opts.buildLeaderState();
    const run = {
      status: lastRunStatus,
      index: active?.scheduler.currentIndex() ?? lastPersistedIndex,
      cycles: active?.cycles ?? 0,
      speed: active?.speed ?? 0,
      nextFixInMs: active?.nextFixInMs ?? null,
    };
    return { ...base, run };
  }

  async function persistLeaderState(): Promise<void> {
    try {
      await opts.db.writeLeaderState(buildLeaderPayload());
      ticksSinceLeaderStateWrite = 0;
    } catch (err) {
      logError(err, "writeLeaderState");
    }
  }

  async function persistIndex(index: number): Promise<void> {
    try {
      await opts.db.update({ index });
      lastPersistedIndex = index;
    } catch (err) {
      // Persistence failures are logged; the next tick will retry.
      logError(err, "persistIndex", { index });
    }
  }

  async function stopActive(): Promise<void> {
    if (!active) return;
    active.scheduler.stop();
    active = null;
    try {
      opts.onStop();
    } catch (err) {
      logError(err, "onStop");
    }
  }

  async function handleEmit(e: SchedulerEmit): Promise<void> {
    const run = active;
    if (!run) return;
    run.nextFixInMs = e.nextFixInMs;
    try {
      opts.onEmit({ point: e.point, recordedAtNow: e.recordedAtNow });
    } catch (err) {
      logError(err, "onEmit", { year: run.year, index: e.index });
    }
    run.emittedSinceLastPersist += 1;
    // Persist index every ten fixes: `e.index` is the emitted fix, so the
    // resume point after this one is `e.index + 1`. A hand-off during the
    // window between persists skips at most a few points.
    if (run.emittedSinceLastPersist >= 10) {
      run.emittedSinceLastPersist = 0;
      const nextIndex = e.index + 1;
      await persistIndex(nextIndex);
      if (active !== run) return;
      try {
        await opts.db.update({ lastFixAt: e.recordedAtNow });
      } catch (err) {
        logError(err, "update lastFixAt");
      }
    }
  }

  async function handleEnd(): Promise<void> {
    const run = active;
    if (!run) return;
    const total = run.points.length;
    // Loop at the end (simulator-beacon.md 4): when `loop` is true (the row's
    // current value), start again from the first point at once with the same
    // year and speed, and bump `cycles` — persisted on the row. When it is
    // false the run stops with the index at the last point.
    if (run.loop) {
      const nextCycles = run.cycles + 1;
      run.cycles = nextCycles;
      run.emittedSinceLastPersist = 0;
      lastPersistedIndex = 0;
      try {
        await opts.db.update({ index: 0, cycles: nextCycles });
      } catch (err) {
        logError(err, "update loop restart");
      }
      if (active !== run) return;
      run.scheduler.start(0);
      return;
    }
    active = null;
    try {
      await opts.db.update({ status: "stopped", index: total });
      lastPersistedIndex = total;
      lastRunStatus = "stopped";
    } catch (err) {
      logError(err, "update end-of-run");
    }
    try {
      opts.onStop();
    } catch (err) {
      logError(err, "onStop");
    }
    // A status change the worker made: persist leader_state immediately.
    await persistLeaderState();
  }

  async function loadAndStart(row: SimRun): Promise<void> {
    if (row.year == null) {
      try {
        await opts.db.update({ status: "failed", lastError: "no year" });
      } catch (err) {
        logError(err, "update failed(no year)");
      }
      lastRunStatus = "failed";
      await persistLeaderState();
      return;
    }
    if (!isSpeed(row.speed)) {
      try {
        await opts.db.update({ status: "failed", lastError: `invalid speed ${row.speed}` });
      } catch (err) {
        logError(err, "update failed(bad speed)");
      }
      lastRunStatus = "failed";
      await persistLeaderState();
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
      try {
        await opts.db.update({ status: "failed", lastError: message });
      } catch (dbErr) {
        logError(dbErr, "update failed(load)");
      }
      lastRunStatus = "failed";
      await persistLeaderState();
      return;
    }
    if (flight.points.length === 0) {
      try {
        await opts.db.update({ status: "failed", lastError: "no published points" });
      } catch (err) {
        logError(err, "update failed(no points)");
      }
      lastRunStatus = "failed";
      await persistLeaderState();
      return;
    }
    const startIndex = Math.max(0, Math.min(row.index, flight.points.length - 1));
    const scheduler = startSched({
      points: flight.points,
      speed: row.speed as Speed,
      onEmit: (e) => {
        handleEmit(e).catch((err) =>
          logError(err, "handleEmit", { year: row.year, index: e.index }),
        );
      },
      onEnd: () => {
        handleEnd().catch((err) =>
          logError(err, "handleEnd", { year: row.year }),
        );
      },
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
    try {
      await opts.db.update({
        status: "running",
        total: flight.points.length,
        index: startIndex,
        startedAt: isoNow(),
        lastError: null,
      });
    } catch (err) {
      logError(err, "update running");
    }
    lastRunStatus = "running";
    scheduler.start(startIndex);
    // A status change the worker made: persist leader_state immediately.
    await persistLeaderState();
  }

  function tick(): Promise<void> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
      if (stopped) return;
      let row: SimRun;
      try {
        row = await opts.db.read();
      } catch (err) {
        logError(err, "read");
        return;
      }
      ticksSinceLeaderStateWrite += 1;
      const prev = lastRunStatus;
      lastRunStatus = row.status;
      let workerChangedStatus = false;
      if (row.status === "stopped" || row.status === "failed") {
        if (active) await stopActive();
      } else if (row.status === "loading" && prev !== "loading") {
        if (active) await stopActive();
        await loadAndStart(row);
        // loadAndStart flipped the row's status (running or failed) itself
        // and persisted leader_state; skip the cadence-based write below.
        return;
      } else if (row.status === "running") {
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
          try {
            await opts.db.update({ index: 0, cycles: 0 });
          } catch (err) {
            logError(err, "update year switch");
          }
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
      }
      // Cadence: write leader_state every `persistEvery` ticks (about once a
      // second at tickMs=250), or immediately after a status change the worker
      // made (loadAndStart and handleEnd persist inline; the fall-through case
      // here is stopActive on a row-driven stop, which also counts).
      if (
        (prev === "running" || prev === "loading") &&
        (row.status === "stopped" || row.status === "failed")
      ) {
        workerChangedStatus = true;
      }
      if (workerChangedStatus || ticksSinceLeaderStateWrite >= persistEvery) {
        await persistLeaderState();
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
        try {
          await tick();
        } catch (err) {
          logError(err, "tick");
        }
        schedule();
      })();
    }, tickMs);
  }

  // The first tick fires after `tickMs`, matching the recurring cadence. A
  // hand-off gains at most a quarter second; the resume path (running row
  // without an active scheduler) will load the flight on the first tick.
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
    currentCycles: () => active?.cycles ?? 0,
    currentSpeed: () => active?.speed ?? 0,
    nextFixInMs: () => active?.nextFixInMs ?? null,
  };
}

export function isAllowedSpeed(v: unknown): v is Speed {
  return (
    typeof v === "number" && (ALLOWED_SPEEDS as readonly number[]).includes(v)
  );
}
