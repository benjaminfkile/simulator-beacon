// The sim_run row per simulator-beacon.md 6. One database, one table, one row;
// the app creates the table on boot when missing and inserts the singleton row.
// The control API writes status/year/speed/index/requested_by; the leader
// reads it every second, writes index every ten fixes, and writes
// leader_state and leader_at every second.
//
// SIM_DB_CONNECTION is a libpq URI. It is parsed with `pg-connection-string`
// and the pool is built from the explicit host/port/user/password/database
// fields so that our `ssl` object survives; passing `{ connectionString, ssl }`
// to pg lets its own URI parser overwrite `ssl` and drop the CA bundle. The
// URI's `sslmode` picks the TLS shape:
//   - `verify-full`, `verify-ca`: `ssl: { ca, rejectUnauthorized: true }`; the
//     Dockerfile installs the RDS global bundle at `/etc/ssl/certs/rds-global-bundle.pem`
//     and `db.ts` reads it. Boot fails with a clear message when the file is
//     missing rather than silently falling back to an unverified chain.
//   - `disable`: `ssl: false` (local docker-compose Postgres has no TLS).
//   - anything else (`require`, `prefer`, omitted): `ssl: { rejectUnauthorized: false }`.
// `pg` is CommonJS; under Node ESM `import { Pool } from "pg"` fails at load
// time with "does not provide an export named 'Pool'" (Vitest's interop hides
// it), so we use the default-import shape and destructure `Pool` off it.

import { readFileSync } from "node:fs";
import pg from "pg";
import type { PoolClient, PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

const { Pool } = pg;

export const RDS_CA_PATH = "/etc/ssl/certs/rds-global-bundle.pem";

export type SimRunStatus = "stopped" | "loading" | "running" | "failed";

export interface SimRun {
  status: SimRunStatus;
  year: number | null;
  speed: number;
  index: number;
  total: number;
  startedAt: string | null;
  lastFixAt: string | null;
  lastError: string | null;
  requestedBy: string | null;
  leaderState: Record<string, unknown> | null;
  leaderAt: string | null;
  updatedAt: string;
}

export interface SimRunUpdate {
  status?: SimRunStatus;
  year?: number | null;
  speed?: number;
  index?: number;
  total?: number;
  startedAt?: string | null;
  lastFixAt?: string | null;
  lastError?: string | null;
  requestedBy?: string | null;
}

export interface DbOptions {
  connectionString: string;
  // Read the RDS CA bundle from this path (default RDS_CA_PATH). Tests point at
  // a fixture file; production reads the one the Dockerfile installs.
  caPath?: string;
  // Test hook: override the pg Pool factory.
  createPool?: (config: PoolConfig) => pg.Pool;
}

export interface Db {
  init(): Promise<void>;
  read(): Promise<SimRun>;
  update(patch: SimRunUpdate): Promise<SimRun>;
  writeLeaderState(state: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

const CREATE_TABLE_SQL = `
create table if not exists sim_run (
  id            smallint primary key check (id = 1),
  status        text not null default 'stopped' check (status in ('stopped', 'loading', 'running', 'failed')),
  year          integer,
  speed         integer not null default 1,
  index         integer not null default 0,
  total         integer not null default 0,
  started_at    timestamptz,
  last_fix_at   timestamptz,
  last_error    text,
  requested_by  text,
  leader_state  jsonb,
  leader_at     timestamptz,
  updated_at    timestamptz not null default now()
);
`;

const INSERT_ROW_SQL = `insert into sim_run (id) values (1) on conflict do nothing;`;

const SELECT_ROW_SQL = `
  select status, year, speed, index, total, started_at, last_fix_at, last_error,
         requested_by, leader_state, leader_at, updated_at
    from sim_run where id = 1
`;

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

function rowToSimRun(row: Record<string, unknown>): SimRun {
  return {
    status: row.status as SimRunStatus,
    year: row.year == null ? null : Number(row.year),
    speed: Number(row.speed ?? 0),
    index: Number(row.index ?? 0),
    total: Number(row.total ?? 0),
    startedAt: isoOrNull(row.started_at),
    lastFixAt: isoOrNull(row.last_fix_at),
    lastError: (row.last_error as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    leaderState:
      row.leader_state == null
        ? null
        : (row.leader_state as Record<string, unknown>),
    leaderAt: isoOrNull(row.leader_at),
    updatedAt: isoOrNull(row.updated_at) ?? "",
  };
}

export function buildPoolConfig(opts: DbOptions): PoolConfig {
  const parsed = parseConnectionString(opts.connectionString);
  const sslmodeRaw = (parsed as { sslmode?: unknown }).sslmode;
  const sslmode = typeof sslmodeRaw === "string" ? sslmodeRaw : null;
  const caPath = opts.caPath ?? RDS_CA_PATH;

  const base: PoolConfig = {};
  if (parsed.host != null) base.host = parsed.host;
  if (parsed.port != null && parsed.port !== "") {
    const port = Number(parsed.port);
    if (Number.isFinite(port)) base.port = port;
  }
  if (parsed.user != null) base.user = parsed.user;
  if (parsed.password != null) base.password = parsed.password;
  if (parsed.database != null) base.database = parsed.database;

  if (sslmode === "disable") {
    return { ...base, ssl: false };
  }
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    let ca: string;
    try {
      ca = readFileSync(caPath, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SIM_DB_CONNECTION uses sslmode=${sslmode} but the CA bundle at ${caPath} could not be read (${detail}); ` +
          `the RDS global bundle must be present at ${RDS_CA_PATH} (the Dockerfile installs it) or a readable file must be passed via caPath`,
      );
    }
    return { ...base, ssl: { ca, rejectUnauthorized: true } };
  }
  // sslmode=require, sslmode=prefer, or omitted: use TLS but skip verification.
  return { ...base, ssl: { rejectUnauthorized: false } };
}

export function createDb(opts: DbOptions): Db {
  const config = buildPoolConfig(opts);
  const pool = opts.createPool ? opts.createPool(config) : new Pool(config);

  async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function init(): Promise<void> {
    await withClient(async (c) => {
      await c.query(CREATE_TABLE_SQL);
      await c.query(INSERT_ROW_SQL);
    });
  }

  async function read(): Promise<SimRun> {
    return withClient(async (c) => {
      const r = await c.query<Record<string, unknown>>(SELECT_ROW_SQL);
      const row = r.rows[0];
      if (!row) throw new Error("sim_run row missing; init() must run first");
      return rowToSimRun(row);
    });
  }

  async function update(patch: SimRunUpdate): Promise<SimRun> {
    const sets: string[] = [];
    const values: unknown[] = [];
    function push(col: string, v: unknown): void {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    }
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.year !== undefined) push("year", patch.year);
    if (patch.speed !== undefined) push("speed", patch.speed);
    if (patch.index !== undefined) push("index", patch.index);
    if (patch.total !== undefined) push("total", patch.total);
    if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
    if (patch.lastFixAt !== undefined) push("last_fix_at", patch.lastFixAt);
    if (patch.lastError !== undefined) push("last_error", patch.lastError);
    if (patch.requestedBy !== undefined) push("requested_by", patch.requestedBy);
    sets.push(`updated_at = now()`);
    const sql = `update sim_run set ${sets.join(", ")} where id = 1
                 returning status, year, speed, index, total, started_at, last_fix_at,
                          last_error, requested_by, leader_state, leader_at, updated_at`;
    return withClient(async (c) => {
      const r = await c.query<Record<string, unknown>>(sql, values);
      const row = r.rows[0];
      if (!row) throw new Error("sim_run row missing on update");
      return rowToSimRun(row);
    });
  }

  async function writeLeaderState(state: Record<string, unknown>): Promise<void> {
    await withClient(async (c) => {
      await c.query(
        `update sim_run set leader_state = $1::jsonb, leader_at = now() where id = 1`,
        [JSON.stringify(state)],
      );
    });
  }

  async function close(): Promise<void> {
    await pool.end();
  }

  return { init, read, update, writeLeaderState, close };
}
