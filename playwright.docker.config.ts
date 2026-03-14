import { defineConfig, devices } from "@playwright/test";
import { DOCKER_BASE_URL, ADMIN_AUTH_FILE } from "./tests/e2e/global-setup-docker";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup-docker.ts",
  globalTeardown: "./tests/e2e/global-teardown-docker.ts",

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
      name: "routing",
      testMatch: /routing\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "login",
      testMatch: /login\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chat",
      testMatch: /chat\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: ADMIN_AUTH_FILE,
      },
    },
    {
      name: "rate-limit",
      testMatch: /rate-limit\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: ADMIN_AUTH_FILE,
      },
    },
  ],
});
