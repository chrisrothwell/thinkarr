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
- [x] **Carousel arrows unreliable (#6)** — Changed from `hidden group-hover:flex` to `flex opacity-0 group-hover:opacity-100` (opacity transition is more reliable than display toggling under variable load). On mobile, hover events never fire so arrows were invisible; fixed by using `opacity-100 md:opacity-0 md:group-hover:opacity-100` so arrows are always visible below the `md` breakpoint. Buttons slightly enlarged (w-7→w-8) for prominence on touch screens. — `src/components/chat/title-carousel.tsx`
- [x] **Thumbnails unreliable on tab return (#17)** — Extended Plex thumb proxy `Cache-Control` from `max-age=3600` to `max-age=86400, stale-while-revalidate=86400` so cached images serve immediately when returning to a tab. — `src/app/api/plex/thumb/route.ts`

#### Features
- [x] **System prompt mode selector (#7)** — Replaced the "Reset to Default" button (which left the default text unviewable/uneditable) with a radio button pair: "Use Default Prompt" / "Use Custom Prompt". When "Use Default Prompt" is selected the textarea is populated with `DEFAULT_SYSTEM_PROMPT` so the user can read and start from it; editing the text automatically switches the radio to "Use Custom Prompt". Switching back to "Use Default Prompt" reverts the textarea to the default text. `promptMode` is UI-only state — saving strips it and sends `systemPrompt: ""` for default mode so future app-default updates are still picked up. — `src/app/settings/page.tsx`
- [x] **Version number in UI (#4)** — `NEXT_PUBLIC_APP_VERSION` exposed from `package.json` via `next.config.ts` env. Version displayed as `v{version}` in the bottom-left corner of the chat page (muted, non-interactive). — `next.config.ts`, `src/app/chat/page.tsx`

### Phase 15: Features & Security Hardening (#8, #15, #71)

#### Features
- [x] **User message stats in admin (#8)** — `GET /api/settings/users` now includes `msgCount24h`, `msgCount7d`, `msgCount30d` per user (using existing `countUserMessagesSince` helper). Settings > Users tab shows counts inline under the rate limit row as "Messages: N / 24h · N / 7d · N / 30d". — `src/app/api/settings/users/route.ts`, `src/app/settings/page.tsx`
- [x] **Plex collection search (#15)** — New `plex_search_collection` MCP tool. Queries all library sections for a matching collection by name then returns the items within it. Underlying `searchCollections(name)` function iterates sections via `/library/sections`, finds a match via `/library/sections/{key}/collections?title=`, then fetches children via `/library/collections/{id}/children`. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`
- [x] **Plex tag search (#15)** — New `plex_search_by_tag` MCP tool. Queries all movie and TV show sections for items tagged with a genre/mood/custom tag using `/library/sections/{key}/all?genre=`. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`

#### Security
- [x] **Title length validation (#71)** — `POST /api/conversations` and `PATCH /api/conversations/[id]/title` now reject titles longer than 200 characters with HTTP 400. — `src/app/api/conversations/route.ts`, `src/app/api/conversations/[id]/title/route.ts`
- [x] **Per-user API rate limiting (#71)** — New `checkUserApiRateLimit(userId)` utility (in-memory, 60 req/min per user, 1-minute sliding window). Applied to all `/api/conversations/*` and `/api/settings/*` routes; returns HTTP 429 when exceeded. Follows same pattern as existing auth IP rate limiter. — `src/lib/security/api-rate-limit.ts` (new), `src/app/api/conversations/route.ts`, `src/app/api/conversations/[id]/route.ts`, `src/app/api/conversations/[id]/title/route.ts`, `src/app/api/settings/route.ts`, `src/app/api/settings/users/route.ts`

### Phase 16: PWA Support (issue #76)

#### Features
- [x] **PWA installability (#76)** — Added `public/manifest.json` (standalone display, dark theme color) and `public/sw.js` (minimal network-first service worker). Updated `layout.tsx` with `manifest` metadata and `appleWebApp` properties. New `PwaInstallBanner` component shows a dismissible banner at the top of the chat window on mobile only (`pointer: coarse` detection); on Android/Chrome it uses `beforeinstallprompt` to trigger native install, on iOS it shows manual Share → Add to Home Screen instructions (iOS 16.4+ required). New "General" settings tab has platform-aware install UI: desktop users see a redirect message, iOS users see manual steps, Android users get a direct Install button. A module-level singleton in `pwa.ts` (`storeDeferredPrompt`, `triggerPwaInstall`, `isPwaInstallAvailable`, `onPwaAvailabilityChange`) shares the deferred prompt across SPA page navigations; `isMobileDevice()` and `isIos()` helpers cover platform detection. `usePwaInstall` hook provides reactive access and registers the SW. Settings defaults to LLM Setup during initial setup, General otherwise. — `public/manifest.json` (new), `public/sw.js` (new), `src/lib/pwa.ts` (new), `src/hooks/use-pwa-install.ts` (new), `src/components/chat/pwa-install-banner.tsx` (new), `src/app/layout.tsx`, `src/app/chat/page.tsx`, `src/app/settings/page.tsx`, `src/__tests__/lib/pwa.test.ts` (new)

### Phase 18: Bug Fixes & Enhancements (#15, #87, #88, #89, #90)

#### Features
- [x] **Plex multi-category tag search (#15)** — `searchByTag(tag, tagType)` extended to support `genre`, `director`, `actor`, `country`, `studio`, `contentRating`, `label`, and `mood` tag types. `TAG_TYPE_PARAM` map resolves the correct Plex API query parameter. Tool description updated with examples. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`
- [x] **Plex get title tags (#15)** — New `getTagsForTitle(metadataKey)` function fetches all tag categories (genres, directors, actors, countries, studio, contentRating, labels) for a specific title. New `plex_get_title_tags` MCP tool registered. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`
- [x] **Settings access for non-admin users (#90)** — Settings gear icon now visible for all users. Settings page conditionally renders admin-only tabs (LLM Setup, Plex & Arrs, Logs) and Save button. Non-admins see General, MCP (own token), and User (own account read-only) tabs. `/api/settings/mcp-token/user/[userId]` allows self-access. — `src/components/chat/sidebar.tsx`, `src/app/settings/page.tsx`, `src/app/api/settings/mcp-token/user/[userId]/route.ts`

#### Bug Fixes
- [x] **Version floating on mobile (#87)** — Fixed bottom-left version badge in chat page hidden on mobile (`hidden md:block`); version still visible in sidebar when opened. — `src/app/chat/page.tsx`
- [x] **Default system prompt: "leaving soon" (#88)** — Added guideline: use `plex_search_collection` with `'leaving soon'` when users ask what's expiring/leaving the library. — `src/lib/llm/default-prompt.ts`
- [x] **Overseerr titles returning Unknown (#89)** — `listRequests()` batch-fetches titles in parallel via `/movie/{tmdbId}` and `/tv/{tmdbId}` since the `/request` endpoint's media object lacks titles. Falls back gracefully on error. — `src/lib/services/overseerr.ts`

#### Tests
- [x] **`src/__tests__/lib/plex.test.ts`** — Added tests for `searchByTag` with `tagType` (country, director, default genre) and `getTagsForTitle` (full extraction, empty fields)
- [x] **`src/__tests__/lib/overseerr.test.ts`** — New: `listRequests` title resolution (movie, TV), seasons list, graceful fallback on fetch failure

### Phase 22: PWA Installability Fixes

#### Bug Fixes
- [x] **Manifest syntax error blocking PWA install** — Chrome's background PWA installability checker fetches `/manifest.json` without session cookies (unauthenticated context). The auth middleware was intercepting it and redirecting to the login page, so Chrome received HTML instead of JSON and reported "Manifest: Line 1, column 1, Syntax error". `beforeinstallprompt` never fired as a result. Fixed: `/manifest.json`, `/sw.js`, and icon files are now allowed through the middleware without a session cookie. — `src/proxy.ts`

- [x] **Service worker intercepting cross-origin requests** — The SW's fetch handler called `event.respondWith(fetch(event.request))` for all GET/HEAD requests, including cross-origin ones (e.g. `https://api.ipify.org`). When the browser's CSP blocked the re-issued fetch, the SW produced an unhandled rejection and a console error. Fixed: same-origin check added — the SW now only intercepts requests whose origin matches its own. — `public/sw.js`

- [x] **Sidebar fetching public IP via `api.ipify.org`** — `sidebar.tsx` fetched the user's public IP on every page load to display in the footer. This hit the cross-origin SW bug above and is a privacy concern (exposing the user's NAT IP in the UI). Removed entirely; unused `useState`/`useEffect` imports cleaned up. — `src/components/chat/sidebar.tsx`

#### Version
- Bumped to `1.1.4-beta.4`

### Phase 19: Orphaned Tool Call Repair (issue #151)

#### Bug Fix
- [x] **Conversations permanently stuck after server crash mid-tool-call (#151)** — When the server crashed (or the SSE connection dropped) between saving the assistant message with `tool_calls` to the DB and saving the corresponding tool result messages, the conversation was left with an orphaned `tool_call_id`. Every subsequent user message caused the LLM API to return HTTP 400: `"An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."` — making the conversation permanently unrecoverable without manual DB intervention.

  The fix is in `loadHistory()` in `src/lib/llm/orchestrator.ts`: after building the ordered message array from the DB, the function now scans for any assistant message whose `tool_calls` contain a `tool_call_id` that has no matching tool result message. For each such orphan it injects a synthetic error tool message (`{ error: "Tool call did not complete. Please try again." }`) immediately after the assistant message, restoring a valid OpenAI message sequence and allowing the LLM to recover gracefully. A `logger.warn` is emitted for each repair so the issue is visible in logs.

  This covers three crash scenarios: (1) all tool results missing, (2) a partial crash where only some tool results were saved, and (3) the healthy case where nothing is missing (no-op). — `src/lib/llm/orchestrator.ts`

#### Tests
- [x] **`src/__tests__/lib/orchestrator.test.ts`** — New test file with 3 cases: (1) full orphan — assistant with one unmatched tool call; verifies synthetic error result is injected at the right position and the LLM call succeeds; (2) healthy history — all tool calls have results; verifies no extra tool messages are injected; (3) partial orphan — two tool calls but only the first result saved; verifies exactly one synthetic result is injected for the missing ID.

### Phase 17: Realtime OpenAI-Only Guard (issue #80)

#### Bug Fix
- [x] **Realtime restricted to api.openai.com only (#80)** — ChatGPT-compatible providers (Gemini, Anthropic, local proxies) expose an OpenAI-compatible REST surface but do not implement the WebRTC-based Realtime API. Previously, `probeRealtimeSupport` would scan any endpoint's `/models` list for model IDs containing "realtime", which could falsely flag non-OpenAI endpoints as realtime-capable. Two guards added: (1) `isOpenAIEndpoint(url)` helper (exported from `test-connection.ts`) returns `true` only when the URL hostname is `api.openai.com`; `probeRealtimeSupport` returns `null` immediately for any other host. (2) `POST /api/realtime/session` checks `isOpenAIEndpoint(ep.baseUrl)` after the existing `supportsRealtime` check and returns HTTP 400 for non-OpenAI endpoints as a defence-in-depth measure. — `src/lib/services/test-connection.ts`, `src/app/api/realtime/session/route.ts`

#### Tests
- [x] **`src/__tests__/lib/services/is-openai-endpoint.test.ts`** — Unit tests for `isOpenAIEndpoint`: true for `api.openai.com`, false for Gemini/Anthropic/localhost/invalid URLs
- [x] **`src/__tests__/api/realtime-session.test.ts`** — Two new cases: Gemini-compatible endpoint (non-openai.com host) and Anthropic endpoint both return HTTP 400 even when `supportsRealtime: true`

### Phase 21: Realtime Mode Persistence & Cleanup (issue #232)

#### Bug Fixes
- [x] **Realtime turns not saved to conversation history (#232)** — Realtime mode ran in complete isolation from the main conversation system: turns were displayed in a local transcript div but never written to the DB, so they vanished on reload and were excluded from `report-issue` transcripts. Fixed with a new `POST /api/conversations/[id]/messages` endpoint that accepts `{ role, content }` and writes a message row. `useRealtimeChat` now accepts an `onTurnComplete` callback; it fires for each complete turn using `response.audio_transcript.done` (assistant) and `conversation.item.input_audio_transcription.completed` (user). `RealtimeChat` component passes this to the hook via `onTurn` prop. `chat/page.tsx` provides `handleRealtimeTurn`, which creates a conversation on demand (same pattern as `handleSend`) then POSTs each turn and reloads messages so they appear in `MessageList`. — `src/app/api/conversations/[id]/messages/route.ts` (new), `src/hooks/use-realtime-chat.ts`, `src/components/chat/realtime-chat.tsx`, `src/components/chat/chat-input.tsx`, `src/app/chat/page.tsx`

- [x] **User transcript ordering issue (#232)** — In the OpenAI Realtime flow, `response.audio_transcript.delta` events (assistant response) often arrive before `conversation.item.input_audio_transcription.completed` (user speech-to-text). The old code appended the user turn at the end, so the transcript showed assistant text before the user's question. Fixed: when user transcription arrives and the last transcript entry is an assistant turn, the user entry is inserted before it. — `src/hooks/use-realtime-chat.ts`

- [x] **Session leak on navigation (#232)** — Clicking "New Chat", switching conversations, or changing mode all unmount `RealtimeChat` but previously left the WebRTC peer connection and audio element open (no disconnect called). Fixed with a `useEffect` cleanup in `RealtimeChat` that calls `disconnect()` on unmount, covering all exit paths. — `src/components/chat/realtime-chat.tsx`

#### Tests
- [x] **`src/__tests__/api/conversation-messages.test.ts`** — New: 9 tests covering 401 (unauth), 400 (invalid role), 400 (missing/blank content), 404 (nonexistent conversation), 404 (other user's conversation), 200 user message saved to DB, 200 assistant message saved to DB, whitespace trimming

### Phase 14: Coordinated Dependency Upgrades (issue #68)

#### Dependency Upgrades
- [x] **Vitest 3 → 4 + coverage-v8 upgrade (#64/#67)** — Bumped `vitest` from `^3.2.4` to `^4.1.0` and `@vitest/coverage-v8` from `^3.2.4` to `^4.1.0` (coupled package pair, must stay on same major). Added `vite@^6.0.0` as a direct dev dep to satisfy Vitest 4's peer dependency. All 152 unit tests pass. — `package.json`, `package-lock.json`
- [x] **Drop redundant `eslint-plugin-jsx-a11y` direct dep** — `eslint-config-next` already bundles `eslint-plugin-jsx-a11y`; the direct entry was redundant. Removed to avoid future peer-dep conflicts. — `package.json`
- [ ] **ESLint 9 → 10 deferred (#62)** — `eslint-plugin-react` (bundled inside `eslint-config-next@16.1.6`) uses the removed `context.getFilename()` API and is incompatible with ESLint 10. Upgrade deferred until `eslint-config-next` ships ESLint 10 support.

### Phase 14: Voice & Realtime Modes (Issue #75)

#### Features
- [x] **Endpoint capability auto-detection** — `testLlm()` in `test-connection.ts` now probes `POST /audio/transcriptions` (voice) and `GET /models` (realtime model scan) after a successful connection test. `TestConnectionResponse` extended with `capabilities: { supportsVoice, realtimeModel }`. Settings UI writes detected flags back to the endpoint config on test success. — `src/lib/services/test-connection.ts`, `src/types/api.ts`, `src/app/settings/page.tsx`
- [x] **Endpoint voice/realtime config fields** — `LlmEndpoint` extended with `supportsVoice`, `supportsRealtime`, `realtimeModel` (optional, empty = disabled), `realtimeSystemPrompt` (empty = use default). Settings UI shows auto-detected capability badges and a `realtimeModel` override input; when set, a realtime system prompt editor appears with Default/Custom mode (same pattern as text system prompt). — `src/app/api/settings/route.ts`, `src/lib/llm/client.ts`, `src/app/api/models/route.ts`, `src/app/settings/page.tsx`
- [x] **Mode toggle in chat** — `chat/page.tsx` tracks `chatMode` ("text" | "voice" | "realtime") and `endpointCaps`. `ChatInput` shows a mode toggle pill bar when the selected endpoint supports voice or realtime; resets to "text" on model switch if the new endpoint lacks the current mode. — `src/app/chat/page.tsx`, `src/components/chat/chat-input.tsx`
- [x] **Voice mode (Whisper STT)** — `POST /api/voice/transcribe` accepts audio file + modelId, calls `client.audio.transcriptions.create({ file, model: "whisper-1" })`, returns `{ transcript }`. `useVoiceInput` hook uses `MediaRecorder` API; `VoiceInput` component shows mic button with click-to-record-toggle, spinner while transcribing, inline error. On transcript: sends as chat message and reverts to text mode. — `src/app/api/voice/transcribe/route.ts`, `src/hooks/use-voice-input.ts`, `src/components/chat/voice-input.tsx`
- [x] **Realtime mode (WebRTC)** — `POST /api/realtime/session` creates an ephemeral OpenAI Realtime session (calls `POST /realtime/sessions` on the endpoint, passes tools excluding `display_titles`, passes realtime system prompt). Returns `clientSecret`, `realtimeModel`, `rtcBaseUrl`. Browser hook `useRealtimeChat` performs WebRTC SDP exchange directly with OpenAI, plays remote audio, shows live transcript, handles tool calls via `POST /api/realtime/tool` (server-side tool executor reusing existing registry). — `src/app/api/realtime/session/route.ts`, `src/app/api/realtime/tool/route.ts`, `src/hooks/use-realtime-chat.ts`, `src/components/chat/realtime-chat.tsx`
- [x] **Default realtime system prompt** — `DEFAULT_REALTIME_SYSTEM_PROMPT` added (voice-adapted: no markdown/cards, natural spoken language). `buildRealtimeSystemPrompt(customPrompt?)` follows same pattern as `buildSystemPrompt()`. — `src/lib/llm/default-prompt.ts`, `src/lib/llm/system-prompt.ts`
- [x] **`getEndpointConfig(modelId)` helper** — New export from `src/lib/llm/client.ts` to look up the full `LlmEndpointConfig` by modelId without constructing a client (used by realtime session route). — `src/lib/llm/client.ts`

#### Tests
- [x] **`src/__tests__/api/voice-transcribe.test.ts`** — Tests for 401 (unauth), 400 (missing audio), 200 (success with mocked Whisper), 500 (API error)
- [x] **`src/__tests__/api/realtime-session.test.ts`** — Tests for 401 (unauth), 400 (no realtime support), 400 (unknown endpoint), 200 (success with mock fetch), 502 (OpenAI returns error)

### Phase 20: Voice TTS Read-back (issue #120)

#### Features
- [x] **TTS read-back in voice mode (#120)** — Non-realtime voice mode now completes a full speak-listen loop: after the LLM response finishes streaming, the assistant's text is automatically read aloud using the OpenAI TTS API (`/v1/audio/speech`). Markdown is stripped before synthesis so asterisks, headings, code fences etc. are not spoken. Input is truncated to 4096 chars (OpenAI limit). `POST /api/voice/tts` mirrors the existing `/api/voice/transcribe` route: requires auth, checks rate limit, resolves the endpoint client via `getLlmClientForEndpoint(modelId)`, and returns raw `audio/mpeg` bytes. — `src/app/api/voice/tts/route.ts` (new)
- [x] **`useTts` hook** — `speakText(text, voice)` fetches `/api/voice/tts`, decodes the blob to an object URL, plays it with `new Audio()`, and resolves the returned promise when playback ends (or errors). `stop()` immediately pauses and revokes the URL. `speaking: boolean` state lets the UI react to playback. — `src/hooks/use-tts.ts` (new)
- [x] **`useAudioLevel` hook** — During recording, pipes the live `MediaStream` through a Web Audio `AnalyserNode` (fftSize 64) sampled at ~20 fps (every 3rd rAF frame). Returns an array of 7 normalised bar heights (0–1) for the real-time visualizer. — `src/hooks/use-audio-level.ts` (new)
- [x] **`useVoiceInput` exposes live stream** — Added `stream: MediaStream | null` state field (set on recording start, cleared on stop) so `VoiceConversation` can pass it to `useAudioLevel`. — `src/hooks/use-voice-input.ts`
- [x] **`VoiceConversation` component** — Replaces `VoiceInput` in voice mode. Owns a 4-state machine: `idle → listening → processing → speaking → idle`. `idle`: secondary mic button, "Tap to speak". `listening`: destructive mic button + `animate-ping` outer ring + 7 real-time audio level bars (CSS height driven by `useAudioLevel`). `processing`: spinner, "Thinking…". `speaking`: primary `Volume2` icon + `animate-ping` ring, "Speaking…" + "Ask again" button (stops TTS and restarts mic) + "Cancel" link (exits to text mode). No longer auto-switches to text mode after sending. — `src/components/chat/voice-conversation.tsx` (new)
- [x] **`supportsTts` capability probe** — `probeTtsSupport()` sends `POST /audio/speech` with an empty `input` (triggers 400 from the endpoint, proving the route exists, without generating audio). Runs in parallel with existing `probeVoiceSupport` and `probeRealtimeSupport`. Settings UI shows a `✓ TTS` / `✗ No TTS` badge per endpoint; a TTS voice selector (Alloy/Echo/Fable/Onyx/Nova/Shimmer) is shown when `supportsTts` is true. — `src/lib/services/test-connection.ts`, `src/types/api.ts`, `src/app/settings/page.tsx`
- [x] **`ttsVoice` field on endpoints** — `LlmEndpointConfig`, `/api/models`, and `endpointCaps` in `chat/page.tsx` all carry `ttsVoice` (default `"alloy"`). Passed through `ChatInput` → `VoiceConversation` → `useTts`. — `src/lib/llm/client.ts`, `src/app/api/models/route.ts`, `src/app/chat/page.tsx`, `src/components/chat/chat-input.tsx`

#### Tests
- [x] **`src/__tests__/api/voice-tts.test.ts`** — 9 tests: 401 (unauth), 400 (missing text), 400 (empty text), 400 (invalid JSON), 200 success with default voice, 200 success with specified voice, alloy fallback for invalid voice, markdown stripping, 500 on API error

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
├── public/
│   ├── manifest.json                # PWA web app manifest (standalone, dark theme)
│   └── sw.js                        # Minimal service worker (network-first, required for PWA)
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
│   │   │       ├── messages/route.ts # POST save realtime turn (user or assistant)
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
│   │   ├── realtime/
│   │   │   ├── session/route.ts     # POST create ephemeral OpenAI Realtime session (WebRTC)
│   │   │   └── tool/route.ts        # POST execute tool server-side during realtime session
│   │   ├── voice/
│   │   │   ├── transcribe/route.ts  # POST audio → Whisper STT → transcript
│   │   │   └── tts/route.ts         # POST text + voice → OpenAI TTS → audio/mpeg
│   │   └── setup/
│   │       ├── route.ts             # GET status + POST save config
│   │       └── test-connection/
│   │           └── route.ts         # POST test service connectivity (+ capability probing)
│   ├── chat/
│   │   └── page.tsx                 # Chat page (sidebar + model picker + mode toggle + messages + input)
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
│   │   ├── chat-input.tsx           # Text/Voice/Realtime mode toggle + textarea/mic/realtime UI
│   │   ├── message-bubble.tsx       # User/assistant message styling + avatar + tool calls + TitleCarousel interception
│   │   ├── message-content.tsx      # Markdown rendering (react-markdown + remark-gfm)
│   │   ├── message-list.tsx         # Scrollable messages + historical tool call reconstruction
│   │   ├── realtime-chat.tsx        # Full-duplex voice conversation UI (WebRTC, live transcript)
│   │   ├── service-status.tsx       # Traffic light service status (green/amber/red)
│   │   ├── sidebar.tsx              # Collapsible sidebar + grouped conversations + service status
│   │   ├── title-card.tsx           # Rich title card (thumbnail, status, cast, Watch Now / Request / More Info buttons)
│   │   ├── title-carousel.tsx       # Single card or horizontal snap-scroll carousel with arrow buttons
│   │   ├── tool-call.tsx            # "Running {Action} on {Service}" + expandable details
│   │   ├── voice-conversation.tsx   # 4-state voice loop (idle→listening→processing→speaking) with TTS read-back
│   │   └── voice-input.tsx          # Mic record/transcribe UI (legacy, kept for reference)
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
│   ├── use-audio-level.ts           # Web Audio AnalyserNode → 7 normalised bar heights for visualizer
│   ├── use-silence-detection.ts     # VAD: auto-stops recording on 1.5s silence or 60s hard timeout
│   ├── use-auto-scroll.ts           # Auto-scroll on new messages, respects manual scroll
│   ├── use-chat.ts                  # Messages state, SSE streaming, send/stop, model override
│   ├── use-conversations.ts         # Conversation CRUD (list, create, delete, rename, viewAll)
│   ├── use-realtime-chat.ts         # WebRTC realtime hook (connect, SDP, data channel, tool calls)
│   ├── use-tts.ts                   # OpenAI TTS playback hook (speakText, stop, speaking state)
│   └── use-voice-input.ts           # MediaRecorder hook (record, stop, POST to transcribe, exposes live stream)
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
│   │   ├── client.ts                # OpenAI client factory (default + per-endpoint + getEndpointConfig)
│   │   ├── default-prompt.ts        # DEFAULT_SYSTEM_PROMPT + DEFAULT_REALTIME_SYSTEM_PROMPT
│   │   ├── orchestrator.ts          # Chat streaming engine + model override + auto-title
│   │   └── system-prompt.ts         # buildSystemPrompt() + buildRealtimeSystemPrompt()
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
│   │   ├── plex-tools.ts            # Plex tool definitions (6 tools: search, availability, on deck, recently added, collection, tag)
│   │   ├── radarr-tools.ts          # Radarr tool definitions (3 tools)
│   │   ├── registry.ts              # Tool registry (defineTool, getOpenAITools, executeTool) + tool logging
│   │   └── sonarr-tools.ts          # Sonarr tool definitions (4 tools)
│   ├── logger.ts                    # Winston singleton (Console + DailyRotateFile to /config/logs/)
│   ├── pwa.ts                       # PWA banner dismissal helpers (isPwaBannerDismissed, dismiss, reset)
│   ├── security/
│   │   ├── api-rate-limit.ts        # Per-user in-memory rate limiter (60 req/min) for API endpoints
│   │   └── url-validation.ts        # Service URL allowlist/blocklist validation
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
| POST | /api/conversations/[id]/messages | Save a single realtime turn (user or assistant) to a conversation |
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
| POST | /api/voice/transcribe | Transcribe audio file via Whisper STT (auth required) |
| POST | /api/voice/tts | Synthesise speech from text via OpenAI TTS (auth required) |
| POST | /api/realtime/session | Create ephemeral OpenAI Realtime session token for WebRTC (auth required) |
| POST | /api/realtime/tool | Execute a tool server-side during a realtime voice session (auth required) |
| GET | /api/plex/avatar/[userId] | Server-side proxy for Plex user avatar images (auth required; fetches stored Plex.tv URL with token) |

## MCP Tools

| Server | Tools |
|--------|-------|
| Plex | plex_search_library, plex_get_on_deck, plex_get_recently_added, plex_check_availability, plex_search_collection, plex_search_by_tag, plex_get_title_tags |
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

### Phase 19: Version Bump to 1.1.1-beta.2

- Bumped `package.json` and `package-lock.json` version from `1.1.0-beta.1` to `1.1.1-beta.2`.

### Phase 20: Fix Docker Build Flakiness (issue #26)

**Problem:** Multi-arch Docker builds using QEMU emulation for `linux/arm64` intermittently failed with `qemu: uncaught target signal 4 (Illegal instruction) - core dumped` during `npm ci`. QEMU cannot reliably emulate all CPU instructions Node.js uses when compiling native modules (`better-sqlite3`).

**Fix:** Replaced single QEMU-based multi-arch build job with native runners per platform:
- `linux/amd64` builds on `ubuntu-latest` (x86_64)
- `linux/arm64` builds on `ubuntu-24.04-arm` (native arm64)

Each platform builds and pushes by digest, then a `docker-merge` job assembles the final multi-arch manifest via `docker buildx imagetools create`.

**Files changed:**
- `.github/workflows/docker-publish.yml` — split `docker` job into matrix + added `docker-merge` job

### Phase 22: Consistent Title Card Schema Across All Tools

All Plex and Overseerr tools now return the same field names as the `display_titles` tool's input schema, so the LLM can pass results directly to `display_titles` without translation.

#### Field renames

| Tool | Old field | New field |
|------|-----------|-----------|
| Plex | `key` | `plexKey` |
| Plex | `thumb` | `thumbPath` |
| Plex | `type` ("show"/"season") | `mediaType` ("tv") |
| Overseerr search | `id` | `overseerrId` |
| Overseerr search | `overview` | `summary` |
| Overseerr search | `voteAverage` | `rating` |
| Overseerr search | `posterUrl` | `thumbPath` |
| Overseerr search | (added) | `overseerrMediaType` (= `mediaType`) |
| Overseerr requests | `type` | `mediaType` |
| Overseerr requests | `posterUrl` | `thumbPath` |
| Overseerr requests | (added) | `overseerrId` (= `tmdbId`) |

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/plex.ts` | Normalized `PlexSearchResult` fields; `mapMetadata` maps "show"/"season" → `mediaType: "tv"` |
| `src/lib/services/overseerr.ts` | Normalized `OverseerrSearchResult` and `OverseerrRequest` fields |
| `src/lib/tools/display-titles-tool.ts` | Updated description to note direct field mapping |
| `src/lib/tools/plex-tools.ts` | Updated description for `mediaType` field |
| `src/lib/tools/overseerr-tools.ts` | Updated descriptions for normalized field names |
| `src/__tests__/lib/plex.test.ts` | Updated assertions for `mediaType` instead of `type` |
| `src/__tests__/lib/overseerr.test.ts` | Updated assertions for `rating`, `thumbPath`, `overseerrId` |

### Phase 21: Bug Fixes for Issues #76, #87, #88, #98, #99, #100, #101, #102, #103

#### Fixed

- [x] **#87 — Floating version badge visible in landscape mode** — Removed the floating `fixed bottom-2 left-2` version badge from `src/app/chat/page.tsx`. The sidebar already shows the version string; the floating badge caused it to appear twice in landscape mode when the sidebar was open. — `src/app/chat/page.tsx`

- [x] **#88 — System prompt: wrong collection name for "leaving soon"** — Updated `DEFAULT_SYSTEM_PROMPT` to instruct the LLM to use the precise collection names `'Movies leaving soon'` (for movie queries) and `'Series leaving soon'` (for TV queries), or both when the question is ambiguous. — `src/lib/llm/default-prompt.ts`

- [x] **#98 — Sidebar forces text wrapping instead of overlaying chat** — On mobile the sidebar is now `position: fixed` (overlays the chat area) with a semi-transparent backdrop. On desktop (`md:`) it remains `relative` so the layout flows as before. A click on the backdrop dismisses the sidebar. — `src/components/chat/sidebar.tsx`

- [x] **#99 — `plex_get_title_tags` returns empty tags for series** — Tags (genre, director, etc.) are stored at the show level, not on individual seasons or episodes. `getTagsForTitle` now follows `parentKey` when the fetched item is a season, and `grandparentKey` when it is an episode, automatically fetching the parent show's metadata to retrieve the correct tags. Failure to resolve the parent falls back to the original metadata gracefully. — `src/lib/services/plex.ts`

- [x] **#100 — User avatar no longer displays in chat** — Root cause: Plex.tv avatar URLs stored in the DB (`plexUser.thumb` from `/api/v2/user`) now require authentication or are otherwise unavailable when fetched directly by the browser. Fix: added a server-side proxy route `/api/plex/avatar/[userId]` that fetches the stored avatar URL using the user's Plex token and streams the image to the browser. All API endpoints that return `plexAvatarUrl` to the frontend (`getSession`, `/api/auth/callback`, `/api/settings/users`, `/api/conversations`) now return the proxy URL `/api/plex/avatar/{id}` instead of the raw Plex.tv URL. The existing `onError` fallback in `Avatar` is retained as a safety net. — `src/app/api/plex/avatar/[userId]/route.ts`, `src/lib/auth/session.ts`, `src/app/api/auth/callback/route.ts`, `src/app/api/settings/users/route.ts`, `src/app/api/conversations/route.ts`

- [x] **#101 — Overseerr search returns insufficient data for title cards** — `overseerr_search` now returns `voteAverage` (rating out of 10, from TMDB data already in search results), full `overview` (synopsis, no longer truncated), and `cast` (top 5 cast members). Cast requires a detail fetch per result (`/movie/{id}` or `/tv/{id}`); these are performed in parallel alongside the existing TV detail fetch for `numberOfSeasons`. The `overseerr_list_requests` additions from the previous phase (posterUrl, tmdbId, request details) are retained. — `src/lib/services/overseerr.ts`, `src/lib/tools/overseerr-tools.ts`

- [x] **#102 — LLM settings tab UI runs off screen on mobile** — Refactored the endpoint `CardHeader` row to use `flex-wrap` so the name input, Enabled checkbox, Default radio, and delete button wrap gracefully on narrow viewports instead of overflowing horizontally. The name input grows to full width on mobile (`w-full sm:w-48`). — `src/app/settings/page.tsx`

- [x] **#103 — No warning when leaving Settings with unsaved changes** — Added a `savedConfigRef` (via `useRef`) that snapshots the loaded config after initial fetch and after each successful save. When the user clicks the back button, the current config is serialised and compared to the snapshot; if they differ a `window.confirm` dialog asks the user to confirm discarding changes. The existing incomplete-setup warning is preserved. — `src/app/settings/page.tsx`

- [x] **#76 — PWA installation not available** — Root cause: the web app manifest lacked a correctly sized icon required by browsers before they fire `beforeinstallprompt`. Fix: added `public/icon.svg` (512×512 SVG lettermark) and registered it in `manifest.json` with `purpose: "any maskable"`. PWA installation UI remains **mobile-only**: the chat banner returns `null` when `!isMobile`, and the Settings page shows a mobile-only note on desktop instead of the install controls. — `public/manifest.json`, `public/icon.svg`, `src/components/chat/pwa-install-banner.tsx`, `src/app/settings/page.tsx`

#### New / changed files

| File | Change |
|------|--------|
| `src/app/chat/page.tsx` | Removed floating version badge |
| `src/lib/llm/default-prompt.ts` | Updated "leaving soon" collection name guidance |
| `src/components/chat/sidebar.tsx` | Mobile overlay sidebar with backdrop |
| `src/lib/services/plex.ts` | `getTagsForTitle` follows parentKey/grandparentKey for seasons/episodes |
| `src/components/ui/avatar.tsx` | Client component, `onError` fallback for broken images |
| `src/app/api/plex/avatar/[userId]/route.ts` | New server-side avatar proxy route |
| `src/lib/auth/session.ts` | `getSession` returns proxy URL for `plexAvatarUrl` |
| `src/app/api/auth/callback/route.ts` | Returns proxy URL in login response |
| `src/app/api/settings/users/route.ts` | Returns proxy URLs for all users |
| `src/app/api/conversations/route.ts` | Returns proxy URL for `ownerAvatarUrl` |
| `src/lib/services/overseerr.ts` | Normalized field names + rating/cast; `listRequests` includes thumbPath/overseerrId |
| `src/lib/services/plex.ts` | Normalized field names: `plexKey`, `thumbPath`, `mediaType` ("show"→"tv") |
| `src/lib/tools/overseerr-tools.ts` | Updated tool descriptions for normalized fields |
| `src/lib/tools/plex-tools.ts` | Updated `plex_get_recently_added` description for `mediaType` field |
| `src/lib/tools/display-titles-tool.ts` | Updated description: fields now match directly across Plex and Overseerr |
| `src/app/settings/page.tsx` | Mobile-friendly LLM card header; unsaved-changes warning |
| `public/manifest.json` | Added SVG icon entry |
| `public/icon.svg` | New Thinkarr app icon (512×512 SVG) |
| `src/__tests__/lib/plex.test.ts` | Updated tests for normalized field names + season/episode parent tag lookup |
| `src/__tests__/lib/overseerr.test.ts` | Updated tests for normalized field names + rating/cast |

### Phase 23: Bug Fixes for Issues #76, #101, #104 (Second Pass)

#### Fixed

- [x] **#76 — PWA install prompt never fires (manifest missing required PNG icons)** — Root cause: browsers (Chrome/Edge) require at least 192×192 and 512×512 PNG icons in the manifest before firing `beforeinstallprompt`; the previous fix only added an SVG icon which is insufficient. Additionally the install banner and Settings General tab were mobile-only, hiding the Install button from desktop Chrome/Edge users. Fixes: (1) generated `public/icon-192.png` (192×192) and `public/icon-512.png` (512×512) dark-theme PNG icons using a Node.js zlib-based generator; (2) added both PNG icons to `manifest.json`, keeping the SVG as a third entry; (3) removed `!isMobile` early-return from `PwaInstallBanner` so the banner appears on all devices (desktop Chrome/Edge, Android) when the deferred prompt is available — iOS-specific instructions remain mobile-only; (4) updated Settings General tab to show the Install button on desktop when `pwaInstallAvailable` is true, not just on mobile. — `public/manifest.json`, `public/icon-192.png`, `public/icon-512.png`, `src/components/chat/pwa-install-banner.tsx`, `src/app/settings/page.tsx`

- [x] **#101 — Overseerr list requests does not display as title cards** — Root cause: `listRequests()` did not return a `mediaStatus` field, so the LLM could not pass the correct value to `display_titles` (which requires `"available" | "partial" | "pending" | "not_requested"`). Fix: added `mediaStatus` to `OverseerrRequest` interface, derived from the request's status (status 3/Declined → `"not_requested"`, all others → `"pending"`). Updated `overseerr_list_requests` tool description to say "ALWAYS follow with display_titles". Updated system prompt to explicitly mention calling `display_titles` after `overseerr_list_requests`. — `src/lib/services/overseerr.ts`, `src/lib/tools/overseerr-tools.ts`, `src/lib/llm/default-prompt.ts`

- [x] **#101 — "Watch Now" button missing for partially-available Plex content** — Root cause: `title-card.tsx` only showed "Watch Now" for `mediaStatus === "available"`; content that exists in Plex but not all seasons (`mediaStatus === "partial"`) should also be watchable. Fix: changed the Watch Now button condition to `(title.mediaStatus === "available" || title.mediaStatus === "partial") && plexWebUrl`. — `src/components/chat/title-card.tsx`

- [x] **#101 — Overseerr search thumbnail field incorrectly referenced in system prompt** — Root cause: the system prompt said `"posterUrl"` when describing Overseerr thumbnail fields, but the actual field name returned by `overseerr_search` is `"thumbPath"`. The LLM was therefore looking for a non-existent field, causing missing thumbnails. Fix: corrected the system prompt to consistently use `"thumbPath"` for Overseerr results. — `src/lib/llm/default-prompt.ts`

- [x] **#104 — Browser does not prompt for microphone permissions; shows unhelpful error** — Root causes: (1) if the app is served over HTTP (not HTTPS), `navigator.mediaDevices` is undefined in modern browsers (Permissions API requires a secure context); (2) if microphone permission was previously blocked, `getUserMedia` throws immediately without re-prompting; (3) error messages were generic ("Microphone access denied") with no guidance on how to fix them. Fixes: added pre-flight checks in both `useVoiceInput.startRecording()` and `useRealtimeChat.connect()`: check `window.isSecureContext` (show HTTPS error if false), check `navigator.mediaDevices?.getUserMedia` exists (show unsupported-browser error if not). Updated catch blocks to detect `NotAllowedError`/`PermissionDeniedError` (show actionable message with browser settings instructions), `NotFoundError`/`DevicesNotFoundError` (show "no microphone found" message), and other DOMExceptions. The realtime chat no longer shows the generic "Connection failed" for permission issues. — `src/hooks/use-voice-input.ts`, `src/hooks/use-realtime-chat.ts`

#### New / changed files

| File | Change |
|------|--------|
| `public/manifest.json` | Added `icon-192.png` (192×192) and `icon-512.png` (512×512) PNG icons; fixed SVG purpose to `"any"` |
| `public/icon-192.png` | New 192×192 PNG icon (dark theme, "T" lettermark) |
| `public/icon-512.png` | New 512×512 PNG icon (dark theme, "T" lettermark) |
| `src/components/chat/pwa-install-banner.tsx` | Removed `!isMobile` early-return; banner now shows on desktop when deferred prompt available |
| `src/app/settings/page.tsx` | General tab shows Install button on desktop; removed mobile-only guard |
| `src/lib/services/overseerr.ts` | Added `mediaStatus` field to `OverseerrRequest`; derived from request status |
| `src/lib/tools/overseerr-tools.ts` | `overseerr_list_requests` description now says "ALWAYS follow with display_titles" |
| `src/lib/llm/default-prompt.ts` | Fixed "posterUrl" → "thumbPath"; added explicit "including overseerr_list_requests" + mediaStatus mapping guidance |
| `src/components/chat/title-card.tsx` | Watch Now button shown for `"partial"` mediaStatus in addition to `"available"` |
| `src/hooks/use-voice-input.ts` | Added secure-context check, mediaDevices API check, and DOMException-specific error messages |
| `src/hooks/use-realtime-chat.ts` | Added secure-context check, mediaDevices API check, and DOMException-specific error messages |
| `src/__tests__/lib/overseerr.test.ts` | Added tests for `mediaStatus` field: "pending" for approved/pending-approval requests, "not_requested" for declined |

### Phase 24: Second-pass fixes for #76, #101, #104 (thumbnail proxy + Permissions-Policy)

#### Fixed

- [x] **#101 — Overseerr thumbnails not rendering in title card (root cause)** — The TMDB thumbnail URL was correct but the image loaded as a cross-origin third-party resource in the `<img>` tag. Browser extensions (e.g. ad blockers) and some browser security policies block third-party embedded images even when the URL is valid; the image loads fine when opened in a new tab because there is no cross-origin context. Fix: created `/api/tmdb/thumb` server-side proxy route that fetches TMDB images server-side and serves them as same-origin responses (identical pattern to the existing `/api/plex/thumb` Plex image proxy). Updated `display-titles-tool.ts` to route all external `https://` thumbPaths through `/api/tmdb/thumb?url=…` instead of passing them directly to the browser. Security: session-gated, URL validated to `image.tmdb.org` HTTPS-only to prevent open-proxy abuse. — `src/app/api/tmdb/thumb/route.ts`, `src/lib/tools/display-titles-tool.ts`

- [x] **#104 — Browser never prompts for microphone (root cause)** — The `Permissions-Policy: camera=(), microphone=(), geolocation=()` header in `next.config.ts` explicitly denied microphone access for all origins at the HTTP header level, before any JavaScript ran. The browser silently blocked `getUserMedia` with `NotAllowedError` without showing a permission prompt, because the feature was policy-denied by the server. Fix: removed `microphone=()` from the Permissions-Policy header. `camera=()` and `geolocation=()` are retained as those features are genuinely unused. — `next.config.ts`

#### New / changed files

| File | Change |
|------|--------|
| `next.config.ts` | Removed `microphone=()` from Permissions-Policy header |
| `src/app/api/tmdb/thumb/route.ts` | New server-side proxy for TMDB thumbnail images |
| `src/lib/tools/display-titles-tool.ts` | External `https://` thumbPaths routed through `/api/tmdb/thumb` proxy |
| `src/__tests__/api/tmdb-thumb.test.ts` | 8 unit tests for the TMDB proxy route (auth, URL validation, upstream error handling, successful proxy) |

### Phase 25: E2E Tests for Title Cards and Chat Experience (Issue #110)

#### Added

- [x] **#110 — E2E tests for title card rendering** — Added `tests/e2e/title-cards.spec.ts` covering the full `display_titles` tool-call flow end-to-end: the LLM mock returns a `display_titles` tool call, the orchestrator executes it server-side, and the resulting title cards are verified in the browser. Tests cover: "Available" card with Watch Now button, "Not Requested" card with Request button, successful request submission (Overseerr mock), and multiple titles rendered as a scrollable carousel with correct per-card status badges.

- [x] **Mock server enhancements** — Extended `tests/e2e/helpers/mock-servers.ts`: (1) Plex mock now handles `GET /` returning `machineIdentifier` so the `display_titles` tool can build Plex web URLs; (2) Added Overseerr mock server handling `POST /api/v1/request` so the Request button flow is fully exercisable; (3) LLM mock extended to return streaming tool call responses (`display_titles`) when the user message matches E2E trigger phrases, and returns normal text on the second pass (after tool results arrive).

- [x] **Global setup — Overseerr configured** — `tests/e2e/global-setup.ts` now includes Overseerr in the initial `POST /api/setup` call so title card request tests work without manual configuration.

- [x] **`data-testid` attributes added** — Added `data-testid` to `TitleCard` (root div, status badge, Watch Now link, Request button, Requested badge) and `TitleCarousel` (scrollable container) to enable stable Playwright locators.

- [x] **Playwright config** — Added `title-cards` project to `playwright.config.ts` targeting `title-cards.spec.ts` with admin session state.

#### New / changed files

| File | Change |
|------|--------|
| `tests/e2e/title-cards.spec.ts` | New — 7 E2E tests covering title card rendering, buttons, request flow, carousel |
| `tests/e2e/helpers/mock-servers.ts` | Plex GET / for machineId; Overseerr mock server; LLM tool call simulation |
| `tests/e2e/global-setup.ts` | Added Overseerr to initial setup call |
| `playwright.config.ts` | Added `title-cards` project |
| `src/components/chat/title-card.tsx` | Added data-testid to card, status badge, Watch Now, Request button, Requested badge |
| `src/components/chat/title-carousel.tsx` | Added data-testid to scrollable container |


### Phase 26: Version bump to 1.1.1-beta.4

- Bumped `package.json` version from `1.1.1-beta.3` to `1.1.1-beta.4`

### Phase 28: Plex Watch Now button for Overseerr results + Pagination (Issues #117, #109)

#### Fixed

- [x] **#117 — Watch Now button not shown after Overseerr search returns "Available"** — Root cause: `overseerr_search` returns results with `mediaStatus: "available"` but no `plexKey`. The Watch Now button in `title-card.tsx` requires `plexKey` + `plexMachineId` to build the `app.plex.tv` deep-link URL; without `plexKey` the button was never rendered. Fix: in `display-titles-tool.ts`, for any title that is `"available"` or `"partial"` and has no `plexKey`, run a parallel side-query to `plex.searchLibrary(title)` and match by title (case-insensitive) + year. If a match is found, inject the `plexKey` before building the `DisplayTitle` objects. The side-query is non-fatal; if Plex is unconfigured or returns no match, the button simply doesn't render (acceptable). — `src/lib/tools/display-titles-tool.ts`

- [x] **#109 — Search result caps raised to 50 with pagination on all tools** — All Overseerr and Plex search functions now return up to 50 results per page (up from the previous 10–20 per-function limits) along with a `hasMore: boolean` flag so the LLM knows whether to offer "show more". A `page` parameter (1-based, optional, defaults to 1) is exposed on all relevant tools. The `display_titles` tool's `max` input cap is raised from 10 to 50 to match. Changes per function:
  - `overseerr.search(query, page)` — passes `page=N` to the Overseerr API; caps at 50 items; derives `hasMore` from `totalPages`.
  - `overseerr.listRequests(page)` — uses `take=50&skip=(page-1)*50`; derives `hasMore` from `pageInfo.results`.
  - `plex.searchLibrary(query, page)` — fetches with `limit=(offset+51)` to detect overflow; returns slice + `hasMore`.
  - `plex.getOnDeck(page)` — uses `X-Plex-Container-Start` / `X-Plex-Container-Size=51`; returns 50 items + `hasMore`.
  - `plex.getRecentlyAdded(page)` — fetches 200 raw items, deduplicates by show title, then slices to the requested page window; returns 50 deduplicated items + `hasMore`.
  - `plex.searchCollections(name, page)` — fetches all collection children, slices by page offset; returns 50 items + `hasMore`.
  - `plex.searchByTag(tag, tagType, page)` — accumulates results stopping at `offset+51`; slices to page; returns 50 items + `hasMore`.
  — `src/lib/services/overseerr.ts`, `src/lib/services/plex.ts`, `src/lib/tools/overseerr-tools.ts`, `src/lib/tools/plex-tools.ts`, `src/lib/tools/display-titles-tool.ts`

#### New / changed files

| File | Change |
|------|--------|
| `src/lib/tools/display-titles-tool.ts` | Plex side-query for available/partial titles missing plexKey; max titles raised to 50 |
| `src/lib/services/overseerr.ts` | `search` and `listRequests` accept `page` param; return `{ results, hasMore }` |
| `src/lib/services/plex.ts` | All search functions accept `page` param; return `{ results, hasMore }`; cap raised to 50 |
| `src/lib/tools/overseerr-tools.ts` | `overseerr_search` and `overseerr_list_requests` expose `page` param |
| `src/lib/tools/plex-tools.ts` | All search tools expose `page` param; descriptions updated to note 50-item pages |
| `src/__tests__/lib/overseerr.test.ts` | Updated all tests for new `{ results, hasMore }` return shape; added pagination tests |
| `src/__tests__/lib/plex.test.ts` | Updated all tests for new `{ results, hasMore }` return shape; added pagination tests |
| `src/__tests__/lib/display-titles-tool.test.ts` | New — 4 unit tests for the Plex side-query (plexKey injection, no-overwrite, no-match, skip for non-available) |

### Phase 27: Fix CodeQL SSRF findings (Critical)

#### Fixed

- **`src/app/api/tmdb/thumb/route.ts`** — Replaced `fetch(imageUrl, ...)` with `fetch(parsed.toString(), ...)`. The URL was already validated (hostname pinned to `image.tmdb.org`, protocol must be `https:`), but the raw user-supplied string was still passed to `fetch`. Using the serialised validated `URL` object breaks CodeQL's taint propagation path.

- **`src/lib/services/test-connection.ts` — `probeVoiceSupport`** — Added `validateServiceUrl` guard (early return `false` on invalid URL) and reconstructed the base URL from `parsed.origin + parsed.pathname` instead of the raw user string, eliminating the SSRF taint path.

- **`src/lib/services/test-connection.ts` — `probeRealtimeSupport`** — Added `validateServiceUrl` guard (early return `null` on invalid URL) and reconstructed base URL from `parsed.origin + parsed.pathname`. The existing `isOpenAIEndpoint` hostname check is preserved; the new guard and URL reconstruction satisfy CodeQL's sanitizer requirements.

#### Changed files

| File | Change |
|------|--------|
| `src/app/api/tmdb/thumb/route.ts` | Use `parsed.toString()` in `fetch` instead of raw `imageUrl` |
| `src/lib/services/test-connection.ts` | Add `validateServiceUrl` + URL reconstruction in `probeVoiceSupport` and `probeRealtimeSupport` |

### Phase 29: Bug Fixes for Issues #117, #122, #126, #127, #128

#### Fixed

- [x] **#117 — Watch Now button missing for TV series from Overseerr** — Phase 28 fixed movies but TV series were still broken. Root cause: `searchLibrary` (used in the original side-query) only returns the first 10 results across all hubs combined; for TV series, Plex returns episode and season hubs before the show hub, so the show-level result was missed. Season items also have modified titles ("Show — Season N") that broke the exact-match check. Fix: new `findShowPlexKey(title, year?)` in `plex.ts` scans ALL hubs without pagination, preferring show-level items (type "show") first, then falling back to a season's `parentKey` or episode's `grandparentKey`. `display-titles-tool.ts` now calls `findShowPlexKey` for TV and per-season entries; the existing `searchLibrary` match is retained for movies only. — `src/lib/services/plex.ts`, `src/lib/tools/display-titles-tool.ts`

- [x] **#128 — Overseerr search fails for queries with special characters** — Root cause: the Overseerr `/search` API rejects queries whose reserved characters are not percent-encoded. While `encodeURIComponent` was previously used, `URLSearchParams` provides a more robust and idiomatic encoding approach. Fix: replaced template-literal URL construction with `new URLSearchParams({ query, page, language })` in `overseerr.search()`. — `src/lib/services/overseerr.ts`

- [x] **#127 — Tool calls can get stuck (error handling + timeout + recovery)** — Three improvements:
  1. **Timeout**: each tool execution is now race-d against a 30-second `AbortSignal.timeout` promise. If the tool exceeds 30 s the call resolves with an error JSON result instead of hanging indefinitely.
  2. **Error recovery**: tool execution errors (thrown exceptions or timeouts) are now caught inside the orchestrator's tool call loop. A JSON error result is saved to the DB and added to `apiMessages` so the API message sequence stays valid — the LLM receives the tool error and can still reply, preventing the conversation from being permanently blocked.
  3. **Error in card**: the `ToolResultEvent` now carries `error: boolean` and `durationMs`. The `tool_result` handler in `useChat` populates the `ToolCallDisplay` with `status: "error"` and `error: string`. `tool-call.tsx` shows a red border, red label, and inline error text (both collapsed and expanded), replacing the previous global error banner. Historical tool call errors are reconstructed from the saved JSON result. — `src/lib/llm/orchestrator.ts`, `src/types/chat.ts`, `src/hooks/use-chat.ts`, `src/components/chat/tool-call.tsx`, `src/components/chat/message-list.tsx`

- [x] **#126 — Display response times and token usage per call** — Added timing and token metrics throughout the LLM pipeline:
  - **Tool call duration**: orchestrator captures `Date.now()` before/after each tool execution and sends `durationMs` in `ToolResultEvent`. `tool-call.tsx` displays this as `Xs` or `Nms` in the card header.
  - **LLM response duration**: orchestrator timestamps the start of each `client.chat.completions.create` call and calculates `llmDurationMs` after the stream completes.
  - **Token usage**: requests include `stream_options: { include_usage: true }`; usage figures from the final streaming chunk are captured (`promptTokens`, `completionTokens`, `totalTokens`).
  - **Logging**: both round completions (tool-calling) and final responses log `llmDurationMs`, `promptTokens`, `completionTokens`, `totalTokens` at `info` level.
  - **SSE**: `DoneEvent` includes `llmDurationMs`, `promptTokens`, `completionTokens`, `totalTokens` (available to the client for future display).
  — `src/lib/llm/orchestrator.ts`, `src/types/chat.ts`, `src/components/chat/tool-call.tsx`

- [x] **#122 — Tests for non-admin user** — New unit test file covering admin vs non-admin access control:
  - `GET /api/settings` returns 403 for unauthenticated and non-admin users, 200 for admins.
  - `PATCH /api/settings` returns 403 for non-admin users.
  - `GET /api/settings/users` returns 403 for non-admin users, 200 for admins.
  - `GET /api/conversations` with and without `?all=true` confirms non-admin users only see their own conversations; `?all=true` is silently ignored for non-admins.
  — `src/__tests__/api/non-admin-user.test.ts` (new)

#### New / changed files

| File | Change |
|------|--------|
| `src/lib/services/overseerr.ts` | `search()` uses `URLSearchParams` for query string construction (#128) |
| `src/lib/llm/orchestrator.ts` | Tool call timeout (30 s), error capture, `durationMs` tracking, `llmDurationMs` + token usage from stream (#127, #126) |
| `src/types/chat.ts` | `ToolCallStartEvent` gains `startedAt`; `ToolResultEvent` gains `durationMs` and `error`; `DoneEvent` gains `llmDurationMs`, `promptTokens`, `completionTokens`, `totalTokens`; `ToolCallDisplay` gains `durationMs` and `error` (#127, #126) |
| `src/hooks/use-chat.ts` | `tool_result` handler uses `event.error` flag; populates `durationMs` and `error` on `ToolCallDisplay` (#127, #126) |
| `src/components/chat/tool-call.tsx` | Shows duration label in card header; red border + inline error for failed tool calls (#127, #126) |
| `src/components/chat/message-list.tsx` | Historical tool call reconstruction extracts error message from JSON result for `ToolCallDisplay.error` (#127) |
| `src/__tests__/api/non-admin-user.test.ts` | New — 9 unit tests for non-admin access control on settings and conversations endpoints (#122) |
| `src/lib/services/plex.ts` | New `findShowPlexKey(title, year?)` — scans all hubs, returns show-level plexKey for TV series (#117) |
| `src/lib/tools/display-titles-tool.ts` | TV/season entries use `findShowPlexKey`; movie entries retain `searchLibrary` match (#117) |
| `src/__tests__/lib/display-titles-tool.test.ts` | 2 new TV series tests: show buried behind episode/season hubs; season parentKey fallback (#117) |

### Phase 30: Second-pass fixes for Issues #117, #126, #128

Logs revealed the Phase 29 fixes were incomplete. Specific root causes were confirmed from application logs.

- [x] **#117 — Watch Now still missing for Slow Horses (and any show whose seasons have decorated titles)** — Root cause confirmed by logs: `findShowPlexKey` was being called with the season-decorated display title (e.g. `"Slow Horses — Season 2"`) rather than the bare show name. Plex returned zero results for all four season-titled searches. Fix: in `display-titles-tool.ts`, prefer `t.showTitle` when provided; if absent, strip ` — Season N` decoration from `t.title` using a regex before calling `findShowPlexKey`, so Plex is always queried with the series root title. — `src/lib/tools/display-titles-tool.ts`

- [x] **#126 — Tool call durations disappear from chat history** — Root cause: `durationMs` was only stored in the live `toolCalls` React state Map, which was cleared on the post-stream message reload. Historical reconstruction in `buildHistoricalToolCalls` had no source for timing data. Fix (Option B): added `duration_ms` integer column to the `messages` table; orchestrator now persists `durationMs` when saving tool result messages; `buildHistoricalToolCalls` reads `resultMsg.durationMs` and includes it in `ToolCallDisplay`. Durations now survive page reload and appear on all past messages. — `src/lib/db/schema.ts`, `drizzle/0001_add_message_duration.sql`, `src/lib/llm/orchestrator.ts`, `src/types/index.ts`, `src/components/chat/message-list.tsx`

- [x] **#128 — URL encoding not robustly implemented; no test** — Root cause: `URLSearchParams.toString()` encodes spaces as `+` (application/x-www-form-urlencoded), not `%20` (RFC 3986). Some servers do not decode `+` as space in query strings, causing queries like "Slow Horses" to be misinterpreted. Fix: replaced `URLSearchParams` with explicit `encodeURIComponent()` per parameter, which produces standard `%20` encoding. Also added two regression tests verifying spaces encode as `%20` and reserved characters (`:`) encode correctly. — `src/lib/services/overseerr.ts`, `src/__tests__/lib/overseerr.test.ts`

#### Files changed

| File | Change |
|------|--------|
| `src/lib/tools/display-titles-tool.ts` | Use `t.showTitle ?? stripSeasonSuffix(t.title)` when calling `findShowPlexKey` (#117) |
| `src/lib/db/schema.ts` | Added `durationMs: integer("duration_ms")` to messages table (#126) |
| `drizzle/0001_add_message_duration.sql` | Migration: `ALTER TABLE messages ADD duration_ms integer` (#126) |
| `drizzle/meta/0001_snapshot.json` | Drizzle snapshot for migration 0001 (#126) |
| `drizzle/meta/_journal.json` | Added migration 0001 entry (#126) |
| `src/lib/llm/orchestrator.ts` | `saveMessage` accepts `durationMs`; tool result saves include it (#126) |
| `src/types/index.ts` | `Message` interface gains `durationMs: number \| null` (#126) |
| `src/components/chat/message-list.tsx` | `buildHistoricalToolCalls` includes `durationMs` from DB (#126) |
| `src/lib/services/overseerr.ts` | `search()` uses `encodeURIComponent` instead of `URLSearchParams` (#128) |
| `src/__tests__/lib/overseerr.test.ts` | 2 new tests: spaces encode as `%20`, reserved chars encode correctly (#128) |

### Phase 31: Fix issue #134 — schema-migration parity test gap

Issue #134 ("table messages has no column named duration_ms / Failed to load messages") was
caused by the `duration_ms` column being added to `schema.ts` in Phase 29 without a migration
file, meaning existing databases did not receive the new column. The Phase 30 second-pass added
the migration (`drizzle/0001_add_message_duration.sql`), fixing the immediate runtime error.

This phase addresses **why the tests did not catch it**:

The `migrations.test.ts` "messages has correct columns" test only asserted the presence of
specific *known* columns (id, conversation_id, role, content, etc.). It never checked for
`duration_ms`, so the test passed even when the migration was absent. Additionally, all
existing test fixtures inserted rows via raw SQL (not the Drizzle ORM schema), so no Drizzle
query ever attempted to reference `duration_ms` and the mismatch was invisible.

- [x] **Add `duration_ms` to column assertion** — `messages has correct columns` now includes
  `expect(c).toHaveProperty("duration_ms")` so a missing migration is immediately detected. —
  `src/__tests__/db/migrations.test.ts`

- [x] **Add Drizzle ORM round-trip tests** — New describe block "schema-migration parity —
  Drizzle round-trip" performs `db.insert(schema.messages).values({...durationMs: 1234...})`
  and `db.select()...get()` using the live Drizzle schema against a migration-initialised
  in-memory DB. Any column present in `schema.ts` but absent from the migrations will cause
  the insert to throw "table messages has no column named X", catching the class of bug that
  caused #134. A second test verifies `duration_ms` defaults to `null`. —
  `src/__tests__/db/migrations.test.ts`

- [x] **No error logging in conversation message loader** — `GET /api/conversations/[id]` had
  no try/catch around its DB queries. When SQLite threw the column error, the exception
  propagated unhandled and Next.js absorbed it silently — nothing ever reached `logger.error()`.
  Fix: wrapped both GET and DELETE DB paths in try/catch blocks that call `logger.error()` with
  `conversationId`, `userId`, and the error message before returning a structured 500. —
  `src/app/api/conversations/[id]/route.ts`

#### Files changed

| File | Change |
|------|--------|
| `src/__tests__/db/migrations.test.ts` | Added `duration_ms` to column check; added 2 Drizzle round-trip parity tests (#134) |
| `src/app/api/conversations/[id]/route.ts` | Wrapped GET and DELETE DB ops in try/catch with `logger.error()` (#134) |

### Phase 32: Fix issue #134 — defensive column fallback in getDb()

Issue #134 persisted after Phase 31 because existing production databases already had the
`__drizzle_migrations` record for `0001_add_message_duration` registered from an earlier
failed or partial deployment. Drizzle's migrator skips already-registered migrations, so
the `ALTER TABLE` SQL never ran again and `duration_ms` remained absent.

- [x] **Defensive column check in `getDb()`** — After `migrate()` runs, `getDb()` now reads
  `PRAGMA table_info(messages)` and, if `duration_ms` is absent, runs
  `ALTER TABLE messages ADD COLUMN duration_ms INTEGER` directly. This is idempotent and
  bypasses the migration tracking system, ensuring the column always exists on startup
  regardless of the state of `__drizzle_migrations`. A `logger.warn` is emitted when the
  fallback fires so the condition is observable in logs. —
  `src/lib/db/index.ts`

- [x] **Defensive fallback unit test** — New describe block
  "migrations — duration_ms defensive fallback" in `migrations.test.ts` simulates the exact
  failure scenario: baseline schema applied without `duration_ms`, then the fallback SQL
  executed, verified that the column is present afterwards. —
  `src/__tests__/db/migrations.test.ts`

#### Files changed

| File | Change |
|------|--------|
| `src/lib/db/index.ts` | Added post-migration PRAGMA check; runs `ALTER TABLE` if `duration_ms` is absent (#134) |
| `src/__tests__/db/migrations.test.ts` | Added defensive fallback test covering the dirty-migration scenario (#134) |

### Phase 33: Harden CI to catch faulty schema before beta ships

The Phase 32 defensive fallback prevents the production outage but doesn't prevent a broken
build from passing CI. Three gaps remained:

1. **`/api/health` was schema-blind** — it returned `{status:"ok"}` unconditionally. The
   Docker `HEALTHCHECK` and the docker-e2e `waitForServer()` check would both pass even if
   `duration_ms` was missing, meaning a broken container could complete the CI Docker E2E
   suite and ship as `:beta`.

2. **No test exercised the full production failure chain** — the Phase 32 unit test proved
   the fallback SQL works in isolation. It never verified that `migrate()` actually skips 0001
   when the migration hash is in `__drizzle_migrations`, meaning the test didn't confirm the
   fallback is *necessary*. The new test uses `ALTER TABLE DROP COLUMN` (SQLite ≥ 3.35.0) to
   reproduce the exact state: correct hashes in tracking table, column absent from schema,
   `migrate()` skips, fallback restores, health probe succeeds.

3. **No journal ↔ SQL file consistency check** — a column could be added to schema.ts, an
   SQL file created, but the `_journal.json` entry omitted. Drizzle silently ignores SQL files
   not referenced in the journal. The safety linter never caught this gap.

- [x] **Schema-aware health endpoint** — `GET /api/health` now calls `getDb()` and runs a
  zero-row `SELECT id, duration_ms FROM messages LIMIT 0`. Any column absent from the live
  schema causes a 503 instead of 200. The Docker `HEALTHCHECK` and the docker-e2e
  `waitForServer()` (which loops until `status < 500`) will both fail, blocking the CI
  pipeline before the image is promoted. — `src/app/api/health/route.ts`

- [x] **Journal ↔ SQL file consistency checks** — Three new tests added to
  `migration-safety.test.ts`:
  - `_journal.json` is valid JSON with an entries array.
  - Every journal entry has a corresponding `.sql` file (missing file = migration silently
    skipped by drizzle).
  - Every `.sql` file has a journal entry (file without entry = migration silently skipped).
  — `src/__tests__/db/migration-safety.test.ts`

- [x] **Exact production dirty-migration scenario test** — New describe block
  "migrations — exact production dirty-migration scenario" in `migrations.test.ts`. The test:
  1. Applies all migrations via drizzle (correct hashes in `__drizzle_migrations`).
  2. Drops `duration_ms` with `ALTER TABLE DROP COLUMN` to simulate a backup-restore dirty state.
  3. Re-runs `migrate()` and **asserts** it does NOT restore the column (proves the dirty state
     requires the fallback — not just that the fallback works).
  4. Applies the defensive fallback.
  5. Runs the health-probe SELECT to confirm it succeeds.
  — `src/__tests__/db/migrations.test.ts`

- [x] **Docker dirty-DB smoke test in CI** — New step "Schema smoke test — dirty migration
  state" added to the `docker-e2e` job in `docker-publish.yml`, between "Build Docker image"
  and "E2E tests against Docker container". The step:
  1. Runs `scripts/create-dirty-db.cjs` to produce a real on-disk DB file in dirty state.
  2. Starts the freshly-built Docker image with that DB mounted as `/config`.
  3. Polls `GET /api/health` for up to 90 s.
  4. Fails the job if it never returns 200.
  5. Cleans up via a shell `trap` (container + temp dir removed even on failure).
  A `trap EXIT` guarantees port 3000 is free before the full E2E tests run in the next step.
  — `.github/workflows/docker-publish.yml`, `scripts/create-dirty-db.cjs`

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/health/route.ts` | Schema-aware: probes `messages.duration_ms`; returns 503 on failure |
| `src/__tests__/db/migration-safety.test.ts` | 3 new journal ↔ SQL file consistency checks |
| `src/__tests__/db/migrations.test.ts` | New test: exact production dirty-migration chain including `migrate()` skip assertion |
| `scripts/create-dirty-db.cjs` | New helper: creates on-disk dirty-state DB for Docker smoke test |
| `.github/workflows/docker-publish.yml` | New step: Docker dirty-DB smoke test in docker-e2e job |

### Phase 34: Make schema drift correction generic across all columns and tables

Phase 33 fixed the immediate outage and hardened CI, but the defensive fallback in `getDb()`
and the health probe in `/api/health` were still hardcoded to `messages.duration_ms`. Any new
column added to schema.ts in a future migration would not be covered automatically.

The root question: **how do we ensure all future schema changes are correctly applied?**

The answer is a generic schema-integrity function that introspects the Drizzle schema at
runtime using drizzle-orm's public API (`getTableColumns`, `getTableName`, `is`, `SQLiteTable`)
and compares it against the live SQLite database via `PRAGMA table_info`. It handles two cases:

**Safe to auto-repair (nullable columns):** The vast majority of `ALTER TABLE ADD COLUMN`
migrations add nullable columns (no `NOT NULL` constraint). These are safe to add to existing
tables because SQLite sets `NULL` for all existing rows. `ensureSchemaIntegrity` does this
automatically for any nullable column in any table.

**Crash loudly (NOT NULL columns):** `NOT NULL` columns cannot be auto-repaired because the
correct backfill value for existing rows cannot be determined at runtime without the original
migration SQL. Attempting to guess would risk data corruption. Instead the process throws
immediately so the operator knows to intervene. The migration safety linter already enforces
"ADD COLUMN NOT NULL must have DEFAULT", so correctly authored migrations will always be
either nullable or carry a SQL-level DEFAULT — but that DEFAULT cannot be synthesised from
Drizzle's `$defaultFn()` (JS-side function defaults that SQLite never sees). If a NOT NULL
column is somehow missing, crashing loudly is the correct and safe behaviour.

- [x] **Generic `ensureSchemaIntegrity(sqlite)` in `getDb()`** — Replaces the hardcoded
  `duration_ms` PRAGMA check. After `migrate()` runs, `ensureSchemaIntegrity` iterates over
  every table exported from `schema.ts` using `is(v, SQLiteTable)` to filter, calls
  `getTableColumns(table)` to get the expected column set, and cross-references it against
  `PRAGMA table_info`. Missing nullable columns are added with `ALTER TABLE ADD COLUMN
  \`name\` TYPE`. Missing NOT NULL columns throw an error and crash the process. The function
  is exported for direct unit testing. — `src/lib/db/index.ts`

- [x] **Generic health probe in `/api/health`** — Replaces the single `messages.durationMs`
  SELECT with explicit `SELECT * LIMIT 0` probes against every table in schema.ts. Any
  column present in Drizzle's schema but absent from the live database surfaces as an
  immediate SQLite error, returning 503 instead of 200 and failing the Docker HEALTHCHECK.
  New tables must be added to the probe list when introduced. — `src/app/api/health/route.ts`

- [x] **Generic `ensureSchemaIntegrity` unit tests** — Replaces the two hardcoded `duration_ms`
  test blocks (Phase 32 "defensive fallback" and Phase 33 "exact production dirty-migration
  scenario") with three focused tests against the exported function:
  1. No-op when schema matches live database.
  2. Auto-fixes any missing nullable column (drops `duration_ms`, verifies it is re-added).
  3. Throws for a missing NOT NULL column (drops `messages.role`, verifies error message).
  Plus one full-chain integration test: apply all migrations, drop column, re-run
  `migrate()` (confirms skip), call `ensureSchemaIntegrity`, verify health-probe SELECT
  succeeds. — `src/__tests__/db/migrations.test.ts`

#### Files changed

| File | Change |
|------|--------|
| `src/lib/db/index.ts` | Generic `ensureSchemaIntegrity`: introspects all schema tables; auto-fixes nullable, throws for NOT NULL; exported for tests |
| `src/app/api/health/route.ts` | Probes all 5 schema tables (not just messages.duration_ms); add new tables here as schema grows |
| `src/__tests__/db/migrations.test.ts` | Replaced 2 hardcoded duration_ms tests with 4 generic ensureSchemaIntegrity tests |

### Phase 35: Structured startup diagnostics for DB troubleshooting

Without startup logs, diagnosing a production schema corruption requires shell access to the
container to manually run PRAGMA queries. This phase adds a structured diagnostic log sequence
to `getDb()` so that the information needed to understand any DB state is captured in the
application logs the moment the container starts.

The log sequence emits four sections in order:

**1. File metadata** (always first — appears in logs even if a later step crashes):
- `path`, `sqliteVersion`, `sizeBytes`, `mtime`
- `mtime` is the key field: a file modification time from hours or days before the migration
  was added is the clearest signal that the DB file was restored from a backup, which is
  the root cause of dirty-migration states.

**2. Migration state before `migrate()` runs**:
- If `__drizzle_migrations` exists: logs `count` and `hashes` of all already-applied migrations.
- If fresh DB: logs "no `__drizzle_migrations` table yet".
- This makes the dirty state immediately visible: "migration 0001 applied 3 days ago but
  `duration_ms` is missing today" — the migration was tracked before the backup was restored.

**3. What `migrate()` actually did**:
- Distinguishes "newly applied" (lists hashes) from "already up to date" (no change).
- Previously both cases emitted the same `"Database migrations applied"` message, making it
  impossible to tell from logs whether any SQL actually ran.

**4. Per-table schema integrity result** (one line per table from `ensureSchemaIntegrity`):
- `{ columns: N, status: "OK" }` — table is healthy.
- `{ columns: N, repaired: ["col"], status: "repaired" }` — drift corrected.
- For NOT NULL drift: logs `error` with `expectedColumns`, `actualColumns`, and a `hint`
  before throwing, giving the full context needed to write the repair SQL manually.

Final `"Database ready"` line confirms all checks passed and the app is serving correctly.

#### Sample log output — healthy startup after migration

```
[info] Database initializing { path: "/config/thinkarr.db", sqliteVersion: "3.46.1", sizeBytes: 245760, mtime: "2026-03-22T14:00:00.000Z" }
[info] Migration tracking: previously applied { count: 1, hashes: ["<hash-0000>"] }
[info] Migrations applied { count: 1, hashes: ["<hash-0001>"] }
[info] Schema integrity — app_config { columns: 4, status: "OK" }
[info] Schema integrity — users { columns: 8, status: "OK" }
[info] Schema integrity — sessions { columns: 4, status: "OK" }
[info] Schema integrity — conversations { columns: 5, status: "OK" }
[info] Schema integrity — messages { columns: 9, status: "OK" }
[info] Database ready
```

#### Sample log output — dirty migration state (backup-restore scenario)

```
[info] Database initializing { path: "/config/thinkarr.db", sqliteVersion: "3.46.1", sizeBytes: 122880, mtime: "2026-03-19T09:00:00.000Z" }
[info] Migration tracking: previously applied { count: 2, hashes: ["<hash-0000>", "<hash-0001>"] }
[info] Migrations: schema already up to date { totalApplied: 2 }
[warn] Schema drift corrected: added missing nullable column { tableName: "messages", column: "duration_ms", type: "integer" }
[info] Schema integrity — messages { columns: 9, repaired: ["duration_ms"], status: "repaired" }
[info] Database ready
```

#### Sample log output — NOT NULL column missing (requires operator intervention)

```
[error] Schema integrity failure — NOT NULL column missing { tableName: "messages", column: "role", expectedColumns: [...], actualColumns: [...], hint: "..." }
// process crashes — container restarts, operator alerted via HEALTHCHECK failure
```

#### Files changed

| File | Change |
|------|--------|
| `src/lib/db/index.ts` | Added 4-section startup diagnostic log sequence; `ensureSchemaIntegrity` logs per-table result; NOT NULL error includes structured context |


### Phase 36: Version Bump to 1.1.1

Bumped `package.json` version from `1.1.1-beta.5` to `1.1.1` (stable release).

| File | Change |
|------|--------|
| `package.json` | Version `1.1.1-beta.5` → `1.1.1` |

### Phase 37: Internal Log Endpoint for Claude Diagnostics (Issue #132)

Adds a zero-config internal diagnostic endpoint so Claude can pull live log lines directly from the
running container without needing a Plex session or shell access.

#### Features

- **`GET /api/internal/logs`** — Returns the last N log lines (default 300, max 2000) aggregated
  across all daily log files in `/config/logs/`. Protected by a static `X-Api-Key` header; returns
  `401` for any missing or incorrect key. No Plex session required.

- **Auto-generated key on first boot** — `getDb()` now checks for `internal_api_key` in
  `app_config` immediately after schema integrity passes. If absent it generates a 64-char hex key
  via `crypto.randomBytes(32)` and persists it with `encrypted: true`. Fully zero-config for the
  operator.

- **`GET /api/settings/internal-api-key`** — Admin-session-protected endpoint that returns the
  current key so the settings UI can display it.

- **`POST /api/settings/internal-api-key`** — Admin-session-protected endpoint that generates and
  stores a new key, returning the new value immediately.

- **Settings UI — Internal API Key card** — Added to the Logs tab above the file viewer. Shows the
  key in a read-only input with a Copy button and a Regenerate button (same pattern as the MCP
  bearer token). Key is loaded when the Logs tab is first opened.

- **`.claude/commands/beta-logs.md`** — Custom slash command. Running `/beta-logs` in a Claude
  session executes `curl -s -H "X-Api-Key: $THINKARR_INTERNAL_KEY" …/api/internal/logs?tail=300`
  and uses the output as diagnostic context.

- **`CLAUDE.md` rule** — New section "Rule: use /beta-logs before diagnosing runtime issues"
  documents when to run the command and how to set `THINKARR_INTERNAL_KEY` in settings.json.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/internal/logs/route.ts` | New — `GET /api/internal/logs`, X-Api-Key auth, tail param |
| `src/app/api/settings/internal-api-key/route.ts` | New — `GET` / `POST` for admin UI display + regeneration |
| `src/lib/db/index.ts` | Auto-generate `internal_api_key` on first boot after schema integrity check |
| `src/app/settings/page.tsx` | Internal API Key card added to Logs tab; state + fetch functions added |
| `.claude/commands/beta-logs.md` | New slash command — fetches live logs from beta container |
| `CLAUDE.md` | Added "use /beta-logs before diagnosing runtime issues" rule |
| `src/__tests__/api/internal-logs.test.ts` | New — 401 on missing/wrong key, 200 on valid key, tail param, multi-file aggregation |

#### Config keys added

| Key | Encrypted | Description |
|-----|-----------|-------------|
| `internal_api_key` | true | 64-char hex key for `GET /api/internal/logs` |

#### API routes added

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/internal/logs` | `X-Api-Key` header | Return last N log lines |
| `GET` | `/api/settings/internal-api-key` | Admin session | Fetch current key for UI display |
| `POST` | `/api/settings/internal-api-key` | Admin session | Regenerate and return new key |

### Phase 37b: Internal Logs API — efficiency improvements

#### Features
- **Newest-first file iteration with early exit** — `GET /api/internal/logs` now reads log files from newest to oldest and stops as soon as the unfiltered tail quota is met. A routine `tail=300` call no longer reads days-old files when the current log file already contains enough lines.
- **`?level=<error|warn|info>` filter** — Callers can scope results to a single log severity. The filter matches the JSON field `"level":"<value>"` case-insensitively. `tail` applies to the filtered result set.
- **`?conversationId=<id>` filter** — Callers can scope results to a single conversation session. Combinable with `?level=`.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/internal/logs/route.ts` | Newest-first iteration, early exit when quota met, `level` and `conversationId` query filters |
| `src/__tests__/api/internal-logs.test.ts` | 6 new tests — early-exit optimisation, level filter, conversationId filter, combined filter, empty-result case, tail-on-filtered-lines |

### Phase 38: Report Issue Feature (issue #159)

#### Features
- [x] **Report Issue button in chat window (#159)** — "Report Issue" flag button appears in the chat toolbar when a conversation is active. Clicking opens a modal where the user describes the observed problem. On submit, `POST /api/report-issue` fetches the full conversation transcript (messages, tool calls, timestamps) from the DB and creates a GitHub issue tagged `user-reported` via the GitHub REST API. If no GitHub credentials are configured the report is still logged at `info` level. The modal shows a link to the created issue on success. — `src/app/api/report-issue/route.ts` (new), `src/components/chat/report-issue-modal.tsx` (new), `src/app/chat/page.tsx`
- [x] **GitHub config in Settings → Logs** — Admin can store `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPO` in `app_config` via a new card in the Logs tab. Env vars take precedence; stored values are used as fallback. Token is masked in the `GET /api/settings` response.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/report-issue/route.ts` | New — POST endpoint; auth, access control, transcript assembly, GitHub API call; falls back to `app_config` when env vars absent |
| `src/components/chat/report-issue-modal.tsx` | New — modal: description textarea, submit, success/error feedback |
| `src/app/chat/page.tsx` | Combined model-selector + Report Issue toolbar; renders modal |
| `src/app/api/settings/route.ts` | `GET` returns `github: {token, owner, repo}` (token masked); `PATCH` handles `github` section |
| `src/app/settings/page.tsx` | `githubConfig` state; loaded on init; included in save; GitHub config card in Logs tab |
| `src/__tests__/api/report-issue.test.ts` | New — 12 tests covering auth, input validation, access control, no-token path, GitHub integration |

#### API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/report-issue` | User session | Create a GitHub issue from a conversation report |

#### Config keys added

| Key | Encrypted | Description |
|-----|-----------|-------------|
| `github_token` | true | PAT with `repo` scope for creating issues |
| `github_owner` | false | GitHub repository owner (default: `chrisrothwell`) |
| `github_repo` | false | GitHub repository name (default: `thinkarr`) |

Admin can now configure GitHub issue reporting credentials directly in **Settings → Logs** without needing environment variables. Token stored encrypted; owner/repo stored plain. Env vars (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`) still take precedence when set.


### Phase: Version 1.1.2-beta.1

#### Version bump
- [x] Bumped `package.json` version from `1.1.1` to `1.1.2-beta.1`


### Phase 39: Logging gap fixes

#### Features
- [x] **Logout logging** — `DELETE /api/auth/session` now reads the session before destroying it and logs `User logout` with `userId` and `plexUsername`. Previously the logout was silent in the logs, making it impossible to distinguish voluntary logouts from session expiry.
- [x] **Report-issue log message clarity** — Renamed `"report-issue: issue submitted"` (which fired before the GitHub API call) to `"report-issue: report logged"` to make clear it is a local-only log entry. The post-GitHub success log is renamed `"report-issue: GitHub issue created"`. Eliminates the ambiguity seen in live logs where the warn and the info fired in the same millisecond with the same conversation ID.
- [x] **Frontend global error logging** — Added `<ErrorLogger />` client component (`src/components/error-logger.tsx`) to the root layout. It attaches `window.onerror` and `window.unhandledrejection` listeners on mount and forwards errors to the server via `clientLog.error`, so unhandled JS errors and promise rejections now appear in `/api/internal/logs` alongside backend events.
- [x] **Next.js error boundary** — Added `src/app/error.tsx` (React error boundary) that logs caught rendering errors via `clientLog.error` before rendering a minimal "try again" fallback UI.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/auth/session/route.ts` | `DELETE` handler: get session before destroy, log `User logout` |
| `src/app/api/report-issue/route.ts` | Rename pre-GitHub log to `report-issue: report logged`; post-GitHub log to `report-issue: GitHub issue created` |
| `src/components/error-logger.tsx` | New — client component; `window.onerror` + `unhandledrejection` → `clientLog.error` |
| `src/app/layout.tsx` | Add `<ErrorLogger />` to root layout body |
| `src/app/error.tsx` | New — Next.js route error boundary; logs caught errors via `clientLog.error` |
| `src/__tests__/api/session.test.ts` | New — tests for GET and DELETE `/api/auth/session` including logout log assertion |
| `src/__tests__/api/report-issue.test.ts` | Update log message string assertion to match renamed log |

### Phase 40: Session expiry logging

#### Features
- [x] **Expired session warning** — `getSession()` in `src/lib/auth/session.ts` now logs `warn "Session expired or not found"` with the `sessionId` when a session cookie is present but the session row is missing or past its `expiresAt`. Previously this was a silent null return, making it impossible in logs to distinguish "user has no cookie" from "user has a cookie but their 30-day session expired and they'll be bounced to the login screen".

#### Files changed

| File | Change |
|------|--------|
| `src/lib/auth/session.ts` | Import `logger`; add `logger.warn("Session expired or not found", { sessionId })` before the existing `return null` at line 75 |
| `src/__tests__/api/session.test.ts` | Add `logWarnSpy`; new test case: expired session cookie returns 401 and logs the warning with the sessionId |

### Phase 41: Fix Overseerr search — parentheses in query cause HTTP 400

#### Bug
Log analysis of conversation `81f6c0cd` revealed `overseerr_search` returning HTTP 400 when the user searched for titles like `"Star Trek (2009)"`. Overseerr validates the decoded query value server-side and rejects RFC 3986 reserved characters including `(` and `)`. The existing `encodeURIComponent` encoding is insufficient because Overseerr decodes the value before validation.

#### Fix
- Strip RFC 3986 reserved characters (`( ) [ ] { } ! $ & ' * + , ; = ? # @ / \`) from the query string before encoding, collapsing extra whitespace. The movie/show is still found correctly — e.g. `"Star Trek (2009)"` → `"Star Trek 2009"`.

#### Test
- Added regression test: `"Star Trek (2009)"` must call `fetch` with a URL containing no `(` or `)` and must contain `Star%20Trek%202009`.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/overseerr.ts` | Strip reserved characters from query before `encodeURIComponent` in `search()` |
| `src/__tests__/lib/overseerr.test.ts` | New test: parentheses stripped from query |

### Phase 42: Fix stuck spinners and mobile SSE reconnection

#### Bugs
Two related issues observed in beta logs (conversation `81f6c0cd`):

1. **Stuck spinner after SSE disconnect** — `buildHistoricalToolCalls` left incomplete tool calls with `status: "calling"` when rebuilding from the DB after a reload. Since `"calling"` renders a spinner, any tool call that never completed (e.g. because the stream dropped) showed an infinite spinner after reconnecting.

2. **Mobile backgrounding silently kills stream** — When Chrome on mobile is backgrounded, the browser can silently suspend the SSE stream without throwing an error. The `finally` block (which reloads messages and clears state) never fired until the user manually retried.

#### Fix
- `message-list.tsx`: change the fallback status in `buildHistoricalToolCalls` from `"calling"` to `"error"` with message `"Connection was lost"` for tool calls that have no result record in the DB.
- `use-chat.ts`: add a `visibilitychange` listener. When the page becomes visible after being hidden for > 3 s while a stream is active, abort the stream. The existing `finally` block then fires, reloads messages, and clears spinners.
- `buildHistoricalToolCalls` is exported so it can be unit-tested directly.

#### Files changed

| File | Change |
|------|--------|
| `src/components/chat/message-list.tsx` | Export `buildHistoricalToolCalls`; change fallback status from `"calling"` to `"error"` with "Connection was lost" |
| `src/hooks/use-chat.ts` | Add `visibilitychange` listener to abort stale streams on mobile foreground |
| `src/__tests__/lib/build-historical-tool-calls.test.ts` | New — 3 unit tests: done, interrupted (no result), and error result |

### Phase 42 (addendum): Background SSE resilience

#### Root cause
When mobile Chrome backgrounds the app, the client TCP connection drops. This causes `controller.enqueue()` to throw (WHATWG streams cancel the controller when the consumer disconnects). That throw propagated through `for await (const event of orchestrate(...))` in `route.ts`, abandoning the generator mid-execution — before tool results were saved to DB.

#### Fix
- `src/app/api/chat/route.ts`: Introduced `enqueue()` helper that catches `controller.enqueue()` errors and sets `clientConnected = false`. The `for await` loop continues iterating the orchestrator generator regardless — tool calls execute to completion and results are saved to DB. `controller.close()` in the `finally` block is also wrapped since it may also throw on an already-cancelled stream.
- `src/hooks/use-chat.ts`: Added `visibilitychange` listener (after all `useCallback` hooks so `loadMessages` is in scope). When the page becomes visible and no stream is active, reloads messages from DB so server-side results that completed while the page was backgrounded are immediately shown.

### Phase 43: Lean overseerr_search — eliminate per-result detail fetches

#### Problem
Log analysis of conversation `81f6c0cd` showed that each `overseerr_search` tool call was firing up to 10 parallel `/movie|tv/{id}` requests (one per result) to retrieve `cast` and `imdbId`. With the LLM making 15 parallel search calls in a single turn, this produced ~150 supplementary Overseerr HTTP requests and caused the prompt token count to balloon from ~6k to ~16k (search result JSON accumulated in conversation history).

#### Fix
- Removed the `Promise.all` detail-fetch block from `search()` entirely.
- All fields needed for title cards (`mediaStatus`, `summary`, `rating`, `thumbPath`, `seasonCount`) are already present in the TMDB search payload — no extra fetches required.
- `cast`, `imdbId`, `genres`, `runtime`, per-season availability, and request history are now exclusively returned by `overseerr_get_details`, called on demand when the user asks for more information about a specific title.
- Updated `OverseerrSearchResult` interface: removed `cast` and `imdbId`.
- Updated tool descriptions to clearly document the search vs. get_details split.
- Tests: replaced cast/imdbId-in-search tests with a "no extra fetches" assertion suite and new `getDetails` coverage.

#### API call reduction
| Before | After |
|--------|-------|
| 1 search + up to 10 detail fetches per tool call | 1 search fetch per tool call |

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/overseerr.ts` | Remove detail fetch loop from `search()`; drop `cast`/`imdbId` from `OverseerrSearchResult`; read `seasonCount` directly from `r.numberOfSeasons` |
| `src/lib/tools/overseerr-tools.ts` | Update `overseerr_search` and `overseerr_get_details` descriptions |
| `src/__tests__/lib/overseerr.test.ts` | Replace cast/request search tests with no-extra-fetch and `getDetails` test suites |

### Phase 44: Fix repeated orphaned tool call repair on every request

#### Root cause
When the SSE stream dropped mid-tool-execution (mobile backgrounding / network flap), the tool call was saved to the `messages` table (as part of the assistant row's `toolCalls` JSON) but no corresponding tool result row was ever written. `loadHistory()` in `orchestrator.ts` correctly detected the orphan and injected a synthetic error result in memory, allowing the LLM to recover. However, the synthetic result was never persisted to the DB.

**Observed impact (beta logs, conv `6913c98e`):** `sonarr_get_series_status` call `call_vd4Ydqzwy3WmiDZYYtdK2xYM` was repaired on 9 consecutive requests over 12 minutes. The same pattern occurred for a `display_titles` call after a second stream failure. Each repair logged a WARN, none visible as a user-facing error, but they polluted logs and wasted CPU.

#### Fix
Added a `saveMessage()` call inside the orphan repair branch of `loadHistory()`. The first request that encounters an orphaned call writes the synthetic result to DB. Every subsequent `loadHistory()` call finds the row, includes it in `seenToolResultIds`, and skips the repair entirely.

#### Test
New regression test in `orchestrator.test.ts`: seeds a conversation with an orphaned tool call, runs two consecutive `orchestrate()` calls, and asserts the synthetic row count is exactly 1 after both runs (not 2 or more).

#### Files changed

| File | Change |
|------|--------|
| `src/lib/llm/orchestrator.ts` | Add `saveMessage()` call inside orphan repair branch in `loadHistory()` |
| `src/__tests__/lib/orchestrator.test.ts` | New regression test: synthetic result row count stays 1 across consecutive requests |

### Phase 45: Sanitize LLM API errors before forwarding to client

#### Bug
Beta log analysis (conversation `df722f04`, March 25) showed raw OpenAI 429 quota errors being forwarded verbatim to the client UI:

```
ERROR [df722f04] [client] Server error event 429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.
```

These appeared as confusing "network error" glitches in the UI, exposing internal API details to end users.

#### Fix
Added `sanitizeLlmError()` helper in `orchestrator.ts`. Raw error is preserved in server-side logs; only a friendly message is yielded to the client:
- 429 / quota / rate-limit → "The AI service is temporarily unavailable. Please try again in a moment."
- 401 / 403 / unauthorized / forbidden → "The AI service is not properly configured. Please contact the administrator."
- Everything else → "The AI service encountered an error. Please try again."

#### Files changed

| File | Change |
|------|--------|
| `src/lib/llm/orchestrator.ts` | Add `sanitizeLlmError()`; use it in the LLM catch block instead of forwarding raw error |
| `src/__tests__/lib/orchestrator.test.ts` | 2 new tests: 429 yields friendly rate-limit message; generic error yields friendly fallback |

### Phase 46: Fix CodeQL unvalidated dynamic method call in client-log route

#### Issue
GitHub Code Scanning (CodeQL) alert #25 flagged `src/app/api/client-log/route.ts` line 53:

```typescript
logger[level](`[client] ${message}`, ...);
```

Even though `level` is validated to only be `"warn"`, `"error"`, or `"info"`, CodeQL cannot trace through the ternary expression and flags the dynamic property access as an "unvalidated dynamic method call" — a real pattern that can cause unexpected dispatch or prototype pollution in less controlled code.

#### Fix
Replaced the dynamic bracket access with an explicit `if/else if/else` dispatch:

```typescript
if (level === "warn") { logger.warn(...); }
else if (level === "error") { logger.error(...); }
else { logger.info(...); }
```

This eliminates the bracket notation entirely, satisfying CodeQL without changing runtime behaviour.

#### Test
New unit test suite `src/__tests__/api/client-log.test.ts` covering:
- 401 when unauthenticated
- 400 for invalid JSON
- Correct logger method called for `info`, `warn`, `error` levels
- Default to `info` for unknown or missing level
- Message truncation at 500 characters
- Default message for non-string input

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/client-log/route.ts` | Replace `logger[level](...)` with explicit `if/else if/else` dispatch |
| `src/__tests__/api/client-log.test.ts` | New unit test suite (10 tests) |

### Phase 47: Reduce OpenAI token consumption to prevent TPM rate-limit exhaustion

#### Problem
A handful of queries was hitting the OpenAI tokens-per-minute (TPM) rate limit, even on tier 1 (30,000 TPM). Root-cause analysis identified three compounding sources of token bloat:

1. **`overseerr.search()` — unbounded summary field**: `r.overview` was mapped directly from the TMDB payload with no length cap. TMDB overviews can be 500–1,000+ characters. With 10 results per page, a single `overseerr_search` call could inject up to ~10,000 characters of synopsis text into the prompt.

2. **No `llmSummary` on Plex or Overseerr tools**: The `llmSummary` mechanism (used by `display_titles` since Phase 43) compresses tool results stored in conversation history — `loadHistory()` calls `getToolLlmContent()` which substitutes a compact form when the tool defines one. Without it on Plex/Overseerr tools, every turn in a multi-turn conversation re-sent full JSON blobs (summaries, thumbnail paths, episode counts) accumulated from all previous searches.

3. **Architectural conflict — `getToolLlmContent` used for both in-round and history**: The orchestrator called `getToolLlmContent()` both when appending a fresh tool result to `apiMessages` (in-round) and when `loadHistory()` loaded old results from the DB. An aggressive `llmSummary` on Plex tools (stripping `summary` and `thumbPath`) would have broken `display_titles` because the LLM needs those fields from the in-round result to construct its `display_titles` arguments.

#### Fixes

**Fix 1 — Truncate Overseerr summary at source** (`src/lib/services/overseerr.ts`)  
Added `.substring(0, 300)` to `r.overview` in `search()`. TMDB overviews are already truncated at 300 chars in Plex results; this makes both data sources consistent. Directly reduces in-round prompt tokens for every `overseerr_search` call.

**Fix 2 — Decouple in-round vs history usage** (`src/lib/llm/orchestrator.ts`)  
Changed the in-round `apiMessages.push` to pass `result` directly (full JSON) instead of `getToolLlmContent(name, result)`. The `loadHistory()` function continues to use `getToolLlmContent()` for its DB-loaded messages. This decoupling means `llmSummary` functions now only affect conversation history, not the current tool round — so they can safely strip any field without breaking subsequent tool calls.

**Fix 3 — Add `llmSummary` to all Plex search tools** (`src/lib/tools/plex-tools.ts`)  
Added a shared `plexResultsLlmSummary()` helper used by `plex_search_library`, `plex_get_on_deck`, `plex_get_recently_added`, `plex_search_collection`, and `plex_search_by_tag`. The `plex_check_availability` tool gets an inline variant preserving the `available` flag. The compact form retains: `title`, `year`, `mediaType`, `plexKey`, `rating`, `cast`, `showTitle`, `seasonNumber`, `episodeNumber`. Stripped from history: `summary`, `thumbPath`, `seasons`, `totalEpisodes`, `watchedEpisodes`, `dateAdded`.

**Fix 4 — Add `llmSummary` to Overseerr tools** (`src/lib/tools/overseerr-tools.ts`)  
- `overseerr_search`: compact form retains `overseerrId`, `overseerrMediaType`, `title`, `year`, `rating`, `mediaStatus`, `seasonCount`. Strips `summary` and `thumbPath`.  
- `overseerr_list_requests`: compact form retains `mediaType`, `title`, `year`, `status`, `mediaStatus`, `requestedBy`, `overseerrId`, `seasonsRequested`. Strips `id`, `requestedAt`, `tmdbId`, `thumbPath`.

#### Token savings estimate (per turn in a multi-turn conversation)

| Source | Before | After (history) | Saving |
|--------|--------|-----------------|--------|
| `overseerr_search` (10 results) | ~7,500 chars | ~1,000 chars | ~1,600 tokens |
| `plex_search_library` (10 results) | ~5,500 chars | ~1,200 chars | ~1,075 tokens |
| `overseerr_list_requests` (10 results) | ~3,000 chars | ~700 chars | ~575 tokens |

A conversation that had 3 prior searches now starts each new turn with ~3,250 fewer tokens in its history — enough to prevent limit exhaustion at tier 1 (30,000 TPM).

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/overseerr.ts` | Truncate `summary` to 300 chars in `search()` |
| `src/lib/llm/orchestrator.ts` | In-round tool messages use `result` (full); `loadHistory` uses `getToolLlmContent` (compact) |
| `src/lib/tools/plex-tools.ts` | Add `plexResultsLlmSummary` helper + `llmSummary` on all 6 Plex search tools |
| `src/lib/tools/overseerr-tools.ts` | Add `llmSummary` on `overseerr_search` and `overseerr_list_requests`; import types |
| `src/__tests__/lib/token-reduction.test.ts` | 6 new tests covering all four fixes |

### Phase 48: Further TPM reduction — remaining tool payloads and multi-season call args

#### Problem
After Phase 47, the following sources of token bloat remained:

1. **`overseerr_get_details` — no `llmSummary`**: Full response (cast × 10, all per-season statuses, all request history) went into every subsequent turn unchanged. A 10-season show alone contributes 10 season-status objects plus up to 10 request objects.

2. **`plex_get_title_tags` — no `llmSummary`**: Returns full unbounded `directors[]` and `actors[]` arrays. A movie with many associated directors (e.g. anthology films) or large ensemble cast could send 20+ names into history.

3. **`sonarr_search_series` / `radarr_search_movie` — no `llmSummary`**: 200-character `overview` fields × up to 10 results stay in conversation history as noise after the initial search is acted upon.

4. **`sonarr_get_series_status` — no `llmSummary`**: Full per-season array (one object per season with `seasonNumber`, `totalEpisodes`, `downloadedEpisodes`, `monitored`) stays in history for all subsequent turns.

5. **`display_titles` tool call arguments** — the assistant's own `tool_calls` message is replayed verbatim each turn. For a multi-season show (e.g. 20 seasons), the arguments include 20 entries each repeating the same 300-char `summary`, `thumbPath` URL, and `cast` array. This is the single largest remaining source of per-turn bloat.

#### Fixes

**Fix 1 — `overseerr_get_details` `llmSummary`** (`src/lib/tools/overseerr-tools.ts`)
Compact form: `overseerrId`, `overseerrMediaType`, `title`, `year`, `imdbId`, `cast` (first 5 only, down from 10), `genres`, `runtime`/`episodeRuntime`, `seasonCount`. Seasons list replaced by `availableSeasons` (array of season numbers with "Available" status). `requests` array dropped entirely.

**Fix 2 — `plex_get_title_tags` `llmSummary`** (`src/lib/tools/plex-tools.ts`)
Compact form caps `directors` at 3 and `actors` at 5. All other fields (`genres`, `countries`, `studio`, `contentRating`, `labels`) are unchanged.

**Fix 3 — `sonarr_search_series` `llmSummary`** (`src/lib/tools/sonarr-tools.ts`)
Strips `overview` from each result. All identity and status fields preserved.

**Fix 4 — `sonarr_get_series_status` `llmSummary`** (`src/lib/tools/sonarr-tools.ts`)
Top-level stats (`totalEpisodes`, `downloadedEpisodes`, `missingEpisodes`, `nextAiring`) preserved. Per-season array compacted to a single string: `"S1:7/7 S2:13/13 S3:11/13"`.

**Fix 5 — `radarr_search_movie` `llmSummary`** (`src/lib/tools/radarr-tools.ts`)
Strips `overview` from each result. All identity and status fields preserved.

**Fix 6 — `display_titles` tool call arg compression** (`src/lib/llm/orchestrator.ts`)
In `loadHistory()`, after parsing stored `tool_calls`, `display_titles` call arguments are post-processed: `summary`, `thumbPath`, and `cast` are stripped from each title entry. The tool's `llmSummary` already confirms which cards were shown in the result message; the full per-entry media fields are not needed in the replayed call arguments.

#### Token savings estimate (incremental over Phase 47)

| Source | Approximate saving per historical turn |
|--------|---------------------------------------|
| `overseerr_get_details` (10-season show) | ~800 tokens |
| `sonarr_get_series_status` (10 seasons) | ~200 tokens |
| `display_titles` (20-season show, 1 prior call) | ~1,500 tokens |
| `sonarr/radarr` search overviews (10 results each) | ~500 tokens |
| `plex_get_title_tags` (large cast) | ~100 tokens |

#### Files changed

| File | Change |
|------|--------|
| `src/lib/tools/overseerr-tools.ts` | Add `llmSummary` to `overseerr_get_details`; import `OverseerrDetails` type |
| `src/lib/tools/plex-tools.ts` | Add `llmSummary` to `plex_get_title_tags` |
| `src/lib/tools/sonarr-tools.ts` | Add `llmSummary` to `sonarr_search_series` and `sonarr_get_series_status`; import types |
| `src/lib/tools/radarr-tools.ts` | Add `llmSummary` to `radarr_search_movie`; import `RadarrMovie` type |
| `src/lib/llm/orchestrator.ts` | Compact `display_titles` tool call args in `loadHistory()` |
| `src/__tests__/lib/token-reduction.test.ts` | 9 new tests (15 total) covering all new summaries and call-arg compression |

### Phase 49: Fix season-specific request/watch functionality broken by token reduction (PRs 184–186)

#### Problem
PRs 184–186 inadvertently broke three critical behaviours that ensure season-level title cards work correctly:

1. **`plex_search_library` / `plex_check_availability` `llmSummary`** stripped `thumbPath`. In follow-up turns the LLM had no poster URL for Plex results in history, causing title cards without thumbnails.

2. **`overseerr_search` `llmSummary`** stripped `thumbPath`. Same issue: follow-up display calls lacked poster URLs.

3. **`overseerr_get_details` `llmSummary`** replaced the seasons array with only `availableSeasons` (season numbers with "Available" status). Pending and not-requested seasons were invisible to the LLM in subsequent turns, causing it to assign `mediaStatus: "not_requested"` to pending seasons and show a fake Request button — which triggered an Overseerr API error when clicked.

4. **`display_titles` call-arg compression** in `loadHistory()` stripped `thumbPath` along with `summary` and `cast`. Follow-up display calls generated by the LLM in subsequent turns lacked poster URLs even when the LLM had them from the tool result.

#### Impact on season-specific UX
Each season of a TV show must appear as its own tile with:
- A working poster thumbnail
- A Request button that targets only that season (via `overseerrId` + `seasonNumber`)
- A Watch button that opens that season in Plex (via `plexKey` + `seasonNumber`)

Stripping `thumbPath` prevented thumbnails; dropping pending/not-requested seasons caused incorrect `mediaStatus` and broken Request buttons.

#### Fixes

**Fix 1 — Restore `thumbPath` in Plex `llmSummary`** (`src/lib/tools/plex-tools.ts`)  
`plexResultsLlmSummary` and `plex_check_availability` llmSummary now include `thumbPath`. Token saving is negligible (~50 chars per result vs. ~300 chars for summary).

**Fix 2 — Restore `thumbPath` in `overseerr_search` `llmSummary`** (`src/lib/tools/overseerr-tools.ts`)  
`thumbPath` preserved in compact form. Main savings still come from stripping `summary`.

**Fix 3 — All-seasons compact string in `overseerr_get_details` `llmSummary`** (`src/lib/tools/overseerr-tools.ts`)  
Replaced `availableSeasons: number[]` with `seasons: "S1:available S2:pending S3:not_requested"` compact string. This is slightly more compact than the original JSON array objects while preserving every season's status — the LLM can now set the correct `mediaStatus` per season card in follow-up turns.

**Fix 4 — Keep `thumbPath` in `display_titles` call-arg compression** (`src/lib/llm/orchestrator.ts`)  
Only `summary` and `cast` are stripped from historical `display_titles` call arguments. `thumbPath` is preserved so the LLM can reuse poster URLs in follow-up display calls without needing to re-search.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/tools/plex-tools.ts` | Restore `thumbPath` to `plexResultsLlmSummary` and `plex_check_availability` llmSummary |
| `src/lib/tools/overseerr-tools.ts` | Restore `thumbPath` to `overseerr_search` llmSummary; replace `availableSeasons` with all-status compact seasons string in `overseerr_get_details` llmSummary |
| `src/lib/llm/orchestrator.ts` | Only strip `summary` and `cast` from `display_titles` history args; keep `thumbPath` |
| `src/__tests__/lib/token-reduction.test.ts` | Update all affected tests to assert correct new behaviour |

---

## Phase 49 — Version bump to 1.1.3-beta.1

Bumped `package.json` version from `1.1.2` to `1.1.3-beta.1` in preparation for the next beta release.

| File | Change |
|------|--------|
| `package.json` | Version `1.1.2` → `1.1.3-beta.1` |

---

### Phase 50: LLM Optimizations & Plex Series Episodes Tool (#195, #196, #197)

#### Bug Fixes

- [x] **#196 — Tool calls logging full API responses** — `sonarrFetch()` and `radarrFetch()` were logging `body: JSON.stringify(data).slice(0, 5000)` on every successful response, flooding the logs with large JSON payloads. Removed the `body` field from the `Sonarr API response` and `Radarr API response` info logs. Plex and Overseerr were already correct (no body in success path). — `src/lib/services/sonarr.ts`, `src/lib/services/radarr.ts`

#### Features

- [x] **#197 — Plex series episodes tool with season/episode params** — New `getSeriesEpisodes(plexKey, season?, episode?)` function in `plex.ts` that fetches season or episode data for a TV show:
  - No season/episode → returns one card per season ordered by season number (with `totalEpisodes` and `watchedEpisodes`); season 0 (specials) excluded
  - Season only → returns episodes from that season ordered by episode number
  - Season + episode → returns a single matching episode
  - Uses the show's `plexKey` (from a prior `plex_search_library` result), fetches `/children` for seasons, then uses the season's `ratingKey` to fetch `/library/metadata/{ratingKey}/children` for episodes.

  New `plex_get_series_episodes` MCP tool registered with `llmSummary` that preserves `seasonNumber`, `episodeNumber`, `totalEpisodes`, and `watchedEpisodes`. Tool description guides the LLM to prefer this tool over `plex_search_library` when the user asks about specific seasons or episodes. — `src/lib/services/plex.ts`, `src/lib/tools/plex-tools.ts`

- [x] **#195 — SSE heartbeat to prevent client disconnects** — Added a `setInterval` that sends `: heartbeat\n\n` (SSE comment) every 15 seconds in `POST /api/chat`. Prevents mobile browsers and proxies from closing the connection while the backend is waiting for the LLM to finish tool execution. Interval is cleared in the `finally` block whether the stream succeeds or errors. — `src/app/api/chat/route.ts`

- [x] **#195 — Parallel tool execution (request batching)** — Changed the sequential `for...of` tool execution loop in `orchestrator.ts` to use `Promise.all`. All tool calls in a single LLM round now execute concurrently rather than one-by-one. For queries that trigger 10 `overseerr_get_details` calls in a single round, the wall-clock time drops from ~10× individual latency to ~1× the slowest call. `tool_call_start` events are emitted for all tools before awaiting results; `tool_result` events and DB saves happen in original order after all results are available. — `src/lib/llm/orchestrator.ts`

#### Tests

- [x] **`src/__tests__/lib/plex.test.ts`** — 7 new `getSeriesEpisodes` tests: season overview (ordered, specials excluded, totalEpisodes/watchedEpisodes populated), episodes from a season (ordered by episode number, showTitle/seasonNumber preserved), single episode lookup, not-found episode, not-found season, and ratingKey URL assertion.

#### MCP Tools table update

| Server | Tools |
|--------|-------|
| Plex | plex_search_library, plex_get_on_deck, plex_get_recently_added, plex_check_availability, plex_search_collection, plex_search_by_tag, plex_get_title_tags, **plex_get_series_episodes** |

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/sonarr.ts` | Remove `body` from `Sonarr API response` info log (#196) |
| `src/lib/services/radarr.ts` | Remove `body` from `Radarr API response` info log (#196) |
| `src/lib/services/plex.ts` | New `getSeriesEpisodes(plexKey, season?, episode?)` function (#197) |
| `src/lib/tools/plex-tools.ts` | New `plex_get_series_episodes` tool with `llmSummary` (#197) |
| `src/app/api/chat/route.ts` | SSE heartbeat every 15s via `setInterval` (#195) |
| `src/lib/llm/orchestrator.ts` | Parallel tool execution via `Promise.all` instead of sequential loop (#195) |
| `src/__tests__/lib/plex.test.ts` | 7 new `getSeriesEpisodes` tests (#197) |

### Phase 51: Tool History Trimming (token-bloat fix)

#### Problem

Long conversations accumulated tool-calling rounds unboundedly in the OpenAI message history. Even with `llmSummary` compressing individual tool results, each round added ~519 tokens (assistant tool-call message + compressed tool result). At 35+ turns, conversations reached 21k–27k tokens, approaching the TPM limit and causing 429 errors.

#### Fix

Added `trimToolHistory()` in `src/lib/llm/orchestrator.ts`, called from `loadHistory()` after the orphan-repair step.

- Counts the number of assistant messages with `tool_calls` (= number of tool-calling rounds).
- If the count exceeds `MAX_TOOL_ROUNDS_IN_HISTORY` (5), the oldest rounds are collapsed:
  - `tool` result messages for dropped call IDs are removed entirely.
  - The corresponding `assistant` message has its `tool_calls` array stripped and replaced with an inline text note: `[searched: plex_search_library]` (or a comma-separated list for multi-tool rounds).
  - Any existing assistant text content is preserved prepended to the note.
- All user messages and plain (non-tool-calling) assistant messages are kept intact.

#### Effect

Token cost of history is now capped. A conversation with 35 tool-calling rounds sends the same history size as one with 5, rather than growing linearly.

#### Tests

- [x] **`src/__tests__/lib/orchestrator.test.ts`** — 6 new `trimToolHistory — pure unit` tests covering: no-op under limit, trimming oldest rounds, `[searched:]` note injection, content preservation, user/plain-assistant survival count, boundary case at limit+1.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/llm/orchestrator.ts` | `trimToolHistory()` + `MAX_TOOL_ROUNDS_IN_HISTORY` exported; called from `loadHistory()` |
| `src/__tests__/lib/orchestrator.test.ts` | 6 new pure unit tests for `trimToolHistory` |


---

### Phase 52: Bug Fixes & UX Polish (#137, #166, #178, #192, #194)

#### Bug Fixes

- [x] **#137 — No trash icon on mobile** — The delete-chat button was only rendered when `hoveredId === conv.id` (JS hover state), which is never triggered on touch devices. Replaced the conditional render with always-visible rendering, using Tailwind responsive classes (`md:opacity-0 md:group-hover:opacity-100`) so the button is always shown on mobile and appears on hover on desktop. Removed the now-unused `hoveredId` state. — `src/components/chat/sidebar.tsx`

- [x] **#194 — Request button drops to next line** — When the Request button changed from "Request" → "Requesting…" (with spinner) or "Requested", the wider content caused it to wrap below "More Info". Wrapped the More Info anchor and Request/Requested elements in a `flex flex-nowrap gap-2` sub-group so they stay on the same line. Added `whitespace-nowrap` to prevent individual button text from wrapping. — `src/components/chat/title-card.tsx`

#### Features / Enhancements

- [x] **#166 — Report Issue button moved to right side** — Moved the Report Issue button from the left of the top toolbar to the right, placing the model selector on the left. This ensures it doesn't overlap the sidebar toggle or model selector dropdown. — `src/app/chat/page.tsx`

- [x] **#178 — LLM date awareness + Overseerr recent-release hints** — Injected the current date (`{{currentDate}}` placeholder, resolved at runtime via `buildCurrentDate()`) into both the text and realtime default system prompts. Added a guideline hint instructing the LLM to search Overseerr with the current year when users ask about new/recent releases, since Overseerr indexes TMDB and is the best source for titles not yet in Plex. — `src/lib/llm/system-prompt.ts`, `src/lib/llm/default-prompt.ts`

- [x] **#192 (1) — Service status indicators update on model change** — `services/status/route.ts` now iterates all enabled LLM endpoints from `llm.endpoints` (one `ServiceStatus` entry per endpoint, named after the endpoint) instead of a single "LLM" entry from the legacy single-config keys. `ServiceStatus` component accepts a `selectedModel` prop and triggers an immediate re-poll via `useEffect` when the model changes. `Sidebar` forwards the new `selectedModel` prop to `ServiceStatus`. `ChatPage` passes `selectedModel` to `Sidebar`. — `src/app/api/services/status/route.ts`, `src/components/chat/service-status.tsx`, `src/components/chat/sidebar.tsx`, `src/app/chat/page.tsx`

- [x] **#192 (2) — Per-endpoint test result state** — In settings, testing one LLM endpoint was storing the result under the shared key `"llm"`, causing both endpoints' UI to show the same result. Changed to use a per-endpoint key `"llm-{endpointId}"` in `testResults` state, and updated the endpoint card UI to read from `testResults[\`llm-${ep.id}\`]`. — `src/app/settings/page.tsx`

- [x] **#192 (3) — Test connection logging** — Added `logger.info` / `logger.warn` calls in the `POST /api/setup/test-connection` route so every test attempt is written to the application log with endpoint URL, service type, model, endpointId, hasApiKey, success, and message fields for troubleshooting failures. — `src/app/api/setup/test-connection/route.ts`

#### Files changed

| File | Change |
|------|--------|
| `src/components/chat/sidebar.tsx` | Always-visible delete button via CSS opacity; removed `hoveredId` state; new `selectedModel` prop forwarded to `ServiceStatus` (#137, #192) |
| `src/components/chat/title-card.tsx` | More Info + Request/Requested buttons grouped in `flex-nowrap` sub-container (#194) |
| `src/app/chat/page.tsx` | Model selector moved left, Report Issue button moved right; `selectedModel` passed to `Sidebar` (#166, #192) |
| `src/lib/llm/system-prompt.ts` | `buildCurrentDate()` helper; `{{currentDate}}` substitution in `buildSystemPrompt` and `buildRealtimeSystemPrompt` (#178) |
| `src/lib/llm/default-prompt.ts` | `{{currentDate}}` placeholder added; Overseerr recent-release discovery hint added to both prompts (#178) |
| `src/app/api/services/status/route.ts` | `checkLlmEndpoints()` checks all enabled endpoints from `llm.endpoints`; returns one entry per endpoint; legacy single-config fallback retained (#192) |
| `src/components/chat/service-status.tsx` | New `selectedModel` prop; immediate re-poll on model change via `useEffect` (#192) |
| `src/app/settings/page.tsx` | Per-endpoint test result key `"llm-{endpointId}"`; UI reads from endpoint-specific slot (#192) |
| `src/app/api/setup/test-connection/route.ts` | `logger.info` / `logger.warn` on test outcome with endpoint/model/result details (#192) |

### Phase 53: Bug Fixes — Issues #203–#207

#### Bug Fixes

- **#203 LLM test diagnostics**: `testLlm` now extracts rich detail from `APIError` (HTTP status, response body, request endpoint, response headers) so failed LLM connection tests surface actionable information instead of just the SDK message string.
- **#204 Plex 404 on series episodes**: `getSeriesEpisodes` now strips a trailing `/children` suffix from the passed `plexKey` before appending its own `/children`. Plex hub search returns show keys as `/library/metadata/{id}/children`; without the strip the fetch path was `/library/metadata/{id}/children/children` → HTTP 404.
- **#205 Request button on partial series**: `showRequestButton` in `TitleCard` no longer includes `mediaStatus === "partial"`. Partial means the show is already tracked in Overseerr with new episodes incoming — there is nothing to request.
- **#206 Episode results in plex_search_library**: `searchLibrary` now skips hub items whose resolved type is `episode`. Individual episodes should be fetched via `plex_get_series_episodes`, not via the search tool.

#### Enhancements

- **#207 Overseerr tool improvements**:
  - `overseerr_search` description updated: the query must be a specific title — never a year, genre, or keyword.
  - New `overseerr_discover` tool added: browses trending/upcoming movies or TV by genre via Overseerr's `/discover/movies` and `/discover/tv` endpoints. Accepts `mediaType`, optional `genre` (resolved to TMDB genre ID), and `category` ("trending" or "upcoming").
  - System prompt updated: direct the LLM to use `overseerr_discover` for genre/trending queries instead of forcing a year/keyword into `overseerr_search`. Clarify that `partial` status means no request button.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/test-connection.ts` | Richer `APIError` diagnostic in `testLlm` failure path (#203) |
| `src/lib/services/plex.ts` | Strip `/children` suffix in `getSeriesEpisodes` (#204); filter episode items in `searchLibrary` (#206) |
| `src/components/chat/title-card.tsx` | `showRequestButton` no longer true for `partial` status (#205) |
| `src/lib/services/overseerr.ts` | New `OverseerrDiscoverResult` type + `discover()` function (#207) |
| `src/lib/tools/overseerr-tools.ts` | Updated `overseerr_search` description; new `overseerr_discover` tool registered (#207) |
| `src/lib/llm/default-prompt.ts` | Redirect genre/trending queries to `overseerr_discover`; clarify `partial` status (#207) |
| `src/__tests__/lib/plex.test.ts` | Tests for episode filtering and `/children` key stripping |
| `src/__tests__/lib/overseerr.test.ts` | Tests for new `discover()` function |

---

### Phase N+1 — Bug fix: season-level plexKey returns no episodes (#211)

#### Bug fixes

- **#211 `plex_get_series_episodes` returns empty when AI reuses a season-level plexKey**: When `plex_get_series_episodes` is called with no `season` param it returns season cards whose `plexKey` values point to the season's `/children` endpoint (e.g. `/library/metadata/5532/children`). If the AI then re-calls the tool with one of those season-level keys *plus* a `season` number, the function was stripping `/children`, fetching that path's children (which are episodes, not seasons), filtering for `type === "season"` — getting an empty array — and returning no results.

  **Fix**: after fetching children, detect whether the plexKey already points at a season (any child has `type === "episode"`). If so, return the episode list directly without trying to locate a sub-season. A `season` or `episode` filter param still narrows the result to a single episode as expected.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/services/plex.ts` | `getSeriesEpisodes` detects season-level key and returns episodes directly (#211) |
| `src/__tests__/lib/plex.test.ts` | 3 new tests: season-level key with season param, season-level key with episode param, empty season (#211) |


---

### Phase N+2 — Release 1.1.3

Bumped `package.json` version from `1.1.3-beta.1` to `1.1.3` for stable release.

---

### Phase N+3 — Bug fixes: issues #146 and #217

#### Bug Fixes

- **#146 Docker E2E suite ran only 19 of 26 tests**: `playwright.docker.config.ts` was missing the `title-cards` project, so the 7 tests in `title-cards.spec.ts` never ran against the built Docker image. `global-setup-docker.ts` also omitted the Overseerr configuration from `POST /api/setup`, which title-card tests require for the "Request" flow. Additionally `API_RATE_LIMIT_MAX=1000` was missing from the container's environment (matching the dev/beta setup), preventing the title-card tests from being throttled by the default 60 req/min limit.

- **#217 Model selector overlapped with sidebar-toggle icon**: When the sidebar is collapsed, the `SidebarToggle` button is `fixed left-2` with `w-8` (ends ~40 px from the left edge). The top toolbar had a fixed `px-4` (16 px) left padding, so the model selector label sat directly behind the toggle icon. Fixed by conditionally applying `pl-12 pr-4` to the toolbar when `sidebarCollapsed` is true, giving 48 px of clearance.

#### Files changed

| File | Change |
|------|--------|
| `playwright.docker.config.ts` | Added `title-cards` project (#146) |
| `tests/e2e/global-setup-docker.ts` | Added `overseerr` to `POST /api/setup` payload; added `API_RATE_LIMIT_MAX=1000` env var to container (#146) |
| `src/app/chat/page.tsx` | Toolbar left padding conditionally expands to `pl-12` when sidebar is collapsed (#217) |

### Phase N+4 — Voice/Realtime diagnostics & SW phantom-GET fix (#119)

Two connected issues investigated:

- **#119 Realtime 'failed to fetch'**: Server log showed `REALTIME_SESSION_CREATED` but client received "failed to fetch" with no further detail. Root cause unknown without client-side logging. Added phase-tracked `clientLog.error` to `useRealtimeChat.connect()` covering four phases (`session`, `microphone`, `rtc-setup`, `sdp-exchange`). Also added `clientLog.error` for silent tool-call failures. Friendly "Failed to fetch" message handling mirrors `use-chat.ts`.

- **Voice TTS audio not playing (#119)**: POST to `/api/voice/tts` returned 200 with 428 KB `audio/mpeg` but audio did not play; UI returned to idle after ~3 s (exactly the TTS download time). `audio.play()` rejection was silently swallowed — no logging. Most likely cause: browser autoplay policy (`NotAllowedError`) since TTS play is triggered asynchronously after LLM stream completes, not directly from a user gesture. Added `clientLog.error` to `play().catch()`, `audio.onerror`, empty-blob guard, and `!res.ok` path so the next failure will be logged and diagnosable.

- **SW phantom GET → 405**: Browser DevTools showed `anonymous @ sw.js:8` issuing a GET to `/api/voice/tts` ~8 minutes after the TTS POST, returning 405. The service worker (`public/sw.js`) was unconditionally re-issuing every intercepted request via `fetch(event.request)`, including replayed navigations to previously-seen API URLs as GET. Fixed: SW now only intercepts `GET`/`HEAD` non-API requests — the minimum needed for PWA installability.

- **DB data migration for `llm.endpoints`**: `ensureSchemaIntegrity` handles column-level drift but not JSON blob drift inside `app_config`. Endpoints saved before `supportsRealtime`/`supportsVoice`/`realtimeModel` fields were added had those fields missing, causing the realtime UI button to never appear. Added `migrateLlmEndpoints()` that runs at startup after `ensureSchemaIntegrity`, normalises missing fields, and enforces the invariant `supportsRealtime = (realtimeModel !== "")`. 8 unit tests added.

#### Files changed

| File | Change |
|------|--------|
| `src/hooks/use-realtime-chat.ts` | Added `clientLog` with phase tracking for `connect()` failures; added `clientLog.error` in tool-call catch |
| `src/hooks/use-tts.ts` | Added `clientLog.error` to `play().catch()`, `audio.onerror`, empty-blob guard, and `!res.ok` path |
| `public/sw.js` | SW now only intercepts `GET`/`HEAD` non-API requests — prevents phantom API replays |
| `src/lib/db/index.ts` | Added exported `migrateLlmEndpoints()` — startup data migration for `llm.endpoints` JSON blob |
| `src/__tests__/db/migrate-llm-endpoints.test.ts` | 8 unit tests for `migrateLlmEndpoints` |
| `.gitignore` | Added `.claude/settings.json` (may contain internal API key) |
| `package.json` | Version `1.1.4-beta.1` → `1.1.4-beta.2` |

### Phase N+5 — Fix CSP blocking TTS audio blob URLs (#226)

**Root cause** (confirmed from beta logs via `[client] TTS audio element error`):

```
MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check (MediaError code 4)
NotSupportedError: Failed to load because no supported source was found.
blobSize: 479040, mimeType: audio/mpeg
```

The CSP in `next.config.ts` had no `media-src` directive, so it inherited `default-src 'self'` which blocks `blob:` URLs. `useTts` creates an audio blob URL via `URL.createObjectURL()` and passes it to `new Audio(url)` — the browser rejected this before the audio element could play.

Also added `blob: https:` to `connect-src`:
- `blob:` — required for voice input (`MediaRecorder` blob reads in some browsers)
- `https:` — required for WebRTC SDP exchange to the OpenAI realtime endpoint

#### Files changed

| File | Change |
|------|--------|
| `next.config.ts` | Added `media-src 'self' blob:` and extended `connect-src` with `blob: https:` |
| `package.json` | Version `1.1.4-beta.2` → `1.1.4-beta.3` |

### Phase N+6 — Report Issue: add version and base URL (#227)

Added `version` (`NEXT_PUBLIC_APP_VERSION`) and `baseUrl` (derived from `x-forwarded-proto` + `host` request headers) to:
- The GitHub issue body (Conversation Details table)
- The `report-issue: report logged` and `report-issue: GitHub issue created` log entries

This lets Claude immediately identify which deployment and version a user report came from without needing to ask.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/report-issue/route.ts` | Added `version` and `baseUrl` to issue body and both log entries |
| `src/__tests__/api/report-issue.test.ts` | Extended existing test to assert version/baseUrl present in log metadata and issue body |

### Phase N+7 — Fix premature streaming text and speed up title card display (#239)

Two issues reported in beta via the user feedback tool (#239):

1. **Premature text before tool results**: The orchestrator was yielding `text_delta` events to the client as soon as each streamed chunk arrived. When the LLM emitted text *and* tool calls in the same response (e.g. "I'm not seeing any results…" alongside a `plex_search_library` call), the speculative answer appeared in the chat before the tool ran — then the real answer appeared after. The transcript in #239 shows this clearly for the "When is the next apprentice?" query.

   **Fix**: Text deltas are now buffered during streaming and only yielded to the client *after* the full response is consumed. If tool calls were also present in that response, the buffered text is silently discarded (it was a premature guess). If no tool calls were present, the accumulated text is yielded as a single `text_delta` event before `done`. The text is still saved to the DB and forwarded to the LLM context regardless, so history and the next round behave correctly.

2. **Slow title card display**: Between receiving search results and calling `display_titles`, the LLM sometimes emitted an intermediate conversational message (e.g. "Here are the results!") which added a full LLM round of latency before cards appeared.

   **Fix**: Added explicit instructions to `DEFAULT_SYSTEM_PROMPT` telling the LLM to call `display_titles` immediately in the next response after receiving search results — no intermediate text — and to batch all searches for multiple independent titles in a single round so they execute in parallel.

#### Files changed

| File | Change |
|------|--------|
| `src/lib/llm/orchestrator.ts` | Buffer text deltas; suppress premature text when tool calls are present in the same LLM response |
| `src/lib/llm/default-prompt.ts` | New `display_titles` latency guidance: no intermediate rounds, parallel batching for multi-title queries |
| `src/__tests__/lib/orchestrator.test.ts` | 2 new tests: suppresses text when tool calls present; yields text when no tool calls |

### Phase N+8 — Realtime voice: unify transcript into main chat window (#239 follow-up)

Two further improvements requested following the #239 diagnosis:

1. **Title cards and tool results in the voice chat window**: In realtime/voice mode, `display_titles` was filtered out of the tool list and tool call results were never persisted to the DB, so the main `MessageList` never rendered them. Every tool call and its result is now saved to the conversation DB (assistant row with `toolCalls` JSON + tool row with `toolCallId`). After each tool completes, the hook fires `onMessagesUpdated` so the message list reloads and renders title cards, tool call status widgets, etc. exactly as it does for text chat. Audio remains clean — the realtime system prompt already instructs the model to summarise results in speech without reading raw JSON.

2. **Removed the ephemeral transcript widget**: `RealtimeChat` previously rendered a bounded scroll area with live character-by-character turn text that duplicated the main `MessageList`. This is removed. All interactions (user speech, assistant responses, tool results, title cards) appear exclusively in the main chat window. The `RealtimeChat` component now only renders the connection status and connect/end-call button. `transcript` state was removed from `useRealtimeChat` entirely.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/realtime/tool/route.ts` | Accept `conversationId` + `callId`; persist assistant tool-call message + tool result to DB when provided |
| `src/app/api/realtime/session/route.ts` | Remove `display_titles` filter — all tools now available in realtime sessions |
| `src/hooks/use-realtime-chat.ts` | Add `conversationId` + `onMessagesUpdated` options; pass them to tool route; remove `transcript` state |
| `src/components/chat/realtime-chat.tsx` | Remove ephemeral transcript widget; accept `conversationId` + `onMessagesUpdated` props |
| `src/components/chat/chat-input.tsx` | Thread `conversationId` + `onRealtimeMessagesUpdated` down to `RealtimeChat` |
| `src/app/chat/page.tsx` | Pass `activeConversationId` + `handleRealtimeMessagesUpdated` (calls `loadMessages`) into `ChatInput` |

### Phase N+9 — Realtime and voice: ensure connections tear down on all navigation paths

Two cleanup gaps identified:

1. **Realtime model change while connected**: switching to another realtime-capable model left the WebRTC session open on the old model (the component stayed mounted and the `modelId` prop changed silently). Fixed in `chat/page.tsx` by always resetting `chatMode` to `"text"` on any model change while in realtime — the session is model-specific and must be re-established fresh.

2. **Voice mode unmount without cleanup**: `VoiceConversation` only stopped the mic and TTS via the "Exit voice" button handler. Navigating away (mode change, conversation switch, new chat) would unmount the component while the mic stream or TTS audio kept running. Fixed by adding a `useEffect` unmount cleanup that calls `cancelRecording()` and `stopTts()`, using stable refs so the cleanup always reads the latest values without needing them as effect dependencies.

#### Files changed

| File | Change |
|------|--------|
| `src/app/chat/page.tsx` | Always reset realtime to text on model change (session is model-specific) |
| `src/components/chat/voice-conversation.tsx` | Add unmount `useEffect` cleanup for mic + TTS via stable refs |

### Phase N+10 — Realtime: detect unexpected disconnects + Screen Wake Lock

Two mobile resilience improvements:

1. **Unexpected disconnect detection**: Previously `connected` state stayed `true` after the underlying WebRTC connection dropped (screen off, app backgrounded, network loss, server timeout). The UI showed the green dot and "Listening" even though `sendEvent` silently no-oped. Fixed by wiring `pc.onconnectionstatechange` (`"failed"` / `"closed"`) and `dc.onclose` in `useRealtimeChat`. Both fire `handleUnexpectedDisconnect` which tears down the connection and surfaces a "Connection lost. Tap Connect to start a new session." message. An `intentionalDisconnectRef` flag prevents showing this error on a user-initiated end-call.

2. **Screen Wake Lock**: The browser Screen Wake Lock API (`navigator.wakeLock.request("screen")`) is called after a successful WebRTC handshake to prevent the device screen from turning off during an active session (supported on Android Chrome and iOS Safari 16.4+). The lock is released on disconnect (user-initiated or unexpected), and re-acquired on `visibilitychange` to `"visible"` if the session is still connected (since the browser auto-releases the lock when the page is hidden). Falls back silently if the API is unavailable.

#### Files changed

| File | Change |
|------|--------|
| `src/hooks/use-realtime-chat.ts` | Wire `pc.onconnectionstatechange` + `dc.onclose` for unexpected-disconnect detection; add wake lock acquire/release/re-acquire lifecycle |

### Phase N+12 — Cap conversation history at 20 messages to limit token growth

Long-running conversations previously grew unboundedly, increasing token usage and latency with every turn. Added a sliding-window cap of 20 individual messages (≈10 exchanges) applied at the end of history loading.

- `MAX_CONVERSATION_TURNS = 20` constant added to `orchestrator.ts`
- `capConversationHistory(messages, conversationId)` function: walks backwards counting user/assistant turns, finds the cutoff index, slices to the most recent 20, then strips any leading tool messages that would be orphaned
- Called at the end of `loadHistory()` after `trimToolHistory()`
- 6 new unit tests covering: unchanged when under limit, unchanged at exact limit, drops oldest when over, keeps most-recent messages, retains tool messages inside the window, drops tool messages outside the window

#### Files changed

| File | Change |
|------|--------|
| `src/lib/llm/orchestrator.ts` | Add `MAX_CONVERSATION_TURNS`, `capConversationHistory()`, call it in `loadHistory()` |
| `src/__tests__/lib/orchestrator.test.ts` | Add 6 unit tests for `capConversationHistory` |

### Phase N+14 — Fix CodeQL alerts blocking beta → main (tts ReDoS + test-connection SSRF)

Two CodeQL alerts were raised on the `beta → main` PR (#245) because these functions exist in `beta` but not in `main`, making them "new" to the `main` branch scan. The alerts weren't blocking on `beta` because `beta` branch protection does not require CodeQL to pass; `main` does.

#### Fixed

- **js/polynomial-redos — `src/app/api/voice/tts/route.ts`** — `stripMarkdown` used `/```[\w]*\n?([\s\S]*?)```/g` on uncontrolled user input. The overlap between `\n?` and `[\s\S]*?` on newlines is flagged by CodeQL as polynomial. Fix: replaced the regex with a `text.split("``\`")` approach — even-indexed segments are outside code fences, odd-indexed are inside. No regex, no backtracking.

- **js/ssrf — `src/lib/services/test-connection.ts` (`probeTtsSupport`)** — `probeTtsSupport` was added in Phase N+4, after Phase 27 addressed equivalent alerts in `probeVoiceSupport` / `probeRealtimeSupport`. The function already used `validateServiceUrl` + URL reconstruction, but the prior alerts were dismissed rather than fixed in code. Fix: build the fetch target as `new URL(path, origin)` and pass `.toString()` to `fetch`, matching the pattern used for the tmdb-thumb proxy in Phase 27 that broke CodeQL's taint propagation path.

#### Files changed

| File | Change |
|------|--------|
| `src/app/api/voice/tts/route.ts` | Replace fenced-code-block regex with `split("``\`")` to eliminate ReDoS vector |
| `src/lib/services/test-connection.ts` | `probeTtsSupport`: use `new URL(path, origin).toString()` as fetch target |

### Phase N+15 — CodeQL required on beta (CI gate parity with main)

`:beta` is a deployable Docker image with the same attack surface as `:latest`. GitHub's auto-setup CodeQL only gates `main`; a security vulnerability could ship to the beta deployment undetected.

Added a `codeql` job to `ci.yml` that runs on PRs to `dev`, `beta`, and `main`. The job is included in `ci-complete`'s required-jobs list, so `CI Complete` (the single check required by branch protection on all three branches) now automatically requires CodeQL to pass.

`upload: false` is set on the `analyze` step to avoid the "advanced configuration cannot be processed when default setup is enabled" conflict. The default setup continues uploading to the Security tab for `main`; this job acts as a local gate on `dev` and `beta`, failing CI on `error`-level findings and saving the SARIF as a downloadable artifact. GitHub's auto-setup continues to run on `main` in parallel — this is intentional.

Updated `CLAUDE.md` to document the new gate, the `upload: false` constraint, and clarify that the `ci.yml` `codeql` job supplements auto-setup rather than replacing it.

#### Files changed

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | Added `codeql` job (`upload: false`, `fail-on: error`, SARIF artifact); added to `ci-complete` needs |
| `CLAUDE.md` | New "CodeQL is a required gate on dev, beta, and main" rule; documents `upload: false` constraint |

---

### Phase N+13 — Version bump to 1.1.4 (stable release)

Bumped `package.json` version from `1.1.4-beta.5` to `1.1.4` for stable release.

| File | Change |
|------|--------|
| `package.json` | Version `1.1.4-beta.5` → `1.1.4` |

---

### Phase N+11 — Realtime: inject conversation history on connect

When switching from text or voice mode into a realtime session mid-conversation, the OpenAI Realtime session previously started with no knowledge of prior turns. Fixed by injecting history in `dc.onopen`:

- Fetches the conversation from `GET /api/conversations/${conversationId}` after the data channel opens
- Filters to user and assistant messages with non-empty text content (tool messages and pure tool-call assistant entries cannot be represented as Realtime API conversation items)
- Replays the last 20 turns (≈10 exchanges) as `conversation.item.create` events using the correct content type (`input_text` for user, `text` for assistant)
- Best-effort: if the fetch fails the session continues without history rather than erroring

History is injected after `session.update` so transcription is enabled before the model sees the prior context.

#### Files changed

| File | Change |
|------|--------|
| `src/hooks/use-realtime-chat.ts` | Inject last 20 text turns as `conversation.item.create` events in `dc.onopen` |

