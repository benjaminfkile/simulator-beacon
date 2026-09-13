// Control API: every code in simulator-beacon.md 5 against a fake row and
// tokens minted locally with a jose-generated key pair. A people-pool token
// is refused (audience mismatch, since the admin pool is a distinct pool);
// a token without cognito:groups=admin is refused (403).

import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type { FastifyInstance } from "fastify";
import { createAdminAuth } from "../src/control/auth.js";
import { buildControlServer } from "../src/control/routes.js";
import type { Db, SimRun, SimRunUpdate } from "../src/db.js";
import type { FlightsCache } from "../src/flights/cache.js";

type Key = Awaited<ReturnType<typeof generateKeyPair>>;

async function makeKey(): Promise<Key> {
  return generateKeyPair("RS256");
}

async function mint(
  key: Key,
  claims: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  const iss = overrides.issuer ?? "https://cognito-idp.us-west-2.amazonaws.com/pool-admin";
  const aud = overrides.audience ?? "client-admin";
  const exp = overrides.expiresIn ?? "1h";
  const jwt = await new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setIssuer(iss)
    .setAudience(aud)
    .sign(key.privateKey);
  return jwt;
}

function makeFakeDb(initial: Partial<SimRun> = {}): Db {
  let row: SimRun = {
    status: "stopped",
    year: null,
    speed: 1,
    index: 0,
    total: 0,
    startedAt: null,
    lastFixAt: null,
    lastError: null,
    requestedBy: null,
    leaderState: null,
    leaderAt: null,
    updatedAt: new Date().toISOString(),
    ...initial,
  };
  return {
    async init() {},
    async read() {
      return { ...row };
    },
    async update(patch: SimRunUpdate) {
      row = { ...row, ...patch, updatedAt: new Date().toISOString() } as SimRun;
      return { ...row };
    },
    async writeLeaderState(state) {
      row.leaderState = state;
      row.leaderAt = new Date().toISOString();
    },
    async close() {},
  };
}

function makeFakeCache(
  years: Array<{ year: number; eventId: number; name: string; pointCount: number }>,
  opts: { throwOnList?: boolean } = {},
): FlightsCache {
  return {
    async listYears() {
      if (opts.throwOnList) throw new Error("boom");
      return years;
    },
    async loadYear(year) {
      return {
        year,
        eventId: 1,
        name: "x",
        points: [],
        loadedAt: new Date().toISOString(),
        loadMs: 0,
      };
    },
    async refresh() {
      if (opts.throwOnList) throw new Error("boom");
    },
    cachedYears: () => [],
    lastLoad: () => ({ at: null, ms: null }),
  };
}

let key: Key;
let peopleKey: Key;
const ADMIN_ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/pool-admin";
const ADMIN_AUD = "client-admin";
const PEOPLE_ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/pool-people";

beforeAll(async () => {
  key = await makeKey();
  peopleKey = await makeKey();
});

async function buildServer(fakeDb: Db, fakeCache: FlightsCache): Promise<FastifyInstance> {
  const auth = createAdminAuth({
    issuer: ADMIN_ISSUER,
    audiences: [ADMIN_AUD],
    adminGroup: "admin",
    jwks: async () => key.publicKey,
  });
  const server = await buildControlServer({
    db: fakeDb,
    cache: fakeCache,
    auth,
    corsOrigins: ["http://localhost:5175"],
    probe: () => ({ configLoaded: true, leaderPolledOnce: true, isLeader: true }),
    buildBeaconState: () => ({}),
    instance: "test-instance",
  });
  return server;
}

async function inject(
  server: FastifyInstance,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers["Content-Type"] = "application/json";
  return server.inject({
    method: method as "GET" | "POST",
    url: path,
    headers,
    payload: body != null ? JSON.stringify(body) : undefined,
  });
}

describe("control API (simulator-beacon.md 5)", () => {
  it("GET /api/health answers 200 with leader flag", async () => {
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const res = await inject(server, "GET", "/api/health");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.leader).toBe(true);
    await server.close();
  });

  it("GET /api/health answers 503 before the leader has polled", async () => {
    const auth = createAdminAuth({
      issuer: ADMIN_ISSUER,
      audiences: [ADMIN_AUD],
      adminGroup: "admin",
      jwks: async () => key.publicKey,
    });
    const server = await buildControlServer({
      db: makeFakeDb(),
      cache: makeFakeCache([]),
      auth,
      corsOrigins: ["http://localhost:5175"],
      probe: () => ({ configLoaded: true, leaderPolledOnce: false, isLeader: false }),
      buildBeaconState: () => ({}),
      instance: null,
    });
    const res = await inject(server, "GET", "/api/health");
    expect(res.statusCode).toBe(503);
    await server.close();
  });

  it("refuses a missing token with 401", async () => {
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const res = await inject(server, "GET", "/control/state");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("unauthenticated");
    await server.close();
  });

  it("refuses a token from the people pool (wrong issuer/audience) with 401", async () => {
    const peopleToken = await new SignJWT({
      token_use: "id",
      "cognito:groups": ["user"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer(PEOPLE_ISSUER)
      .setAudience("client-people")
      .sign(peopleKey.privateKey);
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const res = await inject(server, "GET", "/control/state", peopleToken);
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("refuses an admin-pool token without the admin group with 403", async () => {
    const noGroupToken = await mint(key, {
      token_use: "id",
      "cognito:groups": ["user"],
      "cognito:username": "alice",
    });
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const res = await inject(server, "GET", "/control/state", noGroupToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    await server.close();
  });

  it("GET /control/state returns 200 with the row", async () => {
    const db = makeFakeDb({ status: "running", year: 2025, speed: 20, total: 100 });
    const server = await buildServer(db, makeFakeCache([]));
    const token = await mint(key, {
      token_use: "id",
      "cognito:groups": ["admin"],
      "cognito:username": "alice",
      email: "alice@example.com",
    });
    const res = await inject(server, "GET", "/control/state", token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.status).toBe("running");
    expect(body.run.year).toBe(2025);
    await server.close();
  });

  it("GET /control/years returns 200 with the list newest-first", async () => {
    const server = await buildServer(
      makeFakeDb(),
      makeFakeCache([
        { year: 2020, eventId: 1, name: "2020", pointCount: 10 },
        { year: 2025, eventId: 6, name: "2025", pointCount: 30 },
      ]),
    );
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "GET", "/control/years", token);
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].year).toBe(2025);
    await server.close();
  });

  it("GET /control/years returns 502 when the API refused", async () => {
    const server = await buildServer(makeFakeDb(), makeFakeCache([], { throwOnList: true }));
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "GET", "/control/years", token);
    expect(res.statusCode).toBe(502);
    await server.close();
  });

  it("POST /control/start with an unknown year returns 400 validation_failed", async () => {
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/start", token, {
      year: 2099,
      speed: 20,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    await server.close();
  });

  it("POST /control/start with a speed outside the set returns 400 validation_failed", async () => {
    const server = await buildServer(
      makeFakeDb(),
      makeFakeCache([{ year: 2025, eventId: 1, name: "2025", pointCount: 1 }]),
    );
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/start", token, {
      year: 2025,
      speed: 3,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    await server.close();
  });

  it("POST /control/start returns 200 with status loading", async () => {
    const server = await buildServer(
      makeFakeDb(),
      makeFakeCache([{ year: 2025, eventId: 1, name: "2025", pointCount: 1 }]),
    );
    const token = await mint(key, {
      token_use: "id",
      "cognito:groups": ["admin"],
      email: "alice@example.com",
    });
    const res = await inject(server, "POST", "/control/start", token, {
      year: 2025,
      speed: 20,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.status).toBe("loading");
    expect(body.run.year).toBe(2025);
    expect(body.run.speed).toBe(20);
    expect(body.run.requestedBy).toBe("alice@example.com");
    await server.close();
  });

  it("POST /control/start returns 409 already_running when a run is active", async () => {
    const db = makeFakeDb({ status: "running", year: 2025, speed: 20 });
    const server = await buildServer(
      db,
      makeFakeCache([{ year: 2025, eventId: 1, name: "2025", pointCount: 1 }]),
    );
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/start", token, {
      year: 2025,
      speed: 20,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("already_running");
    await server.close();
  });

  it("POST /control/stop returns 200 with status stopped and index preserved", async () => {
    const db = makeFakeDb({ status: "running", year: 2025, speed: 20, index: 42, total: 100 });
    const server = await buildServer(db, makeFakeCache([]));
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/stop", token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.status).toBe("stopped");
    expect(body.run.index).toBe(42);
    await server.close();
  });

  it("POST /control/restart returns 409 no_run when no year was ever set", async () => {
    const server = await buildServer(makeFakeDb(), makeFakeCache([]));
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/restart", token);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("no_run");
    await server.close();
  });

  it("POST /control/restart returns 200 with index reset to 0", async () => {
    const db = makeFakeDb({ status: "stopped", year: 2025, speed: 20, index: 88, total: 100 });
    const server = await buildServer(db, makeFakeCache([]));
    const token = await mint(key, { token_use: "id", "cognito:groups": ["admin"] });
    const res = await inject(server, "POST", "/control/restart", token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.status).toBe("loading");
    expect(body.run.index).toBe(0);
    expect(body.run.year).toBe(2025);
    await server.close();
  });
});
