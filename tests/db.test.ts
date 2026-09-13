// db.ts against a real Postgres. The runner points the test at a database by
// setting SIM_TEST_DB_CONNECTION (a libpq URI) or the standard libpq
// variables PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE. When neither is
// present the suite is skipped, so a checkout on a machine without a Postgres
// still passes typecheck and build.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPoolConfig, createDb, RDS_CA_PATH, type Db } from "../src/db.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const fsMod = await import("node:fs");
const readFileSyncMock = vi.mocked(fsMod.readFileSync);

describe("buildPoolConfig", () => {
  afterEach(() => {
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(() => {
      throw new Error("unmocked readFileSync call");
    });
  });

  it("sslmode=disable → ssl: false and explicit fields (no connectionString)", () => {
    const cfg = buildPoolConfig({
      connectionString: "postgresql://u:p@localhost:5433/mydb?sslmode=disable",
    });
    expect(cfg.ssl).toBe(false);
    expect(cfg.host).toBe("localhost");
    expect(cfg.port).toBe(5433);
    expect(cfg.user).toBe("u");
    expect(cfg.password).toBe("p");
    expect(cfg.database).toBe("mydb");
    expect(cfg).not.toHaveProperty("connectionString");
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("sslmode=verify-full → ssl: { ca, rejectUnauthorized: true } and reads the caPath", () => {
    readFileSyncMock.mockReturnValueOnce("---CA-PEM---");
    const cfg = buildPoolConfig({
      connectionString:
        "postgresql://u:p@db.example.com:5432/mydb?sslmode=verify-full",
      caPath: "/fixture/ca.pem",
    });
    expect(cfg.ssl).toEqual({ ca: "---CA-PEM---", rejectUnauthorized: true });
    expect(cfg.host).toBe("db.example.com");
    expect(cfg.port).toBe(5432);
    expect(readFileSyncMock).toHaveBeenCalledWith("/fixture/ca.pem", "utf8");
  });

  it("sslmode=verify-full defaults the CA path to RDS_CA_PATH when caPath is not set", () => {
    readFileSyncMock.mockReturnValueOnce("---CA---");
    buildPoolConfig({
      connectionString: "postgresql://u:p@h:5432/d?sslmode=verify-full",
    });
    expect(readFileSyncMock).toHaveBeenCalledWith(RDS_CA_PATH, "utf8");
  });

  it("sslmode=verify-ca → ssl: { ca, rejectUnauthorized: true }", () => {
    readFileSyncMock.mockReturnValueOnce("---CA---");
    const cfg = buildPoolConfig({
      connectionString: "postgresql://u:p@h:5432/d?sslmode=verify-ca",
      caPath: "/fixture/ca.pem",
    });
    expect(cfg.ssl).toEqual({ ca: "---CA---", rejectUnauthorized: true });
  });

  it("sslmode=verify-full with a missing CA file throws a clear error (no fallback)", () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file");
    });
    expect(() =>
      buildPoolConfig({
        connectionString: "postgresql://u:p@h:5432/d?sslmode=verify-full",
        caPath: "/nowhere.pem",
      }),
    ).toThrow(/sslmode=verify-full.*\/nowhere\.pem/);
  });

  it("sslmode=verify-ca with a missing CA file also throws", () => {
    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file");
    });
    expect(() =>
      buildPoolConfig({
        connectionString: "postgresql://u:p@h:5432/d?sslmode=verify-ca",
        caPath: "/nowhere.pem",
      }),
    ).toThrow(/sslmode=verify-ca/);
  });

  it("sslmode=require → ssl: { rejectUnauthorized: false } (no CA read)", () => {
    const cfg = buildPoolConfig({
      connectionString: "postgresql://u:p@h:5432/d?sslmode=require",
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("no sslmode → ssl: { rejectUnauthorized: false } (no CA read)", () => {
    const cfg = buildPoolConfig({
      connectionString: "postgresql://u:p@h:5432/d",
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("dist/db.js smoke test (Node ESM, no Vitest interop)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const distPath = resolve(here, "..", "dist", "db.js");
  const has = it.skipIf(!existsSync(distPath));
  has("imports cleanly under a fresh Node process", () => {
    const r = spawnSync(
      process.execPath,
      ["-e", `import('${distPath.replace(/\\/g, "\\\\")}')`],
      { encoding: "utf8" },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
  });
});

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
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({
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
