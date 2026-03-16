"use client";

import { useState } from "react";
import { X, Download } from "lucide-react";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { isPwaBannerDismissed, dismissPwaBanner } from "@/lib/pwa";

export function PwaInstallBanner() {
  const { isAvailable, install } = usePwaInstall();
  const [dismissed, setDismissed] = useState(() => isPwaBannerDismissed());

  if (!isAvailable || dismissed) return null;

  function handleInstall() {
    install().then(() => setDismissed(true));
  }

  function handleDismiss() {
    dismissPwaBanner();
    setDismissed(true);
  }

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
