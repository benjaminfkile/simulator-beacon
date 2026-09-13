// The socket loop's transitions per contracts 9.2: `connected` only on the
// `joined` ack; evictions; the 10 s denied wait; backoff never gives up.

import { describe, expect, it } from "vitest";
import { startSocketLoop } from "../src/beacon/socketLoop.js";
import { createBeaconState } from "../src/beacon/state.js";
import { FakeHubClient } from "./fakes.js";
import { BACKOFF_MS, JOIN_DENIED_FIRST_WAIT_MS, backoffMs } from "../src/beacon/backoff.js";

function yieldMacrotask(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await yieldMacrotask();
}

describe("backoff", () => {
  it("is 1 s, 2 s, 3 s, 5 s, then 5 s forever (no maximum beyond that)", () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 3000, 5000]);
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(5000);
    expect(backoffMs(50)).toBe(5000);
    expect(backoffMs(1_000_000)).toBe(5000);
  });
});

describe("socket loop transitions", () => {
  it("becomes 'connected' only after JoinPrivateChannel resolves (the joined ack)", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    let joinResolvers: Array<() => void> = [];
    class Slow extends FakeHubClient {
      constructor() {
        super();
      }
      override invoke<T = unknown>(method: string, ..._args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          return new Promise<T>((resolve) => {
            joinResolvers.push(() => resolve(undefined as unknown as T));
          });
        }
        return super.invoke<T>(method, ..._args);
      }
    }
    const loop = startSocketLoop({
      build: () => (hub = new Slow()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    // Let start() resolve. The join is still pending, so state must be
    // "connecting", not "connected", until the join resolves.
    await drain();
    expect(state.socketState).toBe("connecting");
    joinResolvers.forEach((r) => r());
    await drain();
    expect(state.socketState).toBe("connected");
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("waits 10 s on the first retry after JoinPrivateChannel is denied", async () => {
    const state = createBeaconState();
    const sleepCalls: number[] = [];
    let sleepCount = 0;
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        // First build: denied. Second build: hangs on join so we don't loop.
        if (built.length === 0) {
          h.joinBehavior = "denied";
          h.joinError = new Error("join denied by gateway");
        }
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        sleepCount += 1;
        // After the denied-wait sleep, stop the loop so the test finishes.
        if (sleepCount >= 1) await loop.stop();
      },
    });
    await drain();
    expect(sleepCalls[0]).toBe(JOIN_DENIED_FIRST_WAIT_MS);
  });

  it("survives a build() throw: reports, backs off, and retries", async () => {
    const state = createBeaconState();
    const sleepCalls: number[] = [];
    let buildCalls = 0;
    const buildErrors: unknown[] = [];
    let loopHandle!: { stop(): Promise<void> };
    loopHandle = startSocketLoop({
      build: () => {
        buildCalls += 1;
        if (buildCalls === 1) throw new Error("Cannot resolve wss://…");
        // Second build returns a working fake so the loop reaches "connected"
        // and we know the loop kept running after the first throw.
        return new FakeHubClient();
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onBuildError: (err) => buildErrors.push(err),
      sleep: async (ms) => {
        sleepCalls.push(ms);
        // Stop as soon as the second attempt has connected so the test ends.
        if (state.socketState === "connected") await loopHandle.stop();
      },
    });
    await drain();
    // The first attempt threw; the loop reported the error, waited backoffMs(0)
    // = 1000 ms, then built a working hub and reached "connected".
    expect(buildCalls).toBeGreaterThanOrEqual(2);
    expect(buildErrors.length).toBe(1);
    expect((buildErrors[0] as Error).message).toMatch(/Cannot resolve/);
    expect(sleepCalls[0]).toBe(1000);
    await loopHandle.stop();
    expect(state.socketState).toBe("disconnected");
  });
});

describe("hub ChannelEvent envelope routing (contracts 2.3, 9.2)", () => {
  // The gateway's one client method is `ChannelEvent`. The socket loop routes
  // envelopes on `envelope.channel` and `envelope.event`, and ignores anything
  // outside the ingest channel it joined.

  class CountingHub extends FakeHubClient {
    public joinCount = 0;
    override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      if (method === "JoinPrivateChannel") {
        this.joinCount += 1;
        return Promise.resolve(undefined as unknown as T);
      }
      return super.invoke<T>(method, ...args);
    }
  }

  it("routes a 'joined' envelope on the ingest channel to 'connected' even before invoke resolves", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    const joinResolvers: Array<() => void> = [];
    class Slow extends FakeHubClient {
      override invoke<T = unknown>(method: string, ..._args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          return new Promise<T>((resolve) => {
            joinResolvers.push(() => resolve(undefined as unknown as T));
          });
        }
        return super.invoke<T>(method, ..._args);
      }
    }
    const loop = startSocketLoop({
      build: () => (hub = new Slow()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connecting");
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "joined",
      data: { channel: "x:ingest" },
    });
    expect(state.socketState).toBe("connected");
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("routes 'channelEvicted' with auth_expired: re-invokes JoinPrivateChannel and kicks the send loop; stays connected", async () => {
    const state = createBeaconState();
    let hub!: CountingHub;
    let connectedCount = 0;
    const loop = startSocketLoop({
      build: () => (hub = new CountingHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onConnected: () => {
        connectedCount += 1;
      },
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);
    expect(connectedCount).toBe(1);

    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "auth_expired" },
    });
    await drain();

    // Re-joined on the same connection: JoinPrivateChannel invoked again,
    // onConnected (the send-loop kick) fired again, state stayed connected
    // throughout.
    expect(hub.joinCount).toBe(2);
    expect(connectedCount).toBe(2);
    expect(state.socketState).toBe("connected");

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("routes 'channelEvicted' with any other reason through the normal reconnect path", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    const loop = startSocketLoop({
      build: () => (hub = new FakeHubClient()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "service_removed" },
    });
    // The eviction stopped the current connection; the outer loop reconnects.
    await drain();
    expect(["connecting", "connected", "reconnecting"]).toContain(state.socketState);
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("ignores envelopes for channels this beacon did not join", async () => {
    const state = createBeaconState();
    let hub!: CountingHub;
    let connectedCount = 0;
    const loop = startSocketLoop({
      build: () => (hub = new CountingHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onConnected: () => {
        connectedCount += 1;
      },
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);

    // A joined ack for someone else's channel: ignored.
    hub.emit("ChannelEvent", {
      channel: "y:ingest",
      event: "joined",
      data: { channel: "y:ingest" },
    });
    // An eviction for someone else's channel: also ignored (no re-invoke, no
    // reconnect).
    hub.emit("ChannelEvent", {
      channel: "y:ingest",
      event: "channelEvicted",
      data: { channel: "y:ingest", reason: "auth_expired" },
    });
    await drain();

    expect(hub.joinCount).toBe(1);
    expect(connectedCount).toBe(1);
    expect(state.socketState).toBe("connected");

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });
});
