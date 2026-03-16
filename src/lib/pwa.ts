/** localStorage key used to track PWA install banner dismissal. */
export const PWA_DISMISSED_KEY = "pwa-install-dismissed";

/** Returns true if the user has previously dismissed the PWA install banner. */
export function isPwaBannerDismissed(): boolean {
  try {
    return localStorage.getItem(PWA_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Marks the PWA install banner as dismissed so it won't show again. */
export function dismissPwaBanner(): void {
  try {
    localStorage.setItem(PWA_DISMISSED_KEY, "true");
  } catch {
    // Storage unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Module-level deferred prompt store
// Persists the BeforeInstallPromptEvent across client-side page navigations so
// that both the chat banner and the Settings > General tab can trigger install.
// ---------------------------------------------------------------------------

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let _deferredPrompt: BeforeInstallPromptEvent | null = null;
const _listeners = new Set<() => void>();

/** Store the deferred prompt and notify any registered listeners. */
export function storeDeferredPrompt(e: Event): void {
  _deferredPrompt = e as BeforeInstallPromptEvent;
  _listeners.forEach((fn) => fn());
}

/** Returns true if a deferred install prompt is currently available. */
export function isPwaInstallAvailable(): boolean {
  return _deferredPrompt !== null;
}

/**
 * Subscribe to changes in install-prompt availability.
 * Returns an unsubscribe function.
 */
export function onPwaAvailabilityChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Trigger the browser's native PWA install flow.
 * Returns the outcome, or "unavailable" if no prompt has been captured yet.
 */
export async function triggerPwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!_deferredPrompt) return "unavailable";
  const prompt = _deferredPrompt;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  _deferredPrompt = null;
  _listeners.forEach((fn) => fn());
  return outcome;
}
