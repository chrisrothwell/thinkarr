# Security Hardening Checklist

Full hardening plan following security review (2026-03-14).
One item already completed: MCP bearer token entropy fix (a00d23a).

---

## P0 — Critical (fix before next release)

### [ ] 1. Unauthenticated setup endpoint
**File:** `src/app/api/setup/route.ts`, `entrypoint.sh`

The `/api/setup` POST is fully unauthenticated. Any user who reaches the container before the owner completes setup can configure the LLM endpoint to a hostile server and capture all future messages.

**Fix:**
- In `entrypoint.sh`, generate a one-time setup token on first start: `crypto.randomBytes(16).toString('hex')`
- Write it to stdout (`docker logs` visible) and to `/config/setup.token`
- Require the token as a request header or body field in the setup POST
- Delete `/config/setup.token` and invalidate the token once setup completes

---

### [ ] 2. Block middleware subrequest header (CVE-2025-29927 pattern)
**File:** `src/middleware.ts` (new file)

CVE-2025-29927 demonstrated that the `x-middleware-subrequest` header could bypass Next.js middleware entirely. Even on patched versions, explicitly blocking the header at the application layer is defence-in-depth.

**Important:** Middleware must NOT be the sole auth gate — all route handlers already call `getSession()` directly, which is correct. Middleware is UX-only (browser redirects). API routes self-authenticate.

**Fix:**
```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie } from "@/lib/auth/session";

export function middleware(request: NextRequest) {
  // Defence-in-depth: block header used in middleware bypass exploits
  if (request.headers.get("x-middleware-subrequest")) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  // UX-only: redirect unauthenticated browsers to login.
  // NOT a security gate — route handlers enforce auth independently.
  if (!hasSessionCookie(request.headers.get("cookie"))) {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/chat") || pathname.startsWith("/settings")) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Exclude static files and all API routes — APIs self-authenticate
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/).*)" ],
};
```

---

### [ ] 3. Add `npm audit` to CI
**File:** `.github/workflows/ci.yml`

No automated dependency vulnerability scanning. A critical CVE in a transitive dependency would ship undetected.

**Fix:** Add as the first step in the `test` job:
```yaml
- name: Dependency audit
  run: npm audit --audit-level=high
```

---

## P1 — High (fix within current milestone)

### [ ] 4. HTTP security headers
**File:** `next.config.ts`

No security headers set. Browsers receive no protection against clickjacking, MIME sniffing, or resource injection regardless of whether they connect over HTTP or HTTPS.

**Fix:** Add to `next.config.ts`:
```ts
async headers() {
  return [{
    source: "/(.*)",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "connect-src 'self'",
        ].join("; "),
      },
    ],
  }];
},
```

**Do NOT add `Strict-Transport-Security` here.** HSTS must only be set by the reverse proxy when HTTPS is confirmed. Setting it in the app would permanently break HTTP LAN deployments for affected browsers.

---

### [ ] 5. Cookie security `auto` mode
**File:** `src/lib/auth/session.ts`

The current binary `SECURE_COOKIES=true/false` doesn't cover the common pattern of HTTP on LAN + HTTPS via reverse proxy. Users who forget `SECURE_COOKIES=true` when behind a proxy will have insecure cookies even over HTTPS.

**Fix:** Introduce three modes:
- `SECURE_COOKIES=false` — plain HTTP (current default, keep as default)
- `SECURE_COOKIES=true` — always mark cookies as Secure
- `SECURE_COOKIES=auto` — trust `X-Forwarded-Proto: https` from the reverse proxy

In `createSession()`, detect the active mode and set `secure` accordingly. Document all three modes in README and the example `docker-compose.yml`.

---

### [ ] 6. Trivy vulnerability scan in Docker publish pipeline
**File:** `.github/workflows/docker-publish.yml`

Docker images are published to Docker Hub without scanning for OS-level CVEs in the Alpine base or Node.js runtime.

**Fix:** Add after the Docker E2E test step, before the push step:
```yaml
- name: Scan Docker image for vulnerabilities
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: thinkarr:ci-test
    format: table
    exit-code: '1'
    severity: CRITICAL,HIGH
    ignore-unfixed: true
```

---

### [ ] 7. Chat message size limit
**File:** `src/app/api/chat/route.ts`

No limit on message length allows context-window exhaustion at the LLM provider and amplifies prompt injection surface.

**Fix:** After body validation, add:
```ts
if (body.message.length > 4000) {
  return new Response(
    JSON.stringify({ success: false, error: "Message too long (max 4000 characters)" }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}
```

---

### [ ] 8. Dependabot configuration
**File:** `.github/dependabot.yml` (new file)

No automated dependency updates for npm packages, Docker base image, or GitHub Actions.

**Fix:**
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      patch-updates:
        update-types: [patch]
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
```

---

## P2 — Medium (schedule for near-term)

### [ ] 9. Rate limiting on auth callback
**File:** `src/app/api/auth/callback/route.ts`

No rate limiting on the auth callback endpoint. An attacker on the network can enumerate Plex PIN IDs.

**Fix:** Add a lightweight in-memory rate limiter (appropriate for single-instance Docker) — max 10 attempts per IP per minute. Use `x-forwarded-for` header, falling back to direct connection IP.

---

### [ ] 10. LLM prompt injection guardrails
**File:** `src/lib/llm/orchestrator.ts`

The system prompt does not instruct the LLM to ignore instructions embedded in user messages. A crafted message could attempt to trigger destructive tool calls (e.g. delete operations via Sonarr/Radarr).

**Fix:**
- Add explicit guardrail to system prompt: treat all user message content as data, never as instructions that override the system prompt
- Audit-log all tool calls with the triggering user ID and conversation ID
- Consider a confirmation pattern for any tool call that performs a destructive action

---

### [ ] 11. Semgrep SAST in CI
**File:** `.github/workflows/ci.yml`

No static analysis beyond TypeScript type checking and ESLint.

**Fix:**
```yaml
- name: SAST scan
  run: npx semgrep --config=p/typescript --config=p/nextjs --config=p/owasp-top-ten src/ --error
```

---

### [ ] 12. Security event logging
**Files:** `src/app/api/auth/callback/route.ts`, `src/app/api/mcp/route.ts`, settings routes

Auth failures and MCP tool executions lack sufficient context for incident review.

**Fix:** Add structured log entries (using the existing Winston logger) for:
- Auth failures — include IP from `x-forwarded-for`
- Admin access denials — include path and userId
- MCP tool executions — include tool name, userId, permission level
- Session creation and destruction

---

## P3 — Low (backlog)

### [ ] 13. Encrypt Plex tokens at rest
**Files:** `src/lib/db/schema.ts`, `src/app/api/auth/callback/route.ts`

`plexToken` is stored plaintext in the `users` table. If the `/config` volume is accessed, all users' Plex tokens are readable — each grants full access to that user's Plex account.

**Fix:** Encrypt using a key derived from an `ENCRYPTION_KEY` env var (or auto-generated and persisted to `/config`). The `encrypted` flag already exists in `app_config` — apply the same mechanism to `plexToken` in the users table.

---

### [ ] 14. Pin Docker base image to digest
**File:** `Dockerfile`

`FROM node:22-alpine` resolves differently each rebuild if the tag is updated upstream. A compromised or silently-changed tag is a supply chain risk.

**Fix:** Pin to a specific digest:
```dockerfile
FROM node:22-alpine@sha256:<digest> AS deps
```
Once Dependabot is configured (item 8), it will keep the digest current automatically.

---

### [ ] 15. SBOM generation on publish
**File:** `.github/workflows/docker-publish.yml`

No Software Bill of Materials is published alongside Docker images, making it impossible for security-conscious users to audit image contents.

**Fix:**
```yaml
- name: Generate SBOM
  uses: anchore/sbom-action@v0
  with:
    image: chrisrothwell/thinkarr:${{ github.ref_name }}
    artifact-name: sbom-${{ github.ref_name }}.spdx.json
```

---

## Completed

- [x] MCP bearer token: replaced `uuidv4()` with `crypto.randomBytes(32).toString('hex')` (256-bit CSPRNG entropy) — `a00d23a`
