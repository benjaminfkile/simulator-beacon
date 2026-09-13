// The four VITE_* keys of simulator-beacon.md 5. A missing value renders the
// configuration page (see App.tsx). Reading env vars in one place keeps the
// rest of the app free of `import.meta.env` and keeps the tests simple.

export interface WebConfig {
  apiBaseUrl: string;
  cognitoAuthority: string;
  cognitoDomain: string;
  cognitoClientId: string;
}

export interface ConfigResult {
  ok: boolean;
  config: WebConfig | null;
  missing: string[];
}

const REQUIRED_KEYS = [
  "VITE_SIM_API_BASE_URL",
  "VITE_COGNITO_AUTHORITY",
  "VITE_COGNITO_DOMAIN",
  "VITE_COGNITO_CLIENT_ID",
] as const;

type Env = Record<string, string | undefined>;

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function loadWebConfig(env?: Env): ConfigResult {
  const source: Env =
    env ??
    (typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Env }).env ?? {}
      : {});
  const missing = REQUIRED_KEYS.filter((k) => !isNonEmpty(source[k]));
  if (missing.length > 0) {
    return { ok: false, config: null, missing: missing.slice() };
  }
  const config: WebConfig = {
    apiBaseUrl: source.VITE_SIM_API_BASE_URL!.replace(/\/$/, ""),
    cognitoAuthority: source.VITE_COGNITO_AUTHORITY!.replace(/\/$/, ""),
    cognitoDomain: source.VITE_COGNITO_DOMAIN!.replace(/\/$/, ""),
    cognitoClientId: source.VITE_COGNITO_CLIENT_ID!,
  };
  return { ok: true, config, missing: [] };
}
