import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  SIM_ENV: "dev",
  SIM_API_BASE_URL: "https://api.example.com",
  SIM_API_KEY: "wak_abcdef",
  SIM_BEACON_KEY: "wbk_abcdef",
  SIM_HUB_URL: "wss://gateway.example.com/hub",
  SIM_INGEST_CHANNEL: "simulator-beacon-dev:ingest",
  SIM_GATEWAY_INTERNAL_URL: "http://172.17.0.1:8080",
  SIM_DB_CONNECTION: "postgresql://wmsfo_sim_app_dev:x@localhost:5432/wmsfo_sim_dev?sslmode=disable",
  SIM_COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
  SIM_COGNITO_CLIENT_IDS: "1abc,2def",
  SIM_ADMIN_GROUP: "admin",
  SIM_CORS_ORIGINS: "http://localhost:5175,https://sim.example.com",
  SIM_LOG_LEVEL: "info",
  GATEWAY_REALTIME_TOKEN: "grt_xxx",
} as const;

describe("loadConfig", () => {
  it("loads a valid environment", () => {
    const c = loadConfig({ ...base });
    expect(c.env).toBe("dev");
    expect(c.apiBaseUrl).toBe("https://api.example.com");
    expect(c.forceLeader).toBe(false);
    expect(c.cognitoClientIds).toEqual(["1abc", "2def"]);
    expect(c.corsOrigins).toEqual(["http://localhost:5175", "https://sim.example.com"]);
    expect(c.adminGroup).toBe("admin");
    expect(c.dbConnection).toContain("wmsfo_sim_dev");
  });

  it("fails fast on missing keys, listing only the names", () => {
    const env = { ...base } as Record<string, string | undefined>;
    delete env.SIM_HUB_URL;
    delete env.SIM_BEACON_KEY;
    try {
      loadConfig(env);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.keys).toContain("SIM_HUB_URL");
      expect(ce.keys).toContain("SIM_BEACON_KEY");
      // The message names keys but never values.
      expect(ce.message).not.toContain("wbk_");
      expect(ce.message).not.toContain("wss://");
    }
  });

  it("rejects SIM_FORCE_LEADER=true when SIM_ENV=prod", () => {
    expect(() =>
      loadConfig({ ...base, SIM_ENV: "prod", SIM_FORCE_LEADER: "true" }),
    ).toThrowError(/SIM_FORCE_LEADER/);
  });

  it("accepts SIM_FORCE_LEADER=true in dev", () => {
    const c = loadConfig({ ...base, SIM_FORCE_LEADER: "true" });
    expect(c.forceLeader).toBe(true);
  });

  it("makes GATEWAY_REALTIME_TOKEN optional when SIM_FORCE_LEADER=true", () => {
    const env = { ...base, SIM_FORCE_LEADER: "true" } as Record<string, string | undefined>;
    delete env.GATEWAY_REALTIME_TOKEN;
    const c = loadConfig(env);
    expect(c.forceLeader).toBe(true);
    expect(c.gatewayRealtimeToken).toBeNull();
  });

  it("requires GATEWAY_REALTIME_TOKEN when SIM_FORCE_LEADER is not set", () => {
    const env = { ...base } as Record<string, string | undefined>;
    delete env.GATEWAY_REALTIME_TOKEN;
    try {
      loadConfig(env);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).keys).toContain("GATEWAY_REALTIME_TOKEN");
    }
  });

  it("requires GATEWAY_REALTIME_TOKEN when SIM_FORCE_LEADER=false", () => {
    const env = { ...base, SIM_FORCE_LEADER: "false" } as Record<string, string | undefined>;
    delete env.GATEWAY_REALTIME_TOKEN;
    expect(() => loadConfig(env)).toThrowError(/GATEWAY_REALTIME_TOKEN/);
  });

  it("rejects a non-wak API key and non-wbk beacon key and a bad ingest channel", () => {
    expect(() => loadConfig({ ...base, SIM_API_KEY: "abc" })).toThrowError(/SIM_API_KEY/);
    expect(() => loadConfig({ ...base, SIM_BEACON_KEY: "abc" })).toThrowError(/SIM_BEACON_KEY/);
    expect(() => loadConfig({ ...base, SIM_INGEST_CHANNEL: "no-colon" })).toThrowError(
      /SIM_INGEST_CHANNEL/,
    );
  });

  it("rejects a non-wss hub URL and non-http gateway URL", () => {
    expect(() => loadConfig({ ...base, SIM_HUB_URL: "https://x" })).toThrowError(/SIM_HUB_URL/);
    expect(() => loadConfig({ ...base, SIM_GATEWAY_INTERNAL_URL: "wss://x" })).toThrowError(
      /SIM_GATEWAY_INTERNAL_URL/,
    );
  });

  it("rejects a non-postgres DB connection string", () => {
    expect(() =>
      loadConfig({ ...base, SIM_DB_CONNECTION: "mysql://x:y@localhost/db" }),
    ).toThrowError(/SIM_DB_CONNECTION/);
    expect(() =>
      loadConfig({ ...base, SIM_DB_CONNECTION: "not-a-url" }),
    ).toThrowError(/SIM_DB_CONNECTION/);
  });

  it("rejects a bad CORS origin", () => {
    expect(() =>
      loadConfig({ ...base, SIM_CORS_ORIGINS: "http://localhost:5175,notaurl" }),
    ).toThrowError(/SIM_CORS_ORIGINS/);
  });

  it("rejects a non-https Cognito issuer", () => {
    expect(() =>
      loadConfig({ ...base, SIM_COGNITO_ISSUER: "http://cognito.example.com" }),
    ).toThrowError(/SIM_COGNITO_ISSUER/);
  });
});
