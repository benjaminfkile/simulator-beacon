import { test, expect } from "@playwright/test";
import { TOTP } from "otpauth";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

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

// Cognito refuses a TOTP code that was already used, and two runs inside one
// 30 s window (the dev server run, then the preview run) would share it.
// Remember the last code per secret in the temp directory and wait for the
// window to turn over when it matches.
async function freshTotpCode(secret: string): Promise<string> {
  const totp = new TOTP({ secret });
  const memory = path.join(os.tmpdir(), `wmsfo-sim-e2e-totp-${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`);
  let last = "";
  try { last = fs.readFileSync(memory, "utf8"); } catch { /* first run */ }
  let code = totp.generate();
  while (code === last) {
    await new Promise((r) => setTimeout(r, 1000));
    code = totp.generate();
  }
  fs.writeFileSync(memory, code);
  return code;
}

test("sign in, start 2025 at 60x, watch running, stop", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /sign in/i }).click();

  // Cognito managed login. The admin panel's harness drives the fields by
  // their form name (stable across the template's label revisions) and the
  // TOTP field by its role, with one submit click per step.
  await page.locator('input[name="username"]').fill(
    process.env.E2E_ADMIN_USERNAME!,
  );
  await page.locator('input[name="password"]').fill(
    process.env.E2E_ADMIN_PASSWORD!,
  );
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.getByRole("textbox", { name: /code/i }).fill(await freshTotpCode(process.env.E2E_ADMIN_TOTP_SECRET!));
  await page.getByRole("button", { name: /sign in/i }).click();

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
