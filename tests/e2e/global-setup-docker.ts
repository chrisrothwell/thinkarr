/**
 * Playwright global setup — Docker container mode.
 *
 * Runs once before all Docker E2E tests:
 *   1. Start mock Plex and LLM HTTP servers on the host
 *   2. Start the Docker container with --network=host so it can reach the mocks
 *      via 127.0.0.1 and binds port 3000 directly on the host
 *   3. Verify the container is running as the expected PUID/PGID and that
 *      /config is owned correctly
 *   4. Create the admin user by completing the Plex OAuth flow
 *   5. Configure the app via POST /api/setup (requires admin session from step 4)
 *   6. Save the admin session cookie as Playwright storage state
 */

import { FullConfig, request } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startMockServers } from "./helpers/mock-servers";

export const DOCKER_PORT = 3000;
export const DOCKER_BASE_URL = `http://localhost:${DOCKER_PORT}`;
export const CONTAINER_NAME = "thinkarr-e2e";
export const DOCKER_STATE_FILE = path.join(process.cwd(), "tests/e2e/.docker-server-state.json");
export const ADMIN_AUTH_FILE = path.join(process.cwd(), "tests/e2e/.auth/admin.json");

// Expected PUID/PGID passed to the container — arbitrary non-root value
const TEST_PUID = "1001";
const TEST_PGID = "1001";

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

export default async function globalSetup(_: FullConfig) {
  // 1. Start mock servers — they bind to 127.0.0.1 which is reachable from
  //    the container because we use --network=host
  const mocks = await startMockServers();
  console.log(`[e2e-docker] Mock Plex server:  ${mocks.plexUrl}`);
  console.log(`[e2e-docker] Mock LLM server:   ${mocks.llmUrl}`);

  // 2. Isolated config dir on the host, mounted into the container as /config
  const configDir = mkdtempSync(path.join(tmpdir(), "thinkarr-e2e-docker-"));
  console.log(`[e2e-docker] Temp config dir:   ${configDir}`);

  // 3. Start the Docker container
  const image = process.env.E2E_DOCKER_IMAGE ?? "thinkarr:ci-test";
  execSync(
    [
      "docker run -d",
      `--name ${CONTAINER_NAME}`,
      "--network host",
      `-e PLEX_API_BASE=${mocks.plexUrl}`,
      "-e SECURE_COOKIES=false",
      "-e NEXT_TELEMETRY_DISABLED=1",
      `-e PUID=${TEST_PUID}`,
      `-e PGID=${TEST_PGID}`,
      `-v ${configDir}:/config`,
      image,
    ].join(" \\\n  "),
    { stdio: "inherit" },
  );
  console.log(`[e2e-docker] Container started: ${CONTAINER_NAME}`);

  // 4. Wait for the container's HTTP server to accept requests
  await waitForServer(DOCKER_BASE_URL);
  console.log("[e2e-docker] Container is ready");

  // 5. Verify PUID/PGID — check PID 1's actual UID/GID from /proc, not the
  //    docker exec session which always runs as root regardless of su-exec
  const uid = execSync(
    `docker exec ${CONTAINER_NAME} sh -c 'cat /proc/1/status | grep "^Uid:" | awk "{print \\$2}"'`,
  ).toString().trim();
  const gid = execSync(
    `docker exec ${CONTAINER_NAME} sh -c 'cat /proc/1/status | grep "^Gid:" | awk "{print \\$2}"'`,
  ).toString().trim();
  if (uid !== TEST_PUID || gid !== TEST_PGID) {
    throw new Error(
      `Container running as UID=${uid} GID=${gid}, expected ${TEST_PUID}:${TEST_PGID}`,
    );
  }
  console.log(`[e2e-docker] Process identity: UID=${uid} GID=${gid} ✓`);

  // 6. Verify /config ownership — confirms chown in entrypoint.sh ran correctly
  const configOwner = execSync(
    `docker exec ${CONTAINER_NAME} sh -c 'stat -c "%u:%g" /config'`,
  )
    .toString()
    .trim();
  if (configOwner !== `${TEST_PUID}:${TEST_PGID}`) {
    throw new Error(`/config owned by ${configOwner}, expected ${TEST_PUID}:${TEST_PGID}`);
  }
  console.log(`[e2e-docker] /config ownership: ${configOwner} ✓`);

  // 7. Create admin user via Plex OAuth flow first — POST /api/setup now
  //    requires an admin session, so we must establish one before configuring.
  //    The first user to complete OAuth is always promoted to admin with no
  //    library-access check, so no app config is needed at this stage.
  const apiCtx = await request.newContext({ baseURL: DOCKER_BASE_URL });

  const pinRes = await apiCtx.post("/api/auth/plex");
  const { data: pinData } = await pinRes.json();

  const callbackRes = await apiCtx.post("/api/auth/callback", {
    data: { pinId: pinData.id },
  });
  if (!callbackRes.ok()) {
    throw new Error(
      `POST /api/auth/callback failed: ${callbackRes.status()} ${await callbackRes.text()}`,
    );
  }
  console.log("[e2e-docker] Admin session created");

  // 8. Configure the app via POST /api/setup (LLM + Plex) — authenticated as admin
  const setupRes = await apiCtx.post("/api/setup", {
    data: {
      llm: {
        baseUrl: `${mocks.llmUrl}/v1`,
        apiKey: "e2e-api-key",
        model: "e2e-model",
      },
      plex: {
        url: mocks.plexUrl,
        token: "e2e-plex-admin-token",
      },
    },
  });
  if (!setupRes.ok()) {
    throw new Error(`POST /api/setup failed: ${setupRes.status()} ${await setupRes.text()}`);
  }
  console.log("[e2e-docker] App configured");

  // 9. Save admin session as Playwright storage state
  await apiCtx.storageState({ path: ADMIN_AUTH_FILE });
  await apiCtx.dispose();

  // 10. Persist state so teardown can clean up
  writeFileSync(DOCKER_STATE_FILE, JSON.stringify({ configDir }));

  // Keep mock servers alive for the duration of the test run
  (globalThis as Record<string, unknown>).__e2eMocks = mocks;
}
