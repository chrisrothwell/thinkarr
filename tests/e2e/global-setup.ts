/**
 * Playwright global setup
 *
 * Runs once before all E2E tests:
 *   1. Start mock Plex and LLM HTTP servers on random ports
 *   2. Start the Next.js server on port 3001, pointed at the mock services
 *      and an isolated temp database directory
 *   3. Create the admin user by completing the Plex OAuth flow against the
 *      mock Plex server (POST /api/auth/plex → POST /api/auth/callback)
 *   4. Configure the app via POST /api/setup (requires admin session from step 3)
 *   5. Save the admin session cookie as Playwright storage state so tests
 *      can reuse it without repeating the login flow
 *   6. Write server state (PIDs, URLs, temp dir) to a JSON file so global
 *      teardown can clean everything up
 */

import { FullConfig, request } from "@playwright/test";
import { spawn, ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startMockServers } from "./helpers/mock-servers";

export const E2E_PORT = 3001;
export const BASE_URL = `http://localhost:${E2E_PORT}`;
export const STATE_FILE = path.join(process.cwd(), "tests/e2e/.server-state.json");
export const ADMIN_AUTH_FILE = path.join(process.cwd(), "tests/e2e/.auth/admin.json");

// ---------------------------------------------------------------------------
// Wait for server to be ready
// ---------------------------------------------------------------------------

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Global setup entry point
// ---------------------------------------------------------------------------

export default async function globalSetup(_: FullConfig) {
  // 1. Start mock servers
  const mocks = await startMockServers();
  console.log(`[e2e] Mock Plex server:       ${mocks.plexUrl}`);
  console.log(`[e2e] Mock LLM server:        ${mocks.llmUrl}`);
  console.log(`[e2e] Mock Overseerr server:  ${mocks.overseerrUrl}`);

  // 2. Create isolated temp DB directory
  const configDir = mkdtempSync(path.join(tmpdir(), "thinkarr-e2e-"));
  console.log(`[e2e] Temp config dir:   ${configDir}`);

  // 3. Always use next dev for E2E — standalone requires manual static asset copying
  //    which is error-prone across platforms. Dev mode is sufficient for behaviour testing.
  const nextScript = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const cmd = [process.execPath, nextScript, "dev", "--port", String(E2E_PORT), "--turbopack"];

  console.log(`[e2e] Starting Next.js:  ${cmd.join(" ")}`);

  const nextProcess: ChildProcess = spawn(cmd[0], cmd.slice(1), {
    cwd: process.cwd(),

    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      CONFIG_DIR: configDir,
      PLEX_API_BASE: mocks.plexUrl,
      // Disable secure cookies so the session cookie works over plain HTTP
      SECURE_COOKIES: "false",
      // Suppress Next.js telemetry noise
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "pipe",
    // detached=true creates a new process group so we can kill the whole tree on teardown
    detached: true,
  });

  // Pipe stdout/stderr so failures are debuggable
  nextProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[next] ${d}`));
  nextProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[next] ${d}`));

  nextProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] Next.js exited with code ${code}`);
    }
  });

  // 4. Wait for Next.js to be ready
  await waitForServer(BASE_URL);
  console.log("[e2e] Next.js is ready");

  // 5. Create admin user via Plex OAuth flow first — POST /api/setup now
  //    requires an admin session, so we must establish one before configuring.
  //    The first user to complete OAuth is always promoted to admin with no
  //    library-access check, so no app config is needed at this stage.
  const apiCtx = await request.newContext({ baseURL: BASE_URL });

  //    Step 1: request a PIN (mock returns pin id 10001 immediately)
  const pinRes = await apiCtx.post("/api/auth/plex");
  const { data: pinData } = await pinRes.json();

  //    Step 2: exchange PIN for session (mock marks pin as claimed instantly)
  const callbackRes = await apiCtx.post("/api/auth/callback", {
    data: { pinId: pinData.id },
  });
  if (!callbackRes.ok()) {
    throw new Error(`POST /api/auth/callback failed: ${callbackRes.status()} ${await callbackRes.text()}`);
  }
  console.log("[e2e] Admin session created");

  // 6. Configure the app via POST /api/setup (LLM + Plex) — authenticated as admin
  const setupRes = await apiCtx.post("/api/setup", {
    data: {
      llm: {
        // OpenAI SDK appends /chat/completions to baseUrl, so the mock must serve /v1/*
        baseUrl: `${mocks.llmUrl}/v1`,
        apiKey: "e2e-api-key",
        model: "e2e-model",
      },
      plex: {
        url: mocks.plexUrl,
        token: "e2e-plex-admin-token",
      },
      overseerr: {
        url: mocks.overseerrUrl,
        apiKey: "e2e-overseerr-key",
      },
    },
  });
  if (!setupRes.ok()) {
    throw new Error(`POST /api/setup failed: ${setupRes.status()} ${await setupRes.text()}`);
  }
  console.log("[e2e] App configured");

  // 7. Save admin session as Playwright storage state
  await apiCtx.storageState({ path: ADMIN_AUTH_FILE });
  await apiCtx.dispose();

  // 8. Persist state so global teardown can clean up
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      nextPid: nextProcess.pid,
      configDir,
      plexUrl: mocks.plexUrl,
      llmUrl: mocks.llmUrl,
    }),
  );

  // Keep references alive for the duration of the test run.
  // Playwright keeps the globalSetup module loaded, so these stay in memory.
  (globalThis as Record<string, unknown>).__e2eMocks = mocks;
  (globalThis as Record<string, unknown>).__e2eNextProcess = nextProcess;
}
