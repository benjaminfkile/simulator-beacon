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

import { backoffMs, JOIN_DENIED_FIRST_WAIT_MS } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { BeaconState } from "./state.js";

export interface SocketLoopOptions {
  build: () => HubClient;
  ingestChannel: string;
  key: string;
  state: BeaconState;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBuildError?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface SocketLoop {
  stop(): Promise<void>;
  wake(): void;
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

  async function loop(): Promise<void> {
    while (!stopped) {
      state.socketState = "connecting";
      let client: HubClient;
      try {
        client = opts.build();
      } catch (err) {
        // A build() throw (bad URL, misconfigured transport, …) is treated the
        // same as a failed start: report, backoff, retry. Letting it escape
        // would kill the loop and strand the beacon.
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
        // Ignore envelopes for channels this beacon did not join. The site's
        // channels ride the same connection when a fleet ever grows to share
        // one; the beacon only cares about its ingest topic.
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
          if (reason === "auth_expired") {
            // Re-invoke JoinPrivateChannel on the same connection and kick the
            // send loop. A failed re-join drops the connection and falls back
            // to the normal reconnect path with attempt = 0 so it retries
            // immediately, per contracts 9.2.
            void (async () => {
              try {
                await client.invoke(
                  "JoinPrivateChannel",
                  opts.ingestChannel,
                  opts.key,
                );
                if (current === client) opts.onConnected?.();
              } catch {
                if (current === client) {
                  attempt = 0;
                  await stopCurrent();
                }
              }
            })();
            return;
          }
          // Any other eviction reason: the normal reconnect path.
          void stopCurrent();
          return;
        }
      });
      try {
        await client.start();
        await client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key);
        attempt = 0;
        markConnected();
        // Sit here until stopCurrent() is called (by stop, close, or eviction).
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

  // The loop never throws out: build() throws are caught and treated like a
  // failed start (log, backoff, retry). Kick it off in the microtask queue so
  // the caller returns a handle before the first `state.socketState =
  // "connecting"`.
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
  };
}
