// Pure helpers for the timeline chart (simulator-beacon.md 5). Extracted so
// the maths can be unit tested without a DOM.

import type { FlightSeriesPoint } from "./types.js";

export const MPS_TO_MPH = 2.23694;
export const M_TO_FT = 3.28084;

export interface Bucket {
  x: number;
  tMinMs: number;
  tMaxMs: number;
  speedMinMph: number | null;
  speedMaxMph: number | null;
  altMinFt: number | null;
  altMaxFt: number | null;
  iMin: number;
  iMax: number;
}

// Downsample the points to at most one bucket per horizontal pixel column.
// For each bucket keep the min and max of speed and altitude so a spike
// survives the round trip.
export function downsample(
  points: readonly FlightSeriesPoint[],
  width: number,
  durationMs: number,
): Bucket[] {
  if (points.length === 0 || width <= 0 || durationMs <= 0) return [];
  const buckets = new Map<number, Bucket>();
  for (const p of points) {
    const frac = p.t / durationMs;
    const col = Math.max(0, Math.min(width - 1, Math.round(frac * (width - 1))));
    const speedMph = p.speedMps != null ? p.speedMps * MPS_TO_MPH : null;
    const altFt = p.altitudeM != null ? p.altitudeM * M_TO_FT : null;
    const existing = buckets.get(col);
    if (!existing) {
      buckets.set(col, {
        x: col,
        tMinMs: p.t,
        tMaxMs: p.t,
        speedMinMph: speedMph,
        speedMaxMph: speedMph,
        altMinFt: altFt,
        altMaxFt: altFt,
        iMin: p.i,
        iMax: p.i,
      });
    } else {
      if (p.t < existing.tMinMs) existing.tMinMs = p.t;
      if (p.t > existing.tMaxMs) existing.tMaxMs = p.t;
      if (speedMph != null) {
        if (existing.speedMinMph == null || speedMph < existing.speedMinMph)
          existing.speedMinMph = speedMph;
        if (existing.speedMaxMph == null || speedMph > existing.speedMaxMph)
          existing.speedMaxMph = speedMph;
      }
      if (altFt != null) {
        if (existing.altMinFt == null || altFt < existing.altMinFt)
          existing.altMinFt = altFt;
        if (existing.altMaxFt == null || altFt > existing.altMaxFt)
          existing.altMaxFt = altFt;
      }
      if (p.i < existing.iMin) existing.iMin = p.i;
      if (p.i > existing.iMax) existing.iMax = p.i;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.x - b.x);
}

// Map a point index to its x pixel (0 to width-1). The mapping goes through
// the point's recorded time so a stalled span reads narrow on the chart.
export function indexToX(
  points: readonly FlightSeriesPoint[],
  index: number,
  width: number,
  durationMs: number,
): number {
  if (points.length === 0 || width <= 0) return 0;
  const clamped = Math.max(0, Math.min(points.length - 1, Math.floor(index)));
  const p = points[clamped]!;
  if (durationMs <= 0) return 0;
  const frac = p.t / durationMs;
  return Math.max(0, Math.min(width - 1, frac * (width - 1)));
}

// Map an x pixel back to the nearest point index. Nearest by absolute
// pixel distance so a drag lands on the point under the pointer.
export function xToIndex(
  points: readonly FlightSeriesPoint[],
  x: number,
  width: number,
  durationMs: number,
): number {
  const n = points.length;
  if (n === 0 || width <= 0 || durationMs <= 0) return 0;
  if (x <= 0) return 0;
  if (x >= width - 1) return n - 1;
  // Binary search for the point whose x is closest.
  const targetT = (x / (width - 1)) * durationMs;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < targetT) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first point with t >= targetT (or n-1).
  const cand = [Math.max(0, lo - 1), lo];
  let best = lo;
  let bestDx = Infinity;
  for (const idx of cand) {
    const p = points[idx]!;
    const px = (p.t / durationMs) * (width - 1);
    const dx = Math.abs(px - x);
    if (dx < bestDx) {
      bestDx = dx;
      best = idx;
    }
  }
  return best;
}

// The fastest 10% band: pick the 90th-percentile speed as the threshold, then
// the earliest and latest indices whose speed lies above it. A single
// contiguous band per docs — the eye finds "where the fastest points are".
// Returns null when there is no speed to compare.
export interface FastBand {
  fromIndex: number;
  toIndex: number;
  thresholdMph: number;
}
export function fastestBand(
  points: readonly FlightSeriesPoint[],
): FastBand | null {
  const speeds: { i: number; mph: number }[] = [];
  for (const p of points) {
    if (p.speedMps != null) speeds.push({ i: p.i, mph: p.speedMps * MPS_TO_MPH });
  }
  if (speeds.length === 0) return null;
  const sorted = [...speeds].sort((a, b) => a.mph - b.mph);
  const cut = Math.floor(sorted.length * 0.9);
  const threshold = sorted[cut]?.mph ?? sorted[sorted.length - 1]!.mph;
  let from = Infinity;
  let to = -Infinity;
  for (const s of speeds) {
    if (s.mph >= threshold) {
      if (s.i < from) from = s.i;
      if (s.i > to) to = s.i;
    }
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { fromIndex: from, toIndex: to, thresholdMph: threshold };
}

// Nice-round tick values for a numeric axis. Steps 1, 2, 5, 10, ...
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const range = max - min;
  const roughStep = range / target;
  const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / pow10;
  let step: number;
  if (normalized < 1.5) step = 1 * pow10;
  else if (normalized < 3) step = 2 * pow10;
  else if (normalized < 7) step = 5 * pow10;
  else step = 10 * pow10;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

export function formatElapsedFull(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00:00";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${hh}:${pad(mm)}:${pad(ss)}`;
}
