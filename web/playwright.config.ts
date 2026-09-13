import { defineConfig, devices } from "@playwright/test";

// The dev control page: sign in through the admin pool, pick 2025 at 60x,
// Start, watch the state show `running` with a rising index, Stop. See
// simulator-beacon.md 11.
//
// The spec is skipped end-to-end when the credentials or the base URL are not
// present, so the plain `npm run e2e` in CI does not fail on an
// unconfigured environment.

const BASE = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE ?? "http://localhost:5175",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
