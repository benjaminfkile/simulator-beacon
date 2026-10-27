// Great-circle helpers shared by the flight series (speed from distance) and
// the heading fill (course from bearing). Distances are haversine metres on a
// sphere of radius 6,371 km; bearings are degrees clockwise from true north.

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
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

// The initial bearing (forward azimuth) of the great circle from a to b, in
// degrees clockwise from true north, normalised to [0, 360).
export function initialBearingDeg(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const phi1 = toRadians(aLat);
  const phi2 = toRadians(bLat);
  const dLambda = toRadians(bLng - aLng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = toDegrees(Math.atan2(y, x)) % 360;
  const normalised = deg < 0 ? deg + 360 : deg;
  // A tiny negative value can round up to exactly 360 after the shift.
  return normalised >= 360 ? 0 : normalised;
}
