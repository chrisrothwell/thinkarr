"use client";

import { useEffect, useRef, useState } from "react";
import {
  storeDeferredPrompt,
  isPwaInstallAvailable,
  onPwaAvailabilityChange,
  triggerPwaInstall,
  isMobileDevice,
  isIos,
} from "@/lib/pwa";

/**
 * Registers the service worker and captures the beforeinstallprompt event.
 *
 * Returns:
 *   isAvailable   — true when a deferred prompt is ready to trigger
 *   isMobile      — true on touch-primary devices; callers should hide PWA UI on desktop
 *   isIosDevice   — true on iOS, where beforeinstallprompt never fires and
 *                   users must install manually via Safari Share sheet
 *   install       — triggers the native install flow
 */
export function usePwaInstall() {
  // Initialise from the module singleton so components that mount after the
  // prompt was captured (e.g. navigating to Settings) get the correct value
  // without a synchronous setState call inside an effect.
  const [isAvailable, setIsAvailable] = useState(() => isPwaInstallAvailable());
  const [isMobile] = useState(() => isMobileDevice());
  const [isIosDevice] = useState(() => isIos());
  const swRegistered = useRef(false);

  useEffect(() => {
    // Register the service worker exactly once per page load
    if (!swRegistered.current && "serviceWorker" in navigator) {
      swRegistered.current = true;
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failure is non-fatal
      });
    }

    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      storeDeferredPrompt(e);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    // Subscribe to changes so components re-render when the prompt is
    // consumed (installed or dismissed via the banner) or newly captured
    const unsub = onPwaAvailabilityChange(() => setIsAvailable(isPwaInstallAvailable()));

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      unsub();
    };
  }, []);

  return { isAvailable, isMobile, isIosDevice, install: triggerPwaInstall };
}
