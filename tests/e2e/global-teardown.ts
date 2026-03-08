import { readFileSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { STATE_FILE, E2E_PORT } from "./global-setup";

function killPort(port: number): void {
  try {
    // fuser -k <port>/tcp sends SIGKILL to all processes listening on the port
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    // Best-effort
  }
}

export default async function globalTeardown() {
  // Stop mock servers (held in memory by global-setup module)
  const mocks = (globalThis as Record<string, unknown>).__e2eMocks as
    | { stop: () => Promise<void> }
    | undefined;
  if (mocks) await mocks.stop();

  // Kill the Next.js process tree
  const next = (globalThis as Record<string, unknown>).__e2eNextProcess as
    | { pid?: number; kill: (sig?: string) => void }
    | undefined;
  if (next?.pid) {
    try {
      process.kill(-next.pid, "SIGKILL");
    } catch {
      try { next.kill("SIGKILL"); } catch { /* ignore */ }
    }
  } else if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { nextPid?: number };
      if (state.nextPid) process.kill(-state.nextPid, "SIGKILL");
    } catch { /* ignore */ }
  }

  // Belt-and-suspenders: ensure nothing is left on the E2E port
  killPort(E2E_PORT);

  // Clean up temp DB directory
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { configDir: string };
      if (state.configDir) rmSync(state.configDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}
