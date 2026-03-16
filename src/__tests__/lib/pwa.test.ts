import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPwaBannerDismissed, dismissPwaBanner, resetPwaBannerDismissal, PWA_DISMISSED_KEY } from "@/lib/pwa";

// Provide a minimal localStorage mock backed by a Map
function makeLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
    removeItem: vi.fn((key: string) => { store.delete(key); }),
    clear: vi.fn(() => store.clear()),
    store,
  };
}

describe("pwa utilities", () => {
  let localStorageMock: ReturnType<typeof makeLocalStorageMock>;

  beforeEach(() => {
    localStorageMock = makeLocalStorageMock();
    Object.defineProperty(global, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
  });

  describe("isPwaBannerDismissed", () => {
    it("returns false when nothing is stored", () => {
      expect(isPwaBannerDismissed()).toBe(false);
    });

    it("returns true after the key is set to 'true'", () => {
      localStorageMock.store.set(PWA_DISMISSED_KEY, "true");
      expect(isPwaBannerDismissed()).toBe(true);
    });

    it("returns false if the stored value is not 'true'", () => {
      localStorageMock.store.set(PWA_DISMISSED_KEY, "false");
      expect(isPwaBannerDismissed()).toBe(false);
    });
  });

  describe("dismissPwaBanner", () => {
    it("stores 'true' under the correct key", () => {
      dismissPwaBanner();
      expect(localStorageMock.setItem).toHaveBeenCalledWith(PWA_DISMISSED_KEY, "true");
      expect(localStorageMock.store.get(PWA_DISMISSED_KEY)).toBe("true");
    });

    it("makes isPwaBannerDismissed return true", () => {
      dismissPwaBanner();
      expect(isPwaBannerDismissed()).toBe(true);
    });
  });

  describe("resetPwaBannerDismissal", () => {
    it("removes the key from localStorage", () => {
      localStorageMock.store.set(PWA_DISMISSED_KEY, "true");
      resetPwaBannerDismissal();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(PWA_DISMISSED_KEY);
      expect(localStorageMock.store.has(PWA_DISMISSED_KEY)).toBe(false);
    });

    it("makes isPwaBannerDismissed return false after reset", () => {
      dismissPwaBanner();
      resetPwaBannerDismissal();
      expect(isPwaBannerDismissed()).toBe(false);
    });
  });

  describe("localStorage error handling", () => {
    it("isPwaBannerDismissed returns false when localStorage throws", () => {
      localStorageMock.getItem.mockImplementationOnce(() => { throw new Error("quota"); });
      expect(isPwaBannerDismissed()).toBe(false);
    });

    it("dismissPwaBanner does not throw when localStorage throws", () => {
      localStorageMock.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
      expect(() => dismissPwaBanner()).not.toThrow();
    });

    it("resetPwaBannerDismissal does not throw when localStorage throws", () => {
      localStorageMock.removeItem.mockImplementationOnce(() => { throw new Error("quota"); });
      expect(() => resetPwaBannerDismissal()).not.toThrow();
    });
  });
});
