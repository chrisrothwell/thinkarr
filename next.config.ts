import type { NextConfig } from "next";
import pkg from "./package.json";

// Security headers safe for both HTTP (LAN) and HTTPS (reverse proxy) deployments.
// DO NOT add Strict-Transport-Security here — HSTS must only be set by the
// reverse proxy when HTTPS is confirmed, or it will permanently break HTTP-only
// LAN deployments for affected browsers.
const securityHeaders = [
  // Prevent MIME-type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Deny framing to prevent clickjacking
  { key: "X-Frame-Options", value: "DENY" },
  // Limit referrer information sent to third-party origins
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable browser features not used by the app
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Prevent search engines from indexing home-server instances
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  // Content Security Policy — restricts resource loading to same origin.
  // unsafe-inline is required for Next.js App Router inline scripts/styles.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  serverExternalPackages: ["better-sqlite3", "winston", "winston-daily-rotate-file"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
