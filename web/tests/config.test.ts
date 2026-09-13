import { describe, it, expect } from "vitest";
import { loadWebConfig } from "../src/config.js";

describe("loadWebConfig", () => {
  it("returns the config when every VITE_* key is set", () => {
    const r = loadWebConfig({
      VITE_SIM_API_BASE_URL: "https://api.example/",
      VITE_COGNITO_AUTHORITY: "https://cognito.example/pool/",
      VITE_COGNITO_DOMAIN: "https://auth.example",
      VITE_COGNITO_CLIENT_ID: "abc",
    });
    expect(r.ok).toBe(true);
    expect(r.config).toEqual({
      apiBaseUrl: "https://api.example",
      cognitoAuthority: "https://cognito.example/pool",
      cognitoDomain: "https://auth.example",
      cognitoClientId: "abc",
    });
  });

  it("lists every missing key", () => {
    const r = loadWebConfig({});
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      "VITE_SIM_API_BASE_URL",
      "VITE_COGNITO_AUTHORITY",
      "VITE_COGNITO_DOMAIN",
      "VITE_COGNITO_CLIENT_ID",
    ]);
  });
});
