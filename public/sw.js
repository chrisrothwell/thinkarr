// Minimal service worker — network-first, no caching.
// Required for PWA installability; actual caching is out of scope.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  // Only intercept GET/HEAD navigation requests — let non-GET requests (POST, etc.)
  // and API calls bypass the SW entirely so the browser handles them natively.
  // Re-issuing non-GET requests via fetch(event.request) can cause the SW to replay
  // API calls (e.g. POST /api/voice/tts) as GET on subsequent visits, producing 405s.
  const { method, url } = event.request;
  if (method !== "GET" && method !== "HEAD") return;
  if (url.includes("/api/")) return;
  event.respondWith(fetch(event.request));
});
