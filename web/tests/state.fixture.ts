import type { ControlState } from "../src/types.js";

// Full-shape fixture the state card renders every field of. Values are
// arbitrary but every field is populated so a test asserting "every field
// renders" cannot pass by accident.
export const STATE_FIXTURE: ControlState = {
  run: {
    status: "running",
    year: 2025,
    speed: 20,
    index: 412,
    total: 1065,
    startedAt: "2025-12-22T01:00:00.000Z",
    lastFixAt: "2025-12-22T01:20:34.000Z",
    lastError: null,
    requestedBy: "operator@example.com",
    updatedAt: "2025-12-22T01:20:34.000Z",
  },
  beacon: {
    name: "simulator",
    isActive: true,
    liveEventId: 7,
    socketState: "connected",
    lastDeliveredSeqLocal: 411,
    lastReceiptLatencyMs: 96,
    heartbeatAge: 4,
    revoked: false,
  },
  leaderInstance: "i-abc123",
};
