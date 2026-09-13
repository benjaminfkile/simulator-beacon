// Boot: load config, connect to the database and create the sim_run row when
// missing, start the health server, start the leader poll, run the beacon core
// on the leader. The fix source is a stub in B1: B2 wires the flight scheduler
// and the control API that drives it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type Logger } from "pino";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createDb, type Db } from "./db.js";
import { startLeader, type Leader } from "./leader.js";
import { startHealthServer } from "./health.js";
import { createBeaconState, type BeaconState } from "./beacon/state.js";
import { createRest } from "./beacon/rest.js";
import { buildHubClient, type HubClient } from "./beacon/hub.js";
import { startSocketLoop, type SocketLoop } from "./beacon/socketLoop.js";
import { startSendLoop, type SendLoop } from "./beacon/sendLoop.js";
import { startHeartbeatLoop, type HeartbeatLoop } from "./beacon/heartbeatLoop.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/main.ts and dist/main.js both sit one level below the repo root.
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Core {
  socket: SocketLoop;
  sendLoop: SendLoop;
  heartbeat: HeartbeatLoop;
  getHub: () => HubClient | null;
  clearHub: () => void;
}

function startCore(args: {
  config: Config;
  state: BeaconState;
  bootMs: number;
  version: string;
  instance: string;
  isLeader: () => boolean;
  log: Logger;
}): Core {
  const { config, state, bootMs, version, instance, isLeader, log } = args;
  const rest = createRest({ apiBaseUrl: config.apiBaseUrl, key: config.beaconKey });
  let hub: HubClient | null = null;

  const socket = startSocketLoop({
    build: () => {
      hub = buildHubClient({ hubUrl: config.hubUrl, key: config.beaconKey });
      return hub;
    },
    ingestChannel: config.ingestChannel,
    key: config.beaconKey,
    state,
    onConnected: () => sendLoop.wake(),
    onBuildError: (err) =>
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "hub build failed; backing off",
      ),
  });

  const sendLoop = startSendLoop({
    state,
    rest,
    getHub: () => hub,
    ingestChannel: config.ingestChannel,
  });

  const heartbeat = startHeartbeatLoop({
    state,
    rest,
    buildHealth: () => {
      const lastFixAgeS =
        state.latestFix ? Math.max(0, Math.floor((Date.now() - Date.parse(state.latestFix.recordedAt)) / 1000)) : null;
      return {
        batteryPercent: null,
        lastFixAgeS,
        socketState: state.socketState,
      };
    },
    buildDebug: () => ({
      run: null, // B2 fills this from the scheduler and the sim_run row.
      source: { apiBaseUrl: config.apiBaseUrl },
      transport: {
        socketState: state.socketState,
        reconnectCount: state.reconnectCount,
        httpFallbackSeconds: state.httpFallbackSeconds,
        lastReceiptLatencyMs: state.lastReceiptLatencyMs,
        sendsFailedSinceBoot: state.sendsFailedSinceBoot,
      },
      process: {
        uptimeS: Math.max(0, Math.floor((Date.now() - bootMs) / 1000)),
        leader: isLeader(),
        instance,
        version,
        node: process.version,
      },
    }),
  });

  return {
    socket,
    sendLoop,
    heartbeat,
    getHub: () => hub,
    clearHub: () => {
      hub = null;
    },
  };
}

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`config error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  })();

  const log = pino({ level: config.logLevel });
  const version = readVersion();
  const bootMs = Date.now();
  const instance = process.env.HOSTNAME ?? "local";

  const db: Db = createDb({ connectionString: config.dbConnection });
  await db.init();

  let leader: Leader | null = null;
  const health = startHealthServer(
    () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
    }),
    3000,
  );

  const state = createBeaconState();
  let core: Core | null = null;

  function startCoreOnce() {
    if (core) return;
    log.info("starting beacon core");
    core = startCore({
      config,
      state,
      bootMs,
      version,
      instance,
      isLeader: () => leader?.isLeader() ?? false,
      log,
    });
  }

  async function stopCoreOnce() {
    if (!core) return;
    log.info("stopping beacon core");
    core.sendLoop.stop();
    core.heartbeat.stop();
    await core.socket.stop();
    core.clearHub();
    core = null;
  }

  leader = startLeader({
    gatewayInternalUrl: config.gatewayInternalUrl,
    realtimeToken: config.gatewayRealtimeToken,
    forceLeader: config.forceLeader,
    onChange: (isLeader) => {
      log.info({ isLeader }, "leader change");
      if (isLeader) startCoreOnce();
      else void stopCoreOnce();
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    leader?.stop();
    await stopCoreOnce();
    await health.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
