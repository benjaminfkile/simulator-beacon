// The send loop's decision table (contracts 9.2). Every scenario the brief
// enumerates is one row here.

import { describe, expect, it } from "vitest";
import { createBeaconState, setLatestFix } from "../src/beacon/state.js";
import { decide, startSendLoop } from "../src/beacon/sendLoop.js";
import { FakeHubClient, createFakeRest } from "./fakes.js";

const FIX = {
  lat: 46.87,
  lng: -114,
  recordedAt: "2026-12-22T01:31:07.000Z",
  speedMps: 1,
  altitudeM: 100,
  headingDeg: 0,
  accuracyM: 10,
};

describe("send loop decision", () => {
  it("skips when there is no fix", () => {
    const s = createBeaconState();
    expect(decide(s, false)).toEqual({ action: "skip", reason: "no-fix" });
  });

  it("skips when the current fix has already been delivered", () => {
    const s = createBeaconState();
    const f = setLatestFix(s, FIX);
    s.lastDeliveredSeqLocal = f.seqLocal;
    expect(decide(s, false)).toEqual({ action: "skip", reason: "already-delivered" });
  });

  it("skips when a send is in flight (one in-flight only)", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    expect(decide(s, true)).toEqual({ action: "skip", reason: "in-flight" });
  });

  it("uses the hub while socketState=connected (no fallback while the socket is up)", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    expect(decide(s, false)).toEqual({ action: "hub" });
  });

  it("uses HTTP while the socket is not connected", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    expect(decide(s, false)).toEqual({ action: "http" });
  });
});

describe("send loop behaviour", () => {
  it("sends over the hub and records the receipt latency on success", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 1000,
    });
    // Fire manually; kick off tick, then resolve the recorded invoke.
    const p = loop.tick();
    // Yield so the invoke gets recorded.
    await Promise.resolve();
    await Promise.resolve();
    const inv = hub.lastInvoke();
    expect(inv).toBeDefined();
    expect(inv!.method).toBe("SendToChannel");
    expect(inv!.args[0]).toBe("wmsfo-api-dev:ingest");
    expect(inv!.args[1]).toBe("location");
    inv!.resolve();
    await p;
    expect(s.lastDeliveredSeqLocal).toBe(1);
    expect(s.lastReceiptLatencyMs).not.toBeNull();
    expect(s.sendsFailedSinceBoot).toBe(0);
    loop.stop();
  });

  it("does NOT fall back to HTTP while the socket is up on a rejected invoke", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 60_000,
    });
    const p = loop.tick();
    await Promise.resolve();
    await Promise.resolve();
    hub.lastInvoke()!.reject(new Error("boom"));
    await p;
    expect(rest.locationCalls).toHaveLength(0);
    expect(s.sendsFailedSinceBoot).toBe(1);
    loop.stop();
  });

  it("uses HTTP fallback when the socket is not connected", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    const rest = createFakeRest();
    rest.nextLocation({
      ok: true,
      status: 201,
      seq: 1,
      published: true,
      receivedAt: "2026-12-22T01:31:07.100Z",
      serverTime: "2026-12-22T01:31:07.100Z",
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    expect(s.lastDeliveredSeqLocal).toBe(1);
    loop.stop();
  });

  it("does NOT count sendsFailedSinceBoot before a live event is known", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    // No lastHeartbeat yet: the beacon hasn't learned liveEventId.
    const rest = createFakeRest();
    rest.nextLocation({
      ok: false,
      status: 409,
      code: "no_live_event",
      message: "",
      requestId: null,
      serverTime: null,
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(s.sendsFailedSinceBoot).toBe(0);
    loop.stop();
  });

  it("counts sendsFailedSinceBoot only when lastHeartbeat.liveEventId is non-null", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    rest.nextLocation({
      ok: false,
      status: 500,
      code: null,
      message: null,
      requestId: null,
      serverTime: null,
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(s.sendsFailedSinceBoot).toBe(1);
    loop.stop();
  });

  it("advances backoff without a maximum (5 s tail repeats)", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    for (let i = 0; i < 6; i++) {
      rest.nextLocation({
        ok: false,
        status: 500,
        code: null,
        message: null,
        requestId: null,
        serverTime: null,
      });
    }
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
    });
    for (let i = 0; i < 6; i++) await loop.tick();
    // Attempt has grown past the four-entry backoff table without saturating.
    expect(loop.attempt()).toBeGreaterThanOrEqual(6);
    expect(s.sendsFailedSinceBoot).toBe(6);
    loop.stop();
  });
});
