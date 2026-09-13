// Admin ID token check per simulator-beacon.md 5. The control API accepts
// `Authorization: Bearer <id-token>` from the admin pool. iss must be
// SIM_COGNITO_ISSUER, aud one of SIM_COGNITO_CLIENT_IDS, token_use "id",
// signature from the pool's JWKS (jose createRemoteJWKSet, cached), and
// cognito:groups must include SIM_ADMIN_GROUP. Anything else answers 401 or
// 403 with the contracts' error shape.

import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AdminAuthOptions {
  issuer: string;
  audiences: string[];
  adminGroup: string;
  // Test hook: substitute the JWKS resolver so the routes tests can mint a
  // token from a locally generated key pair without a live Cognito pool.
  jwks?: JWTVerifyGetKey;
}

export interface AdminPrincipal {
  sub: string;
  username: string | null;
  email: string | null;
  groups: string[];
  clientId: string | null;
  issuer: string;
  raw: JWTPayload;
}

export type AuthResult =
  | { ok: true; principal: AdminPrincipal }
  | { ok: false; status: 401 | 403; code: string; message: string };

const BEARER_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/;

export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = BEARER_RE.exec(header);
  return m ? m[1] ?? null : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function toGroups(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export interface AdminAuth {
  verify(header: string | null | undefined): Promise<AuthResult>;
}

export function createAdminAuth(opts: AdminAuthOptions): AdminAuth {
  const jwks =
    opts.jwks ?? createRemoteJWKSet(new URL(`${opts.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));

  async function verify(header: string | null | undefined): Promise<AuthResult> {
    const token = extractBearer(header);
    if (!token) {
      return {
        ok: false,
        status: 401,
        code: "unauthenticated",
        message: "missing bearer token",
      };
    }
    let payload: JWTPayload;
    try {
      const res = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        audience: opts.audiences,
      });
      payload = res.payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 401,
        code: "unauthenticated",
        message: msg,
      };
    }
    if (payload.token_use !== "id") {
      return {
        ok: false,
        status: 401,
        code: "unauthenticated",
        message: "token_use is not id",
      };
    }
    // jwtVerify already enforced exp when present. Guard against a token that
    // omits exp entirely: refuse without an expiry.
    if (typeof payload.exp !== "number") {
      return {
        ok: false,
        status: 401,
        code: "unauthenticated",
        message: "missing exp",
      };
    }
    const groups = toGroups(payload["cognito:groups"]);
    if (!groups.includes(opts.adminGroup)) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "admin group required",
      };
    }
    const principal: AdminPrincipal = {
      sub: typeof payload.sub === "string" ? payload.sub : "",
      username: stringOrNull(payload["cognito:username"]) ?? stringOrNull(payload.username),
      email: stringOrNull(payload.email),
      groups,
      clientId: stringOrNull(payload.client_id) ?? stringOrNull(payload.aud) ?? null,
      issuer: typeof payload.iss === "string" ? payload.iss : opts.issuer,
      raw: payload,
    };
    return { ok: true, principal };
  }

  return { verify };
}
