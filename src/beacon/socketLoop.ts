// Socket loop per contracts 9.2. At most one connection; `connected` only after
// the JoinPrivateChannel invoke resolves (the joined ack); evictions re-join
// immediately (auth_expired) or force a reconnect (any other reason); a join
// denied by the gateway makes the first retry wait 10 s; every other close or
// failure takes the 1 s, 2 s, 3 s, 5 s backoff, and 5 s repeats forever. The
// loop never gives up.
//
// The gateway carries every hub message inside the single client method
// `ChannelEvent` (contracts 2.3 step 1). The envelope is routed on
// `envelope.channel` and `envelope.event`; envelopes for channels this beacon
// did not join are ignored.
//
// `rejoin()` is the same path as `channelEvicted auth_expired`, exposed for the
// send loop's three-consecutive-hub-rejections trigger (contracts 9.2). Each
// call increments `state.rejoinCount` (the transport telemetry counter), logs
// its outcome, and on failure takes the normal reconnect branch so the send
// loop falls back to HTTP until the socket is connected again.

import { backoffMs, JOIN_DENIED_FIRST_WAIT_MS } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { BeaconState } from "./state.js";

export interface SocketLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SocketLoopOptions {
  build: () => HubClient;
  ingestChannel: string;
  key: string;
  state: BeaconState;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBuildError?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: SocketLogger;
}

export interface SocketLoop {
  stop(): Promise<void>;
  wake(): void;
  rejoin(): Promise<void>;
}

const CHANNEL_EVENT = "ChannelEvent";

function isJoinDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /join.*denied|denied.*join|forbidden|401|403/i.test(msg);
}

export function startSocketLoop(opts: SocketLoopOptions): SocketLoop {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state = opts.state;
  let stopped = false;
  let attempt = 0;
  let current: HubClient | null = null;

  async function stopCurrent(): Promise<void> {
    if (!current) return;
    const c = current;
    current = null;
    try {
      await c.stop();
    } catch {
      // A stop() throw is fine; the socket is going away either way.
    }
  }

  function markConnected(): void {
    if (state.socketState === "connected") return;
    state.socketState = "connected";
    state.reconnectCount += 1;
    opts.onConnected?.();
  }

  async function tryRejoinOn(client: HubClient): Promise<void> {
    // Same path as `channelEvicted auth_expired`. Counts every re-invocation
    // whether or not it resolved (contracts 9.2 "rejoinCount ... on a still-open
    // connection"). On success the send loop wakes; on failure the socket
    // takes its close-or-failure branch so the send loop falls back to HTTP.
    state.rejoinCount += 1;
    try {
      await client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key);
      if (current === client) opts.onConnected?.();
      opts.log?.info("socket: rejoined");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.warn(`socket: rejoin failed ${msg}`);
      if (current === client) {
        attempt = 0;
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
        await stopCurrent();
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      state.socketState = "connecting";
      let client: HubClient;
      try {
        client = opts.build();
      } catch (err) {
        opts.onBuildError?.(err);
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
        const delay = backoffMs(attempt);
        attempt += 1;
        if (delay > 0) await sleep(delay);
        continue;
      }
      current = client;
      let deniedNext = false;
      client.onClose(() => {
        if (state.socketState === "connected") state.socketState = "reconnecting";
      });
      client.on(CHANNEL_EVENT, (envelope: unknown) => {
        if (current !== client) return;
        if (!envelope || typeof envelope !== "object") return;
        const env = envelope as {
          channel?: unknown;
          event?: unknown;
          data?: unknown;
        };
        if (env.channel !== opts.ingestChannel) return;
        if (env.event === "joined") {
          markConnected();
          return;
        }
        if (env.event === "channelEvicted") {
          const reason =
            env.data && typeof env.data === "object" && "reason" in (env.data as object)
              ? (env.data as { reason?: string }).reason
              : undefined;
          opts.log?.info(`socket: evicted ${reason ?? "unknown"}`);
          if (reason === "auth_expired") {
            void tryRejoinOn(client);
            return;
          }
          void stopCurrent();
          return;
        }
      });
      try {
        await client.start();
        await client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key);
        attempt = 0;
        markConnected();
        while (!stopped && current === client) {
          await sleep(1000);
        }
      } catch (err) {
        deniedNext = isJoinDenied(err);
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
      } finally {
        await stopCurrent();
      }

      if (stopped) return;
      opts.onDisconnected?.();
      let delay: number;
      if (deniedNext) {
        delay = JOIN_DENIED_FIRST_WAIT_MS;
        attempt = 1;
      } else {
        delay = backoffMs(attempt);
        attempt += 1;
      }
      if (delay > 0) await sleep(delay);
    }
  }

  void Promise.resolve().then(loop);

  return {
    async stop() {
      stopped = true;
      await stopCurrent();
      state.socketState = "disconnected";
    },
    wake() {
      // No wake-up channel: sleep-based delays run to completion; the loop
      // reads `stopped` on every cycle. A caller who needs to break the sleep
      // early passes their own sleep() and drives it themselves.
    },
    async rejoin() {
      const c = current;
      if (!c) return;
      await tryRejoinOn(c);
    },
  };
}
