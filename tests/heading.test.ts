// Heading fill (simulator-beacon.md 4). A recorded heading passes through; a
// null heading takes the course from the nearest earlier point at least 15 m
// back, else the course to the nearest later point at least 15 m ahead, else
// stays null. Fixtures in Missoula coordinates.

import { describe, expect, it } from "vitest";
import type { LocationRow } from "../src/flights/api.js";
import {
  fillHeadings,
  haversineMeters,
  initialBearingDeg,
} from "../src/flights/heading.js";

const LAT = 46.8721;
const LNG = -113.994;
// Metres per degree on the 6,371 km sphere the haversine uses.
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

function row(seq: number, lat: number, lng: number, headingDeg: number | null = null): LocationRow {
  return {
    seq,
    recordedAt: new Date(Date.parse("2025-12-22T01:00:00.000Z") + seq * 1000).toISOString(),
    lat,
    lng,
    speedMps: null,
    altitudeM: null,
    headingDeg,
    accuracyM: null,
  };
}

function eastRun(n: number, stepM: number): LocationRow[] {
  return Array.from({ length: n }, (_, i) => row(i + 1, LAT, LNG + (i * stepM) / M_PER_DEG_LNG));
}

describe("fillHeadings (simulator-beacon.md 4)", () => {
  it("passes a recorded heading through untouched", () => {
    const points = eastRun(3, 100);
    points[1] = { ...points[1]!, headingDeg: 271.5 };
    const out = fillHeadings(points);
    expect(out[1]!.headingDeg).toBe(271.5);
  });

  it("derives 90 along a straight eastward run, the first point from the point ahead", () => {
    const points = eastRun(6, 100);
    expect(haversineMeters(points[0]!.lat, points[0]!.lng, points[1]!.lat, points[1]!.lng)).toBeCloseTo(100, 0);
    const out = fillHeadings(points);
    for (const p of out) {
      expect(p.headingDeg).not.toBeNull();
      expect(Math.abs(p.headingDeg! - 90)).toBeLessThan(0.5);
    }
  });

  it("takes the bearing from the earlier point at least 15 m back, not from a near one", () => {
    // A, then B 100 m north of A, then C 5 m east of B. C is within 15 m of B,
    // so its course is from A: atan2(5, 100) = 2.862 degrees.
    const a = row(1, LAT, LNG);
    const b = row(2, LAT + 100 / M_PER_DEG_LAT, LNG);
    const c = row(3, b.lat, LNG + 5 / M_PER_DEG_LNG);
    const out = fillHeadings([a, b, c]);
    expect(out[1]!.headingDeg!).toBeCloseTo(0, 1);
    expect(out[2]!.headingDeg!).toBeCloseTo(2.862, 1);
    // The near predecessor alone would read due east.
    expect(initialBearingDeg(b.lat, b.lng, c.lat, c.lng)).toBeCloseTo(90, 0);
  });

  it("gives points still within 15 m of the start the course to the first point 15 m ahead", () => {
    // Three points 5 m apart heading east, then one 100 m south of the start.
    const points = [
      row(1, LAT, LNG),
      row(2, LAT, LNG + 5 / M_PER_DEG_LNG),
      row(3, LAT, LNG + 10 / M_PER_DEG_LNG),
      row(4, LAT - 100 / M_PER_DEG_LAT, LNG),
    ];
    const out = fillHeadings(points);
    expect(out[0]!.headingDeg!).toBeCloseTo(180, 1);
    // Point 2 looks back: no point 15 m back, so it looks ahead to point 4.
    const expected = initialBearingDeg(points[1]!.lat, points[1]!.lng, points[3]!.lat, points[3]!.lng);
    expect(out[1]!.headingDeg!).toBeCloseTo(expected, 6);
    expect(out[1]!.headingDeg!).toBeGreaterThan(180);
  });

  it("keeps null for a single point and for a recording that never moves 15 m", () => {
    expect(fillHeadings([row(1, LAT, LNG)])[0]!.headingDeg).toBeNull();
    const still = [
      row(1, LAT, LNG),
      row(2, LAT + 3 / M_PER_DEG_LAT, LNG),
      row(3, LAT + 3 / M_PER_DEG_LAT, LNG + 4 / M_PER_DEG_LNG),
      row(4, LAT, LNG + 6 / M_PER_DEG_LNG),
    ];
    for (const p of fillHeadings(still)) expect(p.headingDeg).toBeNull();
  });

  it("returns new rows and leaves the input unchanged", () => {
    const points = eastRun(4, 100);
    const before = JSON.parse(JSON.stringify(points));
    const out = fillHeadings(points);
    expect(points).toEqual(before);
    expect(out).not.toBe(points);
    out.forEach((p, i) => expect(p).not.toBe(points[i]));
  });

  it("never returns a value outside [0, 360)", () => {
    // A walk in every direction, including due north and the turns either
    // side of it where the raw azimuth is near zero or negative.
    const points: LocationRow[] = [];
    for (let k = 0; k < 72; k++) {
      const angle = (k * 5 * Math.PI) / 180;
      points.push(
        row(k + 1, LAT + (Math.cos(angle) * 200) / M_PER_DEG_LAT, LNG + (Math.sin(angle) * 200) / M_PER_DEG_LNG),
      );
    }
    points.push(row(73, LAT + 1, LNG), row(74, LAT + 1.001, LNG - 1e-12));
    for (const p of fillHeadings(points)) {
      expect(p.headingDeg).not.toBeNull();
      expect(p.headingDeg!).toBeGreaterThanOrEqual(0);
      expect(p.headingDeg!).toBeLessThan(360);
    }
    for (const [dLat, dLng] of [[1, 0], [1, -1e-12], [-1, 0], [0, -1], [-1e-9, 1e-15]]) {
      const v = initialBearingDeg(LAT, LNG, LAT + dLat!, LNG + dLng!);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(360);
    }
  });
});
