// The run's types (simulator-beacon.md 6). `Db` is what the worker and the
// control routes talk to; `createStateDb` in stateDb.ts implements it over the
// beacon's state document.

export type SimRunStatus = "stopped" | "loading" | "running" | "failed";

export interface SimRun {
  status: SimRunStatus;
  year: number | null;
  speed: number;
  loop: boolean;
  cycles: number;
  index: number;
  total: number;
  nextFixInMs: number | null;
  startedAt: string | null;
  lastFixAt: string | null;
  lastError: string | null;
  requestedBy: string | null;
  seekTo: number | null;
  seekAt: string | null;
  leaderState: Record<string, unknown> | null;
  leaderAt: string | null;
  updatedAt: string;
}

export interface SimRunUpdate {
  status?: SimRunStatus;
  year?: number | null;
  speed?: number;
  loop?: boolean;
  cycles?: number;
  index?: number;
  total?: number;
  startedAt?: string | null;
  lastFixAt?: string | null;
  lastError?: string | null;
  requestedBy?: string | null;
  seekTo?: number | null;
  seekAt?: string | null;
}

// The leader's progress through a running year, written with its leader state.
// It lands only while the run is still `running` that year, so a Stop, a
// Start, a Restart, or a year change written by a control route is never
// overwritten by a progress write that was based on the run before it.
export interface RunProgress {
  year: number;
  index: number;
  lastFixAt: string | null;
}

export interface Db {
  init(): Promise<void>;
  read(): Promise<SimRun>;
  update(patch: SimRunUpdate): Promise<SimRun>;
  // Write the leader's state and, in the same write, its progress (above).
  writeLeaderState(state: Record<string, unknown>, progress?: RunProgress): Promise<void>;
  // Set seekTo to null and index to `index` only when seekTo is still `index`.
  // Several seeks in a row (a drag) leave the latest one standing: the clear
  // acts on whatever the run holds at the time, and a newer value survives
  // (the condition does not match) so the worker acts on it on the next tick.
  clearSeekAndSetIndex(index: number): Promise<void>;
  // Clear seekTo without touching index, only when seekTo is still `index`.
  // Used when the worker cannot act on the seek (loading, failed): the request
  // is dropped and the run's index stays where the worker last put it.
  dropSeek(index: number): Promise<void>;
  close(): Promise<void>;
}
