// The leader-only worker loop (simulator-beacon.md 2 and 4). Reads the run on
// its tick, acts on `status` changes, feeds the scheduler's fixes into the
// beacon core, and persists progress: the leader state together with the
// run's `index` (the resume point) and `lastFixAt`, in one document write
// about once a second.
//
// The tick is 250 ms (simulator-beacon.md 2), so a control change lands within
// a quarter second; the leader state is written on every fourth tick (about
// once a second) and immediately after a status change the worker made. The
// read on each tick answers from the node's copy of the state document,
// reloaded when it is older than 250 ms.
//
// Every scheduler callback is wrapped so an exception is logged and never
// escapes. A Stop can land while an end-of-run write is in flight, so handlers
// capture the active run at the top and return when it has changed after any
// await.
//
// While a run is running, or stopped with a year on the run, the worker asks
// the cache at most once every 60 s whether `GET /admin/events` still holds an
// event for the run's year. The check runs beside the tick, never inside it;
// when the year is gone the next tick fails the run with `no event for year
// <year>`. A failed check changes nothing and is tried again at the next 60 s
// mark (simulator-beacon.md 4).
//
// The worker is deliberately independent of the HTTP server: the control API
// writes the run; the worker sees the change on its next tick. A node that
// loses leadership stops the worker within one tick, and the new leader
// resumes from the persisted `index`.

import type { Db, SimRun, SimRunStatus } from "./runStore.js";
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
  warn?: (obj: Record<string, unknown>, msg: string) => void;
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
  lastFixAt: string | null;
  nextFixInMs: number | null;
}

// A flight load that fails for a transient reason (the API unreachable, 408,
// 429, or a 5xx) keeps the run at loading with the reason in lastError and
// retries on this schedule; the tail repeats 5000 ms forever
// (simulator-beacon.md 4).
const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 5000];
const RETRY_DELAY_TAIL_MS = 5000;

function nextRetryDelayMs(attempt: number): number {
  return attempt <= RETRY_DELAYS_MS.length
    ? RETRY_DELAYS_MS[attempt - 1]!
    : RETRY_DELAY_TAIL_MS;
}

// How often the leader re-checks that the run's year still has an event.
const YEAR_CHECK_INTERVAL_MS = 60_000;

// The cache throws a plain Error with `code = "unknown_year"` when no event
// exists for the year; that is permanent, like a 4xx.
function isUnknownYearError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: unknown }).code === "unknown_year"
  );
}

function noEventMessage(year: number): string {
  return `no event for year ${year}`;
}

function isTransientLoadError(err: unknown): boolean {
  if (isUnknownYearError(err)) return false;
  if (!(err instanceof ApiError)) return true;
  const s = err.status;
  if (s == null) return true;
  if (s === 408 || s === 429) return true;
  if (s >= 500) return true;
  return false;
}

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const tickMs = opts.tickMs ?? 250;
  const persistEvery = Math.max(1, opts.persistLeaderStateEveryTicks ?? 4);
  const isoNow = opts.isoNow ?? (() => new Date().toISOString());
  const now = opts.now ?? (() => Date.now());
  const startSched = opts.startScheduler ?? startScheduler;
  const log = opts.log;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  let active: ActiveRun | null = null;
  let lastRunStatus: SimRunStatus | null = null;
  let lastPersistedIndex = 0;
  let ticksSinceLeaderStateWrite = 0;
  // Pending retry for a transient flight-load failure. When the run is still
  // `loading` with no active scheduler and `now() >= pendingRetryAt`, the tick
  // calls loadAndStart again with the run's current index. The counter resets
  // on a successful load, on a year change, and on a `stopped` run.
  let pendingRetryAt: number | null = null;
  let retryAttempt = 0;
  let retryYear: number | null = null;
  // The year check: when the last one started (or a load last confirmed the
  // year), whether one is in flight, and a year a check found gone, which the
  // next tick acts on.
  let yearCheckAt = now();
  let yearCheckInFlight = false;
  let goneYear: number | null = null;

  function resetLoadRetry(): void {
    pendingRetryAt = null;
    retryAttempt = 0;
    retryYear = null;
  }

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

  // Writes the leader state and, while a run is active, its resume point
  // (the scheduler's next index) and lastFixAt in the same write. A failure is
  // logged and the next cadence write tries again.
  async function persistLeaderState(): Promise<void> {
    const run = active;
    const progress = run
      ? { year: run.year, index: run.scheduler.currentIndex(), lastFixAt: run.lastFixAt }
      : undefined;
    try {
      await opts.db.writeLeaderState(buildLeaderPayload(), progress);
      ticksSinceLeaderStateWrite = 0;
      if (progress && active === run) lastPersistedIndex = progress.index;
    } catch (err) {
      logError(err, "writeLeaderState");
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
    // The index and lastFixAt reach the document with the next leader state
    // write (about once a second), so a hand-off resumes within about a
    // second of the last fix.
    run.lastFixAt = e.recordedAtNow;
  }

  async function handleEnd(): Promise<void> {
    const run = active;
    if (!run) return;
    const total = run.points.length;
    // Loop at the end (simulator-beacon.md 4): when `loop` is true (the run's
    // current value), start again from the first point at once with the same
    // year and speed, and bump `cycles`, persisted on the run. When it is
    // false the run stops with the index at the last point.
    if (run.loop) {
      const nextCycles = run.cycles + 1;
      run.cycles = nextCycles;
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
    // A status change the worker made: persist the leader state immediately.
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
      resetLoadRetry();
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
      resetLoadRetry();
      await persistLeaderState();
      return;
    }
    let flight;
    try {
      flight = await opts.cache.loadYear(row.year);
    } catch (err) {
      const message = isUnknownYearError(err)
        ? noEventMessage(row.year)
        : err instanceof ApiError
          ? `${err.code ?? "api_error"}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      if (isTransientLoadError(err)) {
        // The run stays at loading with lastError set so the control page shows
        // why; the tick retries after the backoff delay.
        retryAttempt += 1;
        const delay = nextRetryDelayMs(retryAttempt);
        pendingRetryAt = now() + delay;
        retryYear = row.year;
        try {
          await opts.db.update({ status: "loading", lastError: message });
        } catch (dbErr) {
          logError(dbErr, "update loading(transient)");
        }
        lastRunStatus = "loading";
        if (log?.warn) {
          try {
            log.warn(
              { year: row.year, err: message, delayMs: delay },
              "flight load failed; retrying",
            );
          } catch {
            // A logger throw must not escape into the loop.
          }
        }
        await persistLeaderState();
        return;
      }
      try {
        await opts.db.update({ status: "failed", lastError: message });
      } catch (dbErr) {
        logError(dbErr, "update failed(load)");
      }
      lastRunStatus = "failed";
      resetLoadRetry();
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
      resetLoadRetry();
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
      lastFixAt: null,
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
    resetLoadRetry();
    yearCheckAt = now();
    goneYear = null;
    scheduler.start(startIndex);
    // A status change the worker made: persist the leader state immediately.
    await persistLeaderState();
  }

  async function failMissingYear(year: number): Promise<void> {
    if (active) await stopActive();
    resetLoadRetry();
    try {
      await opts.db.update({ status: "failed", lastError: noEventMessage(year) });
    } catch (err) {
      logError(err, "update failed(no event)", { year });
    }
    lastRunStatus = "failed";
    // A status change the worker made: persist the leader state immediately.
    await persistLeaderState();
  }

  function maybeCheckYear(row: SimRun): void {
    if (yearCheckInFlight || row.year == null) return;
    const eligible =
      (row.status === "running" && active != null) || row.status === "stopped";
    if (!eligible) return;
    if (now() - yearCheckAt < YEAR_CHECK_INTERVAL_MS) return;
    const year = row.year;
    yearCheckAt = now();
    yearCheckInFlight = true;
    opts.cache
      .hasYear(year)
      .then(
        (present) => {
          if (!present && !stopped) goneYear = year;
        },
        (err) => {
          // A failed check (network, 5xx, 408, 429, or anything else) changes
          // nothing; the next 60 s mark tries again.
          if (!log?.warn) return;
          try {
            log.warn(
              { year, err: err instanceof Error ? err.message : String(err) },
              "year check failed; retrying at the next mark",
            );
          } catch {
            // A logger throw must not escape into the loop.
          }
        },
      )
      .finally(() => {
        yearCheckInFlight = false;
      });
  }

  async function handleSeek(row: SimRun): Promise<boolean> {
    // A seek request the operator dropped on the run (simulator-beacon.md 4).
    // A drag leaves the latest one standing: the conditional clear only wins
    // when seekTo is still the value we acted on. Returns true when the
    // handler owned the tick (skip the cadence-based writes below).
    if (row.seekTo == null) return false;
    const seekTo = row.seekTo;
    if (row.status === "loading") {
      // The flight is still loading: the request waits on the run and the
      // first running tick applies it (a drag right after Start).
      return false;
    }
    if (row.status === "failed") {
      // No emit and no index write: the request is dropped.
      try {
        await opts.db.dropSeek(seekTo);
      } catch (err) {
        logError(err, "dropSeek(failed)", { seekTo });
      }
      return true;
    }
    if (row.status === "running") {
      // Running with an active scheduler: re-arm at the clamped index. The
      // scheduler emits the point at once and continues at the run's speed
      // (simulator-beacon.md 4).
      if (!active) return false;
      const idx = Math.max(0, Math.min(seekTo, active.points.length - 1));
      active.scheduler.start(idx);
      lastPersistedIndex = idx;
      try {
        await opts.db.clearSeekAndSetIndex(seekTo);
      } catch (err) {
        logError(err, "clearSeekAndSetIndex(running)", { seekTo });
      }
      return true;
    }
    // Stopped with a year on the run: peek at that point through onEmit and
    // persist the index; the status stays stopped so Start resumes from
    // there.
    if (row.status === "stopped" && row.year != null) {
      let flight;
      try {
        flight = await opts.cache.getOrLoadYear(row.year);
      } catch (err) {
        logError(err, "getOrLoadYear(peek)", { year: row.year, seekTo });
        try {
          await opts.db.dropSeek(seekTo);
        } catch (dbErr) {
          logError(dbErr, "dropSeek(peek load failure)", { seekTo });
        }
        return true;
      }
      if (flight.points.length === 0) {
        try {
          await opts.db.dropSeek(seekTo);
        } catch (err) {
          logError(err, "dropSeek(peek no points)", { seekTo });
        }
        return true;
      }
      const idx = Math.max(0, Math.min(seekTo, flight.points.length - 1));
      const point = flight.points[idx]!;
      try {
        opts.onEmit({ point, recordedAtNow: isoNow() });
      } catch (err) {
        logError(err, "onEmit(peek)", { year: row.year, index: idx });
      }
      lastPersistedIndex = idx;
      try {
        await opts.db.clearSeekAndSetIndex(seekTo);
      } catch (err) {
        logError(err, "clearSeekAndSetIndex(peek)", { seekTo });
      }
      return true;
    }
    // Any other combination (stopped with no year): drop the seek.
    try {
      await opts.db.dropSeek(seekTo);
    } catch (err) {
      logError(err, "dropSeek(no year)", { seekTo });
    }
    return true;
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
      if (goneYear != null) {
        // A year check found the run's year gone: a running or stopped run
        // for that year fails; anything else (a new year, a Start that is
        // loading, a failed run) has moved on.
        const year = goneYear;
        goneYear = null;
        if (
          row.year === year &&
          (row.status === "running" || row.status === "stopped")
        ) {
          await failMissingYear(year);
          return;
        }
      }
      let workerChangedStatus = false;
      if (row.status === "stopped" || row.status === "failed") {
        if (active) await stopActive();
        // A stopped or failed run clears any pending retry from a transient
        // flight-load failure so an operator's Stop during the wait wins at
        // once.
        resetLoadRetry();
      } else if (row.status === "loading" && prev !== "loading") {
        if (active) await stopActive();
        resetLoadRetry();
        await loadAndStart(row);
        // loadAndStart flipped the run's status (running or failed) itself
        // and persisted the leader state; skip the cadence-based write below.
        return;
      } else if (row.status === "loading" && !active) {
        // Still loading after a transient flight-load failure: retry when the
        // backoff delay has elapsed, or right away if the run's year changed
        // during the wait.
        if (row.year !== retryYear) {
          resetLoadRetry();
          await loadAndStart(row);
          return;
        }
        if (pendingRetryAt != null && now() >= pendingRetryAt) {
          await loadAndStart(row);
          return;
        }
      } else if (row.status === "running") {
        // The API writes `loading` and the worker flips to `running`; a run
        // directly at `running` on the first tick after a leader hand-off is
        // the resume case.
        if (!active) {
          const patched: SimRun = { ...row, status: "loading" };
          await loadAndStart(patched);
          return;
        }
        // Compare the run with what is running and apply per section 4:
        // a new year stops the active run and restarts from the first point;
        // a new speed re-times the next delay in place; a new loop applies at
        // the next end. Cycles is authoritative on the run so a follower
        // taking over never regresses it.
        if (row.year != null && row.year !== active.year) {
          await stopActive();
          const patched: SimRun = { ...row, index: 0, cycles: 0 };
          try {
            await opts.db.update({ index: 0, cycles: 0 });
          } catch (err) {
            logError(err, "update year switch");
          }
          resetLoadRetry();
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
      // A seek queued on the run (simulator-beacon.md 4): running re-arms the
      // scheduler; stopped emits one point through onEmit and stays stopped so
      // Start resumes from there; loading keeps it for the first running
      // tick; failed drops it.
      if (row.seekTo != null) {
        await handleSeek(row);
      }
      maybeCheckYear(row);
      // Cadence: write the leader state every `persistEvery` ticks (about once a
      // second at tickMs=250), or immediately after a status change the worker
      // made (loadAndStart and handleEnd persist inline; the fall-through case
      // here is stopActive on a stop written on the run, which also counts).
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
  // hand-off gains at most a quarter second; the resume path (running run
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
