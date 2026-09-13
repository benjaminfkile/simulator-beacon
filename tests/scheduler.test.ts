// Scheduler timing per simulator-beacon.md 4: inter-point delays divided by
// speed, the 100 ms floor and 30 s ceiling, the first fix immediate, stop at
// the end, restart from zero, recordedAt is now.

import { describe, expect, it } from "vitest";
import {
  ALLOWED_SPEEDS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  computeAllIntervals,
  intervalMs,
  startScheduler,
} from "../src/flights/scheduler.js";
import type { LocationRow } from "../src/flights/api.js";

function makePoints(times: string[]): LocationRow[] {
  return times.map((t, i) => ({
    seq: i + 1,
    recordedAt: t,
    lat: 46 + i * 0.001,
    lng: -114 - i * 0.001,
    speedMps: null,
    altitudeM: null,
    headingDeg: null,
    accuracyM: null,
  }));
}

describe("scheduler timing (simulator-beacon.md 4)", () => {
  it("permits only the six speeds", () => {
    expect(ALLOWED_SPEEDS).toEqual([1, 2, 5, 10, 20, 60]);
  });

  it("emits the first fix immediately (index 0 -> 0 ms)", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:30.000Z",
    ]);
    expect(intervalMs(points, 0, 1)).toBe(0);
  });

  it("divides the recorded delay by the speed", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:10.000Z", // 10 s later
    ]);
    expect(intervalMs(points, 1, 1)).toBe(10_000);
    expect(intervalMs(points, 1, 2)).toBe(5_000);
    expect(intervalMs(points, 1, 5)).toBe(2_000);
    expect(intervalMs(points, 1, 10)).toBe(1_000);
    expect(intervalMs(points, 1, 20)).toBe(500);
    expect(intervalMs(points, 1, 60)).toBe(Math.round(10_000 / 60));
  });

  it("clamps a sub-100-ms gap to 100 ms", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.005Z",
    ]);
    expect(intervalMs(points, 1, 1)).toBe(MIN_INTERVAL_MS);
    // Also at high speeds the floor applies.
    expect(intervalMs(points, 1, 60)).toBe(MIN_INTERVAL_MS);
  });

  it("clamps a >30 s gap at speed 1 to 30 s", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T01:00:00.000Z", // 1 h later
    ]);
    expect(intervalMs(points, 1, 1)).toBe(MAX_INTERVAL_MS);
    // At higher speeds a 1 h gap still hits the ceiling until it collapses
    // below it: 3600 s / 60 = 60 s → clamped to 30 s.
    expect(intervalMs(points, 1, 60)).toBe(MAX_INTERVAL_MS);
  });

  it("computes the full interval table", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z", // 0
      "2025-01-01T00:00:02.000Z", // +2 s → 2000 ms
      "2025-01-01T00:00:02.010Z", // +10 ms → 100 ms (floor)
      "2025-01-01T01:00:00.000Z", // ~1 h later → 30 s (ceil)
    ]);
    const table = computeAllIntervals(points, 1);
    expect(table).toEqual([0, 2000, MIN_INTERVAL_MS, MAX_INTERVAL_MS]);
  });

  it("emits index 0 at once and stops at the end", () => {
    const times = [
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:01.000Z",
      "2025-01-01T00:00:02.000Z",
    ];
    const points = makePoints(times);
    let clock = 0;
    const isoValue = "2025-06-01T00:00:00.000Z";
    const pending: Array<{ ms: number; fn: () => void }> = [];
    const emits: Array<{ index: number; recordedAtNow: string; nextFixInMs: number | null }> = [];
    let ended = false;

    const sched = startScheduler({
      points,
      speed: 1,
      onEmit: (e) =>
        emits.push({ index: e.index, recordedAtNow: e.recordedAtNow, nextFixInMs: e.nextFixInMs }),
      onEnd: () => (ended = true),
      now: () => clock,
      isoNow: () => isoValue,
      setTimer: (fn, ms) => {
        const h = { ms, fn };
        pending.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { ms: number; fn: () => void });
        if (i >= 0) pending.splice(i, 1);
      },
    });

    sched.start(0);
    // The first schedule call is 0 ms.
    expect(pending.length).toBe(1);
    expect(pending[0]!.ms).toBe(0);
    const first = pending.shift()!;
    first.fn();
    expect(emits.length).toBe(1);
    expect(emits[0]!.index).toBe(0);
    expect(emits[0]!.recordedAtNow).toBe(isoValue);
    expect(emits[0]!.nextFixInMs).toBe(1000);

    // Next timer is 1000 ms for index 1.
    expect(pending.length).toBe(1);
    expect(pending[0]!.ms).toBe(1000);
    pending.shift()!.fn();
    expect(emits[1]!.index).toBe(1);

    // Then 1000 ms for index 2 (the last).
    expect(pending.length).toBe(1);
    expect(pending[0]!.ms).toBe(1000);
    pending.shift()!.fn();
    expect(emits[2]!.index).toBe(2);
    expect(emits[2]!.nextFixInMs).toBeNull();
    expect(ended).toBe(true);
    expect(pending.length).toBe(0);
  });

  it("restart begins again from the requested index", () => {
    const points = makePoints([
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:01.000Z",
    ]);
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const emits: number[] = [];
    const sched = startScheduler({
      points,
      speed: 1,
      onEmit: (e) => emits.push(e.index),
      onEnd: () => undefined,
      setTimer: (fn, ms) => {
        const h = { fn, ms };
        pending.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; ms: number });
        if (i >= 0) pending.splice(i, 1);
      },
    });
    sched.start(0);
    pending.shift()!.fn(); // 0
    expect(emits).toEqual([0]);
    // Re-arm from index 1 without running the second emit.
    sched.start(1);
    pending.shift()!.fn(); // Immediate emit at index 1.
    expect(emits).toEqual([0, 1]);
  });
});
