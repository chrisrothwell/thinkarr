# Thinkarr Implementation Plan

## Context

Build an LLM-powered chat frontend for media management (*arr stack). Users log in via Plex, chat with an AI assistant that can search libraries, check availability, request content, and answer questions about movies/TV shows. Packaged as a Docker container following linuxserver.io conventions.

## Tech Stack

- **Framework**: Next.js 16 (App Router, `output: "standalone"`)
- **Language**: TypeScript throughout
- **Database**: SQLite via better-sqlite3 + Drizzle ORM, stored at `/config/thinkarr.db`
- **LLM**: OpenAI-compatible API via `openai` SDK (multi-endpoint support)
- **Tools**: In-process MCP-style tool registry (Zod schemas -> OpenAI function format), also exposed as external MCP endpoint
- **Auth**: Plex PIN-based OAuth (custom implementation, no NextAuth)
- **Styling**: Tailwind CSS 4, dark theme, shadcn/ui-style components
- **Docker**: Multi-stage Alpine/Node build, PUID/PGID/TZ support, `/config` volume

## Implementation Phases

### Phase 1: Foundation
- [x] Initialize Next.js project with TS, Tailwind, App Router
- [x] Install all dependencies
- [x] Write DB schema (app_config, users, sessions, conversations, messages) — `src/lib/db/schema.ts`
- [x] Write DB connection singleton + config reader/writer — `src/lib/db/index.ts`, `src/lib/config/index.ts`
- [x] Generate initial Drizzle migration — `drizzle/0000_short_gressill.sql`
- [x] Set up base UI components + dark theme + cn() utility — `src/components/ui/` (9 components), `src/app/globals.css`, `src/lib/utils.ts`
- [x] Configure next.config.ts (standalone output, better-sqlite3 external)

**Also completed (not originally in plan):**
- [x] DB migration utility + auto-migration on first connection — `src/lib/db/migrate.ts`, `src/lib/db/index.ts`
- [x] Type definitions — `src/types/index.ts`, `src/types/api.ts`, `src/types/chat.ts`
- [x] Drizzle config — `drizzle.config.ts`
- [x] ESLint + PostCSS config

### Phase 2: Setup & Onboarding
- [x] Setup API routes (GET status, POST save config, POST test-connection) — `src/app/api/setup/route.ts`, `src/app/api/setup/test-connection/route.ts`
- [x] Minimal service clients (connection testing only) — `src/lib/services/test-connection.ts`
- [x] Welcome splash page with "Login with Plex" for first-time setup — `src/app/setup/page.tsx`
- [x] Root page redirect logic (no users → setup, authenticated → chat) — `src/app/page.tsx`
- [x] Admin redirect to Settings when LLM not configured — `src/app/login/page.tsx`

### Phase 3: Authentication
- [x] Plex OAuth implementation (PIN-based flow) — `src/lib/services/plex-auth.ts`
- [x] Session management (create/validate/destroy + httpOnly cookie) — `src/lib/auth/session.ts`
- [x] Auth API routes (plex, callback, session) — `src/app/api/auth/{plex,callback,session}/route.ts`
- [x] Next.js proxy (cookie check, redirects) — `src/proxy.ts`
- [x] Login page UI with Plex popup flow — `src/app/login/page.tsx`
- [x] First user auto-promoted to admin — `src/app/api/auth/callback/route.ts`

### Phase 4: Chat UI
- [x] App layout with collapsible sidebar — `src/app/chat/page.tsx`
- [x] Sidebar (conversation list grouped by user for admin, new chat, user menu, service status) — `src/components/chat/sidebar.tsx`
- [x] Conversation CRUD API routes + useConversations hook (with admin `?all=true` support) — `src/app/api/conversations/`, `src/hooks/use-conversations.ts`
- [x] Chat components (message-list, message-bubble, message-content, chat-input) — `src/components/chat/`
- [x] useChat hook with SSE stream reading + model override — `src/hooks/use-chat.ts`
- [x] useAutoScroll hook — `src/hooks/use-auto-scroll.ts`
- [x] Model selector dropdown (per-user permissions, multi-endpoint) — `src/app/chat/page.tsx`, `src/app/api/models/route.ts`
- [x] Service status traffic lights (Green/Amber/Red) — `src/components/chat/service-status.tsx`, `src/app/api/services/status/route.ts`

### Phase 5: LLM Integration
- [x] OpenAI client factory from DB config (multi-endpoint resolution) — `src/lib/llm/client.ts`
- [x] System prompt builder — `src/lib/llm/system-prompt.ts`
- [x] Chat orchestrator (async generator with streaming, model override support) — `src/lib/llm/orchestrator.ts`
- [x] POST /api/chat route with SSE response + modelId passthrough — `src/app/api/chat/route.ts`
- [x] End-to-end wiring: type -> save -> stream -> render — `useChat` sends to `/api/chat`, reads SSE, renders via `MessageList`
- [x] Auto-title generation for new conversations — `generateTitle()` in orchestrator, called after first response

### Phase 6: MCP Tools
- [x] Tool registry with Zod -> JSON Schema -> OpenAI function format — `src/lib/tools/registry.ts`
- [x] Full service clients (plex, sonarr, radarr, overseerr) — `src/lib/services/{plex,sonarr,radarr,overseerr}.ts`
- [x] MCP tool definitions + auto-init — `src/lib/tools/{plex,sonarr,radarr,overseerr}-tools.ts`, `src/lib/tools/init.ts`
- [x] Tool call loop in chat orchestrator (max 5 rounds) — `src/lib/llm/orchestrator.ts`
- [x] Tool call display with "Running {Action} on {Service}..." labels — `src/components/chat/tool-call.tsx`
- [x] Historical tool call reconstruction from DB messages — `src/components/chat/message-list.tsx`
- [x] External MCP endpoint with bearer auth + permission framework — `src/app/api/mcp/route.ts`

### Phase 7: Settings & Admin
- [x] Tabbed settings page (LLM Setup, Plex & Arrs, MCP, Users) — `src/app/settings/page.tsx`
- [x] Multi-LLM endpoint management (add/remove/enable/disable) — `src/app/api/settings/route.ts`
- [x] Plex OAuth "Connect to Plex" button in settings — `src/app/api/settings/plex-connect/route.ts`
- [x] MCP bearer token management (view/copy/regenerate) — `src/app/api/settings/mcp-token/route.ts`
- [x] User management (role, default model, can-change-model) — `src/app/api/settings/users/route.ts`
- [x] Admin can view all user conversations grouped by user — `src/app/api/conversations/route.ts`, `sidebar.tsx`
- [x] Tabs UI component — `src/components/ui/tabs.tsx`

### Phase 8: Docker & Polish
- [x] Multi-stage Dockerfile with TZ timezone support — `Dockerfile`, `.dockerignore`
- [x] Entrypoint script (PUID/PGID, migrations, start) — `entrypoint.sh`
- [x] docker-compose.yml with TZ example — `docker-compose.yml`
- [x] README with full documentation — `README.md`
- [x] Loading states, error handling, responsive design — chat page loading spinner, auto-collapse sidebar on mobile
- [x] Next.js 16 proxy convention (middleware.ts → proxy.ts) — `src/proxy.ts`

### Phase 9: Bug Fixes & Settings Improvements

#### Fixed
- [x] **Docker auth loop** — Session cookie used `secure: true` whenever `NODE_ENV=production`, which browsers silently drop over plain HTTP. Changed to opt-in via `SECURE_COOKIES=true` env var (set this when running behind an HTTPS reverse proxy). — `src/lib/auth/session.ts`
- [x] **First message no response** — `setActiveConversationId()` in `handleSend` triggered a `useEffect` → `loadMessages()` which fetched from DB and called `setMessages([])`, overwriting the optimistic SSE placeholder mid-stream. Fixed with `streamingRef` (a `useRef` that tracks streaming state synchronously); `loadMessages` bails out early if a stream is active. — `src/hooks/use-chat.ts`
- [x] **New chats show "Unknown" user (admin view)** — `POST /api/conversations` returned no `userId`/`ownerName`, so the optimistic sidebar update lacked owner info. Response now includes both. — `src/app/api/conversations/route.ts`

- [x] **Test connection masked credentials** — Settings GET masks secrets as "••••••••"; frontend sent empty string; backend rejected. Test-connection route now resolves credentials server-side from stored config (by service type; by `endpointId` for multi-LLM). `TestConnectionRequest.apiKey` made optional, `endpointId` added. — `src/app/api/setup/test-connection/route.ts`, `src/types/api.ts`, `src/app/settings/page.tsx`
- [x] **LLM test max_tokens rejected** — Non-OpenAI endpoints (Ollama, LM Studio) reject `max_tokens: 1`. Test now retries without it if first attempt fails. — `src/lib/services/test-connection.ts`
- [x] **Default LLM endpoint** — Added `isDefault: boolean` to `LlmEndpoint` everywhere. Settings page uses radio group to select one default. PATCH enforces single-default invariant. `models/route.ts` uses `isDefault` endpoint as system default. — `src/app/api/settings/route.ts`, `src/app/api/models/route.ts`, `src/app/settings/page.tsx`
- [x] **Master admin lock** — PATCH `/api/settings/users` blocks `isAdmin=false` for lowest-ID user (server-enforced). Settings UI shows "Administrator (locked)" for that user instead of a role selector. — `src/app/api/settings/users/route.ts`, `src/app/settings/page.tsx`

- [x] **Chat auto-title real-time** — `generateTitle()` now returns `string | null`. Chat route awaits it inside the stream and emits a `title_update` SSE event before `[DONE]`. `useChat` calls an optional `onTitleUpdate` callback. `chat/page.tsx` wires this to `updateConversationTitle()` (new local-only update in `useConversations`) so the sidebar updates without a page refresh. — `src/lib/llm/orchestrator.ts`, `src/app/api/chat/route.ts`, `src/types/chat.ts`, `src/hooks/use-chat.ts`, `src/hooks/use-conversations.ts`, `src/app/chat/page.tsx`
- [x] **Traffic light false amber** — `checkLlm()` in the status route used `max_tokens: 1`; same endpoint compatibility fix as test-connection. — `src/app/api/services/status/route.ts`
- [x] **System prompt template** — Extracted `DEFAULT_SYSTEM_PROMPT` to `src/lib/llm/default-prompt.ts` (client-importable). Uses `{{serviceList}}` placeholder substituted at runtime. `buildSystemPrompt(customPrompt?)` accepts per-endpoint override. Orchestrator passes endpoint's `systemPrompt`. Settings textarea placeholder shows default template; hint explains `{{serviceList}}`. — `src/lib/llm/default-prompt.ts` (new), `src/lib/llm/system-prompt.ts`, `src/lib/llm/client.ts`, `src/lib/llm/orchestrator.ts`, `src/app/settings/page.tsx`

- [x] **Plex token input (direct)** — Removed Plex OAuth "Connect to Plex" button and polling flow. Replaced with a plain password input so users paste their Plex token directly (same UX as Sonarr/Radarr/Overseerr API keys). Includes hint text on where to find the token. — `src/app/settings/page.tsx`
- [x] **MCP tool improvements** — Plex: extracts `seasons`, `totalEpisodes`, `watchedEpisodes`, `dateAdded` from the existing search response fields (`childCount`, `leafCount`, `viewedLeafCount`, `addedAt`). Sonarr: replaced `sonarr_list_series` with `sonarr_get_series_status` (per-season episode counts, download progress, next air date); queue now includes `downloadPercent` and season/episode numbers. Radarr: replaced `radarr_list_movies` with `radarr_get_movie_status` (downloaded, in-queue, download %, time left); queue now includes `downloadPercent`. Overseerr: search returns per-season availability status and year; listRequests returns `seasonsRequested` and `requestedAt`. — `src/lib/services/{plex,sonarr,radarr,overseerr}.ts`, `src/lib/tools/{sonarr,radarr}-tools.ts`

### Phase 10: Features & Bug Fixes (features branch)

#### Bug Fixes
- [x] **Plex episode metadata missing** — `PlexSearchResult` extended with `showTitle`, `seasonNumber` (parentIndex), `episodeNumber` (index); `mapMetadata()` populates these when type is `"episode"`. — `src/lib/services/plex.ts`
- [x] **Historic conversation tool calls duplicate + phantom cursor** — Two root causes fixed: (1) `loadMessages` now clears `toolCalls` state before fetching so stale live tool calls cannot bleed into a loaded historical conversation; (2) `MessageBubble` no longer renders the content bubble (or its pulsing cursor) when a message has no content but already has tool calls rendered above it. — `src/hooks/use-chat.ts`, `src/components/chat/message-bubble.tsx`

#### Features
- [x] **Plex server discovery** — New `GET /api/settings/plex-devices` queries `plex.tv/api/v2/resources` using the admin's stored OAuth token and returns all linked Plex Media Servers. Settings Plex section now has a "Discover Servers" button; selecting a server auto-fills the URL (preferring local HTTP) and access token. Manual entry preserved as fallback. — `src/app/api/settings/plex-devices/route.ts`, `src/app/settings/page.tsx`
- [x] **Setup completion redirect + exit guard** — Settings page detects initial setup (no LLM endpoints on load). After a successful save, checks `/api/services/status`; if LLM and Plex are both green, a 5s countdown banner appears with a redirect to chat and a Cancel button. Back button and `beforeunload` show a confirmation guard while setup is incomplete. — `src/app/settings/page.tsx`
- [x] **Plex library membership check** — New `checkUserHasLibraryAccess(serverUrl, userToken)` in `plex-auth.ts` probes `GET /library/sections` on the configured Plex server with the registering user's personal token. New registrations (non-first user) are rejected with the standard error message when access is denied. Fails closed on network error. — `src/lib/services/plex-auth.ts`, `src/app/api/auth/callback/route.ts`
- [x] **Per-user rate limiting** — Rate limits stored in `app_config` as `user.{id}.rateLimit` JSON. `config/index.ts` exports `getRateLimit`, `setRateLimit`, `getPeriodStart`, `getNextPeriodStart` (calendar-aligned), `countUserMessagesSince` (join query). `/api/chat` enforces the limit before streaming; over-limit requests receive an SSE error: "Your Session Limit has expired and will refresh on DD/MMM/YY HH:MM". Default: 100 messages/day. Admin can set per-user limits (messages + period) in Settings > Users tab. — `src/lib/config/index.ts`, `src/app/api/chat/route.ts`, `src/app/api/settings/users/route.ts`, `src/app/settings/page.tsx`

#### Git Workflow
- `main` — production-ready merges only
- `dev` — integration branch; feature branches merge here before main
- `features` — active development branch (current)

### Phase 11: Title Cards, Logging & Bug Fixes (features branch)

#### Title Cards & Carousel (TODO #6)
- [x] **`display_titles` MCP tool** — New `display_titles` tool registered unconditionally. Accepts 1–10 title entries with rich metadata (mediaType, thumbPath, overseerrId, seasonNumber, etc.) and returns `DisplayTitle[]` with server-side resolved `thumbUrl` and `plexMachineId`. Zod schema uses `.nullish()` on all optional fields (LLMs send `null`; coercion to `undefined` done in handler). — `src/lib/tools/display-titles-tool.ts`, `src/lib/tools/init.ts`
- [x] **`DisplayTitle` type** — Shared type for title card data, including `plexMachineId` (for Watch Now URL) and `imdbId`. — `src/types/titles.ts`
- [x] **`TitleCard` component** — Horizontal card with thumbnail (TMDB or Plex), status badge (available/partial/pending/not_requested), rating, summary, cast, and action buttons (Watch Now → `app.plex.tv` universal link, More Info → IMDB or TMDB fallback, Request → `POST /api/request`). Request button shows spinner during request and switches to "Requested" badge on success. — `src/components/chat/title-card.tsx`
- [x] **`TitleCarousel` component** — Single title renders in `max-w-md` wrapper; multiple titles render in a horizontal snap-scroll carousel (`w-[352px]` per card) with hover-reveal left/right arrow buttons and hidden scrollbar. — `src/components/chat/title-carousel.tsx`
- [x] **`message-bubble.tsx` integration** — `display_titles` tool calls render as both a collapsible `ToolCall` panel (same as other tools) AND a `TitleCarousel` below it. Intermediate assistant messages (tool-calling rounds with no text) suppress the message bubble / pulsing cursor. — `src/components/chat/message-bubble.tsx`
- [x] **Request API route** — `POST /api/request` calls `requestMovie` or `requestTv` from Overseerr service. Accepts `seasons: [n]` for single-season requests. Auth required; logs success and failure. — `src/app/api/request/route.ts`
- [x] **Watch Now universal link** — Uses `https://app.plex.tv/desktop/#!/server/{machineId}/details?key={encodedKey}` — works externally and opens native Plex app on iOS/Android. `getPlexMachineId()` fetches and in-memory caches from `GET /` on the Plex server. — `src/lib/services/plex.ts`
- [x] **System prompt updated** — LLM instructed to always call `display_titles` after searching, never request media autonomously (button-only), and generate per-season cards for multi-season shows. — `src/lib/llm/default-prompt.ts`

#### Logging (TODO #10, #12, #15)
- [x] **Winston logger** — Singleton with Console transport (stdout, pretty-printed JSON with newline separator for Docker logs) and DailyRotateFile transport (`/config/logs/thinkarr-YYYY-MM-DD.log`, 14-day retention, 20 MB max). — `src/lib/logger.ts`, `next.config.ts`
- [x] **API call logging** — Full request URL, method, and response body (truncated to 5000 chars) logged at `info` level in all four service clients (Plex, Overseerr, Sonarr, Radarr). — `src/lib/services/{plex,overseerr,sonarr,radarr}.ts`
- [x] **Tool call/result logging** — `executeTool` logs tool name + args at call time and result (truncated to 2000 chars) on completion; errors logged at `error` level. — `src/lib/tools/registry.ts`
- [x] **Settings Logs tab** — `GET /api/settings/logs` lists log files (name, size, modified). `GET /api/settings/logs/[filename]` returns last 500 lines (or full with `?full=true`) or streams file for download (`?download=true`). Settings page has a new Logs tab with file selector, line count toolbar, scrollable `<pre>` viewer, and Download button. — `src/app/api/settings/logs/route.ts`, `src/app/api/settings/logs/[filename]/route.ts`, `src/app/settings/page.tsx`

#### Bug Fixes
- [x] **Overseerr `seasonCount` missing** — `/search` proxies TMDB which omits `numberOfSeasons`. Fixed by parallel `GET /tv/{id}` detail calls in `search()` using `Promise.all`. — `src/lib/services/overseerr.ts`
- [x] **Overseerr `mediaStatus: "Unknown"`** — Status code 1 (tracked, nothing requested) now maps to `"Not Requested"` instead of `"Unknown"`. — `src/lib/services/overseerr.ts`
- [x] **More Info button (IMDB/TMDB)** — Overseerr `/search` never returns `imdbId`; fixed by always showing More Info for requestable titles using IMDB when available, falling back to TMDB URL from `overseerrId`. — `src/components/chat/title-card.tsx`, `src/lib/services/overseerr.ts`
- [x] **Multi-season TV requests** — Removed `overseerr_request_movie` and `overseerr_request_tv` LLM tools. Requests made button-only with `seasons: [n]` payload for per-season requests. — `src/lib/tools/overseerr-tools.ts`
- [x] **Next.js proxy convention** — Renamed `src/middleware.ts` → `src/proxy.ts`, export `middleware` → `proxy`, eliminating build deprecation warning. — `src/proxy.ts`
- [x] **Posterless titles** — Overseerr-only results (not in Plex) use TMDB `posterUrl` directly as `thumbPath`; `display-titles-tool.ts` detects `startsWith("http")` and passes through without wrapping in Plex token URL. — `src/lib/tools/display-titles-tool.ts`
- [x] **`display_titles` Zod null rejection** — LLMs pass `null` for absent optional fields; schema now uses `.nullish()` (JSON Schema compatible, no transforms). Handler coerces `null → undefined` with `?? undefined`. — `src/lib/tools/display-titles-tool.ts`

### Phase 12: Bug Fixes & Enhancements

#### Security
- [x] **Per-user MCP bearer tokens (#9)** — Each user now has an individual MCP bearer token stored as `user.{id}.mcpToken` in `app_config`. `getUserMcpToken`, `setUserMcpToken`, `getUserIdByMcpToken` helpers added to `config/index.ts`. `authenticateMcp()` in `mcp/route.ts` checks per-user tokens after the global admin token (backward compat preserved). New `GET/POST /api/settings/mcp-token/user/[userId]` route (admin only). Settings > Users tab shows per-user token with copy + regenerate. — `src/lib/config/index.ts`, `src/app/api/mcp/route.ts`, `src/app/api/settings/mcp-token/user/[userId]/route.ts`, `src/app/settings/page.tsx`

#### Bug Fixes
- [x] **Plex recently added wrong titles (#14) + missing parent context (#16)** — `mapMetadata()` now handles `type: "season"`: title becomes "Show Name — Season N" (using `parentTitle`), `showTitle` and `seasonNumber` populated. `getRecentlyAdded()` fetches 20 items then deduplicates TV entries by show title, returning at most 10 unique results. Tool description updated to document `type` field and deduplication behaviour. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`
- [x] **Wrong avatar when admin views another user's conversation (#13)** — `ownerAvatarUrl` added to `Conversation` type and returned in the admin conversations query and `POST /api/conversations` response. `chat/page.tsx` detects when the active conversation belongs to a different user and passes that user's avatar/name to `MessageList`. — `src/types/index.ts`, `src/app/api/conversations/route.ts`, `src/app/chat/page.tsx`
- [x] **Flaky E2E test (#23)** — Added `data-testid="empty-chat-state"` to the empty chat placeholder in `MessageList`. E2E test updated to wait for this element to appear (positive assertion) instead of waiting for messages to disappear (negative, timing-sensitive). — `src/components/chat/message-list.tsx`, `tests/e2e/chat.spec.ts`
- [x] **Carousel arrows unreliable (#6)** — Changed from `hidden group-hover:flex` to `flex opacity-0 group-hover:opacity-100` (opacity transition is more reliable than display toggling under variable load). — `src/components/chat/title-carousel.tsx`
- [x] **Thumbnails unreliable on tab return (#17)** — Extended Plex thumb proxy `Cache-Control` from `max-age=3600` to `max-age=86400, stale-while-revalidate=86400` so cached images serve immediately when returning to a tab. — `src/app/api/plex/thumb/route.ts`

#### Features
- [x] **Reset to Default system prompt (#7)** — "Reset to Default" button appears next to the System Prompt label in LLM Settings when the field is non-empty; clicking it clears the field so the system falls back to `DEFAULT_SYSTEM_PROMPT`. — `src/app/settings/page.tsx`
- [x] **Version number in UI (#4)** — `NEXT_PUBLIC_APP_VERSION` exposed from `package.json` via `next.config.ts` env. Version displayed as `v{version}` in the bottom-left corner of the chat page (muted, non-interactive). — `next.config.ts`, `src/app/chat/page.tsx`

### Phase 14: Coordinated Dependency Upgrades (issue #68)

#### Dependency Upgrades
- [x] **Vitest 3 → 4 + coverage-v8 upgrade (#64/#67)** — Bumped `vitest` from `^3.2.4` to `^4.1.0` and `@vitest/coverage-v8` from `^3.2.4` to `^4.1.0` (coupled package pair, must stay on same major). Added `vite@^6.0.0` as a direct dev dep to satisfy Vitest 4's peer dependency. All 152 unit tests pass. — `package.json`, `package-lock.json`
- [x] **Drop redundant `eslint-plugin-jsx-a11y` direct dep** — `eslint-config-next` already bundles `eslint-plugin-jsx-a11y`; the direct entry was redundant. Removed to avoid future peer-dep conflicts. — `package.json`
- [ ] **ESLint 9 → 10 deferred (#62)** — `eslint-plugin-react` (bundled inside `eslint-config-next@16.1.6`) uses the removed `context.getFilename()` API and is incompatible with ESLint 10. Upgrade deferred until `eslint-config-next` ships ESLint 10 support.

### Phase 13: React 19 Upgrade Fix

#### Bug Fixes
- [x] **E2E tests #15/#16 broken by React 19.2.4 upgrade (#60)** — Fixed a race condition in `use-chat.ts` where the post-stream message reload fetch in `sendMessage`'s `finally` block could resolve after the user clicked "New Chat", overwriting the cleared state and preventing the `empty-chat-state` element from appearing. Added a `conversationIdRef` that tracks the current active conversation; the reload is now skipped (at both the pre-fetch and post-fetch stages) if the active conversation has changed since the message was sent. — `src/hooks/use-chat.ts`

#### Housekeeping
- [x] **ESLint warnings resolved (#25)** — Added `eslint-disable` comments for intentional `<img>` usage in `avatar.tsx` and `title-card.tsx`; fixed unused destructuring var in `registry.ts`; moved `options` to a ref in `use-chat.ts` to satisfy `react-hooks/exhaustive-deps` without stale closures. Zero warnings. — `src/components/ui/avatar.tsx`, `src/components/chat/title-card.tsx`, `src/lib/tools/registry.ts`, `src/hooks/use-chat.ts`

## Current File Structure

```
├── Dockerfile                       # Multi-stage Alpine/Node build (with TZ/tzdata)
├── .dockerignore                    # Excludes node_modules, .next, etc.
├── entrypoint.sh                    # PUID/PGID user creation + server start
├── docker-compose.yml               # Development/example compose (with TZ)
├── drizzle/
│   └── 0000_short_gressill.sql      # Initial migration (5 tables)
src/
├── proxy.ts                         # Auth cookie check + route protection (Next.js 16)
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── plex/route.ts        # POST create Plex PIN
│   │   │   ├── callback/route.ts    # POST exchange PIN for session (returns isAdmin)
│   │   │   └── session/route.ts     # GET current user / DELETE logout
│   │   ├── chat/route.ts            # POST send message, stream SSE (with modelId)
│   │   ├── conversations/
│   │   │   ├── route.ts             # GET list (?all=true for admin) / POST create
│   │   │   └── [id]/
│   │   │       ├── route.ts         # GET with messages (admin can view any) / DELETE
│   │   │       └── title/route.ts   # PATCH rename
│   │   ├── mcp/route.ts             # GET list tools / POST execute tool (bearer auth)
│   │   ├── models/route.ts          # GET available models for current user
│   │   ├── services/
│   │   │   └── status/route.ts      # GET service health status (traffic lights)
│   │   ├── settings/
│   │   │   ├── route.ts             # GET config (masked) / PATCH update (multi-LLM)
│   │   │   ├── mcp-token/route.ts   # GET/POST global admin bearer token management
│   │   │   ├── mcp-token/user/[userId]/route.ts  # GET/POST per-user MCP token (admin only)
│   │   │   ├── plex-connect/route.ts # POST Plex OAuth from settings
│   │   │   ├── plex-devices/route.ts # GET discovered Plex servers via plex.tv API
│   │   │   └── users/route.ts       # GET list / PATCH update user settings (incl. rate limits)
│   │   └── setup/
│   │       ├── route.ts             # GET status + POST save config
│   │       └── test-connection/
│   │           └── route.ts         # POST test service connectivity
│   ├── chat/
│   │   └── page.tsx                 # Chat page (sidebar + model picker + messages + input)
│   ├── login/
│   │   └── page.tsx                 # Plex OAuth login (redirects admin to settings if needed)
│   ├── settings/
│   │   └── page.tsx                 # 4-tab settings (LLM, Plex & Arrs, MCP, Users)
│   ├── setup/
│   │   └── page.tsx                 # Welcome splash ("Login with Plex" for first user)
│   ├── globals.css                  # Dark theme CSS variables + Tailwind 4
│   ├── layout.tsx                   # Root layout with Geist fonts
│   ├── page.tsx                     # Root redirect (no users → setup, else → chat)
│   └── favicon.ico
├── components/
│   ├── chat/
│   │   ├── chat-input.tsx           # Auto-resizing textarea + send/stop buttons
│   │   ├── message-bubble.tsx       # User/assistant message styling + avatar + tool calls + TitleCarousel interception
│   │   ├── message-content.tsx      # Markdown rendering (react-markdown + remark-gfm)
│   │   ├── message-list.tsx         # Scrollable messages + historical tool call reconstruction
│   │   ├── service-status.tsx       # Traffic light service status (green/amber/red)
│   │   ├── sidebar.tsx              # Collapsible sidebar + grouped conversations + service status
│   │   ├── title-card.tsx           # Rich title card (thumbnail, status, cast, Watch Now / Request / More Info buttons)
│   │   ├── title-carousel.tsx       # Single card or horizontal snap-scroll carousel with arrow buttons
│   │   └── tool-call.tsx            # "Running {Action} on {Service}" + expandable details
│   └── ui/
│       ├── avatar.tsx               # Image/fallback avatar (sm/md/lg)
│       ├── badge.tsx                # 4 variants
│       ├── button.tsx               # 6 variants + 4 sizes
│       ├── card.tsx                 # Card + Header/Title/Description/Content/Footer
│       ├── input.tsx                # Styled input field
│       ├── label.tsx                # Form label
│       ├── spinner.tsx              # Animated loading spinner
│       ├── tabs.tsx                 # Tabs/TabsList/TabsTrigger/TabsContent
│       └── textarea.tsx             # Multi-line text input
├── hooks/
│   ├── use-auto-scroll.ts           # Auto-scroll on new messages, respects manual scroll
│   ├── use-chat.ts                  # Messages state, SSE streaming, send/stop, model override
│   └── use-conversations.ts         # Conversation CRUD (list, create, delete, rename, viewAll)
├── lib/
│   ├── auth/
│   │   └── session.ts               # Session create/validate/destroy + cookie management
│   ├── config/
│   │   └── index.ts                 # getConfig/setConfig/getConfigMap/isSetupComplete + rate limit utils (getRateLimit, setRateLimit, getPeriodStart, countUserMessagesSince)
│   ├── db/
│   │   ├── index.ts                 # DB singleton + auto-migration
│   │   ├── migrate.ts               # runMigrations standalone utility
│   │   └── schema.ts               # 5 tables
│   ├── llm/
│   │   ├── client.ts                # OpenAI client factory (default + per-endpoint resolution)
│   │   ├── orchestrator.ts          # Chat streaming engine + model override + auto-title
│   │   └── system-prompt.ts         # Dynamic system prompt builder
│   ├── services/
│   │   ├── overseerr.ts             # Overseerr client (search, request, list)
│   │   ├── plex.ts                  # Plex client (search, on deck, recently added, availability)
│   │   ├── plex-auth.ts             # Plex PIN OAuth (create/check PIN, get user, checkUserHasLibraryAccess)
│   │   ├── radarr.ts                # Radarr client (search, list, queue)
│   │   ├── sonarr.ts                # Sonarr client (search, list, calendar, queue)
│   │   └── test-connection.ts       # Connection testers
│   ├── tools/
│   │   ├── display-titles-tool.ts   # display_titles tool (builds DisplayTitle[], resolves thumbUrl + machineId)
│   │   ├── init.ts                  # Auto-register tools based on configured services
│   │   ├── overseerr-tools.ts       # Overseerr tool definitions (search + list_requests; request tools removed)
│   │   ├── plex-tools.ts            # Plex tool definitions (4 tools)
│   │   ├── radarr-tools.ts          # Radarr tool definitions (3 tools)
│   │   ├── registry.ts              # Tool registry (defineTool, getOpenAITools, executeTool) + tool logging
│   │   └── sonarr-tools.ts          # Sonarr tool definitions (4 tools)
│   ├── logger.ts                    # Winston singleton (Console + DailyRotateFile to /config/logs/)
│   └── utils.ts                     # cn() class merge utility
└── types/
    ├── api.ts                       # SetupStatus, TestConnection, SetupSaveRequest types
    ├── chat.ts                      # SSE events, ChatRequest (with modelId), ToolCallDisplay types
    ├── index.ts                     # User, Session, Conversation (with ownerName), Message interfaces
    └── titles.ts                    # DisplayTitle, TitleMediaType, TitleMediaStatus types
```

## Database Schema

| Table | Key Columns |
|-------|-------------|
| app_config | key (PK), value, encrypted, updatedAt |
| users | id, plexId (unique), plexUsername, plexEmail, plexAvatarUrl, plexToken, isAdmin |
| sessions | id (UUID PK), userId (FK), expiresAt |
| conversations | id (UUID PK), userId (FK), title, createdAt, updatedAt |
| messages | id (UUID PK), conversationId (FK), role, content, toolCalls, toolCallId, toolName |

### Key Config Keys (app_config)

| Key | Purpose |
|-----|---------|
| llm.endpoints | JSON array of LLM endpoint configs (multi-endpoint) |
| llm.baseUrl / llm.apiKey / llm.model | Legacy single-endpoint keys (backward compat) |
| plex.url / plex.token | Plex server connection |
| sonarr.url / sonarr.apiKey | Sonarr connection |
| radarr.url / radarr.apiKey | Radarr connection |
| overseerr.url / overseerr.apiKey | Overseerr connection |
| mcp.bearerToken | Bearer token for external MCP access (admin-level, global) |
| user.{id}.defaultModel | Per-user default model selection |
| user.{id}.canChangeModel | Per-user permission to switch models |
| user.{id}.rateLimit | JSON: `{"messages": number, "period": "hour"|"day"|"week"|"month"}` |
| user.{id}.mcpToken | Per-user MCP bearer token (scoped to that user's permission level) |

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /api/setup | Check if setup complete |
| POST | /api/setup | Save initial config |
| POST | /api/setup/test-connection | Test service connectivity |
| POST | /api/auth/plex | Initiate Plex OAuth (returns PIN + URL) |
| POST | /api/auth/callback | Exchange PIN for token, create session (returns isAdmin) |
| GET | /api/auth/session | Get current user session |
| DELETE | /api/auth/session | Logout |
| POST | /api/chat | Send message + optional modelId, stream LLM response (SSE) |
| GET | /api/conversations | List conversations (?all=true for admin to see all users) |
| POST | /api/conversations | Create new conversation |
| GET | /api/conversations/[id] | Get conversation with messages (admin can view any) |
| DELETE | /api/conversations/[id] | Delete conversation |
| PATCH | /api/conversations/[id]/title | Rename conversation |
| GET | /api/mcp | List available MCP tools (bearer auth, permission-filtered) |
| POST | /api/mcp | Execute tool or list tools (bearer auth, permission-checked) |
| GET | /api/models | Get available models for current user (respects canChangeModel) |
| GET | /api/services/status | Get service health status (all 5 services) |
| GET | /api/settings | Get config with multi-LLM endpoints (secrets masked, admin) |
| PATCH | /api/settings | Update config including LLM endpoints (admin) |
| GET | /api/settings/mcp-token | Get global admin MCP bearer token (admin) |
| POST | /api/settings/mcp-token | Regenerate global admin MCP bearer token (admin) |
| GET | /api/settings/mcp-token/user/[userId] | Get per-user MCP token, auto-generate if missing (admin) |
| POST | /api/settings/mcp-token/user/[userId] | Regenerate per-user MCP token (admin) |
| POST | /api/settings/plex-connect | Plex OAuth from settings (create PIN / check claim) |
| GET | /api/settings/users | List all users with settings incl. rate limits (admin) |
| PATCH | /api/settings/users | Update user role/model/permissions/rate limit (admin) |
| GET | /api/settings/plex-devices | List Plex servers discoverable via admin's plex.tv account (admin) |
| GET | /api/settings/logs | List log files with name/size/modified (admin) |
| GET | /api/settings/logs/[filename] | Read last 500 lines or full log; `?download=true` streams file (admin) |
| POST | /api/request | Submit Overseerr media request (movie or TV with optional seasons array) |

## MCP Tools

| Server | Tools |
|--------|-------|
| Plex | plex_search_library, plex_get_on_deck, plex_get_recently_added, plex_check_availability |
| Sonarr | sonarr_search_series, sonarr_get_series_status, sonarr_get_calendar, sonarr_get_queue |
| Radarr | radarr_search_movie, radarr_get_movie_status, radarr_get_queue |
| Overseerr | overseerr_search, overseerr_list_requests |
| (built-in) | display_titles — renders TitleCarousel in chat UI (registered unconditionally) |

## MCP Permission Framework

| Permission | Query Tools | Action Tools | Scope |
|-----------|-------------|--------------|-------|
| Admin | All | All | All users, full system access |
| User | All query/read tools | request_movie, request_tv, monitor_series, monitor_movie | Own requests only, cannot delete others' requests |

External MCP access uses bearer token (from `mcp.bearerToken` config). Optional `X-User-Id` header scopes operations to a specific user's permission level.
