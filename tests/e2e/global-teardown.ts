import { readFileSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { STATE_FILE, E2E_PORT } from "./global-setup";

const isWindows = process.platform === "win32";

function killPort(port: number): void {
  try {
    if (isWindows) {
      // netstat finds the PID, taskkill terminates it
      execSync(
        `for /f "tokens=5" %p in ('netstat -ano ^| findstr :${port}') do taskkill /PID %p /F`,
        { stdio: "ignore", shell: "cmd.exe" },
      );
    } else {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: "ignore" });
    }
  } catch {
    // Best-effort
  }
}

function killProcessTree(pid: number): void {
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      // Negative PID kills the entire process group (spawned with detached:true)
      process.kill(-pid, "SIGKILL");
    }
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
    killProcessTree(next.pid);
  } else if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { nextPid?: number };
      if (state.nextPid) killProcessTree(state.nextPid);
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
