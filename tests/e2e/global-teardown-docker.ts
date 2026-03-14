import { execSync } from "child_process";
import { readFileSync, rmSync, existsSync } from "fs";
import { CONTAINER_NAME, DOCKER_STATE_FILE } from "./global-setup-docker";

export default async function globalTeardown() {
  // Stop mock servers
  const mocks = (globalThis as Record<string, unknown>).__e2eMocks as
    | { stop: () => Promise<void> }
    | undefined;
  if (mocks) await mocks.stop();

  // Stop and remove the Docker container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Best-effort
  }

  // Clean up temp config dir
  if (existsSync(DOCKER_STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(DOCKER_STATE_FILE, "utf-8")) as { configDir: string };
      if (state.configDir) rmSync(state.configDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}
