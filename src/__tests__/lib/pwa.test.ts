import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPwaBannerDismissed,
  dismissPwaBanner,
  storeDeferredPrompt,
  isPwaInstallAvailable,
  onPwaAvailabilityChange,
  triggerPwaInstall,
  isMobileDevice,
  isIos,
  PWA_DISMISSED_KEY,
} from "@/lib/pwa";

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

// Build a minimal BeforeInstallPromptEvent stub
function makePromptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  return {
    preventDefault: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome }),
  } as unknown as Event;
}

// Reset the module-level singleton between tests by storing then clearing
function clearDeferredPrompt() {
  // Force-clear by triggering a fake install so the singleton nulls itself out
  // Use a private escape hatch: store a fake event then await triggerPwaInstall
  return triggerPwaInstall(); // consumes whatever is stored
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

  // --- localStorage helpers ---

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

    it("returns false when localStorage throws", () => {
      localStorageMock.getItem.mockImplementationOnce(() => { throw new Error("quota"); });
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

    it("does not throw when localStorage throws", () => {
      localStorageMock.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
      expect(() => dismissPwaBanner()).not.toThrow();
    });
  });

  // --- Module-level deferred prompt singleton ---

  describe("storeDeferredPrompt / isPwaInstallAvailable", () => {
    beforeEach(async () => {
      await clearDeferredPrompt();
    });

    it("isPwaInstallAvailable returns false initially", () => {
      expect(isPwaInstallAvailable()).toBe(false);
    });

    it("isPwaInstallAvailable returns true after storeDeferredPrompt", () => {
      storeDeferredPrompt(makePromptEvent());
      expect(isPwaInstallAvailable()).toBe(true);
    });
  });

  describe("onPwaAvailabilityChange", () => {
    beforeEach(async () => {
      await clearDeferredPrompt();
    });

    it("notifies listener when prompt is stored", () => {
      const listener = vi.fn();
      const unsub = onPwaAvailabilityChange(listener);
      storeDeferredPrompt(makePromptEvent());
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("does not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = onPwaAvailabilityChange(listener);
      unsub();
      storeDeferredPrompt(makePromptEvent());
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("triggerPwaInstall", () => {
    beforeEach(async () => {
      await clearDeferredPrompt();
    });

    it("returns 'unavailable' when no prompt is stored", async () => {
      const result = await triggerPwaInstall();
      expect(result).toBe("unavailable");
    });

    it("returns the browser outcome when prompt is available", async () => {
      storeDeferredPrompt(makePromptEvent("accepted"));
      const result = await triggerPwaInstall();
      expect(result).toBe("accepted");
    });

    it("clears the stored prompt after triggering", async () => {
      storeDeferredPrompt(makePromptEvent());
      await triggerPwaInstall();
      expect(isPwaInstallAvailable()).toBe(false);
    });

    it("notifies listeners when the prompt is consumed", async () => {
      storeDeferredPrompt(makePromptEvent());
      const listener = vi.fn();
      const unsub = onPwaAvailabilityChange(listener);
      await triggerPwaInstall();
      // listener called once when prompt stored, once when consumed
      expect(listener).toHaveBeenCalled();
      unsub();
    });
  });

  // --- Platform detection ---

  describe("isMobileDevice", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns true when pointer media query matches (touch device)", () => {
      vi.stubGlobal("window", { matchMedia: vi.fn().mockReturnValue({ matches: true }) });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns false when pointer media query does not match (desktop)", () => {
      vi.stubGlobal("window", { matchMedia: vi.fn().mockReturnValue({ matches: false }) });
      expect(isMobileDevice()).toBe(false);
    });
  });

  describe("isIos", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns true for iPhone user agent", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      });
      expect(isIos()).toBe(true);
    });

    it("returns true for iPad user agent", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/605.1.15",
      });
      expect(isIos()).toBe(true);
    });

    it("returns false for Android user agent", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/117.0.0.0",
      });
      expect(isIos()).toBe(false);
    });

    it("returns false for desktop Chrome user agent", () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/117.0.0.0",
      });
      expect(isIos()).toBe(false);
    });
  });
});
