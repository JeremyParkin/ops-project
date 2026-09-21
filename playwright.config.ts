import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_STORAGE_STATE } from "./tests/e2e/helpers/auth-state";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    storageState: E2E_AUTH_STORAGE_STATE,
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run build -- --webpack && npm run start:e2e",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
