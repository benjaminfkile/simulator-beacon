// The control API of simulator-beacon.md 5, plus GET /api/health from
// simulator-beacon.md 2. Fastify serves both surfaces on the same port; CORS
// is opened for the exact origins in SIM_CORS_ORIGINS.
//
// The API only ever writes the sim_run row; it never talks to the hub or the
// scheduler directly. The leader's worker (see src/worker.ts) reads the row
// every second and acts on the transitions.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type { Db, SimRun } from "../db.js";
import type { FlightsCache } from "../flights/cache.js";
import type { AdminAuth, AdminPrincipal } from "./auth.js";
import { ApiError } from "../flights/api.js";
import { ALLOWED_SPEEDS, type Speed } from "../flights/scheduler.js";

export interface HealthProbe {
  configLoaded: boolean;
  leaderPolledOnce: boolean;
  isLeader: boolean;
}

export interface HeartbeatDebug {
  build(): Record<string, unknown>;
}

export interface ControlRoutesOptions {
  db: Db;
  cache: FlightsCache;
  auth: AdminAuth;
  corsOrigins: string[];
  probe: () => HealthProbe;
  buildBeaconState: () => Record<string, unknown>;
  instance: string | null;
  now?: () => number;
  logger?: boolean | object;
}

type ControlRequest = FastifyRequest & { adminPrincipal?: AdminPrincipal };

function errBody(code: string, message: string, details: unknown = null) {
  return { code, message, details, requestId: "" };
}

function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply
    .code(status)
    .header("Content-Type", "application/json; charset=utf-8")
    .send(body);
}

async function requireAdmin(
  auth: AdminAuth,
  req: ControlRequest,
  reply: FastifyReply,
): Promise<AdminPrincipal | null> {
  const header = req.headers.authorization ?? null;
  const result = await auth.verify(header);
  if (!result.ok) {
    sendJson(reply, result.status, errBody(result.code, result.message));
    return null;
  }
  req.adminPrincipal = result.principal;
  return result.principal;
}

function buildStateBody(row: SimRun, instance: string | null) {
  const leaderState =
    row.leaderState && typeof row.leaderState === "object"
      ? (row.leaderState as Record<string, unknown>)
      : null;
  const beacon = leaderState
    ? {
        name: (leaderState.name as string | null) ?? null,
        isActive: (leaderState.isActive as boolean | null) ?? null,
        liveEventId: (leaderState.liveEventId as number | null) ?? null,
        socketState: (leaderState.socketState as string | null) ?? null,
        lastDeliveredSeqLocal:
          (leaderState.lastDeliveredSeqLocal as number | null) ?? null,
        lastReceiptLatencyMs:
          (leaderState.lastReceiptLatencyMs as number | null) ?? null,
        heartbeatAge: (leaderState.heartbeatAge as number | null) ?? null,
        revoked: (leaderState.revoked as boolean | null) ?? null,
      }
    : null;
  const leaderAtMs = row.leaderAt ? Date.parse(row.leaderAt) : NaN;
  const fresh = Number.isFinite(leaderAtMs) && Date.now() - leaderAtMs <= 10_000;
  // Live index/cycles/nextFixInMs come from leader_state when fresh so
  // GET /control/state follows the scheduler within a second; else they fall
  // back to the row (the persisted `index` every ten fixes, `cycles` on
  // status writes, `nextFixInMs` null).
  const liveRun =
    fresh && leaderState && leaderState.run && typeof leaderState.run === "object"
      ? (leaderState.run as Record<string, unknown>)
      : null;
  const liveIndex =
    liveRun && typeof liveRun.index === "number" ? liveRun.index : row.index;
  const liveCycles =
    liveRun && typeof liveRun.cycles === "number" ? liveRun.cycles : row.cycles;
  const liveNextFixInMs =
    liveRun && typeof liveRun.nextFixInMs === "number"
      ? liveRun.nextFixInMs
      : null;
  return {
    run: {
      status: row.status,
      year: row.year,
      speed: row.speed,
      loop: row.loop,
      cycles: liveCycles,
      index: liveIndex,
      total: row.total,
      nextFixInMs: liveNextFixInMs,
      startedAt: row.startedAt,
      lastFixAt: row.lastFixAt,
      lastError: row.lastError,
      requestedBy: row.requestedBy,
      updatedAt: row.updatedAt,
    },
    beacon: fresh ? beacon : null,
    leaderInstance: fresh ? (instance ?? null) : null,
  };
}

export async function buildControlServer(
  opts: ControlRoutesOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, disableRequestLogging: true });

  // Fastify's default JSON parser rejects an empty body with 400. The stop
  // and restart endpoints take no body but a real browser fetch may still
  // send `Content-Type: application/json`; accept an empty payload as no
  // body rather than answer 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const s = typeof body === "string" ? body.trim() : "";
      if (s.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)), undefined);
      }
    },
  );

  await app.register(cors, {
    origin: opts.corsOrigins,
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  });

  app.get("/api/health", async (_req, reply) => {
    const p = opts.probe();
    if (!p.configLoaded || !p.leaderPolledOnce) {
      return sendJson(reply, 503, errBody("unavailable", "starting up"));
    }
    return sendJson(reply, 200, { status: "ok", leader: p.isLeader });
  });

  app.get("/control/state", async (req, reply) => {
    if (!(await requireAdmin(opts.auth, req as ControlRequest, reply))) return reply;
    const row = await opts.db.read();
    return sendJson(reply, 200, buildStateBody(row, opts.instance));
  });

  app.get("/control/years", async (req, reply) => {
    if (!(await requireAdmin(opts.auth, req as ControlRequest, reply))) return reply;
    try {
      const items = (await opts.cache.listYears())
        .slice()
        .sort((a, b) => b.year - a.year);
      return sendJson(reply, 200, { items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendJson(reply, 502, errBody("upstream_unavailable", msg));
    }
  });

  app.post("/control/start", async (req, reply) => {
    const principal = await requireAdmin(opts.auth, req as ControlRequest, reply);
    if (!principal) return reply;
    const body = (req.body ?? null) as {
      year?: unknown;
      speed?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return sendJson(reply, 400, errBody("validation_failed", "body required"));
    }
    const year = body.year;
    const speed = body.speed;
    const fields: Record<string, string> = {};
    if (typeof year !== "number" || !Number.isInteger(year)) fields.year = "must be an integer";
    if (typeof speed !== "number" || !(ALLOWED_SPEEDS as readonly number[]).includes(speed))
      fields.speed = `must be one of ${ALLOWED_SPEEDS.join(",")}`;
    if (Object.keys(fields).length > 0) {
      return sendJson(reply, 400, errBody("validation_failed", "invalid body", { fields }));
    }
    // Reject when a run is already active (loading or running); a stopped or
    // failed row is fair game.
    const current = await opts.db.read();
    if (current.status === "loading" || current.status === "running") {
      return sendJson(reply, 409, errBody("already_running", "a run is already active"));
    }
    // Guard the year against the current API answer so the caller gets 400
    // rather than a delayed `failed` for an unknown year. If the API is down
    // we let the row go to `loading` anyway, the worker will surface the
    // failure through the row and the panel.
    let known = true;
    try {
      const years = await opts.cache.listYears();
      known = years.some((y) => y.year === year);
    } catch {
      known = true;
    }
    if (!known) {
      return sendJson(
        reply,
        400,
        errBody("validation_failed", "unknown year", {
          fields: { year: "not a published event year" },
        }),
      );
    }
    // Start resumes (simulator-beacon.md 4): keep the row's index when the
    // requested year equals the row's year and 0 <= index < total; a run that
    // ended without loop (index == total) starts from 0. Restart is from 0 as
    // before; Stop keeps the index, so Stop then Start pauses and resumes.
    const sameYear = current.year === year;
    const resumeIndex =
      sameYear && current.index >= 0 && current.index < current.total
        ? current.index
        : 0;
    const patched = await opts.db.update({
      status: "loading",
      year: year as number,
      speed: speed as Speed,
      index: resumeIndex,
      total: sameYear ? current.total : 0,
      startedAt: null,
      lastError: null,
      requestedBy: principal.email ?? principal.username ?? principal.sub,
    });
    return sendJson(reply, 200, buildStateBody(patched, opts.instance));
  });

  app.post("/control/stop", async (req, reply) => {
    if (!(await requireAdmin(opts.auth, req as ControlRequest, reply))) return reply;
    const current = await opts.db.read();
    const patched = await opts.db.update({
      status: "stopped",
      index: current.index,
    });
    return sendJson(reply, 200, buildStateBody(patched, opts.instance));
  });

  app.patch("/control/run", async (req, reply) => {
    if (!(await requireAdmin(opts.auth, req as ControlRequest, reply))) return reply;
    const body = (req.body ?? null) as {
      year?: unknown;
      speed?: unknown;
      loop?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return sendJson(reply, 400, errBody("validation_failed", "body required"));
    }
    const patch: {
      year?: number;
      speed?: Speed;
      loop?: boolean;
    } = {};
    const fields: Record<string, string> = {};
    if (body.year !== undefined) {
      const year = body.year;
      if (typeof year !== "number" || !Number.isInteger(year)) {
        fields.year = "must be an integer";
      } else {
        // Guard the year against the current API answer so an unknown year
        // fails 400 rather than a delayed `failed` from the worker.
        let known = true;
        try {
          const years = await opts.cache.listYears();
          known = years.some((y) => y.year === year);
        } catch {
          known = true;
        }
        if (!known) {
          fields.year = "not a published event year";
        } else {
          patch.year = year;
        }
      }
    }
    if (body.speed !== undefined) {
      const speed = body.speed;
      if (
        typeof speed !== "number" ||
        !(ALLOWED_SPEEDS as readonly number[]).includes(speed)
      ) {
        fields.speed = `must be one of ${ALLOWED_SPEEDS.join(",")}`;
      } else {
        patch.speed = speed as Speed;
      }
    }
    if (body.loop !== undefined) {
      if (typeof body.loop !== "boolean") {
        fields.loop = "must be a boolean";
      } else {
        patch.loop = body.loop;
      }
    }
    if (Object.keys(fields).length > 0) {
      return sendJson(reply, 400, errBody("validation_failed", "invalid body", { fields }));
    }
    // No fields to patch: return the current row without touching it.
    if (Object.keys(patch).length === 0) {
      const current = await opts.db.read();
      return sendJson(reply, 200, buildStateBody(current, opts.instance));
    }
    const patched = await opts.db.update(patch);
    return sendJson(reply, 200, buildStateBody(patched, opts.instance));
  });

  app.post("/control/restart", async (req, reply) => {
    const principal = await requireAdmin(opts.auth, req as ControlRequest, reply);
    if (!principal) return reply;
    const current = await opts.db.read();
    if (current.year == null) {
      return sendJson(reply, 409, errBody("no_run", "no year to restart"));
    }
    const patched = await opts.db.update({
      status: "loading",
      index: 0,
      startedAt: null,
      lastError: null,
      requestedBy: principal.email ?? principal.username ?? principal.sub,
    });
    return sendJson(reply, 200, buildStateBody(patched, opts.instance));
  });

  // 404 answers the contracts' error shape.
  app.setNotFoundHandler((_req, reply) => {
    sendJson(reply, 404, errBody("not_found", "no route"));
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      sendJson(reply, 502, errBody("upstream_unavailable", err.message));
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 400 && (err as { code?: string }).code === "FST_ERR_VALIDATION") {
      sendJson(reply, 400, errBody("validation_failed", err.message));
      return;
    }
    sendJson(reply, status, errBody("server_error", err.message));
  });

  return app;
}
