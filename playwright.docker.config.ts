import { defineConfig, devices } from "@playwright/test";
import { DOCKER_BASE_URL } from "./tests/e2e/global-setup-docker";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup-docker.ts",
  globalTeardown: "./tests/e2e/global-teardown-docker.ts",

  // Smoke suite — only smoke-docker.spec.ts runs against the built image.
  // Full feature coverage lives in playwright.config.ts (dev-server suite).
  testMatch: /smoke-docker\.spec\.ts/,

  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",

  use: {
    baseURL: DOCKER_BASE_URL,

    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },

  projects: [
    {
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
