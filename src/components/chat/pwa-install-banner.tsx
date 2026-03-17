"use client";

import { useState } from "react";
import { X, Download, Share } from "lucide-react";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { isPwaBannerDismissed, dismissPwaBanner } from "@/lib/pwa";

export function PwaInstallBanner() {
  const { isAvailable, isMobile, isIosDevice, install } = usePwaInstall();
  const [dismissed, setDismissed] = useState(() => isPwaBannerDismissed());

  if (dismissed) return null;

  function handleDismiss() {
    dismissPwaBanner();
    setDismissed(true);
  }

  // iOS: beforeinstallprompt never fires — show manual instructions on mobile only
  if (isIosDevice && isMobile) {
    return (
      <div className="flex items-start gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
        <Share className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-muted-foreground">
          To install Thinkarr, tap <span className="font-medium text-foreground">Share</span> then{" "}
          <span className="font-medium text-foreground">Add to Home Screen</span>.
        </span>
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

  // Show install banner when the browser has offered the install prompt
  if (!isAvailable) return null;

  function handleInstall() {
    install().then(() => setDismissed(true));
  }

  return (
    <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
      <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-muted-foreground">
        Install Thinkarr as an app for quick access from your home screen or taskbar.
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
