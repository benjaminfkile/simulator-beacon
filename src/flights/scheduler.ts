// The replay scheduler (simulator-beacon.md 4). Inputs are the points in `seq`
// order with their `recordedAt`, a speed s in { 1, 2, 5, 10, 20, 60 }, and a
// starting index. Output: fix i is emitted `(recordedAt[i] - recordedAt[i-1]) / s`
// after fix i-1, clamped to [100 ms, 30 s]; the first fix (at whatever the
// starting index is) is emitted immediately.
//
// The scheduler is pure timing plus a subscribe hook: the caller runs a
// per-fix callback that carries the point plus `recordedAt = now()` (the API
// stores what the beacon says and the tracker shows the current position; a
// replay is a flight happening now). At the end the scheduler notifies once
// with `end: true` and does not emit anything else; `start(index)` resets it
// and re-arms from that point.

import type { LocationRow } from "./api.js";

export const ALLOWED_SPEEDS = [1, 2, 5, 10, 20, 60] as const;
export type Speed = (typeof ALLOWED_SPEEDS)[number];

export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 30_000;

export interface SchedulerEmit {
  index: number;
  point: LocationRow;
  recordedAtNow: string;
  nextFixInMs: number | null;
}

export interface SchedulerOptions {
  points: LocationRow[];
  speed: Speed;
  onEmit: (e: SchedulerEmit) => void;
  onEnd: () => void;
  now?: () => number;
  isoNow?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Scheduler {
  start(index: number): void;
  stop(): void;
  running(): boolean;
  currentIndex(): number;
  computeIntervals(): number[];
}

export function isSpeed(v: unknown): v is Speed {
  return typeof v === "number" && (ALLOWED_SPEEDS as readonly number[]).includes(v);
}

// Returns the delay (ms) that separates fix i from fix i-1, clamped to
// [MIN_INTERVAL_MS, MAX_INTERVAL_MS] and divided by the given speed. Index 0
// always returns 0 (the first emit is immediate).
export function intervalMs(points: LocationRow[], i: number, speed: Speed): number {
  if (i <= 0) return 0;
  const prev = points[i - 1];
  const cur = points[i];
  if (!prev || !cur) return MIN_INTERVAL_MS;
  const prevMs = Date.parse(prev.recordedAt);
  const curMs = Date.parse(cur.recordedAt);
  if (!Number.isFinite(prevMs) || !Number.isFinite(curMs)) return MIN_INTERVAL_MS;
  const raw = (curMs - prevMs) / speed;
  if (!Number.isFinite(raw) || raw <= MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  if (raw >= MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return Math.round(raw);
}

export function computeAllIntervals(points: LocationRow[], speed: Speed): number[] {
  const out: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = intervalMs(points, i, speed);
  return out;
}

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? (() => Date.now());
  const isoNow = opts.isoNow ?? (() => new Date(now()).toISOString());
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let index = 0;
  let running = false;

  function schedule(delay: number, fn: () => void): void {
    if (timer) clearTimer(timer);
    timer = setTimer(fn, Math.max(0, delay));
  }

  function tick(): void {
    if (!running) return;
    const p = opts.points[index];
    if (!p) {
      running = false;
      timer = null;
      opts.onEnd();
      return;
    }
    const nextIndex = index + 1;
    const nextFix = opts.points[nextIndex];
    const nextInMs = nextFix ? intervalMs(opts.points, nextIndex, opts.speed) : null;
    opts.onEmit({
      index,
      point: p,
      recordedAtNow: isoNow(),
      nextFixInMs: nextInMs,
    });
    index = nextIndex;
    if (!nextFix) {
      running = false;
      timer = null;
      opts.onEnd();
      return;
    }
    schedule(nextInMs ?? MIN_INTERVAL_MS, tick);
  }

  function start(from: number): void {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (opts.points.length === 0) {
      running = false;
      opts.onEnd();
      return;
    }
    index = Math.max(0, Math.min(from, opts.points.length));
    if (index >= opts.points.length) {
      running = false;
      opts.onEnd();
      return;
    }
    running = true;
    // First fix is immediate whatever the starting index.
    schedule(0, tick);
  }

  function stop(): void {
    running = false;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    running: () => running,
    currentIndex: () => index,
    computeIntervals: () => computeAllIntervals(opts.points, opts.speed),
  };
}
