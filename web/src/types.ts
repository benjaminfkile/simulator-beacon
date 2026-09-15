// Wire types for the control API. Keep in sync with simulator-beacon.md 5.

export type RunStatus = "stopped" | "loading" | "running" | "failed";

export interface SimRun {
  status: RunStatus;
  year: number | null;
  speed: number;
  loop: boolean;
  cycles: number;
  index: number;
  total: number;
  nextFixInMs: number | null;
  startedAt: string | null;
  lastFixAt: string | null;
  lastError: string | null;
  requestedBy: string | null;
  updatedAt: string;
}

export interface BeaconState {
  name: string | null;
  isActive: boolean | null;
  liveEventId: number | null;
  socketState: string | null;
  lastDeliveredSeqLocal: number | null;
  lastReceiptLatencyMs: number | null;
  heartbeatAge: number | null;
  revoked: boolean | null;
}

export interface ControlState {
  run: SimRun;
  beacon: BeaconState | null;
  leaderInstance: string | null;
}

export interface YearItem {
  year: number;
  eventId: number;
  name: string;
  pointCount: number;
}

export interface YearsResponse {
  items: YearItem[];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
  requestId: string;
}

export const ALLOWED_SPEEDS = [1, 2, 5, 10, 20, 60] as const;
export type Speed = (typeof ALLOWED_SPEEDS)[number];

export type SpeedSource = "recorded" | "derived" | "mixed";

export interface FlightSeriesPoint {
  i: number;
  t: number;
  lat: number;
  lng: number;
  speedMps: number | null;
  altitudeM: number | null;
}

export interface FlightSeries {
  year: number;
  eventId: number;
  name: string;
  pointCount: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  durationMs: number;
  hasAltitude: boolean;
  speedSource: SpeedSource;
  points: FlightSeriesPoint[];
}
