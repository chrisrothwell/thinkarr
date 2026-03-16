"use client";

import { useEffect, useRef, useState } from "react";
import {
  storeDeferredPrompt,
  isPwaInstallAvailable,
  onPwaAvailabilityChange,
  triggerPwaInstall,
} from "@/lib/pwa";

/**
 * Registers the service worker and captures the beforeinstallprompt event.
 * Returns reactive install availability and a function to trigger the install.
 */
export function usePwaInstall() {
  // Initialise from the module singleton so components that mount after the
  // prompt was captured (e.g. navigating to Settings) get the correct value
  // without a synchronous setState call inside an effect.
  const [isAvailable, setIsAvailable] = useState(() => isPwaInstallAvailable());
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

  return { isAvailable, install: triggerPwaInstall };
}
