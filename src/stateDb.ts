// The run in the beacon's state document (simulator-beacon.md 6, contracts 4.2
// and 9.5), behind the `Db` interface the worker and the control routes use.
// One `createStateStore` per node holds the last copy read or written; every
// write goes through the store's version check and conflict retry, so a
// control write and the leader's write landing together both survive.
//
// The document is `{ run: {...}, leader: { state, at } }`. Every write starts
// from the stored document and changes only `run` or `leader`, so any other
// top-level key survives.
//
// Reads share one copy per node: `read()` reloads only when the copy is older
// than 250 ms, and concurrent reads wait on the same reload. A failed reload
// (a 429, a transport error) keeps the last copy. A failed write rejects; the
// worker logs it and writes again on a later tick.

import type { GetStateResponse, PutStateResponse, Rest, RestError, StateStore } from "beacon-library";
import type { Db, RunProgress, SimRun, SimRunStatus, SimRunUpdate } from "./runStore.js";

export const STATE_COPY_MAX_AGE_MS = 250;

export interface StoredRun {
  status: SimRunStatus;
  year: number | null;
  speed: number;
  loop: boolean;
  cycles: number;
  index: number;
  total: number;
  startedAt: string | null;
  lastFixAt: string | null;
  lastError: string | null;
  requestedBy: string | null;
  seekTo: number | null;
  seekAt: string | null;
}

export interface LeaderEntry {
  state: Record<string, unknown> | null;
  at: string | null;
}

export interface SimDocument {
  run?: StoredRun;
  leader?: LeaderEntry;
  [key: string]: unknown;
}

export function emptyDocument(): SimDocument {
  return {};
}

export function defaultRun(): StoredRun {
  return {
    status: "stopped",
    year: null,
    speed: 1,
    loop: true,
    cycles: 0,
    index: 0,
    total: 0,
    startedAt: null,
    lastFixAt: null,
    lastError: null,
    requestedBy: null,
    seekTo: null,
    seekAt: null,
  };
}

const STATUSES: readonly SimRunStatus[] = ["stopped", "loading", "running", "failed"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// The stored run with every field present: a missing or mistyped field reads
// as its default.
function normalizeRun(raw: unknown): StoredRun {
  const d = defaultRun();
  if (!isObject(raw)) return d;
  return {
    status: STATUSES.includes(raw.status as SimRunStatus) ? (raw.status as SimRunStatus) : d.status,
    year: intOrNull(raw.year),
    speed: intOr(raw.speed, d.speed),
    loop: typeof raw.loop === "boolean" ? raw.loop : d.loop,
    cycles: intOr(raw.cycles, d.cycles),
    index: intOr(raw.index, d.index),
    total: intOr(raw.total, d.total),
    startedAt: stringOrNull(raw.startedAt),
    lastFixAt: stringOrNull(raw.lastFixAt),
    lastError: stringOrNull(raw.lastError),
    requestedBy: stringOrNull(raw.requestedBy),
    seekTo: intOrNull(raw.seekTo),
    seekAt: stringOrNull(raw.seekAt),
  };
}

function normalizeLeader(raw: unknown): LeaderEntry {
  if (!isObject(raw)) return { state: null, at: null };
  return {
    state: isObject(raw.state) ? raw.state : null,
    at: stringOrNull(raw.at),
  };
}

function definedFields(patch: SimRunUpdate): Partial<StoredRun> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<StoredRun>;
}

// Wraps the REST client so the document's `updatedAt` from the latest read or
// write is at hand; the store's snapshots carry only the state and version.
export function trackUpdatedAt(rest: Pick<Rest, "getState" | "putState">): {
  rest: Pick<Rest, "getState" | "putState">;
  updatedAt: () => string | null;
} {
  let updatedAt: string | null = null;
  return {
    rest: {
      async getState(): Promise<GetStateResponse | RestError> {
        const res = await rest.getState();
        if (res.ok) updatedAt = res.updatedAt;
        return res;
      },
      async putState(state: object, expectedVersion: number): Promise<PutStateResponse | RestError> {
        const res = await rest.putState(state, expectedVersion);
        if (res.ok) updatedAt = res.updatedAt;
        return res;
      },
    },
    updatedAt: () => updatedAt,
  };
}

export interface StateDbOptions {
  store: StateStore<SimDocument>;
  now?: () => number;
  // The document's `updatedAt` (trackUpdatedAt above). Without it, the time
  // the copy was last read or written stands in.
  updatedAt?: () => string | null;
}

// Thrown from a mutator to leave the document as it is: the store passes it
// through without writing.
const UNCHANGED = Symbol("unchanged");

export function createStateDb(opts: StateDbOptions): Db {
  const { store } = opts;
  const now = opts.now ?? (() => Date.now());
  const iso = (ms: number) => new Date(ms).toISOString();
  // When the store's copy was last read or written; -Infinity means the next
  // read reloads.
  let copyAt = Number.NEGATIVE_INFINITY;
  let reloading: Promise<void> | null = null;

  function toSimRun(doc: SimDocument): SimRun {
    const run = normalizeRun(doc.run);
    const leader = normalizeLeader(doc.leader);
    return {
      ...run,
      nextFixInMs: null,
      leaderState: leader.state,
      leaderAt: leader.at,
      updatedAt: opts.updatedAt?.() ?? (Number.isFinite(copyAt) ? iso(copyAt) : iso(now())),
    };
  }

  function reload(): Promise<void> {
    if (!reloading) {
      reloading = store
        .load()
        .then(
          () => {
            copyAt = now();
          },
          (err: unknown) => {
            // The store logged the failure. With a copy in hand the read
            // answers from it and the next reload waits another 250 ms;
            // without one there is nothing to answer.
            if (!store.current()) throw err;
            copyAt = now();
          },
        )
        .finally(() => {
          reloading = null;
        });
    }
    return reloading;
  }

  async function write(mutator: (doc: SimDocument) => void): Promise<SimDocument> {
    const snap = await store.update(mutator);
    copyAt = now();
    return snap.state;
  }

  // Writes only when `change` returns true for the stored document. The
  // store's version check makes the condition and the write one step: on a
  // conflict it reloads and asks again.
  async function writeIf(change: (doc: SimDocument) => boolean): Promise<void> {
    let attempts = 0;
    try {
      await write((doc) => {
        attempts += 1;
        if (!change(doc)) throw UNCHANGED;
      });
    } catch (err) {
      if (err !== UNCHANGED) throw err;
      // After a conflict the store keeps the copy it had before the write, so
      // the next read reloads.
      if (attempts > 1) copyAt = Number.NEGATIVE_INFINITY;
    }
  }

  async function init(): Promise<void> {
    const snap = await store.load();
    copyAt = now();
    if (isObject(snap.state.run)) return;
    await writeIf((doc) => {
      if (isObject(doc.run)) return false;
      doc.run = defaultRun();
      return true;
    });
  }

  async function read(): Promise<SimRun> {
    if (!store.current() || now() - copyAt >= STATE_COPY_MAX_AGE_MS) await reload();
    const snap = store.current();
    if (!snap) throw new Error("the state document has not been read");
    return toSimRun(snap.state);
  }

  async function update(patch: SimRunUpdate): Promise<SimRun> {
    const fields = definedFields(patch);
    const doc = await write((d) => {
      d.run = { ...normalizeRun(d.run), ...fields };
    });
    return toSimRun(doc);
  }

  async function writeLeaderState(
    state: Record<string, unknown>,
    progress?: RunProgress,
  ): Promise<void> {
    await write((d) => {
      d.leader = { state, at: iso(now()) };
      if (!progress || !isObject(d.run)) return;
      const run = normalizeRun(d.run);
      if (run.status !== "running" || run.year !== progress.year) return;
      d.run = {
        ...run,
        index: progress.index,
        lastFixAt: progress.lastFixAt ?? run.lastFixAt,
      };
    });
  }

  async function clearSeekAndSetIndex(index: number): Promise<void> {
    await writeIf((d) => {
      const run = normalizeRun(d.run);
      if (run.seekTo !== index) return false;
      d.run = { ...run, seekTo: null, index };
      return true;
    });
  }

  async function dropSeek(index: number): Promise<void> {
    await writeIf((d) => {
      const run = normalizeRun(d.run);
      if (run.seekTo !== index) return false;
      d.run = { ...run, seekTo: null };
      return true;
    });
  }

  async function close(): Promise<void> {
    // The store holds no connection.
  }

  return { init, read, update, writeLeaderState, clearSeekAndSetIndex, dropSeek, close };
}
