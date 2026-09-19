// Wires the beacon-library core to the simulator's worker, database, and
// control server. `main.ts` is a thin caller of `startService`; the returned
// `stop()` unwinds the leader, the worker, the beacon, the HTTP server, and
// the database pool in that order.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type Logger } from "pino";
import {
  createBeacon,
  gateOnLeader,
  setLatestFix,
  type Beacon,
  type HealthCore,
  type HubClient,
  type HubOptions,
  type Leader,
} from "beacon-library";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { createDb as createDbDefault, type Db } from "./db.js";
import { createFlightsApi } from "./flights/api.js";
import { createFlightsCache } from "./flights/cache.js";
import { createAdminAuth } from "./control/auth.js";
import { buildControlServer } from "./control/routes.js";
import { startWorker, type WorkerHandle } from "./worker.js";

export interface ServiceLeaderOverrides {
  pollMs?: number;
  timeoutMs?: number;
  expiryMs?: number;
  autoStart?: boolean;
  now?: () => number;
}

export interface ServiceDeps {
  logger?: Logger;
  createDb?: (opts: { connectionString: string }) => Db;
  buildHub?: (o: HubOptions) => HubClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
  port?: number;
  host?: string;
  version?: string;
  instance?: string;
  bootMs?: number;
  installProcessHandlers?: boolean;
  leaderOverrides?: ServiceLeaderOverrides;
  workerTickMs?: number;
}

export interface HeartbeatBodyForTests {
  sentAt: string;
  health: Record<string, unknown> | null;
  debug: Record<string, unknown> | null;
}

export interface Service {
  stop(): Promise<void>;
  beacon: Beacon;
  leader: Leader;
  db: Db;
  server: FastifyInstance;
  address(): string | null;
  getWorkerRunning(): boolean;
  buildHeartbeatBody(): HeartbeatBodyForTests;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function startService(config: Config, deps: ServiceDeps = {}): Promise<Service> {
  const log = deps.logger ?? pino({ level: config.logLevel });
  const version = deps.version ?? readVersion();
  const bootMs = deps.bootMs ?? Date.now();
  const instance = deps.instance ?? process.env.HOSTNAME ?? "local";

  if (deps.installProcessHandlers !== false) {
    // A beacon never gives up: an unhandled rejection or a synchronous throw
    // that escapes anything in the loops is logged at error and swallowed so
    // the process keeps running (simulator-beacon.md 2, contracts 9.2).
    process.on("unhandledRejection", (reason) => {
      log.error(
        {
          err: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        },
        "unhandledRejection",
      );
    });
    process.on("uncaughtException", (err) => {
      log.error(
        { err: err.message, stack: err.stack },
        "uncaughtException",
      );
    });
  }

  const db: Db = (deps.createDb ?? createDbDefault)({ connectionString: config.dbConnection });
  await db.init();

  const flightsApi = createFlightsApi({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const cache = createFlightsCache({ api: flightsApi });
  void cache.refresh().catch((err) =>
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "initial flight cache refresh failed",
    ),
  );

  const auth = createAdminAuth({
    issuer: config.cognitoIssuer,
    audiences: config.cognitoClientIds,
    adminGroup: config.adminGroup,
  });

  let worker: WorkerHandle | null = null;
  let leader: Leader | null = null;

  const beaconLog = {
    info: (fields: Record<string, unknown>, msg: string) => log.info(fields, msg),
    warn: (fields: Record<string, unknown>, msg: string) => log.warn(fields, msg),
    error: (fields: Record<string, unknown>, msg: string) => log.error(fields, msg),
  };

  function buildHealth(): HealthCore {
    const s = beacon.state;
    const lastFixAgeS = s.latestFix
      ? Math.max(0, Math.floor((Date.now() - Date.parse(s.latestFix.recordedAt)) / 1000))
      : null;
    return {
      batteryPercent: null,
      lastFixAgeS,
      socketState: s.socketState,
    };
  }
  function buildDebug(): Record<string, unknown> {
    const s = beacon.state;
    const lastLoad = cache.lastLoad();
    const status = worker?.runningStatus() ?? null;
    return {
      run: worker
        ? {
            status,
            index: worker.currentIndex(),
            total: worker.currentTotal(),
            nextFixInMs: worker.nextFixInMs(),
          }
        : null,
      source: {
        apiBaseUrl: config.apiBaseUrl,
        cachedYears: cache.cachedYears(),
        lastFlightLoadMs: lastLoad.ms,
        lastFlightLoadAt: lastLoad.at,
      },
      transport: {
        socketState: s.socketState,
        reconnectCount: s.reconnectCount,
        rejoinCount: s.rejoinCount,
        httpFallbackSeconds: s.httpFallbackSeconds,
        lastReceiptLatencyMs: s.lastReceiptLatencyMs,
        sendsFailedSinceBoot: s.sendsFailedSinceBoot,
      },
      process: {
        uptimeS: Math.max(0, Math.floor((Date.now() - bootMs) / 1000)),
        leader: leader?.isLeader() ?? false,
        instance,
        version,
        node: process.version,
      },
    };
  }

  const beacon = createBeacon({
    apiBaseUrl: config.apiBaseUrl,
    beaconKey: config.beaconKey,
    hubUrl: config.hubUrl,
    ingestChannel: config.ingestChannel,
    log: beaconLog,
    ...(deps.buildHub ? { buildHub: deps.buildHub } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    buildHealth,
    buildDebug,
  });

  function beaconLeaderState(): Record<string, unknown> {
    const s = beacon.state;
    const hb = s.lastHeartbeat;
    const heartbeatAge = hb?.receivedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(hb.receivedAt)) / 1000))
      : null;
    return {
      name: "simulator",
      isActive: hb?.isActive ?? null,
      liveEventId: hb?.liveEventId ?? null,
      socketState: s.socketState,
      lastDeliveredSeqLocal: s.lastDeliveredSeqLocal,
      lastReceiptLatencyMs: s.lastReceiptLatencyMs,
      heartbeatAge,
      revoked: s.revoked,
    };
  }

  const server = await buildControlServer({
    db,
    cache,
    auth,
    corsOrigins: config.corsOrigins,
    probe: () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
      isLeader: leader?.isLeader() ?? false,
    }),
    buildBeaconState: () => beaconLeaderState(),
    instance,
  });

  await server.listen({ port: deps.port ?? 3000, host: deps.host ?? "0.0.0.0" });

  leader = gateOnLeader({
    leader: {
      gatewayInternalUrl: config.gatewayInternalUrl,
      realtimeToken: config.gatewayRealtimeToken,
      forceLeader: config.forceLeader,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.leaderOverrides ?? {}),
    },
    beacon,
    log: beaconLog,
    onStart: () => {
      if (worker) return;
      log.info("starting worker");
      worker = startWorker({
        db,
        cache,
        buildLeaderState: () => beaconLeaderState(),
        onEmit: ({ point, recordedAtNow }) => {
          setLatestFix(beacon.state, {
            lat: point.lat,
            lng: point.lng,
            recordedAt: recordedAtNow,
            speedMps: point.speedMps,
            altitudeM: point.altitudeM,
            headingDeg: point.headingDeg,
            accuracyM: point.accuracyM,
          });
          beacon.wake();
        },
        onStop: () => undefined,
        ...(deps.workerTickMs != null ? { tickMs: deps.workerTickMs } : {}),
        log: {
          warn: (obj, msg) => log.warn(obj, msg),
          error: (obj, msg) => log.error(obj, msg),
        },
      });
    },
    onStop: async () => {
      if (!worker) return;
      log.info("stopping worker");
      await worker.stop();
      worker = null;
    },
  });

  return {
    beacon,
    get leader() {
      return leader!;
    },
    db,
    server,
    address() {
      const addr = server.server.address();
      if (!addr || typeof addr === "string") return addr;
      return `http://${addr.address}:${addr.port}`;
    },
    getWorkerRunning() {
      return worker !== null;
    },
    buildHeartbeatBody() {
      return {
        sentAt: new Date().toISOString(),
        health: buildHealth() as Record<string, unknown>,
        debug: buildDebug(),
      };
    },
    async stop() {
      leader?.stop();
      if (worker) {
        await worker.stop();
        worker = null;
      }
      await beacon.stop();
      await server.close();
      await db.close();
    },
  };
}
