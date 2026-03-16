"use client";

import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";
import { isPwaBannerDismissed, dismissPwaBanner } from "@/lib/pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function PwaInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Register the service worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failure is non-fatal
      });
    }

    // Don't show if already dismissed
    if (isPwaBannerDismissed()) return;

    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  function handleInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      setDeferredPrompt(null);
      setVisible(false);
    });
  }

  function handleDismiss() {
    dismissPwaBanner();
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
      <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-muted-foreground">
        Install Thinkarr as an app for quick access from your home screen.
      </span>
      <button
        onClick={handleInstall}
        className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        Install
      </button>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
        className="rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
