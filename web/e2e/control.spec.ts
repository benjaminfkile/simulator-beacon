import { test, expect } from "@playwright/test";
import { TOTP } from "otpauth";

// The Playwright spec of simulator-beacon.md 11: sign in through the admin
// pool, pick 2025 at 60x, Start, the state shows `running` with a rising
// index, Stop. It runs only when E2E_BASE_URL and the dev admin's
// credentials are set; missing any of them skips the whole file rather than
// fail CI on an unconfigured environment.
//
// Environment expected:
//   E2E_BASE_URL              https://wmsfo-dev.vercel.app  (or the local dev URL)
//   E2E_ADMIN_USERNAME        the dev admin's email
//   E2E_ADMIN_PASSWORD        the dev admin's password
//   E2E_ADMIN_TOTP_SECRET     base32 secret from the enroller QR
//   E2E_YEAR                  optional, default "2025"
//   E2E_SPEED                 optional, default "60"

const REQUIRED = [
  "E2E_BASE_URL",
  "E2E_ADMIN_USERNAME",
  "E2E_ADMIN_PASSWORD",
  "E2E_ADMIN_TOTP_SECRET",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);

test.skip(missing.length > 0, `missing env: ${missing.join(", ")}`);

const YEAR = process.env.E2E_YEAR ?? "2025";
const SPEED = process.env.E2E_SPEED ?? "60";

test("sign in, start 2025 at 60x, watch running, stop", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /sign in/i }).click();

  // Cognito hosted UI (the classic template). The field labels are stable but
  // may drift; fall back to placeholder selectors.
  await page.locator('input[name="username"], input[type="email"]').first().fill(
    process.env.E2E_ADMIN_USERNAME!,
  );
  await page.locator('input[name="password"], input[type="password"]').first().fill(
    process.env.E2E_ADMIN_PASSWORD!,
  );
  await page
    .getByRole("button", { name: /(sign in|log in|continue)/i })
    .first()
    .click();

  const totp = new TOTP({ secret: process.env.E2E_ADMIN_TOTP_SECRET! });
  const code = totp.generate();
  await page.locator('input[name="totpCode"], input[inputmode="numeric"]').first().fill(code);
  await page
    .getByRole("button", { name: /(verify|confirm|sign in|continue)/i })
    .first()
    .click();

  await page.waitForURL("**/");
  await expect(page.getByTestId("year-select")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("year-select").selectOption(YEAR);
  await page.getByTestId("speed-select").selectOption(SPEED);
  await page.getByTestId("btn-start").click();

  await expect(page.getByTestId("run-status")).toHaveText(/running|loading/, {
    timeout: 20_000,
  });

  const initialIndex = await page.getByTestId("run-progress").innerText();
  await page.waitForTimeout(4_000);
  const laterIndex = await page.getByTestId("run-progress").innerText();
  expect(laterIndex).not.toEqual(initialIndex);

  await page.getByTestId("btn-stop").click();
  await expect(page.getByTestId("run-status")).toHaveText(/stopped/, {
    timeout: 20_000,
  });
});
