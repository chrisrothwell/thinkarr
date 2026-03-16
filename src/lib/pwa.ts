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

/** Clears the dismissal so the PWA install banner will show again next time. */
export function resetPwaBannerDismissal(): void {
  try {
    localStorage.removeItem(PWA_DISMISSED_KEY);
  } catch {
    // Storage unavailable — silently ignore
  }
}
