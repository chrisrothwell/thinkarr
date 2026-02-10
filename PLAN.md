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
│   │   │   ├── mcp-token/route.ts   # GET/POST bearer token management
│   │   │   ├── plex-connect/route.ts # POST Plex OAuth from settings
│   │   │   └── users/route.ts       # GET list / PATCH update user settings
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
│   │   ├── message-bubble.tsx       # User/assistant message styling + avatar + tool calls
│   │   ├── message-content.tsx      # Markdown rendering (react-markdown + remark-gfm)
│   │   ├── message-list.tsx         # Scrollable messages + historical tool call reconstruction
│   │   ├── service-status.tsx       # Traffic light service status (green/amber/red)
│   │   ├── sidebar.tsx              # Collapsible sidebar + grouped conversations + service status
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
│   │   └── index.ts                 # getConfig/setConfig/getConfigMap/isSetupComplete
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
│   │   ├── plex-auth.ts             # Plex PIN OAuth (create/check PIN, get user)
│   │   ├── radarr.ts                # Radarr client (search, list, queue)
│   │   ├── sonarr.ts                # Sonarr client (search, list, calendar, queue)
│   │   └── test-connection.ts       # Connection testers
│   ├── tools/
│   │   ├── init.ts                  # Auto-register tools based on configured services
│   │   ├── overseerr-tools.ts       # Overseerr tool definitions (4 tools)
│   │   ├── plex-tools.ts            # Plex tool definitions (4 tools)
│   │   ├── radarr-tools.ts          # Radarr tool definitions (3 tools)
│   │   ├── registry.ts              # Tool registry (defineTool, getOpenAITools, executeTool)
│   │   └── sonarr-tools.ts          # Sonarr tool definitions (4 tools)
│   └── utils.ts                     # cn() class merge utility
└── types/
    ├── api.ts                       # SetupStatus, TestConnection, SetupSaveRequest types
    ├── chat.ts                      # SSE events, ChatRequest (with modelId), ToolCallDisplay types
    └── index.ts                     # User, Session, Conversation (with ownerName), Message interfaces
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
| mcp.bearerToken | Bearer token for external MCP access |
| user.{id}.defaultModel | Per-user default model selection |
| user.{id}.canChangeModel | Per-user permission to switch models |

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
| GET | /api/settings/mcp-token | Get MCP bearer token (admin) |
| POST | /api/settings/mcp-token | Regenerate MCP bearer token (admin) |
| POST | /api/settings/plex-connect | Plex OAuth from settings (create PIN / check claim) |
| GET | /api/settings/users | List all users with settings (admin) |
| PATCH | /api/settings/users | Update user role/model/permissions (admin) |

## MCP Tools

| Server | Tools |
|--------|-------|
| Plex | plex_search_library, plex_get_watch_history, plex_get_on_deck, plex_check_availability |
| Sonarr | sonarr_search_series, sonarr_get_calendar, sonarr_get_queue, sonarr_list_series, sonarr_monitor_series |
| Radarr | radarr_search_movie, radarr_list_movies, radarr_get_queue, radarr_monitor_movie |
| Overseerr | overseerr_search, overseerr_request_movie, overseerr_request_tv, overseerr_list_requests |

## MCP Permission Framework

| Permission | Query Tools | Action Tools | Scope |
|-----------|-------------|--------------|-------|
| Admin | All | All | All users, full system access |
| User | All query/read tools | request_movie, request_tv, monitor_series, monitor_movie | Own requests only, cannot delete others' requests |

External MCP access uses bearer token (from `mcp.bearerToken` config). Optional `X-User-Id` header scopes operations to a specific user's permission level.
