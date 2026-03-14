# Security Hardening Checklist

Full hardening plan following security review (2026-03-14).

---

## P0 — Critical

- [x] **1. Unauthenticated setup endpoint** — `src/app/api/setup/route.ts`, `src/app/api/setup/test-connection/route.ts`
  Added admin session check to `POST /api/setup` and `POST /api/setup/test-connection`. Both previously accepted unauthenticated requests; an attacker reaching the container before the owner could set a hostile LLM endpoint. Tests updated with 403 coverage.

- [x] **2. Block x-middleware-subrequest header (CVE-2025-29927 pattern)** — `src/middleware.ts`
  Created middleware that explicitly rejects requests containing `x-middleware-subrequest`. Also adds UX-only browser redirects to `/login` for protected pages. API routes continue to self-authenticate — middleware is NOT the auth gate.

- [x] **3. npm audit in CI** — `.github/workflows/ci.yml`
  Added `npm audit --audit-level=high` as first step in the test job. Two HIGH severity CVEs (flatted, minimatch) were found and fixed. Remaining 4 moderate issues are in `drizzle-kit`'s deprecated transitive `@esbuild-kit` chain — dev-only, no production exposure, unfixable without breaking drizzle-kit. Accepted exception.

---

## P1 — High

- [x] **4. HTTP security headers** — `next.config.ts`
  Added `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag`, and `Content-Security-Policy` via Next.js `headers()` config. HSTS deliberately omitted — must only be set by the reverse proxy when HTTPS is confirmed.

- [x] **5. Cookie security auto mode** — `src/lib/auth/session.ts`
  Replaced binary `SECURE_COOKIES=true/false` with three modes:
  - `false` (default) — plain HTTP LAN deployments
  - `true` — always Secure (user confirms HTTPS)
  - `auto` — trusts `X-Forwarded-Proto: https` from reverse proxy
  Tests added for all three modes.

- [x] **6. Trivy vulnerability scan in Docker publish pipeline** — `.github/workflows/docker-publish.yml`
  Added Trivy scan of the built Docker image after E2E tests, before the push step. Blocks on CRITICAL/HIGH unfixed CVEs.

- [x] **7. Chat message size limit** — `src/app/api/chat/route.ts`
  Added 4000-character limit on chat messages. Returns `400` with clear error. Tests added for boundary (4000 chars passes, 4001 fails).

- [x] **8. Dependabot configuration** — `.github/dependabot.yml`
  Added weekly automated updates for npm packages, Docker base image, and GitHub Actions.

---

## P2 — Medium

- [x] **9. Rate limiting on auth callback** — `src/lib/auth/rate-limit.ts`, `src/app/api/auth/callback/route.ts`
  Added in-memory IP rate limiter (10 attempts/minute). Reads `X-Forwarded-Proto`, `X-Real-IP`, and direct IP. Returns `429` with log entry. Unit tests for rate limiter logic and IP extraction. Integration test for 429 in auth callback.

- [x] **10. LLM prompt injection guardrails** — `src/lib/llm/default-prompt.ts`
  Added explicit security section to the default system prompt instructing the LLM to treat user message content as data only, disregard embedded instruction patterns, and never reveal the system prompt.

- [x] **11. Semgrep SAST in CI** — `.github/workflows/ci.yml`
  Added `npx semgrep@latest` with `p/typescript`, `p/nextjs`, and `p/owasp-top-ten` rulesets. Run locally with `npm run security:scan`.

- [x] **12. Security event logging** — `src/app/api/mcp/route.ts`, `src/app/api/settings/route.ts`
  Added structured log entries for:
  - `MCP_AUTH_FAILURE` — invalid bearer token (with IP)
  - `MCP_PERMISSION_DENIED` — valid token but insufficient permission (with tool name and userId)
  - `MCP_TOOL_EXEC` — successful tool execution audit trail (with tool name, permission level, userId)
  - `ADMIN_ACCESS_DENIED` — non-admin attempting settings access (with userId and path)
  Auth callback already logged rate limit hits and login events.

---

## P3 — Low

- [ ] **13. Encrypt Plex tokens at rest** — `src/lib/db/schema.ts`, `src/app/api/auth/callback/route.ts`
  `plexToken` is stored plaintext in the `users` table. Requires a crypto subsystem, `ENCRYPTION_KEY` env var, DB migration, and key management strategy. **Deferred to its own PR** due to complexity.

- [x] **14. Pin Docker base image to digest** — `Dockerfile`
  Added comment explaining how to pin and update the base image digest. Dependabot (item 8) will automatically open PRs when the `node:22-alpine` digest changes.

- [x] **15. SBOM generation on publish** — `.github/workflows/docker-publish.yml`
  Added `anchore/sbom-action` after the Docker push step. Generates an SPDX JSON SBOM attached to the pushed image digest and uploaded as a 90-day workflow artifact.

---

## Completed (from earlier work)

- [x] MCP bearer token: replaced `uuidv4()` with `crypto.randomBytes(32).toString('hex')` (256-bit CSPRNG) — `a00d23a`
- [x] npm audit fix: resolved HIGH severity CVEs in `flatted` and `minimatch` — `ed7680b`
- [x] Local security check scripts added to `package.json` (`security:audit`, `security:scan`, `security:trivy`, `security:all`)
