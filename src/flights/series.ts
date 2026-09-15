// The flight series returned by GET /control/flight (simulator-beacon.md 4 and
// 5). Built once per loaded year and kept with the cache entry; the control
// page charts speed and altitude against `t` (ms since the first point) and
// scrubs the playhead with `i` (the point index the seek writes).
//
// `speedMps` on each point is the recorded value when present, else derived
// from the haversine distance from the previous point divided by the seconds
// between the two recordedAt values; the first point and any zero/negative
// time delta produce null. `speedSource` describes the whole series: all
// recorded non-null values, all derived, or a mix. `altitudeM` is the
// recorded value or null; `hasAltitude` is true when at least one point had
// one.

import type { LocationRow } from "./api.js";

export interface FlightSeriesPoint {
  i: number;
  t: number;
  lat: number;
  lng: number;
  speedMps: number | null;
  altitudeM: number | null;
}

export type SpeedSource = "recorded" | "derived" | "mixed";

export interface FlightSeries {
  pointCount: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  durationMs: number;
  hasAltitude: boolean;
  speedSource: SpeedSource;
  points: FlightSeriesPoint[];
}

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = toRadians(lat2 - lat1);
  const dLambda = toRadians(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function buildFlightSeries(points: LocationRow[]): FlightSeries {
  const n = points.length;
  if (n === 0) {
    return {
      pointCount: 0,
      firstRecordedAt: "",
      lastRecordedAt: "",
      durationMs: 0,
      hasAltitude: false,
      speedSource: "recorded",
      points: [],
    };
  }
  const first = points[0]!;
  const firstMs = Date.parse(first.recordedAt);
  const last = points[n - 1]!;
  const lastMs = Date.parse(last.recordedAt);
  let sawRecorded = false;
  let sawDerived = false;
  let hasAltitude = false;
  const out: FlightSeriesPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const pMs = Date.parse(p.recordedAt);
    const t = Number.isFinite(pMs) && Number.isFinite(firstMs) ? pMs - firstMs : 0;
    let speedMps: number | null;
    if (p.speedMps != null) {
      speedMps = p.speedMps;
      sawRecorded = true;
    } else if (i === 0) {
      speedMps = null;
    } else {
      const prev = points[i - 1]!;
      const prevMs = Date.parse(prev.recordedAt);
      const deltaSec = (pMs - prevMs) / 1000;
      if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
        speedMps = null;
      } else {
        const meters = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
        speedMps = meters / deltaSec;
        sawDerived = true;
      }
    }
    const altitudeM = p.altitudeM;
    if (altitudeM != null) hasAltitude = true;
    out[i] = {
      i,
      t,
      lat: p.lat,
      lng: p.lng,
      speedMps,
      altitudeM,
    };
  }
  let speedSource: SpeedSource;
  if (sawRecorded && sawDerived) speedSource = "mixed";
  else if (sawDerived) speedSource = "derived";
  else speedSource = "recorded";
  return {
    pointCount: n,
    firstRecordedAt: first.recordedAt,
    lastRecordedAt: last.recordedAt,
    durationMs: Number.isFinite(firstMs) && Number.isFinite(lastMs) ? lastMs - firstMs : 0,
    hasAltitude,
    speedSource,
    points: out,
  };
}
