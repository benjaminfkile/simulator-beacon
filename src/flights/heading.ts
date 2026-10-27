// Heading fill for a loaded year (simulator-beacon.md 4). A point whose
// recorded `headingDeg` is a number keeps it. A null heading becomes the
// initial bearing from the nearest earlier point (in `seq` order) at least
// `minDistanceM` metres away to this point, the same lookback the API uses for
// its own derivation (contracts 7.2); when no earlier point is that far, the
// bearing from this point to the nearest later point at least `minDistanceM`
// away; when neither exists it stays null. Pure: the input rows are not
// mutated and new rows are returned.

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
