import { vi } from "vitest";

// Silence Winston logger output during tests, but pass through real utility exports
vi.mock("@/lib/logger", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/logger")>();
  return {
    ...real,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});
