// The run in the beacon's state document (simulator-beacon.md 6) over the
// library's fake REST client, which serves one versioned document and answers
// a stale expectedVersion with 409 state_version_conflict.

import { describe, expect, it } from "vitest";
import { createFakeRest, createStateStore, type FakeRest } from "beacon-library";
import {
  createStateDb,
  defaultRun,
  emptyDocument,
  trackUpdatedAt,
  type SimDocument,
} from "../src/stateDb.js";
import type { Db } from "../src/runStore.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Clock {
  ms: number;
  now: () => number;
}

function makeClock(start = Date.parse("2026-10-18T12:00:00.000Z")): Clock {
  const clock: Clock = { ms: start, now: () => clock.ms };
  return clock;
}

// One node: its own store over the shared fake document.
function makeNode(rest: FakeRest, clock: Clock): Db {
  const tracked = trackUpdatedAt(rest);
  const store = createStateStore<SimDocument>({ rest: tracked.rest, log: silent, empty: emptyDocument });
  return createStateDb({ store, now: clock.now, updatedAt: tracked.updatedAt });
}

function gets(rest: FakeRest): number {
  return rest.stateCalls.filter((c) => c.method === "get").length;
}

function puts(rest: FakeRest): number {
  return rest.stateCalls.filter((c) => c.method === "put").length;
}

function doc(rest: FakeRest): SimDocument {
  return rest.state as SimDocument;
}

describe("createStateDb (simulator-beacon.md 6)", () => {
  it("init on an empty document writes the defaults with the version it read", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    expect(doc(rest).run).toEqual(defaultRun());
    expect(rest.stateVersion).toBe(1);
    expect(rest.stateCalls[1]).toMatchObject({ method: "put", expectedVersion: 0 });
    const run = await db.read();
    expect(run).toMatchObject({
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
    });
    expect(run.updatedAt).toBe(new Date(clock.ms).toISOString());
  });

  it("init keeps a run that is already there without writing", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    rest.setState({ run: { ...defaultRun(), status: "running", year: 2025, index: 40 } }, 7);
    const db = makeNode(rest, clock);
    await db.init();
    expect(puts(rest)).toBe(0);
    expect(await db.read()).toMatchObject({ status: "running", year: 2025, index: 40 });
  });

  it("two nodes initialising together leave one run", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const a = makeNode(rest, clock);
    const b = makeNode(rest, clock);
    await Promise.all([a.init(), b.init()]);
    // Both tried to write on version 0; one landed, the other met the newer
    // version, reloaded, and kept what was there.
    expect(rest.stateCalls.filter((c) => c.method === "put" && c.expectedVersion === 0)).toHaveLength(2);
    expect(puts(rest)).toBe(2);
    expect(rest.stateVersion).toBe(1);
    expect(doc(rest).run).toEqual(defaultRun());
    clock.ms += 300;
    expect(await a.read()).toMatchObject({ status: "stopped", index: 0 });
    expect(await b.read()).toMatchObject({ status: "stopped", index: 0 });
  });

  it("update merges the patch into the run and returns the merged run", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    await db.update({ status: "loading", year: 2025, speed: 20, requestedBy: "op" });
    const merged = await db.update({ speed: 60, index: undefined });
    expect(merged).toMatchObject({
      status: "loading",
      year: 2025,
      speed: 60,
      loop: true,
      index: 0,
      requestedBy: "op",
    });
    expect(doc(rest).run).toMatchObject({ status: "loading", year: 2025, speed: 60, index: 0 });
  });

  it("writeLeaderState and a concurrent control update on another node both land", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const leader = makeNode(rest, clock);
    const follower = makeNode(rest, clock);
    await leader.init();
    await follower.init();
    await leader.update({ status: "running", year: 2025, speed: 20, total: 100 });
    clock.ms += 1000;
    await Promise.all([
      leader.writeLeaderState(
        { socketState: "connected" },
        { year: 2025, index: 33, lastFixAt: "2026-10-18T12:00:01.000Z" },
      ),
      follower.update({ speed: 60 }),
    ]);
    // Both wrote on the same version; the one that met the conflict retried.
    expect(rest.stateVersion).toBe(4);
    expect(puts(rest)).toBe(5);
    const d = doc(rest);
    expect(d.run).toMatchObject({ speed: 60, index: 33, lastFixAt: "2026-10-18T12:00:01.000Z" });
    expect(d.leader).toEqual({
      state: { socketState: "connected" },
      at: new Date(clock.ms).toISOString(),
    });
    clock.ms += 300;
    const seen = await follower.read();
    expect(seen.leaderState).toEqual({ socketState: "connected" });
    expect(seen.leaderAt).toBe(new Date(clock.ms - 300).toISOString());
  });

  it("writeLeaderState leaves the index alone once the run is no longer running that year", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const leader = makeNode(rest, clock);
    const follower = makeNode(rest, clock);
    await leader.init();
    await leader.update({ status: "running", year: 2025, index: 10 });
    await follower.init();
    // A Restart on the other node lands first.
    await follower.update({ status: "loading", index: 0 });
    await leader.writeLeaderState({}, { year: 2025, index: 50, lastFixAt: null });
    expect(doc(rest).run).toMatchObject({ status: "loading", index: 0 });
    expect(doc(rest).leader?.state).toEqual({});
  });

  it("clearSeekAndSetIndex acts only on a matching seekTo", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    await db.update({ status: "stopped", year: 2025, index: 3, seekTo: 12, seekAt: "t" });
    const before = puts(rest);
    await db.clearSeekAndSetIndex(11);
    expect(puts(rest)).toBe(before);
    expect(doc(rest).run).toMatchObject({ seekTo: 12, index: 3 });
    await db.clearSeekAndSetIndex(12);
    expect(doc(rest).run).toMatchObject({ seekTo: null, index: 12 });
  });

  it("dropSeek acts only on a matching seekTo and keeps the index", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    await db.update({ status: "failed", year: 2025, index: 3, seekTo: 12 });
    await db.dropSeek(4);
    expect(doc(rest).run).toMatchObject({ seekTo: 12, index: 3 });
    await db.dropSeek(12);
    expect(doc(rest).run).toMatchObject({ seekTo: null, index: 3 });
  });

  it("a newer seek written on another node survives the clear of the older one", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const leader = makeNode(rest, clock);
    const follower = makeNode(rest, clock);
    await leader.init();
    await leader.update({ status: "running", year: 2025, index: 3, seekTo: 12 });
    await follower.init();
    // The leader acted on 12 from its copy; the drag moved on to 40 meanwhile.
    await follower.update({ seekTo: 40 });
    await leader.clearSeekAndSetIndex(12);
    expect(doc(rest).run).toMatchObject({ seekTo: 40, index: 3 });
    // The leader's next read sees the newer seek.
    expect(await leader.read()).toMatchObject({ seekTo: 40 });
    await leader.dropSeek(12);
    expect(doc(rest).run).toMatchObject({ seekTo: 40 });
  });

  it("reads within 250 ms share one fetch", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    const afterInit = gets(rest);
    clock.ms += 100;
    await db.read();
    await db.read();
    expect(gets(rest)).toBe(afterInit);
    clock.ms += 200;
    // The copy is 300 ms old: concurrent reads wait on one reload.
    await Promise.all([db.read(), db.read(), db.read()]);
    expect(gets(rest)).toBe(afterInit + 1);
    clock.ms += 249;
    await db.read();
    expect(gets(rest)).toBe(afterInit + 1);
  });

  it("a 429 on a reload keeps the last copy", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    await db.update({ year: 2025 });
    clock.ms += 300;
    rest.nextStateError({
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "slow down",
      requestId: null,
      serverTime: null,
    });
    expect(await db.read()).toMatchObject({ year: 2025 });
  });

  it("a 429 on a write rejects and the next write lands", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    const db = makeNode(rest, clock);
    await db.init();
    rest.nextStateError({
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "slow down",
      requestId: null,
      serverTime: null,
    });
    await expect(db.writeLeaderState({ a: 1 })).rejects.toMatchObject({ status: 429 });
    await db.writeLeaderState({ a: 2 });
    expect(doc(rest).leader?.state).toEqual({ a: 2 });
  });

  it("unknown top-level keys survive writes", async () => {
    const clock = makeClock();
    const rest = createFakeRest(clock.now);
    rest.setState({ notes: { keep: true }, other: [1, 2] }, 4);
    const db = makeNode(rest, clock);
    await db.init();
    await db.update({ speed: 5 });
    await db.writeLeaderState({ x: 1 });
    await db.update({ seekTo: 2 });
    await db.clearSeekAndSetIndex(2);
    expect(doc(rest)).toMatchObject({ notes: { keep: true }, other: [1, 2] });
    expect(doc(rest).run).toMatchObject({ speed: 5, index: 2, seekTo: null });
  });
});
