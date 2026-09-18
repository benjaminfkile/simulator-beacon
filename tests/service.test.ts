// Service wiring test: the worker follows leadership, a fix the worker emits
// reaches the hub while connected, and the heartbeat body validates against
// contracts/schema/heartbeat.schema.json with the debug keys of
// simulator-beacon.md 8.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { FakeHubClient } from "beacon-library";
import { startService } from "../src/service.js";
import type { Config } from "../src/config.js";
import type { Db, SimRun, SimRunUpdate } from "../src/db.js";
import type { EventItem, LocationRow } from "../src/flights/api.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "dev",
    apiBaseUrl: "http://api.local",
    apiKey: "wak_test",
    beaconKey: "wbk_test",
    hubUrl: "wss://hub.local/hub",
    ingestChannel: "simulator-beacon-dev:ingest",
    gatewayInternalUrl: "http://gateway.local",
    dbConnection: "postgres://ignored",
    cognitoIssuer: "https://cognito-idp.us-west-2.amazonaws.com/pool-admin",
    cognitoClientIds: ["client-admin"],
    adminGroup: "admin",
    corsOrigins: ["http://localhost:5175"],
    logLevel: "silent",
    forceLeader: false,
    gatewayRealtimeToken: "grt_test",
    ...overrides,
  };
}

interface FakeDbHandle extends Db {
  readonly row: SimRun;
  readonly updates: SimRunUpdate[];
}

function makeDb(initial: Partial<SimRun> = {}): FakeDbHandle {
  const state: { row: SimRun; updates: SimRunUpdate[] } = {
    row: {
      status: "stopped",
      year: null,
      speed: 1,
      loop: true,
      cycles: 0,
      index: 0,
      total: 0,
      nextFixInMs: null,
      startedAt: null,
      lastFixAt: null,
      lastError: null,
      requestedBy: null,
      seekTo: null,
      seekAt: null,
      leaderState: null,
      leaderAt: null,
      updatedAt: new Date().toISOString(),
      ...initial,
    },
    updates: [],
  };
  const db: Db = {
    async init() {},
    async read() {
      return { ...state.row };
    },
    async update(patch: SimRunUpdate) {
      state.updates.push(patch);
      state.row = {
        ...state.row,
        ...patch,
        updatedAt: new Date().toISOString(),
      } as SimRun;
      return { ...state.row };
    },
    async writeLeaderState(s) {
      state.row.leaderState = s;
      state.row.leaderAt = new Date().toISOString();
    },
    async clearSeekAndSetIndex(index: number) {
      if (state.row.seekTo === index) {
        state.row = { ...state.row, seekTo: null, index } as SimRun;
      }
    },
    async dropSeek(index: number) {
      if (state.row.seekTo === index) {
        state.row = { ...state.row, seekTo: null } as SimRun;
      }
    },
    async close() {},
  };
  return Object.defineProperties(db as FakeDbHandle, {
    row: { get: () => state.row, enumerable: true },
    updates: { get: () => state.updates, enumerable: true },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchController {
  fetch: typeof fetch;
  leaderResponse: { isLeader: boolean };
  events: EventItem[];
  locations: LocationRow[];
  locationPosts: unknown[];
  heartbeatPosts: unknown[];
}

function makeFetch(): FetchController {
  const ctrl: FetchController = {
    leaderResponse: { isLeader: false },
    events: [],
    locations: [],
    locationPosts: [],
    heartbeatPosts: [],
  } as unknown as FetchController;
  ctrl.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/internal/leader")) {
      return jsonResponse(200, {
        isLeader: ctrl.leaderResponse.isLeader,
        evaluatedAt: new Date().toISOString(),
      });
    }
    if (method === "GET" && url.includes("/admin/events") && !url.includes("/locations")) {
      return jsonResponse(200, { items: ctrl.events });
    }
    if (method === "GET" && url.includes("/admin/events") && url.includes("/locations")) {
      return jsonResponse(200, { items: ctrl.locations, nextCursor: null });
    }
    if (method === "POST" && url.endsWith("/locations")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      ctrl.locationPosts.push(body);
      return jsonResponse(200, {
        seq: ctrl.locationPosts.length,
        published: true,
        receivedAt: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      });
    }
    if (method === "POST" && url.endsWith("/beacons/heartbeat")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      ctrl.heartbeatPosts.push(body);
      return jsonResponse(200, {
        receivedAt: new Date().toISOString(),
        liveEventId: 1,
        isActive: true,
        serverTime: new Date().toISOString(),
      });
    }
    return jsonResponse(404, { code: "not_found", message: url });
  }) as typeof fetch;
  return ctrl;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

describe("service (simulator-beacon.md 2 and 8)", () => {
  it("starts the worker on becoming leader and stops it on becoming follower", async () => {
    const db = makeDb();
    const controller = makeFetch();
    const service = await startService(makeConfig(), {
      createDb: () => db,
      buildHub: () => new FakeHubClient(),
      fetchImpl: controller.fetch,
      port: 0,
      installProcessHandlers: false,
      leaderOverrides: { autoStart: false, pollMs: 10 },
    });
    try {
      expect(service.getWorkerRunning()).toBe(false);
      // Poll once as follower: still no worker.
      await service.leader.pollOnce();
      await new Promise((r) => setImmediate(r));
      expect(service.getWorkerRunning()).toBe(false);
      // Flip to leader and poll: the worker starts.
      controller.leaderResponse.isLeader = true;
      await service.leader.pollOnce();
      await waitFor(() => service.getWorkerRunning());
      expect(service.getWorkerRunning()).toBe(true);
      // Flip back to follower: the worker stops.
      controller.leaderResponse.isLeader = false;
      await service.leader.pollOnce();
      await waitFor(() => !service.getWorkerRunning());
      expect(service.getWorkerRunning()).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("a fix the worker emits reaches the hub while connected", async () => {
    const points: LocationRow[] = [
      {
        seq: 1,
        recordedAt: "2025-12-22T01:00:00.000Z",
        lat: 46.5,
        lng: -114.1,
        speedMps: 10,
        altitudeM: 500,
        headingDeg: 90,
        accuracyM: 5,
      },
    ];
    const db = makeDb({ status: "loading", year: 2025, speed: 60, index: 0 });
    const controller = makeFetch();
    controller.events = [
      {
        id: 42,
        year: 2025,
        name: "2025",
        statusId: 3,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    controller.locations = points;
    const hub = new FakeHubClient();
    const service = await startService(makeConfig({ forceLeader: true }), {
      createDb: () => db,
      buildHub: () => hub,
      fetchImpl: controller.fetch,
      port: 0,
      installProcessHandlers: false,
      workerTickMs: 20,
    });
    try {
      await waitFor(() => service.beacon.state.socketState === "connected");
      await waitFor(() =>
        hub.invokes.some((i) => i.method === "SendToChannel"),
        3000,
      );
      const sent = hub.invokes.find((i) => i.method === "SendToChannel");
      expect(sent).toBeDefined();
      const args = sent!.args;
      expect(args[0]).toBe("simulator-beacon-dev:ingest");
      expect(args[1]).toBe("location");
      const payload = args[2] as Record<string, unknown>;
      expect(payload.lat).toBe(46.5);
      expect(payload.lng).toBe(-114.1);
      expect(payload.speedMps).toBe(10);
    } finally {
      await service.stop();
    }
  });

  it("the heartbeat body validates against the schema and carries the debug keys of section 8", async () => {
    const db = makeDb();
    const controller = makeFetch();
    const service = await startService(makeConfig({ forceLeader: true }), {
      createDb: () => db,
      buildHub: () => new FakeHubClient(),
      fetchImpl: controller.fetch,
      port: 0,
      installProcessHandlers: false,
    });
    try {
      const body = service.buildHeartbeatBody();
      const schema = JSON.parse(
        readFileSync("contracts/schema/heartbeat.schema.json", "utf8"),
      );
      const ajv = new Ajv2020({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(schema);
      const ok = validate(body);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
      expect(body.debug).not.toBeNull();
      const debug = body.debug as Record<string, unknown>;
      expect(Object.keys(debug).sort()).toEqual(
        ["process", "run", "source", "transport"].sort(),
      );
      const source = debug.source as Record<string, unknown>;
      expect(Object.keys(source).sort()).toEqual(
        ["apiBaseUrl", "cachedYears", "lastFlightLoadAt", "lastFlightLoadMs"].sort(),
      );
      const transport = debug.transport as Record<string, unknown>;
      expect(Object.keys(transport).sort()).toEqual(
        [
          "httpFallbackSeconds",
          "lastReceiptLatencyMs",
          "reconnectCount",
          "rejoinCount",
          "sendsFailedSinceBoot",
          "socketState",
        ].sort(),
      );
      const proc = debug.process as Record<string, unknown>;
      expect(Object.keys(proc).sort()).toEqual(
        ["instance", "leader", "node", "uptimeS", "version"].sort(),
      );
    } finally {
      await service.stop();
    }
  });
});
