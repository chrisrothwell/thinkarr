# Thinkarr Architecture

LLM-powered chat frontend for the *arr media stack. Users log in via Plex OAuth, chat with an AI that can search libraries, check availability, and request content. Packaged as a self-hosted Docker container.

## Tech Stack

- **Framework**: Next.js 16 (App Router, `output: "standalone"`)
- **Language**: TypeScript throughout
- **Database**: SQLite via better-sqlite3 + Drizzle ORM, stored at `/config/thinkarr.db`
- **LLM**: OpenAI-compatible API via `openai` SDK (multi-endpoint support)
- **Tools**: In-process MCP-style tool registry (Zod schemas → OpenAI function format), also exposed as external MCP endpoint
- **Auth**: Plex PIN-based OAuth (custom implementation, no NextAuth)
- **Styling**: Tailwind CSS 4, dark theme, shadcn/ui-style components
- **Docker**: Multi-stage Alpine/Node build, PUID/PGID/TZ support, `/config` volume
- **Observability**: Optional Langfuse tracing (opt-in via env vars or Settings UI)

---

## File Structure

```
├── Dockerfile                       # Multi-stage Alpine/Node build
├── entrypoint.sh                    # PUID/PGID user creation + server start
├── docker-compose.yml               # Development/example compose
├── drizzle/
│   └── 0000_short_gressill.sql      # Initial migration (5 tables)
├── public/
│   ├── manifest.json                # PWA web app manifest
│   └── sw.js                        # Service worker (network-first)
└── src/
    ├── proxy.ts                     # Auth cookie check + route protection
    ├── app/
    │   ├── api/
    │   │   ├── auth/
    │   │   │   ├── plex/route.ts            # POST initiate Plex PIN OAuth
    │   │   │   ├── callback/route.ts        # POST exchange PIN → session
    │   │   │   └── session/route.ts         # GET current user / DELETE logout
    │   │   ├── chat/route.ts                # POST stream LLM response (SSE)
    │   │   ├── conversations/
    │   │   │   ├── route.ts                 # GET list / POST create
    │   │   │   └── [id]/
    │   │   │       ├── route.ts             # GET with messages / DELETE
    │   │   │       ├── messages/route.ts    # POST save realtime turn
    │   │   │       └── title/route.ts       # PATCH rename
    │   │   ├── mcp/route.ts                 # GET list tools / POST execute (bearer auth)
    │   │   ├── models/route.ts              # GET available models for current user
    │   │   ├── plex/
    │   │   │   └── avatar/[userId]/route.ts # GET server-side Plex avatar proxy
    │   │   ├── realtime/
    │   │   │   ├── session/route.ts         # POST create ephemeral OpenAI Realtime session
    │   │   │   └── tool/route.ts            # POST execute tool during realtime session
    │   │   ├── report-issue/route.ts        # POST create GitHub issue + Langfuse score
    │   │   ├── request/route.ts             # POST submit Overseerr media request
    │   │   ├── services/
    │   │   │   └── status/route.ts          # GET service health (traffic lights)
    │   │   ├── settings/
    │   │   │   ├── route.ts                 # GET config (masked) / PATCH update
    │   │   │   ├── logs/route.ts            # GET list log files (admin)
    │   │   │   ├── logs/[filename]/route.ts # GET read/download log file (admin)
    │   │   │   ├── mcp-token/route.ts       # GET/POST global admin MCP token
    │   │   │   ├── mcp-token/user/[userId]/route.ts  # GET/POST per-user MCP token
    │   │   │   ├── plex-connect/route.ts    # POST Plex OAuth from Settings
    │   │   │   ├── plex-devices/route.ts    # GET discover Plex servers via plex.tv
    │   │   │   └── users/route.ts           # GET list / PATCH update user settings
    │   │   ├── setup/
    │   │   │   ├── route.ts                 # GET status / POST save config
    │   │   │   └── test-connection/route.ts # POST test connectivity + capability probe
    │   │   └── voice/
    │   │       ├── transcribe/route.ts      # POST audio → Whisper STT
    │   │       └── tts/route.ts             # POST text → OpenAI TTS
    │   ├── chat/page.tsx            # Chat page (sidebar, model picker, messages, input)
    │   ├── login/page.tsx           # Plex OAuth login
    │   ├── settings/page.tsx        # 5-tab settings (General, LLM, Plex & Arrs, MCP, Users, Logs)
    │   ├── setup/page.tsx           # Welcome splash (first-time setup)
    │   ├── globals.css              # Dark theme CSS variables + Tailwind 4
    │   ├── layout.tsx               # Root layout with Geist fonts
    │   └── page.tsx                 # Root redirect (no users → setup, else → chat)
    ├── components/
    │   ├── chat/
    │   │   ├── chat-input.tsx       # Text/Voice/Realtime mode toggle + input UI
    │   │   ├── message-bubble.tsx   # Message styling, avatar, tool calls, TitleCarousel
    │   │   ├── message-content.tsx  # Markdown rendering (react-markdown + remark-gfm)
    │   │   ├── message-list.tsx     # Scrollable messages + tool call reconstruction
    │   │   ├── pwa-install-banner.tsx
    │   │   ├── realtime-chat.tsx    # Full-duplex WebRTC voice UI
    │   │   ├── service-status.tsx   # Traffic light service status
    │   │   ├── sidebar.tsx          # Collapsible sidebar + grouped conversations
    │   │   ├── title-card.tsx       # Rich media card (thumbnail, status, cast, actions)
    │   │   ├── title-carousel.tsx   # Single card or snap-scroll carousel
    │   │   ├── tool-call.tsx        # Tool call display + expandable details
    │   │   └── voice-conversation.tsx  # 4-state voice loop (idle/listen/process/speak)
    │   └── ui/                      # avatar, badge, button, card, input, label, spinner, tabs, textarea
    ├── hooks/
    │   ├── use-audio-level.ts       # Web Audio bars for visualizer
    │   ├── use-auto-scroll.ts       # Auto-scroll, respects manual scroll
    │   ├── use-chat.ts              # Messages state, SSE streaming, send/stop
    │   ├── use-conversations.ts     # Conversation CRUD
    │   ├── use-pwa-install.ts       # PWA install state + SW registration
    │   ├── use-realtime-chat.ts     # WebRTC hook (SDP, data channel, tool calls)
    │   ├── use-silence-detection.ts # VAD: auto-stop on 1.5s silence / 60s timeout
    │   ├── use-tts.ts               # OpenAI TTS playback hook
    │   └── use-voice-input.ts       # MediaRecorder + transcribe hook
    ├── lib/
    │   ├── auth/session.ts          # Session create/validate/destroy + cookie management
    │   ├── config/index.ts          # getConfig/setConfig + rate limit utils
    │   ├── db/
    │   │   ├── index.ts             # DB singleton + auto-migration
    │   │   ├── migrate.ts           # runMigrations standalone utility
    │   │   └── schema.ts            # 5 tables
    │   ├── llm/
    │   │   ├── client.ts            # OpenAI client factory (per-endpoint)
    │   │   ├── default-prompt.ts    # DEFAULT_SYSTEM_PROMPT + DEFAULT_REALTIME_SYSTEM_PROMPT
    │   │   ├── langfuse.ts          # Langfuse client singleton, startTrace, scoreTrace, flush
    │   │   ├── orchestrator.ts      # Chat streaming engine + auto-title + orphan repair
    │   │   └── system-prompt.ts     # buildSystemPrompt() + buildRealtimeSystemPrompt()
    │   ├── security/
    │   │   ├── api-rate-limit.ts    # Per-user in-memory rate limiter (60 req/min)
    │   │   └── url-validation.ts    # Service URL allowlist/blocklist validation
    │   ├── services/
    │   │   ├── overseerr.ts
    │   │   ├── plex.ts
    │   │   ├── plex-auth.ts         # PIN OAuth, checkUserHasLibraryAccess
    │   │   ├── radarr.ts
    │   │   ├── sonarr.ts
    │   │   └── test-connection.ts   # Connectivity testers + capability probing
    │   ├── tools/
    │   │   ├── display-titles-tool.ts  # display_titles (builds DisplayTitle[], resolves thumbUrl)
    │   │   ├── init.ts              # Auto-register tools based on configured services
    │   │   ├── overseerr-tools.ts
    │   │   ├── plex-tools.ts        # 8 tools
    │   │   ├── radarr-tools.ts      # 3 tools
    │   │   ├── registry.ts          # defineTool, getOpenAITools, executeTool + tool logging
    │   │   └── sonarr-tools.ts      # 4 tools
    │   ├── logger.ts                # Winston singleton (Console + DailyRotateFile)
    │   ├── pwa.ts                   # PWA singleton (deferred prompt, install trigger)
    │   └── utils.ts                 # cn() class merge utility
    └── types/
        ├── api.ts                   # Setup/test-connection types
        ├── chat.ts                  # SSE events, ChatRequest, ToolCallDisplay
        ├── index.ts                 # User, Session, Conversation, Message interfaces
        └── titles.ts                # DisplayTitle, TitleMediaType, TitleMediaStatus
```

---

## Database Schema

| Table | Key Columns |
|-------|-------------|
| `app_config` | `key` (PK), `value`, `encrypted`, `updatedAt` |
| `users` | `id`, `plexId` (unique), `plexUsername`, `plexEmail`, `plexAvatarUrl`, `plexToken`, `isAdmin` |
| `sessions` | `id` (UUID PK), `userId` (FK), `expiresAt` |
| `conversations` | `id` (UUID PK), `userId` (FK), `title`, `createdAt`, `updatedAt` |
| `messages` | `id` (UUID PK), `conversationId` (FK), `role`, `content`, `toolCalls`, `toolCallId`, `toolName` |

---

## app_config Keys

| Key | Type | Purpose |
|-----|------|---------|
| `llm.endpoints` | JSON array | Multi-endpoint LLM configs (`baseUrl`, `apiKey`, `model`, `systemPrompt`, `isDefault`, `supportsVoice`, `supportsRealtime`, `realtimeModel`, `realtimeSystemPrompt`, `ttsVoice`) |
| `llm.baseUrl` / `llm.apiKey` / `llm.model` | String | Legacy single-endpoint keys (backward compat) |
| `plex.url` / `plex.token` | String | Plex server connection |
| `sonarr.url` / `sonarr.apiKey` | String | Sonarr connection |
| `radarr.url` / `radarr.apiKey` | String | Radarr connection |
| `overseerr.url` / `overseerr.apiKey` | String | Overseerr connection |
| `mcp.bearerToken` | String | Global admin bearer token for external MCP access |
| `langfuse.secretKey` / `langfuse.publicKey` | String (encrypted) | Langfuse credentials (env vars take precedence) |
| `langfuse.baseUrl` | String | Langfuse host (default: `https://cloud.langfuse.com`) |
| `user.{id}.defaultModel` | String | Per-user default model |
| `user.{id}.canChangeModel` | Boolean | Permission to switch models (default `true`) |
| `user.{id}.rateLimit` | JSON | `{"messages": number, "period": "hour"/"day"/"week"/"month"}` |
| `user.{id}.mcpToken` | String | Per-user MCP bearer token |

---

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/setup` | Check setup status |
| POST | `/api/setup` | Save initial config |
| POST | `/api/setup/test-connection` | Test connectivity + capability probe |
| POST | `/api/auth/plex` | Initiate Plex OAuth (returns PIN + URL) |
| POST | `/api/auth/callback` | Exchange PIN → session (returns `isAdmin`) |
| GET | `/api/auth/session` | Get current user |
| DELETE | `/api/auth/session` | Logout |
| POST | `/api/chat` | Stream LLM response (SSE); enforces rate limiting |
| GET | `/api/conversations` | List conversations (`?all=true` for admin) |
| POST | `/api/conversations` | Create conversation |
| GET | `/api/conversations/[id]` | Get with messages (admin can view any) |
| DELETE | `/api/conversations/[id]` | Delete conversation |
| PATCH | `/api/conversations/[id]/title` | Rename (max 200 chars) |
| POST | `/api/conversations/[id]/messages` | Save realtime turn |
| GET | `/api/mcp` | List MCP tools (bearer auth, permission-filtered) |
| POST | `/api/mcp` | Execute tool (bearer auth) |
| GET | `/api/models` | Available models for current user |
| GET | `/api/services/status` | Service health (LLM, Plex, Sonarr, Radarr, Overseerr) |
| GET | `/api/settings` | Get config (secrets masked, admin only) |
| PATCH | `/api/settings` | Update config (admin only) |
| GET | `/api/settings/logs` | List log files (admin) |
| GET | `/api/settings/logs/[filename]` | Read/download log (`?download=true`) |
| GET | `/api/settings/mcp-token` | Get global admin MCP token |
| POST | `/api/settings/mcp-token` | Regenerate global admin MCP token |
| GET | `/api/settings/mcp-token/user/[userId]` | Get per-user MCP token (admin; user can self-access) |
| POST | `/api/settings/mcp-token/user/[userId]` | Regenerate per-user MCP token |
| POST | `/api/settings/plex-connect` | Plex OAuth from Settings |
| GET | `/api/settings/plex-devices` | Discover Plex servers via plex.tv (admin) |
| GET | `/api/settings/users` | List users with settings (admin) |
| PATCH | `/api/settings/users` | Update user role/model/permissions/rate limit (admin) |
| POST | `/api/request` | Submit Overseerr media request |
| POST | `/api/report-issue` | Create GitHub issue + attach Langfuse score |
| POST | `/api/voice/transcribe` | Audio → Whisper STT |
| POST | `/api/voice/tts` | Text → OpenAI TTS |
| POST | `/api/realtime/session` | Create ephemeral OpenAI Realtime session (WebRTC) |
| POST | `/api/realtime/tool` | Execute tool during realtime session |
| GET | `/api/plex/avatar/[userId]` | Server-side Plex avatar proxy |

---

## MCP Tools

| Service | Tools |
|---------|-------|
| Plex | `plex_search_library`, `plex_get_on_deck`, `plex_get_recently_added`, `plex_check_availability`, `plex_search_collection`, `plex_search_by_tag`, `plex_get_title_tags` |
| Sonarr | `sonarr_search_series`, `sonarr_get_series_status`, `sonarr_get_calendar`, `sonarr_get_queue` |
| Radarr | `radarr_search_movie`, `radarr_get_movie_status`, `radarr_get_queue` |
| Overseerr | `overseerr_search`, `overseerr_get_details`, `overseerr_list_requests`, `overseerr_discover`, `overseerr_get_season_episodes` |
| Built-in | `display_titles` — renders TitleCarousel in chat (always registered) |

External MCP access via bearer token (`mcp.bearerToken`). Optional `X-User-Id` header scopes operations to a user's permission level. Per-user tokens stored as `user.{id}.mcpToken`.

---

## Key Design Decisions

### Plex PIN OAuth (no NextAuth)
Custom flow in `src/lib/services/plex-auth.ts`. POST `/api/auth/plex` returns PIN + URL; backend polls until claimed. First user auto-promoted to admin; subsequent users verified via `checkUserHasLibraryAccess()`. Avoids NextAuth dependency; fits the linuxserver.io container model.

### SQLite + Drizzle (no external DB)
Stored at `/config/thinkarr.db`, auto-migrated on first connection. Zero external dependencies — no separate DB container. Uses better-sqlite3 (synchronous) configured as an external in `next.config.ts` for standalone builds.

### In-Process MCP Tool Registry
Tools defined with Zod schemas, converted to JSON Schema → OpenAI function format at runtime. Single source of truth: same registry serves both the in-process chat engine and the external `/api/mcp` endpoint. Auto-initialized based on which services are configured.

### Orphaned Tool Call Repair
If the server crashes between saving an assistant message with `tool_calls` and saving the tool results, the LLM rejects the conversation on next load. `loadHistory()` in the orchestrator detects orphaned `tool_call_ids` and injects synthetic error tool messages so the conversation is always recoverable.

### Agentic Tool Call Limit
`MAX_TOOL_ROUNDS = 8` in `orchestrator.ts`. If the loop exhausts all rounds without the LLM producing a final text response, the stream ends with `{ type: "error", message: "Tool call limit reached" }` and the Langfuse trace is updated accordingly.

### Sonarr Series Title Matching
`getSeriesStatus()` in `sonarr.ts` prefers an exact (case-insensitive) title match against the `/series` list before falling back to substring matching. This prevents titles like "Celebrity Race Across the World" from being returned when the user asks about "Race Across the World".

### mediaStatus Normalization
Overseerr's API returns title-cased status strings (`"Processing"`, `"Not Requested"`, `"Partially Available"`) which conflict with the lowercase enum expected by `display_titles` (`"pending"`, `"not_requested"`, `"partial"`). `normalizeMediaStatus()` in `overseerr.ts` handles the mapping. The `overseerr_search` and `overseerr_discover` tool handlers apply this function before returning results so the LLM always sees display_titles-compatible values. `enrichSonarrSeries()` in `sonarr-tools.ts` also pre-computes `mediaStatus` — `"available"` when found in Plex, normalized Overseerr status when found there, otherwise `"pending"` if monitored or `"not_requested"` if not.

### Multi-Endpoint LLM Support
`llm.endpoints` JSON array stores per-endpoint config including capabilities. Legacy single-key config preserved for backward compat. Capability auto-detection: `testLlm()` probes Whisper, realtime (model list scan + OpenAI-only guard), and TTS. Per-user model override via `user.{id}.defaultModel` + `canChangeModel`.

### OpenAI Realtime Guard
Realtime (WebRTC) is restricted to `api.openai.com` only. `probeRealtimeSupport()` returns `null` for non-OpenAI hosts. Defence-in-depth check also in `POST /api/realtime/session`.

### Rate Limiting (Multi-Layer)
1. **Message-based**: Per-user configurable (`user.{id}.rateLimit`), calendar-aligned, checked before each `/api/chat` stream.
2. **API-based**: Per-user in-memory (60 req/min sliding window) on `/api/conversations/*` and `/api/settings/*`; returns HTTP 429.

### Title Card Display System
`display_titles` tool accepts 1–10 titles with rich metadata. Server resolves `thumbUrl` (Plex proxy + token) and `plexMachineId` (Watch Now universal link). Renders as both a collapsible tool call panel and a full-width TitleCarousel below the message. LLM always calls `display_titles` after searches.

The `year` field is typed as `number` throughout (`OverseerrSearchResult`, `OverseerrDetails`, `OverseerrRequest`, `OverseerrDiscoverResult`). The `yearFromDate()` helper in `overseerr.ts` parses the ISO date string from TMDB at source. The `display_titles` schema uses `z.coerce.number()` as a defensive measure so string years from any future path are coerced rather than rejected.

### Langfuse Observability
Opt-in tracing via `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` env vars, or via Settings UI (env vars take precedence). Each chat request creates a root trace keyed by the user message UUID, with per-round LLM generation spans and per-tool spans. When a user reports an issue, a `user-report` score is attached to the trace and the GitHub issue body includes a `curl` retrieval command instead of a verbose transcript.

### Logging
Winston singleton: Console (stdout, JSON) + DailyRotateFile (`/config/logs/`, 14-day retention, 20 MB max). Tool calls and API responses logged with truncation. Settings Logs tab provides file browser, 500-line viewer, and download.

### Chat Mode Toggle
Three modes: text (default), voice (Whisper STT + TTS read-back), realtime (WebRTC full-duplex). Availability tied to endpoint capabilities. Mode resets to text on model switch if capability unavailable.

### PWA
Manifest + service worker (network-first). Platform-aware install UI: Android native prompt, iOS manual steps. Module-level singleton in `pwa.ts` shares deferred prompt across SPA navigations.

### Conversation History Cap
Last 20 messages sent to LLM. Prevents unbounded token growth on long conversations.

### Gemini Empty Response Retry + Dangling Message Cleanup
When `gemini-2.5-flash-lite` (and similar) returns 0 output tokens with no text and no tool calls after a tool result, the orchestrator retries the LLM call up to `MAX_EMPTY_RESPONSE_RETRIES` (2) times. If all retries are exhausted (or any other error fires), the orchestrator:
1. Deletes **all tool-round messages** (`assistant(tool_calls)` + `tool(result)` from every round) from the DB — tracked in `toolRoundMessageIds`. Without this, each failure leaves dangling unclosed tool sequences in history; Gemini (stricter about conversation format than OpenAI) refuses to generate output on every subsequent request.
2. **Keeps the user message** in the DB intentionally — the user genuinely typed and sent it; the UI shows it as "message sent, no reply came back", which is consistent with Langfuse traces.
3. Yields `{ type: "error" }` rather than a silent empty done event.

**Exception — empty after `display_titles`:** If the previous round's tool calls were exclusively `display_titles`, a zero-token follow-up response is correct and expected (the card is the answer). In this case the orchestrator skips the error path and yields `{ type: "done" }` instead, keeping all tool-round messages in the DB. Tracked via `previousRoundToolNames` in the outer loop.

### Gemini Null Content in Assistant Tool-Call Messages (issue #328)
When the LLM emits a tool call with no accompanying text, `fullContent` is `""`. The orchestrator previously pushed `{ role: "assistant", content: null, tool_calls: [...] }` into `apiMessages` for the next round. Gemini's OpenAI-compatible API rejects `content: null` in assistant messages that contain `tool_calls`, returning an `llm_error` on round 1. The fix omits the `content` field entirely when `fullContent` is falsy, matching the behaviour of `loadHistory()` which only sets `content` when the stored value is truthy.

### Ghost User Turn Collapse
When a request fails after saving its user message but before saving any assistant response, the user message remains in the DB. If the user retries, `saveMessage()` saves another user message, producing consecutive user turns in history (`[user#1, user#2]`). Gemini's strict alternating-turn format then returns 0 output tokens on every retry, permanently breaking the conversation.

`loadHistory()` detects consecutive user messages and skips the earlier "ghost" messages from the LLM context. Ghost messages remain in the DB for UI display but are never resent to the LLM — only the most recent user message in any consecutive run is included in the API call.

### SSE Heartbeat Interval and Network Error Recovery
The chat SSE heartbeat is sent every 5 seconds (down from 15 s) to reset reverse-proxy idle timeouts on long LLM responses. When the streaming connection drops mid-response (e.g. a 30+ second GPT-4.1 reply hitting a 30 s proxy timeout), the client `use-chat.ts` now suppresses the "Network error" toast and lets the post-stream reload recover the completed response silently. The error is only surfaced if the server-side reload also fails or returns no assistant content.

### Gemini Parallel Tool-Call Concatenation Repair
Some Gemini variants (e.g. `gemini-2.5-flash-lite`) emit parallel tool calls as a single concatenated call: the tool name becomes two registered names joined (e.g. `sonarr_search_seriesplex_search_library`) and the arguments become two JSON objects concatenated (`{"term":"X"}{"query":"X"}`). `trySplitConcatenatedCall()` and `trySplitJsonArgs()` in `orchestrator.ts` detect this pattern and split it back into two valid calls before execution. The system prompt also includes an explicit instruction not to concatenate tool calls.

### Gemini Tool Name & Argument Normalization
`gemini-2.5-flash-lite` sometimes emits PascalCase tool names (e.g. `DisplayTitles`) or appends the first parameter name to the tool name (e.g. `DisplayTitlesTitles` = `display_titles` + `titles` param). `resolveToolName()` in `registry.ts` handles this via:
1. Direct lookup
2. Case-insensitive/underscore-stripped exact match
3. PascalCase → snake_case conversion (`DisplayTitles` → `display_titles`)
4. Prefix match after snake_case conversion (`display_titles_titles` starts with `display_titles`)

Additionally, `executeTool()` detects when `display_titles` receives a flat single-title object (e.g. `{title: "...", mediaStatus: "..."}`) instead of the correct `{titles: [{...}]}` wrapper and auto-wraps it before Zod parsing.

### Episode Thumbnails from Overseerr
`overseerr.getSeasonEpisodes()` now maps the `stillPath` field from the TMDB/Overseerr season endpoint to a full `thumbPath` URL (`https://image.tmdb.org/t/p/w300{stillPath}`) on each `OverseerrEpisode`. The `overseerr_get_season_episodes` tool's `llmSummary` includes `thumbPath` so the LLM passes it to `display_titles` for episode cards.
