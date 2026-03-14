import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, ADMIN_AUTH_FILE } from "./tests/e2e/global-setup";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",

  // Run each test file serially to avoid DB/session conflicts
  workers: 1,

  // Retry once on CI to handle timing flakiness
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [["github"], ["list"]] : "list",

  use: {
    baseURL: BASE_URL,

    // Keep trace/screenshots for failed tests to aid debugging
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    // Generous timeout — streaming responses take a few seconds
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    // Use system chromium if the expected revision isn't available (sandbox environments)
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },

  projects: [
    // -----------------------------------------------------------------------
    // Unauthenticated tests — routing, login flow
    // No storage state: browser starts with no cookies
    // -----------------------------------------------------------------------
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
    // -----------------------------------------------------------------------
    // Authenticated tests — chat features, rate limiting
    // Pre-loaded admin session so login is not repeated
    // -----------------------------------------------------------------------
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
