// Fills for a loaded year (simulator-beacon.md 4): the headings and the speeds
// the recording lacks, as a real beacon would report them. Both are pure: the
// input rows are not mutated and new rows are returned.
//
// Heading. A point whose recorded `headingDeg` is a number keeps it. A null
// heading becomes the initial bearing from the nearest earlier point (in `seq`
// order) at least `minDistanceM` metres away to this point, the same lookback
// the API uses for its own derivation (contracts 7.2); when no earlier point
// is that far, the bearing from this point to the nearest later point at least
// `minDistanceM` away; when neither exists it stays null.
//
// Speed. A point whose recorded `speedMps` is a number keeps it. A null speed
// becomes the recording's own speed over the segment from the previous point
// (`segmentSpeedMps`); the first point takes the segment ahead. A segment with
// a zero or negative time delta, or a non-finite result, gives null, as does a
// point with no neighbour. The value is never scaled by the replay speed. The
// flight series (`series.ts`) derives its speeds through `segmentSpeedMps` too,
// so the chart and the sent fixes agree.

import type { LocationRow } from "./api.js";
import { haversineMeters, initialBearingDeg } from "./geo.js";

export { haversineMeters, initialBearingDeg };

export function fillHeadings(
  points: LocationRow[],
  minDistanceM = 15,
): LocationRow[] {
  const n = points.length;
  return points.map((p, i) => {
    if (p.headingDeg != null) return { ...p };
    for (let j = i - 1; j >= 0; j--) {
      const q = points[j]!;
      if (haversineMeters(q.lat, q.lng, p.lat, p.lng) >= minDistanceM) {
        return { ...p, headingDeg: initialBearingDeg(q.lat, q.lng, p.lat, p.lng) };
      }
    }
    for (let j = i + 1; j < n; j++) {
      const q = points[j]!;
      if (haversineMeters(p.lat, p.lng, q.lat, q.lng) >= minDistanceM) {
        return { ...p, headingDeg: initialBearingDeg(p.lat, p.lng, q.lat, q.lng) };
      }
    }
    return { ...p, headingDeg: null };
  });
}

// The recording's speed from `a` to `b`: the haversine distance divided by the
// seconds between the two `recordedAt` values, in metres per second, rounded
// to 0.1. Null for a zero or negative time delta or a non-finite result.
export function segmentSpeedMps(
  a: Pick<LocationRow, "lat" | "lng" | "recordedAt">,
  b: Pick<LocationRow, "lat" | "lng" | "recordedAt">,
): number | null {
  const deltaSec = (Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) / 1000;
  if (!Number.isFinite(deltaSec) || deltaSec <= 0) return null;
  const mps = Math.round((haversineMeters(a.lat, a.lng, b.lat, b.lng) / deltaSec) * 10) / 10;
  return Number.isFinite(mps) ? mps : null;
}

export function fillSpeeds(points: LocationRow[]): LocationRow[] {
  const n = points.length;
  return points.map((p, i) => {
    if (p.speedMps != null) return { ...p };
    let speedMps: number | null = null;
    if (i > 0) speedMps = segmentSpeedMps(points[i - 1]!, p);
    else if (n > 1) speedMps = segmentSpeedMps(p, points[1]!);
    return { ...p, speedMps };
  });
}
