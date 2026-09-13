// db.ts against a real Postgres. The runner points the test at a database by
// setting SIM_TEST_DB_CONNECTION (a libpq URI) or the standard libpq
// variables PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE. When neither is
// present the suite is skipped, so a checkout on a machine without a Postgres
// still passes typecheck and build.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../src/db.js";

function connectionStringFromEnv(): string | null {
  const direct = process.env.SIM_TEST_DB_CONNECTION;
  if (direct && direct.length > 0) return direct;
  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  if (!host || !database) return null;
  const user = process.env.PGUSER ?? "";
  const password = process.env.PGPASSWORD ?? "";
  const port = process.env.PGPORT ?? "5432";
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
  const sslmode = process.env.PGSSLMODE ?? "disable";
  return `postgresql://${auth}${host}:${port}/${encodeURIComponent(database)}?sslmode=${sslmode}`;
}

const connectionString = connectionStringFromEnv();
const has = describe.skipIf(!connectionString);

has("db.ts against a real Postgres", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb({ connectionString: connectionString! });
    // Start from an empty database: drop the table if a prior run left one.
    // The connection is direct; init() creates the table when missing.
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: connectionString!,
      ssl: connectionString!.includes("sslmode=disable") ? false : undefined,
    });
    try {
      await pool.query("drop table if exists sim_run");
    } finally {
      await pool.end();
    }
    await db.init();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("creates sim_run on an empty database and reads the row back", async () => {
    const row = await db.read();
    expect(row.status).toBe("stopped");
    expect(row.speed).toBe(1);
    expect(row.index).toBe(0);
    expect(row.total).toBe(0);
    expect(row.year).toBeNull();
    expect(row.leaderState).toBeNull();
  });

  it("init() is idempotent", async () => {
    await db.init();
    const row = await db.read();
    expect(row.status).toBe("stopped");
  });

  it("round-trips an update", async () => {
    const patched = await db.update({
      status: "loading",
      year: 2025,
      speed: 20,
      total: 1065,
      requestedBy: "alice@example.com",
    });
    expect(patched.status).toBe("loading");
    expect(patched.year).toBe(2025);
    expect(patched.speed).toBe(20);
    expect(patched.total).toBe(1065);
    expect(patched.requestedBy).toBe("alice@example.com");
    const reread = await db.read();
    expect(reread).toEqual(patched);
  });

  it("writeLeaderState writes leader_state and leader_at", async () => {
    await db.writeLeaderState({ socketState: "connected", debug: { nested: true } });
    const row = await db.read();
    expect(row.leaderState).toEqual({ socketState: "connected", debug: { nested: true } });
    expect(row.leaderAt).not.toBeNull();
  });
});
