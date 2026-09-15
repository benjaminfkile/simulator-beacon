// Validates every SIM_* key of simulator-beacon.md 7 and returns a typed Config.
// Fails fast: prints the key names that failed, never a value.

export interface Config {
  env: "dev" | "prod";
  apiBaseUrl: string;
  apiKey: string;
  beaconKey: string;
  hubUrl: string;
  ingestChannel: string;
  gatewayInternalUrl: string;
  dbConnection: string;
  cognitoIssuer: string;
  cognitoClientIds: string[];
  adminGroup: string;
  corsOrigins: string[];
  logLevel: string;
  forceLeader: boolean;
  // Required only when forceLeader is false, a forced leader never polls
  // /internal/leader, and the local recipe runs without a gateway.
  gatewayRealtimeToken: string | null;
}

export class ConfigError extends Error {
  constructor(public readonly keys: string[], message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED_KEYS = [
  "SIM_ENV",
  "SIM_API_BASE_URL",
  "SIM_API_KEY",
  "SIM_BEACON_KEY",
  "SIM_HUB_URL",
  "SIM_INGEST_CHANNEL",
  "SIM_GATEWAY_INTERNAL_URL",
  "SIM_DB_CONNECTION",
  "SIM_COGNITO_ISSUER",
  "SIM_COGNITO_CLIENT_IDS",
  "SIM_ADMIN_GROUP",
  "SIM_CORS_ORIGINS",
  "SIM_LOG_LEVEL",
] as const;

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseHttpUrl(v: string, keys: string[], key: string, protocols: string[]): URL | null {
  try {
    const u = new URL(v);
    if (!protocols.includes(u.protocol)) {
      keys.push(key);
      return null;
    }
    return u;
  } catch {
    keys.push(key);
    return null;
  }
}

function splitCsv(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bad: string[] = [];

  for (const k of REQUIRED_KEYS) {
    if (!isNonEmpty(env[k])) bad.push(k);
  }

  const envValueRaw = env.SIM_ENV;
  let envValue: Config["env"] | undefined;
  if (isNonEmpty(envValueRaw)) {
    if (envValueRaw === "dev" || envValueRaw === "prod") envValue = envValueRaw;
    else bad.push("SIM_ENV");
  }

  if (isNonEmpty(env.SIM_API_BASE_URL))
    parseHttpUrl(env.SIM_API_BASE_URL, bad, "SIM_API_BASE_URL", ["http:", "https:"]);
  if (isNonEmpty(env.SIM_HUB_URL))
    parseHttpUrl(env.SIM_HUB_URL, bad, "SIM_HUB_URL", ["ws:", "wss:"]);
  if (isNonEmpty(env.SIM_GATEWAY_INTERNAL_URL))
    parseHttpUrl(env.SIM_GATEWAY_INTERNAL_URL, bad, "SIM_GATEWAY_INTERNAL_URL", ["http:", "https:"]);
  if (isNonEmpty(env.SIM_COGNITO_ISSUER))
    parseHttpUrl(env.SIM_COGNITO_ISSUER, bad, "SIM_COGNITO_ISSUER", ["https:"]);

  if (isNonEmpty(env.SIM_API_KEY) && !env.SIM_API_KEY.startsWith("wak_"))
    bad.push("SIM_API_KEY");

  if (isNonEmpty(env.SIM_BEACON_KEY) && !env.SIM_BEACON_KEY.startsWith("wbk_"))
    bad.push("SIM_BEACON_KEY");

  if (isNonEmpty(env.SIM_INGEST_CHANNEL) && !env.SIM_INGEST_CHANNEL.includes(":"))
    bad.push("SIM_INGEST_CHANNEL");

  if (isNonEmpty(env.SIM_DB_CONNECTION)) {
    try {
      const u = new URL(env.SIM_DB_CONNECTION);
      if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") bad.push("SIM_DB_CONNECTION");
    } catch {
      bad.push("SIM_DB_CONNECTION");
    }
  }

  let cognitoClientIds: string[] = [];
  if (isNonEmpty(env.SIM_COGNITO_CLIENT_IDS)) {
    cognitoClientIds = splitCsv(env.SIM_COGNITO_CLIENT_IDS);
    if (cognitoClientIds.length === 0) bad.push("SIM_COGNITO_CLIENT_IDS");
  }

  let corsOrigins: string[] = [];
  if (isNonEmpty(env.SIM_CORS_ORIGINS)) {
    corsOrigins = splitCsv(env.SIM_CORS_ORIGINS);
    if (corsOrigins.length === 0) bad.push("SIM_CORS_ORIGINS");
    for (const o of corsOrigins) {
      try {
        const u = new URL(o);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          bad.push("SIM_CORS_ORIGINS");
          break;
        }
      } catch {
        bad.push("SIM_CORS_ORIGINS");
        break;
      }
    }
  }

  let forceLeader = false;
  if (isNonEmpty(env.SIM_FORCE_LEADER)) {
    const v = env.SIM_FORCE_LEADER.toLowerCase();
    if (v !== "true" && v !== "false") bad.push("SIM_FORCE_LEADER");
    else forceLeader = v === "true";
  }

  // SIM_FORCE_LEADER is a local-only override and is refused when SIM_ENV is prod.
  if (envValue === "prod" && forceLeader) bad.push("SIM_FORCE_LEADER");

  // GATEWAY_REALTIME_TOKEN is only used to authenticate GET /internal/leader.
  // A forced leader never polls that endpoint, so the token is optional in that
  // mode; every other run requires it.
  if (!forceLeader && !isNonEmpty(env.GATEWAY_REALTIME_TOKEN))
    bad.push("GATEWAY_REALTIME_TOKEN");

  const uniqueBad = Array.from(new Set(bad));
  if (uniqueBad.length > 0) {
    throw new ConfigError(
      uniqueBad,
      `invalid or missing configuration: ${uniqueBad.join(", ")}`,
    );
  }

  return {
    env: envValue!,
    apiBaseUrl: env.SIM_API_BASE_URL!.replace(/\/$/, ""),
    apiKey: env.SIM_API_KEY!,
    beaconKey: env.SIM_BEACON_KEY!,
    hubUrl: env.SIM_HUB_URL!,
    ingestChannel: env.SIM_INGEST_CHANNEL!,
    gatewayInternalUrl: env.SIM_GATEWAY_INTERNAL_URL!.replace(/\/$/, ""),
    dbConnection: env.SIM_DB_CONNECTION!,
    cognitoIssuer: env.SIM_COGNITO_ISSUER!,
    cognitoClientIds,
    adminGroup: env.SIM_ADMIN_GROUP!,
    corsOrigins,
    logLevel: env.SIM_LOG_LEVEL!,
    forceLeader,
    gatewayRealtimeToken: isNonEmpty(env.GATEWAY_REALTIME_TOKEN)
      ? env.GATEWAY_REALTIME_TOKEN
      : null,
  };
}
