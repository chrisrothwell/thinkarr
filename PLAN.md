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

### Phase 17: Realtime OpenAI-Only Guard (issue #80)

#### Bug Fix
- [x] **Realtime restricted to api.openai.com only (#80)** — ChatGPT-compatible providers (Gemini, Anthropic, local proxies) expose an OpenAI-compatible REST surface but do not implement the WebRTC-based Realtime API. Previously, `probeRealtimeSupport` would scan any endpoint's `/models` list for model IDs containing "realtime", which could falsely flag non-OpenAI endpoints as realtime-capable. Two guards added: (1) `isOpenAIEndpoint(url)` helper (exported from `test-connection.ts`) returns `true` only when the URL hostname is `api.openai.com`; `probeRealtimeSupport` returns `null` immediately for any other host. (2) `POST /api/realtime/session` checks `isOpenAIEndpoint(ep.baseUrl)` after the existing `supportsRealtime` check and returns HTTP 400 for non-OpenAI endpoints as a defence-in-depth measure. — `src/lib/services/test-connection.ts`, `src/app/api/realtime/session/route.ts`

#### Tests
- [x] **`src/__tests__/lib/services/is-openai-endpoint.test.ts`** — Unit tests for `isOpenAIEndpoint`: true for `api.openai.com`, false for Gemini/Anthropic/localhost/invalid URLs
- [x] **`src/__tests__/api/realtime-session.test.ts`** — Two new cases: Gemini-compatible endpoint (non-openai.com host) and Anthropic endpoint both return HTTP 400 even when `supportsRealtime: true`

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
│   │   │   └── transcribe/route.ts  # POST audio → Whisper STT → transcript
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
│   │   └── voice-input.tsx          # Mic record/transcribe UI (click-to-toggle, spinner)
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
│   ├── use-conversations.ts         # Conversation CRUD (list, create, delete, rename, viewAll)
│   ├── use-realtime-chat.ts         # WebRTC realtime hook (connect, SDP, data channel, tool calls)
│   └── use-voice-input.ts           # MediaRecorder hook (record, stop, POST to transcribe)
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
