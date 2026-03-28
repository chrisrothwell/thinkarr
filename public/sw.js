// Minimal service worker — network-first, no caching.
// Required for PWA installability; actual caching is out of scope.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  // Only intercept same-origin GET/HEAD requests.
  // Cross-origin requests (e.g. external APIs fetched by the page) must bypass
  // the SW — intercepting them causes CSP violations and unexpected failures.
  // Non-GET requests and /api/ calls also bypass so the browser handles them natively.
  const { method, url } = event.request;
  if (method !== "GET" && method !== "HEAD") return;
  try {
    if (new URL(url).origin !== self.location.origin) return;
  } catch {
    return;
  }
  if (url.includes("/api/")) return;
  event.respondWith(fetch(event.request));
});
