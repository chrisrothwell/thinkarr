# Thinkarr Architecture

LLM-powered chat frontend for the *arr media stack. Users log in via Plex OAuth, chat with an AI that can search libraries, check availability, and request content. Packaged as a self-hosted Docker container.

## Tech Stack

- **Framework**: Next.js 16.4 (App Router, `output: "standalone"`), React 19.3
- **Language**: TypeScript throughout
- **Database**: SQLite via better-sqlite3 + Drizzle ORM, stored at `/config/thinkarr.db`
- **LLM**: OpenAI-compatible API via `openai` SDK (multi-endpoint support)
- **Tools**: In-process MCP-style tool registry (Zod schemas → OpenAI function format), also exposed as external MCP endpoint
- **Auth**: Plex PIN-based OAuth (custom implementation, no NextAuth)
- **Styling**: Tailwind CSS 4, dark theme, shadcn/ui-style components
- **Docker**: Multi-stage Alpine/Node build, standalone runtime without npm/npx, PUID/PGID/TZ support, `/config` volume
- **Observability**: Optional Langfuse tracing (opt-in via env vars or Settings UI)

---

## File Structure

```
├── Dockerfile                       # Multi-stage Alpine/Node build
├── entrypoint.sh                    # PUID/PGID user creation + server start
├── docker-compose.yml               # Development/example compose
├── connectors/
│   ├── delegated-mcp/
│   │   ├── linking.ts                # Harness-neutral signed MCP client, private link and prompt receipt boundaries
│   │   ├── diagnostics.ts            # Value-free structured operation traces, safe error classification and debug gating
│   │   ├── http-diagnostics.ts       # Bounded HTTP correlation/timing metadata and non-buffering SDK response-body observation
│   │   ├── media-contract.ts         # Strict pilot media inputs/results and deterministic confirmation grammar
│   │   └── README.md                 # Trusted host contract and OpenClaw adapter requirements
│   └── openclaw/
│       ├── index.ts                  # Native factory/hook registration, canonical PN identity and private outbound receipt checks
│       ├── host.ts                   # Narrow structural host types checked against the published pinned SDK
│       ├── lifecycle.ts              # Executing-instance/version correlation, whole-operation inventory and detached debug snapshots
│       ├── reply-guard.ts            # Exact-turn duplicate prompt-response guard using host run/call/session correlation
│       ├── secrets.ts                # Invocation-only prepared-secret SDK boundary (no direct store/provider resolution)
│       ├── setup.ts                  # Trusted API enrollment helper; stdin-only native secret-store writes
│       ├── skills/thinkarr/SKILL.md   # Packaged interaction playbook: scoped tools, single native prompt and safe outcomes
│       ├── openclaw.plugin.json      # Native plugin manifest and public config schema
│       ├── package.json             # Separately packed ESM plugin, exact host peer and runtime dependencies
│       ├── package-lock.json        # Plugin dependency lock/audit boundary
│       ├── tsconfig.build.json      # Emit adapter and portable core into ignored dist/
│       ├── README.md                # Companion plugin overview, compatibility and native-secret configuration
│       └── SETUP.md                 # Packaged, discoverable agent-led API setup and owner authorization guide
├── scripts/check-openclaw-sdk.mjs    # Integrity-pinned SDK declarations-only compatibility check
├── drizzle/
│   ├── 0000_short_gressill.sql      # Initial migration (5 tables)
│   ├── 0001_add_message_duration.sql
│   ├── 0002_mcp_channel_integration.sql  # mcp_channel_identities, mcp_registration_tokens, mcp_pending_baskets
│   ├── 0003_mcp_service_principals.sql  # Service identities, hashed credentials, verification keys, audit
│   ├── 0004_mcp_delegation_replay.sql   # Durable HTTP nonce and provider-event replay claims
│   ├── 0005_mcp_trusted_linking.sql     # Scoped hashed link challenges and versioned trusted actor bindings
│   ├── 0006_mcp_mobile_handoff.sql      # Public origin/bot configuration and pending handoff fingerprint
│   ├── 0007_mcp_beta_pilot.sql          # Persisted pilot-group ceiling and durable selection/submission state
│   └── 0008_mcp_setup_grants.sql        # Hashed, expiring, single-use owner enrollment grants
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
    │   │   ├── account-links/
    │   │   │   ├── route.ts                 # GET current user's trusted assistant links
    │   │   │   └── [id]/route.ts            # DELETE unlink own binding
    │   │   ├── chat/route.ts                # POST stream LLM response (SSE)
    │   │   ├── conversations/
    │   │   │   ├── route.ts                 # GET list / POST create
    │   │   │   └── [id]/
    │   │   │       ├── route.ts             # GET with messages / DELETE
    │   │   │       ├── messages/route.ts    # POST save realtime turn
    │   │   │       └── title/route.ts       # PATCH rename
    │   │   ├── mcp/
    │   │   │   ├── route.ts                 # GET list tools / POST execute (bearer auth; ?mode=text for channel adapter)
    │   │   │   ├── info/route.ts            # GET public versioned delegation audience, no Plex login
    │   │   │   ├── setup/route.ts           # POST owner-code-authorized API key enrollment and credential issuance
    │   │   │   ├── link/route.ts            # Legacy unsigned channel registration
    │   │   │   └── account-links/
    │   │   │       ├── inspect/route.ts     # POST private challenge inspection; no URL/query secrets
    │   │   │       └── prepare/route.ts     # POST prepare code for authenticated Plex browser session
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
    │   │   │   ├── mcp-integrations/
    │   │   │   │   ├── route.ts                 # GET list / POST create disabled integration (admin)
    │   │   │   │   └── [id]/
    │   │   │   │       ├── route.ts             # GET detail / PATCH name, scope, disable
    │   │   │   │       ├── setup/route.ts       # POST admin creates one-use API setup code (shown once)
    │   │   │   │       ├── credentials/route.ts  # POST issue/rotate; secret returned once
    │   │   │   │       ├── credentials/[credentialId]/route.ts # DELETE revoke credential
    │   │   │   │       ├── bindings/[bindingId]/route.ts # DELETE admin revoke participant binding
    │   │   │   │       ├── keys/route.ts         # POST register Ed25519 public verification key
    │   │   │   │       └── keys/[keyId]/route.ts # DELETE revoke key
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
    │   ├── mcp/
    │   │   ├── link/page.tsx        # Legacy channel identity registration
    │   │   └── connect/page.tsx     # Public fragment-only mobile Plex/private-message handoff
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
    │   ├── settings/
    │   │   ├── account-links.tsx      # Owner-only trusted link view/unlink in Settings → Users
    │   │   └── mcp-integrations.tsx  # Administrator integration scope/credential/key management
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
    │   ├── auth/
    │   │   ├── session.ts           # Session create/validate/destroy + cookie management
    │   │   └── plex-registration.ts # Normal Plex account admission/upsert shared by the login path
    │   ├── config/index.ts          # getConfig/setConfig + rate limit utils
    │   ├── db/
    │   │   ├── index.ts             # DB singleton + auto-migration
    │   │   ├── migrate.ts           # runMigrations standalone utility
    │   │   └── schema.ts            # 16 tables
    │   ├── llm/
    │   │   ├── client.ts            # OpenAI client factory (per-endpoint)
    │   │   ├── default-prompt.ts    # DEFAULT_SYSTEM_PROMPT + DEFAULT_REALTIME_SYSTEM_PROMPT
    │   │   ├── langfuse.ts          # Langfuse client singleton, startTrace, scoreTrace, flush
    │   │   ├── orchestrator.ts      # Chat streaming engine + auto-title + orphan repair
    │   │   └── system-prompt.ts     # buildSystemPrompt() + buildRealtimeSystemPrompt()
    │   ├── mcp/
    │   │   ├── account-linking.ts   # Scoped challenge/browser/private-proof binding state and actor resolution
    │   │   ├── media-access.ts      # Read-only actor Plex sections/search/details and effective-user Seerr eligibility preflight
    │   │   ├── media-library.ts     # Strict library query/metadata schemas and group-safe catalog projection
    │   │   ├── media-dispatch.ts    # Pilot media policy, delivered prompt lifecycle and atomic confirmed request claim
    │   │   ├── integration-policy.ts # Live persisted integration/group policy, managed through Settings
    │   │   ├── connection-setup.ts   # Owner setup grant issuance, atomic enrollment and replay/configuration checks
    │   │   ├── link-dispatch.ts     # Signed stateless MCP dispatch, exact source/scope policy and trusted delivery metadata
    │   │   ├── request-timing.ts    # Delegated HTTP request/phase timing, cancellation and Server-Timing headers
    │   │   ├── account-link-api.ts  # Browser JSON/session guards, safe errors and no-store/no-referrer output
    │   │   ├── auth-context.ts      # Discriminated personal/service server-owned caller context
    │   │   ├── delegation.ts        # JOSE assertion verification, stable audience and durable replay claims
    │   │   ├── integration-api.ts   # Admin-session authorization, rate limit and no-store responses
    │   │   ├── link-handoff.ts      # Validated public origin/bot destination, fragment token and prefilled URI helpers
    │   │   └── service-principals.ts # Disabled principal/credential/key lifecycle and metadata-only audit
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
    │   │   ├── display-titles-text.ts  # formatDisplayTitlesAsText() — markdown renderer for text channels
    │   │   ├── init.ts              # Auto-register tools based on configured services
    │   │   ├── overseerr-tools.ts
    │   │   ├── pending-basket.ts    # createBasket / resolveBasket (one-time-use, 10-min TTL)
    │   │   ├── plex-tools.ts        # 8 tools
    │   │   ├── radarr-tools.ts      # 3 tools
    │   │   ├── registry.ts          # defineTool, getOpenAITools, executeTool + tool logging
    │   │   └── sonarr-tools.ts      # 4 tools
    │   ├── logger.ts                # Winston singleton (Console + DailyRotateFile)
    │   ├── plex-device-select.ts    # selectPlexConnectionUrl() — pure connection-picking logic for Settings → Discover Servers
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
| `mcp_channel_identities` | `(channelType, channelUserId)` (composite PK), `userId` (FK) — maps external channel user (WhatsApp/Telegram/etc.) to a Thinkarr user |
| `mcp_registration_tokens` | `token` (PK), `channelType`, `channelUserId`, `expiresAt` — short-lived (15 min) self-registration link tokens |
| `mcp_pending_baskets` | `token` (PK), `itemsJson`, `userId`, `expiresAt` — one-time-use (10 min) confirm_request validation state |
| `mcp_service_principals` | `id` (UUID PK), `name`, `enabled` (default false), `allowedOperations` (JSON), nullable administrator-configured `pilotGroup` / `publicLinkOrigin` / `whatsappBotNumber`, creator user reference, timestamps — no Plex/user role |
| `mcp_service_credentials` | `id`, `principalId` (FK), unique SHA-256 `tokenHash`, safe `prefix`, creator, creation/expiry/revocation/last-use timestamps |
| `mcp_service_keys` | `id`, `principalId` (FK), `issuer`, `keyId`, Ed25519 `publicKeyPem`, creation/revocation; unique principal/issuer/key ID |
| `mcp_service_audit` | `id`, `principalId` (FK), nullable human `actorUserId`, action, opaque target ID, creation time — no secrets or raw arguments |
| `mcp_delegation_nonces` | `(principalId, issuer, nonce)` composite PK, expiry in Unix seconds including allowed clock skew; FK to service principal |
| `mcp_delegation_events` | SHA-256 `eventHash` PK over principal/issuer/actor/context/provider event, principal FK, creation/expiry seconds; no raw sender/message/event identifiers |
| `mcp_actor_bindings` | `id`, principal FK, hashed actor/context scopes (unique), channel/context kind, real user FK, immutable Plex ID snapshot, version, creation/update/revocation milliseconds |
| `mcp_link_challenges` | Unique token/code digests, original principal/credential/key references, hashed actor/origin scopes, handoff-configuration fingerprint, browser user/Plex/session-hash snapshots, preparation/consumption/expiry milliseconds; no cleartext token/code/session ID |
| `mcp_media_selections` | Actor binding/version/user and exact target/subset, draft/pending/submission/outcome state, prompt receipt/time/expiry; partial unique active slot per binding |
| `mcp_setup_grants` | `id`, principal/creator FKs, unique SHA-256 setup-token digest, configuration fingerprint, expiry/consumption milliseconds; no cleartext setup code or issued credential |

---

## app_config Keys

| Key | Type | Purpose |
|-----|------|---------|
| `llm.endpoints` | JSON array | Multi-endpoint LLM configs (`baseUrl`, `apiKey`, `model`, `systemPrompt`, `isDefault`, `supportsVoice`, `supportsRealtime`, `realtimeModel`, `realtimeSystemPrompt`, `ttsVoice`) |
| `llm.baseUrl` / `llm.apiKey` / `llm.model` | String | Legacy single-endpoint keys (backward compat) |
| `plex.url` / `plex.token` | String | Plex server connection |
| `plex.clientIdentifier` | String | Selected server's Plex `clientIdentifier`, used to re-match it during automatic token refresh |
| `sonarr.url` / `sonarr.apiKey` | String | Sonarr connection |
| `radarr.url` / `radarr.apiKey` | String | Radarr connection |
| `overseerr.url` / `overseerr.apiKey` | String | Overseerr connection |
| `mcp.bearerToken` | String | Global admin bearer token for external MCP access |
| `mcp.delegationAudience` | String | Stable public instance UUID for delegated JWT audience; created conflict-safely on first administrator metadata read or verification |
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
| GET | `/api/mcp` | List MCP tools (bearer auth, permission-filtered; `?mode=text` adds `confirm_request`) |
| POST | `/api/mcp` | Personal tool execution (bearer auth; `?mode=text` enables text-channel adapter); service principals use signed linking and opt-in group-scoped beta media dispatch, with validated diagnostic request-ID echo and Server-Timing metrics |
| GET | `/api/mcp/info` | Public `{version:1,audience}` discovery, independent of Plex sessions/integration creation/credential issuance; no service or credential metadata |
| POST | `/api/mcp/setup` | Redeem a single-use owner setup code in Authorization; register the supplied public key and issue a scoped service bearer atomically; no browser session required |
| GET | `/api/mcp/link` | Validate a channel registration token |
| POST | `/api/mcp/link` | Complete channel registration: exchange Plex PIN + registration token → store identity |
| POST | `/api/mcp/account-links/inspect` | Inspect a JSON-body challenge from its configured browser origin; safe integration/channel/expiry metadata only |
| POST | `/api/mcp/account-links/prepare` | Prepare a prefilled private handoff URL for the actual browser user/session; optional expected-user comparison rejects account switches but never selects a beneficiary; does not activate a binding |
| GET | `/api/account-links` | List only the current user's trusted links, including integration enabled/revoked state |
| DELETE | `/api/account-links/[id]` | Unlink own binding and increment its version; another user's ID returns 404 |
| GET | `/api/models` | Available models for current user |
| GET | `/api/services/status` | Service health (LLM, Plex, Sonarr, Radarr, Overseerr) |
| GET | `/api/settings` | Get config (secrets masked, admin only) |
| PATCH | `/api/settings` | Update config (admin only) |
| GET | `/api/settings/logs` | List log files (admin) |
| GET | `/api/settings/logs/[filename]` | Read/download log (`?download=true`) |
| GET | `/api/settings/langfuse-keys` | Get unmasked Langfuse public + secret keys (admin) |
| GET | `/api/settings/mcp-token` | Get global admin MCP token |
| POST | `/api/settings/mcp-token` | Regenerate global admin MCP token |
| GET | `/api/settings/mcp-token/user/[userId]` | Get per-user MCP token (admin; user can self-access) |
| POST | `/api/settings/mcp-token/user/[userId]` | Regenerate per-user MCP token |
| GET | `/api/settings/mcp-integrations` | List integrations including saved group configuration, curated operations, stable delegation audience and access availability (admin session) |
| POST | `/api/settings/mcp-integrations` | Create a disabled service principal with optional group/link settings (admin session) |
| GET | `/api/settings/mcp-integrations/[id]` | Get safe principal/credential/public-key/participant metadata and latest 20 audit records (admin session) |
| PATCH | `/api/settings/mcp-integrations/[id]` | Update name/scopes/group/link settings and enable/disable; enabling requires a valid saved group, link origin and bot number; group changes revoke bindings/pending verification |
| POST | `/api/settings/mcp-integrations/[id]/credentials` | Issue or rotate a credential; return secret only here with no-store |
| POST | `/api/settings/mcp-integrations/[id]/setup` | Admin session authorizes a ten-minute, single-use enrollment grant for this integration; return setup code once with no-store |
| DELETE | `/api/settings/mcp-integrations/[id]/credentials/[credentialId]` | Revoke an individual credential (admin session) |
| POST | `/api/settings/mcp-integrations/[id]/keys` | Register an Ed25519 public verification key; private keys are rejected |
| DELETE | `/api/settings/mcp-integrations/[id]/keys/[keyId]` | Revoke a verification key (admin session) |
| DELETE | `/api/settings/mcp-integrations/[id]/bindings/[bindingId]` | Administrator revokes a participant binding within the specified integration |
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
| Seerr | `overseerr_search`, `overseerr_get_details`, `overseerr_list_requests`, `overseerr_discover`, `overseerr_get_season_episodes`, `overseerr_similar`, `overseerr_report_issue` |
| Built-in | `display_titles` — renders TitleCarousel in chat (always registered) |
| Text-channel only | `confirm_request` — submits an Overseerr request after explicit user confirmation; only available in `?mode=text` |

Personal MCP access uses the existing global (`mcp.bearerToken`) or per-user (`user.{id}.mcpToken`) bearer. The global token's optional `X-User-Id` scope must be a valid positive integer naming an existing user; explicit malformed/nonexistent scopes fail authentication. Reserved `thk_svc_` credentials are recognized in a separate branch before either personal token path, including when copied into the global-token setting.

Service principals start disabled and can be configured/enabled through authenticated integration Settings. Disabled service credentials receive HTTP 403 before body parsing or SDK dispatch; service GET is always denied. Enabled-service POST enters a separate signed dispatcher before raw tool initialization or unsigned channel resolution. Only explicitly permitted linking and scoped media operations are accepted; legacy/batch envelopes and raw tools are denied in both text/non-text modes. Revoked/expired/unknown service credentials fail authentication without administrator fallback. The registry independently refuses service-context calls before name normalization or hidden-tool suggestions.

Personal `POST /api/mcp` speaks two request shapes, discriminated by a top-level `jsonrpc: "2.0"` field:
- **Spec-compliant JSON-RPC 2.0** (real MCP clients — Claude Desktop, Claude Code `mcp add`, etc.): handled by the official `@modelcontextprotocol/sdk`, not a hand-rolled envelope. `handleMcpProtocolRequest()` in `route.ts` builds a fresh low-level `Server` + `WebStandardStreamableHTTPServerTransport` per request (stateless — SDK 1.26+ transports can't be reused across requests), which handles `initialize`/`notifications/initialized` and protocol-version negotiation automatically. Only `ListToolsRequestSchema` and `CallToolRequestSchema` handlers are implemented ourselves, reusing `runToolCall()` for permission checks. `tools/call` rejections (bad params, permission denied, unknown tool) throw `McpError(ErrorCode.InvalidParams, ...)`, a genuine protocol-level error; exceptions during tool execution are returned as a successful result with `isError: true` per spec, so the calling LLM can see and react to them. Handlers use the per-request server-authenticated personal context captured by the stateless server. Permission/user metadata is also supplied in `AuthInfo.extra`.
- **Legacy ad-hoc dispatch** (no `jsonrpc` field): `{method: "list"|"execute"|"tools/list"|"tools/call", tool, arguments}` → bare `{tools: [...]}` / `{tool, result}`. Still hand-rolled — kept for the text-channel adapter below, which predates the JSON-RPC handling and reuses these method names without the envelope.

Both paths share one `runToolCall()` helper for permission checks, `confirm_request`, and the text-mode `display_titles` interception, so that logic isn't duplicated.

In `?mode=text` (OpenClaw / external channel adapter): channel identity is resolved from `X-Channel-Type` + `X-Channel-User-Id` headers via `mcp_channel_identities`; `display_titles` results are transformed to markdown; `confirm_request` replaces the direct request tools as the only path to submit Overseerr requests.

---

## Key Design Decisions

### Plex PIN OAuth (no NextAuth)
Custom flow in `src/lib/services/plex-auth.ts`. POST `/api/auth/plex` returns PIN + URL; backend polls until claimed. First user auto-promoted to admin; subsequent users verified via `checkUserHasLibraryAccess()`. Avoids NextAuth dependency; fits the linuxserver.io container model.

### Automatic Plex token refresh on 401 (#457)
`plex.token` (the per-server access token used for all `plexFetch`/tool-call requests) can go stale independently of a user's `users.plexToken` (their plex.tv account token, from login), which is long-lived and doesn't need re-authenticating in a browser. `refreshPlexToken()` in `plex-auth.ts` reproduces the "click Discover Servers again" fix automatically: it re-runs `getPlexDevices()` against every admin's account token, matches the resource by `plex.clientIdentifier` (stable across LAN IP changes, unlike matching by URL), and stores the fresh `accessToken` as `plex.token`. Both `plexFetch` (`plex.ts`) and `checkPlex` (`services/status/route.ts`) call this and retry once on a 401 before surfacing a "reconnect in Settings" error. `plex.clientIdentifier` is recorded whenever an admin selects a server from Discover Servers in Settings.

### Discover Servers can return zero connections (#457)
plex.tv's `/api/v2/resources` can return a server resource with an empty `connection` array even when the server itself is reachable directly — confirmed via beta logs where `plexFetch` calls to the same server's LAN address succeeded throughout. This isn't recoverable client-side: it usually means the server isn't publishing itself on plex.tv (Plex Media Server → Settings → Remote Access), common for LAN-only setups, so plex.tv genuinely has no address on file. `selectPlexConnectionUrl()` (`plex-device-select.ts`) surfaces this as an explicit error pointing at manual URL entry instead of silently leaving the field blank. `GET /api/settings/plex-devices` logs a per-server `connectionCount` summary (no tokens) on every discovery call so this is diagnosable from `/beta-logs` without a live repro.

### SQLite + Drizzle (no external DB)
Stored at `/config/thinkarr.db`, auto-migrated on first connection. Zero external dependencies — no separate DB container. Uses better-sqlite3 (synchronous) configured as an external in `next.config.ts` for standalone builds.

### Schema Integrity Check Is Only Cached On Success
`ensureSchemaIntegrity()` (`src/lib/db/index.ts`) compares every table in `schema.ts` against the live SQLite file after `migrate()` runs, and throws if a NOT NULL column (or, degenerate case, a whole missing table) can't be safely auto-repaired — this is meant to fail loudly rather than let the app silently serve broken queries. `getDb()`'s module-level `_db` handle is only assigned *after* this check succeeds; a failed check is retried (and re-thrown) on every subsequent call within the same process instead of being cached. This matters because a live beta instance hit exactly this: `mcp_channel_identities`/`mcp_registration_tokens`/`mcp_pending_baskets` never got created despite `__drizzle_migrations` recording the migration as applied, and with the old caching order the failure logged once at boot and then went silent forever — the text-channel adapter kept 500ing on every request with no further signal. Fixed by an operator running the migration SQL directly against the live DB and restarting; regression coverage in `src/__tests__/db/get-db-cache.test.ts` and the "entire table missing" case in `src/__tests__/db/migrations.test.ts`.

### In-Process MCP Tool Registry
Tools defined with Zod schemas, converted to JSON Schema → OpenAI function format at runtime. Single source of truth: same registry serves both the in-process chat engine and personal external `/api/mcp` access. Auto-initialized based on which services are configured. `executeTool` accepts an optional server-owned authentication context passed separately to handlers; existing in-process callers remain compatible. External personal MCP calls pass their authenticated permission/user identity; model arguments cannot replace it. Service contexts are unconditionally rejected by this registry and use the isolated signed dispatcher instead.

### Administrator-Managed MCP Integrations
Service principals are separate from Plex-authenticated users. An administrator web session is required for every management API; bearer credentials never authorize management. Principals start disabled and operation lists contain only explicit curated media/link names. Settings → MCP → Service integrations manages each integration's native WhatsApp group, public linking origin, bot number and enable/disable state. Enabling requires all three saved connection fields; multiple independently configured integrations can be enabled. No container environment variables, special principal UUID or restart are required. The existing `pilot_group` database column/API field stores the integration's group restriction for compatibility with deployed pilot records; it is not an environment-backed feature flag. Current persisted configuration is rechecked on calls and downstream boundaries. Group operations cannot use another group; direct chat remains only for private linking controls. Changing the group atomically consumes pending verification challenges and revokes/version-increments existing participant bindings, invalidating old selections even if the group is later changed back. Saving the same group preserves links. This is a context restriction, not a participant admission list. The panel supports integration ID/audience copy, scopes, credential rotation, public keys and recent activity. A newly issued secret lives only in component memory and disappears on dismissal, tab exit or reload; retrieval contains safe metadata only.

High-entropy bearer secrets are returned once, stored only as indexed SHA-256 digests and never included in list/detail/audit/log output. Credentials have a 90-day default lifetime (1–365 days configurable), individual revocation, and explicit rotation. Immediate replacement is the default; optional overlap is bounded to 60 minutes and cannot extend the old expiry. At most two active credentials can coexist during overlap. Verification keys are independently registered Ed25519 public keys; key IDs cannot be reused and at most four non-revoked keys can coexist. Registration never accepts a private key or fetches a remote key URL.

Lifecycle changes and credential replacement occur in SQLite transactions with metadata-only audit entries identifying the administrator. Service-denial audit entries identify the service principal/credential and leave the human actor null; the integration creator is not a beneficiary. Management responses use `Cache-Control: no-store` and existing per-user API rate limits. These records use dedicated tables, not new `app_config` keys.

### Commit-Phase Callback Refs
Chat and realtime event callbacks read current conversation/options/connection values from refs synchronized in `useLayoutEffect`, after React commits and before browser events. Rendering does not mutate these refs, so an abandoned concurrent render cannot publish uncommitted callback state. Conversation-list effects update state from fetch promise callbacks; a missing channel-link token derives the expired view directly rather than scheduling a synchronous effect update.

### Dependency Audit Scope
The lockfile is the deployment dependency contract. The CI production audit blocks on every severity and updates must use fixed compatible dependency versions without bypassing the gate. Development-only findings are reported separately. CI uses Node 22 and the Docker image uses Node 26; runtime dependencies must support both.

Transitive build-tool refreshes retain the framework's dependency constraints and keep Vitest and its coverage provider on the same release. Browser-target metadata, esbuild platform binaries and PostCSS resolutions are pinned together in the lockfile.

The production Docker stage removes the base image's npm CLI, npx launcher and npm-bundled dependencies. Build stages retain npm for installation/compilation; the standalone entrypoint runs `node server.js` directly. This prevents unused package-manager dependencies from shipping vulnerabilities independently of the application lockfile. Docker smoke coverage checks that Node runs and npm/npx plus the bundled npm directory are absent; image vulnerability scanning remains enabled without npm-only CVE suppressions.

### Delegation Verification and Two Independent Replay Boundaries
`src/lib/mcp/delegation.ts` uses the maintained `jose` library to verify the compact Ed25519 JWS profile. It pins algorithm/type, registered principal/issuer/key ID, stable instance audience, strict versioned source/identity/intent claims and a maximum 60-second assertion lifetime with five seconds of clock tolerance. HTTP method, exact encoded path/query and SHA-256 of the original body bytes must match. It does not accept inline or remote verification keys, user-selected beneficiary fields or proxy-derived audiences.

After asynchronous cryptographic verification, an immediate SQLite transaction rechecks current principal/credential/key state and current operation policy before consuming the HTTP nonce. Nonce rows survive process restarts and retain replay protection through the full allowed clock-skew interval. The returned frozen service context carries verified opaque actor/conversation claims; it does not resolve a Plex/Thinkarr user or independently authorize a tool.

Provider-event deduplication is separate from HTTP nonce replay. A valid message-source context can claim an event hash scoped to issuer/principal/channel account/sender/context kind/conversation. The helper rechecks service/key/credential status and assertion expiry, accepts provider events at most 15 minutes old (plus five seconds skew), and rejects a fresh HTTP assertion reusing an already-consumed event. Event claims can join the business transaction so a rollback does not discard an unsubmitted confirmation. Expired replay records are pruned on claim; event time bounds prevent old events becoming usable after retention expiry.

Every enabled-service POST, including initialization and discovery, must pass the verifier before the isolated service dispatcher. Activation is explicitly managed through authenticated Settings; enabled services still cannot enter the raw registry, which unconditionally rejects service contexts. Personal MCP access does not require these assertions.

### API Connection Enrollment and Native OpenClaw Secrets
The delegation audience is a public, stable instance identifier, created/read independently from service credentials. `/api/mcp/info` exposes only its versioned discovery value without Plex login, and Settings explains this before any credential is issued. Agents do not automate a Plex browser login for metadata or enrollment.

An administrator creates a ten-minute setup code for one configured integration. Only its SHA-256 digest is stored. New codes replace prior grants; group/link/scope changes, disablement and credential issuance invalidate them. Redemption checks expiry/consumption, current creator administrator status and a configuration fingerprint in an immediate transaction. It accepts only issuer/key ID/Ed25519 public key, atomically registers/reuses that exact public key, issues one service credential and consumes the code. A normal service bearer cannot mint or redeem setup grants; owner session authority is not inherited. Existing active credentials are never rotated implicitly. Setup does not enable an integration or authorize a human/media request. Anonymous redemption has separate rate limits, streaming body/time bounds, sanitized errors and no-store/no-referrer responses. Private keys never enter Thinkarr.

The packaged OpenClaw helper accepts the owner code through a hidden prompt/trusted stdin, discovers the audience and enrolls via HTTPS with no cookies or redirects. It reuses a supplied dedicated key or generates it in memory, pipes values to `openclaw secrets store set --kind secret`, and writes only public connection metadata/native SecretRefs into its own plugin config. It creates no custom credentials file, prints no raw HTTP/CLI errors, preserves an existing native configuration, and reports uncertain issuance rather than blindly retrying. Owner authorization is distinct from agent-local provisioning; the helper leaves activation to the ordinary platform owner flow. Its README/SETUP guide ships in the archive and uses generic deployment placeholders.

The plugin manifest declares `connection.bearer` and `connection.privateKeyPem` as SecretRef inputs for OpenClaw preparation, Settings redaction and secret audit. Source configurations require references at those fields. Registration accepts references without secret access; admitted invocations read the two fixed manifest paths through the pinned SDK's `getPreparedPluginSecretInput`. Missing/denied values or mismatched revisions fail closed without direct provider/store/environment resolution. Invocation and delivery guards recheck availability and the captured secrets revision. Host-materialized strings remain compatible. Registration validation errors expose only schema-owned paths, validation codes and primitive connection-value types; raw validator messages, input values and arbitrary config/map keys are excluded. The legacy mode-0600 credentials-file option remains only for migration compatibility; native setup is the supported default. Existing temporary private-key files are not deleted blindly—verify import/runtime access before retiring old copies. Secrets are protected by OpenClaw's native access model; this does not claim encryption of its underlying store.

### Signed Service MCP Transport
`link-dispatch.ts` creates a separate official SDK server and stateless Streamable HTTP transport per request. It accepts at most 64 KiB and only non-batch JSON-RPC initialize, initialized notification, ping, tools/list and tools/call. The same current scope/source/channel policy controls discovery and direct execution, with exact tool names and strict argument schemas. Launch support is WhatsApp: `account_link_start` accepts tool-source calls or the exact `link-start` command; `account_link_confirm` requires a direct-message source and signed `link-confirm:<code>` intent matching its sole code argument. Model-supplied identity, recipient and context selectors are rejected. Authorization failures return sanitized HTTP 403, including denials detected during SDK execution; business failures use safe MCP `isError` results. Responses use no-store/no-referrer headers.

An unlinked start returns only `{linked:false, privateDeliveryRequired:true}` in model-facing content. The URL, authenticated channel/account/recipient and expiry are carried separately in `_meta["thinkarr/private-delivery"]` for the trusted connector. MCP metadata is not itself a privacy boundary: the trusted connector consumes this data privately, strips it from model context and confirms delivery before reporting success. Completion returns only `{linked:true}` and atomically deduplicates the provider event independently of the HTTP assertion nonce. Neither handler reaches the personal/raw tool registry.

### Minimal Group-Scoped Beta Media Pilot
`media-dispatch.ts` applies the same exact-name/source/scope policy to discovery and execution. In the configured pilot group, an actively linked human can use tool-source `media_search`, `media_details` and `media_select`. Search/details reuse the web's Seerr/TMDB endpoints, title normalization and basic movie/TV facts through the bounded actor capability. A strict nested allowlist returns at most five titles, synopsis/rating/genre/cast and public season numbers; global availability/request state, personal activity, requester history, file paths and thumbnail URLs are omitted. Searching the public title catalog does not require current Plex shares or grant downstream request permission. The older actor-visible library methods remain internal building blocks rather than another pilot prerequisite.

Selection fetches authoritative title/season facts and stores the exact target/subset with the current actor binding/version. `mcp_media_selections` retains draft, pending, superseded, submitting, completed, failed and unknown records. A partial unique index permits only one draft/pending row per scoped binding. A new choice atomically supersedes the previous active prompt; drafts expire after five minutes and do not authorize confirmation. The trusted connector sends the server-generated prompt to the exact captured group and validates a provider message/destination receipt, then signs a hidden command-source `present:<selection UUID>` acknowledgement through `media_select`. Model tool arguments cannot acknowledge presentation. Only that receipt-backed acknowledgement activates a two-minute pending prompt. After replacement, unquoted assent is ambiguous and must quote the current prompt; old quotes and queued events predating presentation are rejected.

Only admitted message-source `media_confirm_request` can claim a pending choice. The actual native text determines intent; `request it`/`request 1` confirm the single current title/subset, other numbers ask for clarification. Generic yes is accepted only when quoting the exact active prompt; unrelated quotes/messages stay with the existing router. An immediate transaction rechecks binding/version/scope/expiry/quote/event time, consumes the provider event and claims the selection once. Current Plex identity, immutable Seerr mapping, effective `X-Api-User` identity, request permission/quota and selected TV seasons are reverified before a single POST to Seerr with no body `userId`. Already tracked/requested titles are conservatively blocked with a generic outcome, not global availability disclosure. The response must match the effective requester, TMDB target/type, exact TV seasons and pending/approved status. Submitting/unknown records survive crashes and prevent automatic retries of the same user's target, even after a fresh selection; unknown outcomes require checking Seerr. No polling/completion notifications are added.

### Trusted Linking Connector Core
`connectors/delegated-mcp/linking.ts` is a portable host-side core using the existing MCP SDK and JOSE dependencies; it imports no Next.js/database/configuration code and is not an installable OpenClaw plugin. Trusted host code supplies configuration, canonical actor/context metadata, explicit direct/group kind, a live invocation guard, cancellation and a private delivery capability. Each invocation snapshots identity and owns a separate MCP client. Its custom fetch signs final serialized POST bytes with fresh nonces, pins the configured `/api/mcp` endpoint, omits ambient cookies, rejects redirects and rechecks live authority after asynchronous work and immediately before dispatch. A bounded invocation lifetime covers network work and cooperative private delivery.

The core accepts only exact safe link outcomes. It validates private handoff account/recipient against the captured actor, the independently configured public origin, fragment-only token URL and five-minute expiry before calling the host. All upstream content/metadata, errors and receipt identifiers are stripped from the returned status. Only a matching platform acceptance receipt yields `private_link_sent`; failed/unknown sends return `failed` without automatic retries or public-link fallback. The host must resolve canonical sender aliases to a private target on the exact channel account, honor cancellation and recheck the supplied guard immediately before each physical send. Receipt-shaped test fixtures are not proof of provider routing.

Private completion recognizes only the exact browser-prefilled `Link account <64 lowercase hex>` message from an admitted direct-chat event with provider ID and original millisecond timestamp. Unrelated content remains unclaimed; matching outcomes are safe statuses for the host's handled response, never raw codes or MCP output. Tests exercise the core through the real Thinkarr route/verifier/link state with synthetic delivery, including interleaved actors/contexts, revocation, stale invocation, sender mismatch, replay and malformed handoffs.

The release-matched OpenClaw tool context lacks an explicit direct/group field; the host adapter establishes kind from validated provider-native addresses rather than session keys. The core also validates beta media outcomes through shared schemas and supports a trusted prompt-delivery capability; prompt drafts/receipts never enter model context. The application exposes the pilot through signed MCP, but gateway installation/deployment is an operator action.

### Version-Pinned OpenClaw Plugin
The manifest declares the exact four optional tool names in `contracts.tools` with matching tool metadata. Explicit `activation.onStartup: true` is required because the admitted `before_dispatch` hook must exist before any model tool call. OpenClaw's manifest-first selection otherwise excludes the runtime regardless of reloads or runtime `registerTool` calls. Startup activation does not grant tool use or bypass host/group/actor policy.

The permanent plugin-local `debug` boolean defaults to false and is exposed in the manifest configuration/UI. Errors, rejections, registration and operation summaries use the host logger in normal mode. Debug adds detailed stage transitions under the same random per-operation trace ID and elapsed timer, including prepared-secret availability, MCP HTTP status and recognized error codes. Debug records deliberately use the host info sink with a `level: "debug"` field so enabling this plugin setting does not require global Gateway debug logging; changes take effect on normal config apply/reload. The portable connector accepts the same optional diagnostic sink. Logging explicitly projects bounded metadata and known reason/error classifications, never upstream exception text/stacks, config values, credentials, URLs, message/receipt contents or actor identities. Logger failures are isolated from delivery and request semantics; model-facing outcomes remain unchanged.

Private verification checks the admitted event's channel, direct kind, message identity, freshness and sender agreement before accepting either a peer-address or receiving-account bot-address hook conversation. Only the latter is normalized to the authenticated human sender; other destinations/accounts, self echoes and unsupported identities remain rejected, and model tool factories retain their strict peer rule. Acknowledgements use one explicit fixed-text private outbound send with current-lifetime and physical-dispatch fences, rather than automatic handled-text delivery. The hook returns handled without automatic text. Backend completion and acknowledgement confirmation have separate diagnostic outcomes; failed/uncertain acknowledgement delivery does not roll back the binding or trigger a resend. Actor rejection reasons and receipt-check booleans reveal no raw identities or provider IDs.

`connectors/openclaw` packages a native plugin for OpenClaw `2026.10.4`, with an optional zero-argument `thinkarr_account_link` version-2 tool factory and an admitted `before_dispatch` private-verification hook. An optional native `pilotGroup` exposes three additive `thinkarr_media_*` read/selection tools and a global `reply_dispatch` confirmation handler. That handler uses matching post-admission native `From`/`ChatId`/`OriginatingTo`, receiving account/bot, sender/event/time, reply route and quote facts rather than the legacy bot-valued conversation field. It requires a foreground agent-owned user-request turn and allowed send policy. Normal group `message_tool_only` suppression of automatic finals permits the explicit native result; hard send-policy denial, other delivery suppression, observed/tail/synthetic/internal, ACP/background and other-group events remain unclaimed. The pinned WhatsApp ingress derives `ReplyToId` from the native provider quote; this remains valid when optional quote-body/flag metadata is absent after context-visibility filtering. Conflicting supplemental IDs and explicit non-quote flags are rejected; stale/replaced/exact-prompt checks remain server-owned. Claimed confirmations emit one fixed-text group status with physical-send fences/verified provider receipts and report actual delivery counts. Bare yes and unrelated finance quotes remain unclaimed; uncertain post-submission outcomes never retry. Registration is synchronous and version/lifecycle checked. Prepared native secrets are obtained through the host SDK during admitted invocations, not registration/discovery; credentials/errors never enter tool metadata/results. Legacy file mode reads only within a current invocation and requires an owned regular no-symlink file of at most 16 KiB with mode 0600. Source configuration contains public connection metadata, native SecretRefs, receiving-account/self-identity map and optional group restriction, not participant admission rules. Host channel policy governs human admission; self identities, missing metadata and conflicting route/event facts fail closed.

Companion lifecycle diagnostics correlate executing-code version and random registration instance, whole admitted tool/hook execution (through outbound acknowledgements and awaited cleanup), cancellation requests and physical settlement. Debug full-runtime snapshots report even idle instances every ten seconds; their unreferenced timer is created through the public detached-background API and cleared on abort/disposal, with no retained-work claim or discovery polling. Work inventories retain only fixed kinds/stages, random trace IDs, times and cancellation signals; they are not the host's lease/consumer counts. MCP exchanges have independent IDs, pending fetch/body counts, cleanup start/slow/completion/failure timings and distinct body-cancellation request/settlement records. Host pre-replacement drain may precede lifecycle abort; executing-version logs and companion-idle snapshots must be compared with host saved/active status and retained-work facts. Diagnostics never abandon cleanup, cancel admitted work, retry uncertain writes, extend drain budgets or restart the host.

The plugin manifest declares its packaged Thinkarr interaction skill. Tool descriptions/results and that playbook instruct agents to use scoped tools, announce private-link guidance once, and end with the standard silent-reply marker after a receipt-checked native confirmation prompt is delivered. The prompt is self-contained; the model must not send a second instruction/confirmation or synthesize approval. This guidance is not an authorization boundary, does not modify live agent/tool policy, and needs live model-adherence validation.

Native media tools remain eligible for normal catalog assembly and Code Mode globals/search; `direct-only` is not used because the pinned host excludes those descriptors from its JavaScript catalog. A bounded two-minute presentation guard correlates host `before_tool_call` run/call/session facts with the actual successful native selection execution. Only after native receipt and backend presentation acknowledgement does it block a redundant text-only `message` send to the same WhatsApp group/account or cancel an exactly correlated automatic reply. Host-discriminated `code_mode_exec` wrappers are transport, not mixed work; all nested child tools still run their normal checks. New turns, missing correlation, other routes/accounts, media/error payloads and mixed-tool workflows remain unmuted; shell `exec` and unrelated finance tools disable guarding for that run. Abort clears ephemeral state; no background timer, session-wide mute, inferred group authority or request permission is introduced. Value-free armed/unavailable/block/cancel diagnostics distinguish enforced presentation from model guidance.

The canonical sender namespace is the WhatsApp PN JID, normalizing exact E.164/PN-JID host aliases. Validated native `@g.us` addresses identify groups; direct addresses must match the sender. Session keys serve only exact-turn presentation correlation, never identity or group authority; latest-sender caches are unused. Unresolved LID, hosted/device-scoped and unknown addresses are rejected rather than guessed; verified provider alias support and reassignment recovery remain launch dependencies.

Private delivery loads the registered WhatsApp outbound adapter, validates its resolved destination against the captured sender, pins the receiving account and checks returned provider message ID/actual destination. It uses the pinned implementation's `onPlatformSendDispatch` fence before each physical send/chunk to recheck live authority and cancellation; it does not rely on the handoff callback that this WhatsApp implementation does not forward. There is no group/current-route helper or automatic retry/public fallback. The inbound hook checks explicit direct kind, matching sender/message metadata, timestamp and private conversation, returns a safe handled outcome, and leaves finance/unrelated messages unclaimed. Plugin disposal, tool invocation guards and bounded operation signals fence retained work.

Linking reserves a 45-second overall MCP budget and 20-second tool-call limit; private verification has 55 seconds including acknowledgement inside a 60-second hook. Physical fetches combine invocation and SDK request/transport signals so cancellation/close cannot leave requests running until only the outer deadline. Optional standalone SSE GET is rejected locally with 405, preserving signed POST-only transport without false error logs. Safe HTTP diagnostics include protocol phase. A connection failure before tool submission is `unavailable`; a connectivity failure after submission is `unknown`, since it may follow a committed binding. Dispatched private sends without a verifiable receipt/destination produce `private_delivery_unconfirmed` and guidance to check private instructions, never a verified-delivery claim or automatic resend. Known wrong destinations remain rejected. Receipt destination kind is logged only as an enum, without the address; ambiguous aliases do not acquire identity authority.

Each physical delegated HTTP POST carries an independent UUID diagnostic `X-Thinkarr-Request-Id`, distinct from JWT replay nonces. The app validates/echoes it or generates a replacement; it is never an authority input. Per-request `MCP_HTTP_TIMING` summaries begin before authentication and end after SDK cleanup. Plugin debug mode requests detailed app spans with `X-Thinkarr-Debug-Timing: 1`: authentication, body reading, delegation/key/signature/nonce verification, envelope, SDK connect/dispatch, tool handler, response buffering and cleanup. Request aborts are recorded without their reasons. `Server-Timing` includes total and nested phase durations. Client logs correlate IDs and measure fetch-to-headers plus body start/completion/error/cancellation using a non-buffering response observer; headers/body contents are never logged or cloned for diagnostics. Comparing client round-trip-to-headers against app total avoids clock-skew assumptions but leaves network/proxy/framework/output/client-scheduling combined outside the measured handler. Both app and companion must be updated for two-sided timing; missing response metrics are explicit. Timing observers are request-scoped, fault-isolated and do not change authentication, replay, dispatch or cleanup behavior.

`npm run check:openclaw` extracts integrity-pinned published SDK/TypeBox declarations into ignored dependency cache and type-checks the structural host surface against the real API without executing or installing OpenClaw. `npm run build:openclaw` emits the adapter and portable core as a separate ESM archive; OpenClaw is an optional exact-version peer. The plugin has its own runtime lock/audit boundary. CI treats connector changes as code and checks SDK compatibility, package compilation and dependency audit. Source-shaped host tests exercise the real Thinkarr route, SQLite prompt claims, credential permissions and Seerr request attribution with synthetic provider delivery/mocked downstream HTTP. No live installation/message/deployment is performed by tests; actual host admission/self echoes, PN/LID/routing formats, receipt/fence behavior, transcript privacy and handset handoff are the controlled beta pilot's validation targets before broader activation.

### Delegated Media Downstream Identity and Access
`media-access.ts` creates a non-serializable capability closure from a verified service context, exact media-operation scope and current trusted actor binding. It snapshots binding version, participant Plex account token and configured downstream identities. Every network boundary rechecks principal/credential/key/assertion lifetime, operation scope, actor/binding version, token and configuration. No administrator role, creator identity, model beneficiary argument or process-wide username cache participates. The module exposes no raw HTTP primitive, downstream credentials or account identifiers. The pilot dispatcher uses its catalog and confirmed-submission methods; actor-library methods retain separate safe projections.

Plex identity is reverified against the participant's own account token for each operation. Library discovery uses that same account's resources and derives only its token for the configured server; resource-supplied connection URLs are never followed. The configured endpoint must match the configured machine ID under that actor token before library sections are read. Section results include only visible movie/show keys/types (at most 64 sections). Missing server shares yield an explicit empty unshared result rather than administrator-token fallback, and do not independently block Seerr request eligibility.

`searchLibrary` requires the exact `media_search` capability and a strict query with optional movie/TV type; caller-supplied actors, sections, URLs and backend parameters are rejected. It searches the actor's visible sections using fixed `/library/sections/<key>/all` title/type filters under the actor server token. Reads request at most 21 items per section, validate container counts/offsets/section/type and unique numeric item IDs, return at most 20 items, and report truncation rather than paginate/broaden automatically. `libraryDetails` requires the exact `media_details` capability and a numeric item handle. It rederives current actor access, reads only the fixed metadata path and independently confirms that exact item in the actor-filtered section listing **after** fetching details; guessed IDs and unprovable/hidden membership fail closed. If a bounded same-title listing cannot prove membership, no broader lookup is attempted. Neither method caches visibility or invokes the legacy administrator-backed media clients.

`media-library.ts` parses nested library data into an explicit projection: numeric `itemId`, movie/TV type, title, optional year/synopsis/rating, bounded genre/cast name arrays and `availability: "available"`. Synopsis is capped at 1,000 characters, genres at 10 and cast at eight. Item IDs are lookup handles, not authorization or arbitrary fetch paths; every detail call rechecks actor visibility. Availability means that actor can see that library title, not that every season/episode is available. Viewing counts/history/progress, user ratings, added/viewed timestamps, account/requester/request records, file/media paths, thumbnail/connection URLs and tokens are discarded, including unknown nested fields. These internal library reads are separate from the pilot's public Seerr/TMDB catalog projection, which reports no availability. Richer library episode facts and aggregate request-state projection are deferred.

Seerr identity resolution scans the complete, bounded, stable-ID-paginated user directory using the configured API key internally and matches immutable Plex ID only. Missing users produce a safe request-ineligible reason; duplicate/non-Plex mappings and malformed/unstable pagination fail closed. The selected user is independently verified through `/auth/me` with server-owned `X-Api-User`; both Seerr ID and Plex ID/type must match. Request permission and exact movie/TV-season quota units are checked under that effective user. Thinkarr `users.isAdmin` grants no permission. Approval is not predicted; a later confirmed submission must preserve Seerr's actual pending/approved outcome.

Downstream reads are GET-only; the claimed message-confirmation path has one bounded POST with effective-user attribution checks and no automatic retry. Requests use validated configured bases, omit ambient cookies, refuse redirects and share a bounded operation deadline. Responses have a one-MiB streaming limit and strict required-field validation; raw bodies, user directory fields, account names, tokens and upstream errors are neither logged nor returned. Tests use real signed contexts, SQLite bindings and mocked downstream HTTP to cover restricted-library tokens, concurrent actors, effective-user header enforcement, pagination/ambiguity, no-share eligibility, permissions/quotas, safe nested catalog projection, guessed detail IDs, independent actor-filtered item membership and in-flight revocation. Private missing-account sign-up delivery, no-share web admission and broader library/episode features remain deferred; deployed Plex restrictions and actual channel/write behavior require controlled proof. Each enabled integration remains restricted to its saved group and curated operation scopes.

### Trusted Account-Link State and Ownership
Trusted linking uses new tables; legacy `mcp_channel_identities` rows created from unsigned headers are never accepted as trusted bindings. An internal verified-context control creates a five-minute high-entropy challenge bound to principal/issuer/channel account/sender and origin context kind/ID. Actor/context tuples are stored as scoped hashes, and token/code/session credentials are stored only as digests. Creating a new challenge supersedes earlier pending challenges in that exact scope. The original credential/key/principal must remain active during preparation/completion.

Browser inspection uses JSON POST, no-store/no-referrer responses and a separate auth-rate-limit namespace. Preparation requires a real, unexpired Thinkarr browser session, pins its user/Plex ID/session digest, and returns a fresh completion code without activating the link. A retry in the same browser rotates the code without extending challenge expiry; a different user/session cannot replace the pending account. The normal Plex login/registration admission policy is preserved by `plex-registration.ts`; possession of a link token does not bypass it or create a service-derived administrator.

Only a fresh verified direct-message assertion with the matching `link-confirm:<code>` intent and exact original actor namespace can activate the origin binding. Completion rechecks the prepared session/Plex snapshot, atomically claims the provider event, updates the binding and consumes the challenge in the same immediate transaction. It returns only a safe linked outcome. Owner unlink/admin revocation increments the binding version. Explicit re-verification can reactivate the same real user with a newer version; re-linking the same channel identity to a different Plex account is rejected instead of silently overwriting it. Stable provider identity/reassignment detection remains the connector's canonical-identity contract, not something a phone-number hash proves.

`resolveServiceActor` returns server-owned user/Plex/binding/version identifiers from a live binding; it does not inherit the user's administrator role or perform downstream permission/library checks. Settings → Users exposes only the current user's trusted link metadata and unlink action; administrator integration settings can view/revoke participant bindings. Neither response exposes raw sender/group hashes or private challenge material.

Service-token generation of link challenges and completion are exposed only through the signed dispatcher for principals enabled through Settings. The mobile landing/handoff and trusted private-delivery adapter are implemented; actual canonical provider-identity/handset behavior is validated in the controlled pilot. Supporting Plex accounts without an existing library share must not grant access to legacy administrator-backed personal tools; the existing web-registration admission gate remains unchanged, so the pilot uses an existing eligible account.

### Fragment-Only Mobile Linking and Configured Private Handoff
Settings → MCP integration details include a public linking origin and international WhatsApp bot number. Origins must be HTTPS without userinfo/path/query/fragment; explicit HTTP loopback is supported for development. Numbers normalize an optional leading plus to digits. The browser/request/model never chooses a destination. New link challenges include a digest of the registered origin/number, and changing either through management atomically consumes pending challenges. Fingerprint verification also rejects direct storage drift and pre-handoff-migration drafts; completed actor bindings are unaffected.

The internal initiation result includes `/mcp/connect#token=<secret>` on the configured origin for trusted private delivery only. The exact new landing route is public with no-store/no-referrer headers; sibling and legacy paths retain their existing protection. The fragment is not sent over HTTP, and client initialization captures it in a component ref and strips it from browser history before POST inspection. It is never placed in query parameters, local/session storage, rendered UI or a callback URL. Development effect replay is cancelled before duplicate initial network requests, and a new fragment in an existing tab resets the old invocation state.

The mobile page uses normal Plex PIN sign-in, opening its popup during the user gesture and offering a standard link if the popup is blocked. It polls without overlapping requests until completion or challenge expiry, displays the actual signed-in Plex username and offers account switching. Finish in WhatsApp sends only the challenge in the JSON body, plus a displayed-user comparison header; the API still derives the user/session exclusively from the cookie and refuses a changed account. Browser API origins must match registered configuration. Preparation builds the URI inside the binding-preparation transaction and the public response contains only the handoff URL/expiry, not a separate raw-code field.

The destination is strictly `https://wa.me/<configured-number>?text=Link+account+<code>`. The user must tap Send in WhatsApp; browser navigation/preparation does not claim successful linking. The page deduplicates in-flight preparation and reuses its prepared URI for a retry, so a double click cannot rotate away the draft it just opened. Expiry, changed configuration and changed sign-in refuse handoff with a short recovery message. Real WhatsApp delivery/completion still requires the trusted connector; browser tests intercept both Plex's page and the WhatsApp destination and make no external messages or media requests.

### Orphaned Tool Call Repair
If the server crashes between saving an assistant message with `tool_calls` and saving the tool results, the LLM rejects the conversation on next load. `loadHistory()` in the orchestrator detects orphaned `tool_call_ids` and injects synthetic error tool messages so the conversation is always recoverable.

### Agentic Tool Call Limit
`MAX_TOOL_ROUNDS = 8` in `orchestrator.ts`. If the loop exhausts all rounds without the LLM producing a final text response, the stream ends with `{ type: "error", message: "Tool call limit reached" }` and the Langfuse trace is updated accordingly.

### Sonarr Series Title Matching
`getSeriesStatus()` in `sonarr.ts` prefers an exact (case-insensitive) title match against the `/series` list before falling back to substring matching. This prevents titles like "Celebrity Race Across the World" from being returned when the user asks about "Race Across the World".

### mediaStatus Normalization
Overseerr's API returns title-cased status strings (`"Processing"`, `"Not Requested"`, `"Partially Available"`) which conflict with the lowercase enum expected by `display_titles` (`"pending"`, `"not_requested"`, `"partial"`). `normalizeMediaStatus()` in `overseerr.ts` handles the mapping. The `overseerr_search` and `overseerr_discover` tool handlers apply this function before returning results so the LLM always sees display_titles-compatible values. `enrichSonarrSeries()` in `sonarr-tools.ts` and `enrichRadarrMovie()` in `radarr-tools.ts` both pre-compute `mediaStatus` — `"available"` when found in Plex with all expected seasons, `"partial"` when Plex has fewer seasons than Sonarr expects (compares `match.seasons` / `childCount` vs `s.seasonCount`), normalized Overseerr status when found there, otherwise `"partial"` if monitored (being managed — no request button) or `"not_requested"` if not. When partial due to missing Plex seasons, `plexSeasons` is also returned so the LLM can assign `"available"` to individual season cards 1..plexSeasons and `"partial"` to season cards above that. `searchSeries()` in `sonarr.ts` queries `/series` and `searchMovie()` in `radarr.ts` queries `/movie` (both library-only endpoints) and filter results client-side by title substring or exact year; neither calls the `/lookup` variant, which returns external TVDB/TMDB results with unreliable `monitored` values regardless of library membership. Season 0 (specials) is excluded from `seasonCount` in `searchSeries()` and `totalSeasons` in `getSeriesStatus()` so specials don't inflate the season count.

### Plex Metadata Side-Query Recovery
`display_titles` performs Plex metadata fetches for items that have a `plexKey` but are missing `imdbId` or `thumbPath` (both can be dropped by the LLM). `getMetadataFromPlexKey()` in `plex.ts` fetches the item once and returns both: `thumbPath` from the item itself, `imdbId` from the show-level Guid array (follows `parentKey` for seasons, `grandparentKey` for episodes). Results are deduplicated by normalized plexKey so season cards sharing the same show key fire one fetch, not one per card. For items with no `plexKey` but with `overseerrId`, `display_titles` falls back to an Overseerr `getDetails` call to recover `thumbPath` (existing behaviour).

### Multi-Endpoint LLM Support
`llm.endpoints` JSON array stores per-endpoint config including capabilities. Legacy single-key config preserved for backward compat. Capability auto-detection: `testLlm()` probes Whisper, realtime (model list scan + OpenAI-only guard), and TTS. Per-user model override via `user.{id}.defaultModel` + `canChangeModel`.

### OpenAI Realtime Guard
Realtime (WebRTC) is restricted to `api.openai.com` only. `probeRealtimeSupport()` returns `null` for non-OpenAI hosts. Defence-in-depth check also in `POST /api/realtime/session`.

### Rate Limiting (Multi-Layer)
1. **Message-based**: Per-user configurable (`user.{id}.rateLimit`), calendar-aligned, checked before each `/api/chat` stream.
2. **API-based**: Per-user in-memory (60 req/min sliding window) on `/api/conversations/*` and `/api/settings/*`; returns HTTP 429.

### Text-Channel Adapter (`?mode=text`)

Enables external channel gateways (e.g. OpenClaw) to drive Thinkarr via MCP without a web UI. Three behaviour changes activate when `?mode=text` is appended to MCP requests:

1. **Channel identity resolution**: `X-Channel-Type` + `X-Channel-User-Id` headers resolve to a `users` row via `mcp_channel_identities`. Unregistered users receive `{ error: "unregistered", registrationUrl: "..." }` pointing to `/mcp/link?token=...`. The token is short-lived (15 min) and stored in `mcp_registration_tokens`.

2. **`display_titles` interception**: The route post-processes the tool result before returning. `formatDisplayTitlesAsText()` converts `displayTitles[]` to a markdown numbered list. Requestable items (`mediaStatus: "not_requested"` with an `overseerrId`) are stored in `mcp_pending_baskets` (10-min TTL) and the basket token is returned as `pendingKey` alongside the text.

3. **`confirm_request` tool**: Exposed only in text mode. Takes `{ pendingKey, selection }`, validates the basket (token, TTL, ownership), calls `overseerr.requestMovie` or `overseerr.requestTv`, and returns a user-facing confirmation string. The basket is deleted on resolution (one-time use). `overseerr_request_movie` and `overseerr_request_tv` are hard-blocked in text mode — `confirm_request` is the only path to submit a request.

### Title Card Display System
`display_titles` tool accepts 1–10 titles with rich metadata. Server resolves `thumbUrl` (Plex proxy + token) and `plexMachineId` (Watch Now universal link). Renders as both a collapsible tool call panel and a full-width TitleCarousel below the message. LLM always calls `display_titles` after searches.

**More Info button:** `TitleCard` builds the More Info href in priority order: IMDb (if `imdbId` is set) → TMDB direct page (if `overseerrId` is set) → Google search (final fallback for Plex-only titles with no external IDs). For TV shows/episodes in the Google fallback, the query uses `showTitle` instead of the full `"Show — Season N"` title string.

**imdbId resolution:** `mapMetadata()` in `plex.ts` extracts `imdbId` from the Plex `Guid` array (`"imdb://tt..."` entries) so it flows through tool results. `display-titles-tool.ts` adds an `imdbId` side-query (same non-fatal pattern as `thumbPathOverrides`): for available/partial titles with a `plexKey` but no `imdbId`, it calls `getImdbIdFromPlexKey()` which fetches the Plex metadata and follows `parentKey` to the show for season cards (Guid lives on the show, not the season). Deduplicated by normalized `plexKey` so season cards for the same show fire one set of fetches.

The `year` field is typed as `number` throughout (`OverseerrSearchResult`, `OverseerrDetails`, `OverseerrRequest`, `OverseerrDiscoverResult`). The `yearFromDate()` helper in `overseerr.ts` parses the ISO date string from TMDB at source. The `display_titles` schema uses `z.coerce.number()` as a defensive measure so string years from any future path are coerced rather than rejected.

**Request status persistence:** After a user clicks Request on a title card and the Overseerr submission succeeds, the "Requested" badge state is written to `localStorage` keyed as `thinkarr:requested:{mediaType}:{overseerrId}` (with an optional `:s{seasonNumber}` suffix for season-specific requests). On mount, `TitleCard` reads this key and initialises `requestStatus` to `"success"` if present, so the badge survives conversation reload without any server round-trip.

### Langfuse Observability
Opt-in tracing via `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` env vars, or via Settings UI (env vars take precedence). Each chat request creates a root trace keyed by the user message UUID, with per-round LLM generation spans and per-tool spans. When a user reports an issue, a `user-report` score is attached to the trace and the GitHub issue body includes a `curl` retrieval command instead of a verbose transcript.

### Logging
Winston singleton: Console (stdout, JSON) + DailyRotateFile (`/config/logs/`, 14-day retention, 20 MB max). Tool calls and API responses logged with truncation. Settings Logs tab provides file browser, 500-line viewer, and download.

All `OpenAI` client instances (default and per-endpoint) use a `loggingFetch` wrapper (`src/lib/llm/client.ts`) that clones and logs the raw response body of any non-2xx HTTP response before the SDK reads it. The SDK often discards the body on parse failure (e.g. "400 status code (no body)"), so the wrapper ensures the raw body is always captured in logs regardless of model or provider.

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

### Gemini Null/Absent Content in Assistant Tool-Call Messages (issues #328, #337)
Three related bugs around assistant message content in tool-call sequences were fixed:

**Round 1 (live path, issue #328):** When the LLM emits a tool call with no accompanying text, `fullContent` is `""`. The orchestrator previously pushed `{ role: "assistant", content: null, tool_calls: [...] }` into `apiMessages`. Gemini rejected `content: null`. The fix at the time omitted the field entirely. However, `gemini-3.1-flash-lite-preview` later returned HTTP 400 at round 1 when the `content` field was absent. The current fix always sets `content: fullContent || ""` — an explicit empty string that all known providers accept.

**History path (issue #328):** `loadHistory()` now also sets `content: ""` on assistant messages that have `tool_calls` but no stored content, so reloaded history carries the same explicit empty string.

**Phantom message (issue #328):** The display_titles empty-response special case saves `saveMessage(conversationId, "assistant", "")` — an assistant record with empty content and no tool_calls. `loadHistory()` skips these phantom records (`if (!msg.content && !msg.tool_calls?.length) continue`) so they never reach the LLM.

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

### Request Visibility: Non-Admin Users See Only Their Own Requests
`overseerr_list_requests` now filters by the calling user for non-admins. The tool handler calls `getSession()` (available in the request context) to check `user.isAdmin` and `user.plexUsername`. For non-admins it calls `getSeerrUserId(plexUsername)` which fetches `/user?take=100` from Seerr and matches by `plexUsername` (case-insensitive). The resulting Seerr user ID is passed to `listRequests()` as the `requestedBy` query parameter. Results are cached in a process-level Map so the `/user` list is fetched at most once per process restart. Admins see all requests unchanged.

### Seerr Migration: Genre Endpoint, Similar, and Issue Creation
Upgraded from Overseerr to Seerr. The genre list endpoint moved from `/discover/genres/{mediaType}` to `/genres/{mediaType}` (e.g. `/genres/movie`, `/genres/tv`). `discover()` in `overseerr.ts` was updated to use the new path. Two new service functions were added: `similar(id, mediaType, page)` calls `/movie/{id}/similar` or `/tv/{id}/similar` to find titles like a given one; `createIssue(seerrMediaId, issueType, message)` posts to `/issue` to report a playback problem. `getDetails()` now also returns `seerrMediaId` (the Seerr internal `mediaInfo.id`, distinct from the TMDB ID) which is the required `mediaId` parameter for issue creation. Two new tools expose this: `overseerr_similar` (genre-browse-style results from the similar endpoint) and `overseerr_report_issue` (guided issue creation — LLM must ask the user for a description before calling). The `IssueType` enum (1=Video, 2=Audio, 3=Subtitles, 4=Other) is exported from `overseerr.ts`.
