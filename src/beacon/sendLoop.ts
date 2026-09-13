// Send loop per contracts 9.2. Every fix interval and on a new fix:
//  - if no fix or the current fix has been delivered: return
//  - if a send is in flight: return
//  - if socketState == connected: SendToChannel; on failure keep the fix, do
//    not fall back (the socket is up); the next attempt waits backoffMs.
//  - else: POST /locations; on 2xx success; else failed send.
//  - failed send while lastHeartbeat.liveEventId is null: log at most once per
//    minute, do NOT increment sendsFailedSinceBoot.
//  - failed send otherwise: increment sendsFailedSinceBoot and attempt.

import { backoffMs } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { LatestFix, BeaconState } from "./state.js";
import type { LocationBody, Rest } from "./rest.js";

export interface SendLoopOptions {
  state: BeaconState;
  rest: Rest;
  getHub: () => HubClient | null;
  ingestChannel: string;
  intervalMs?: number;
  now?: () => number;
  onSent?: (fix: LatestFix, viaHub: boolean, receiptLatencyMs: number) => void;
  onFailed?: (viaHub: boolean, reason: string) => void;
}

export type SendDecision =
  | { action: "skip"; reason: "no-fix" | "already-delivered" | "in-flight" }
  | { action: "hub" }
  | { action: "http" };

export function decide(state: BeaconState, inFlight: boolean): SendDecision {
  if (!state.latestFix) return { action: "skip", reason: "no-fix" };
  if (state.latestFix.seqLocal === state.lastDeliveredSeqLocal)
    return { action: "skip", reason: "already-delivered" };
  if (inFlight) return { action: "skip", reason: "in-flight" };
  if (state.socketState === "connected") return { action: "hub" };
  return { action: "http" };
}

function toBody(f: LatestFix): LocationBody {
  return {
    lat: f.lat,
    lng: f.lng,
    recordedAt: f.recordedAt,
    speedMps: f.speedMps,
    altitudeM: f.altitudeM,
    headingDeg: f.headingDeg,
    accuracyM: f.accuracyM,
  };
}

export interface SendLoop {
  wake(): void;
  stop(): void;
  tick(): Promise<void>;
  inFlight(): boolean;
  attempt(): number;
}

export function startSendLoop(opts: SendLoopOptions): SendLoop {
  const intervalMs = opts.intervalMs ?? 1000;
  const now = opts.now ?? (() => Date.now());
  const state = opts.state;
  let inFlight = false;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let noLiveLoggedAt = 0;

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const decision = decide(state, inFlight);
    if (decision.action === "skip") {
      schedule(intervalMs);
      return;
    }
    const fix = state.latestFix!;
    inFlight = true;
    const started = now();
    try {
      if (decision.action === "hub") {
        const hub = opts.getHub();
        if (!hub) {
          onFail(true, "no-hub");
          return;
        }
        try {
          await hub.invoke("SendToChannel", opts.ingestChannel, "location", toBody(fix));
          onOk(fix, true, now() - started);
        } catch (err) {
          onFail(true, err instanceof Error ? err.message : String(err));
        }
      } else {
        const res = await opts.rest.postLocation(toBody(fix));
        if (res.ok) {
          state.httpFallbackSeconds += (now() - started) / 1000;
          onOk(fix, false, now() - started);
        } else {
          onFail(false, res.code ?? String(res.status ?? res.transportError ?? "http-error"));
        }
      }
    } finally {
      inFlight = false;
    }
  }

  function onOk(fix: LatestFix, viaHub: boolean, latency: number): void {
    state.lastDeliveredSeqLocal = fix.seqLocal;
    state.lastReceiptLatencyMs = latency;
    attempt = 0;
    opts.onSent?.(fix, viaHub, latency);
    // A new fix may already be waiting; try again immediately.
    schedule(0);
  }

  function onFail(viaHub: boolean, reason: string): void {
    const hasLiveEvent = state.lastHeartbeat?.liveEventId != null;
    if (hasLiveEvent) {
      state.sendsFailedSinceBoot += 1;
    } else {
      const nowMs = now();
      if (nowMs - noLiveLoggedAt >= 60_000) {
        noLiveLoggedAt = nowMs;
      }
    }
    opts.onFailed?.(viaHub, reason);
    const wait = backoffMs(attempt);
    attempt += 1;
    schedule(wait);
  }

  schedule(intervalMs);

  return {
    wake() {
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
    inFlight: () => inFlight,
    attempt: () => attempt,
  };
}
