# Thinkarr Implementation Plan

## Context

Build an LLM-powered chat frontend for media management (*arr stack). Users log in via Plex, chat with an AI assistant that can search libraries, check availability, request content, and answer questions about movies/TV shows. Packaged as a Docker container following linuxserver.io conventions.

## Tech Stack

- **Framework**: Next.js 16 (App Router, `output: "standalone"`)
- **Language**: TypeScript throughout
- **Database**: SQLite via better-sqlite3 + Drizzle ORM, stored at `/config/thinkarr.db`
- **LLM**: OpenAI-compatible API via `openai` SDK
- **Tools**: In-process MCP-style tool registry (Zod schemas -> OpenAI function format)
- **Auth**: Plex PIN-based OAuth (custom implementation, no NextAuth)
- **Styling**: Tailwind CSS 4, dark theme, shadcn/ui-style components
- **Docker**: Multi-stage Alpine/Node build, PUID/PGID support, `/config` volume

## Implementation Phases

### Phase 1: Foundation
- [x] Initialize Next.js project with TS, Tailwind, App Router
- [x] Install all dependencies
- [x] Write DB schema (app_config, users, sessions, conversations, messages) — `src/lib/db/schema.ts`
- [x] Write DB connection singleton + config reader/writer — `src/lib/db/index.ts`, `src/lib/config/index.ts`
- [x] Generate initial Drizzle migration — `drizzle/0000_short_gressill.sql`
- [x] Set up base UI components + dark theme + cn() utility — `src/components/ui/` (8 components), `src/app/globals.css`, `src/lib/utils.ts`
- [x] Configure next.config.ts (standalone output, better-sqlite3 external)

**Also completed (not originally in plan):**
- [x] DB migration utility + auto-migration on first connection — `src/lib/db/migrate.ts`, `src/lib/db/index.ts`
- [x] Type definitions — `src/types/index.ts`, `src/types/api.ts`, `src/types/chat.ts`
- [x] Drizzle config — `drizzle.config.ts`
- [x] ESLint + PostCSS config

### Phase 2: Setup Wizard
- [x] Setup API routes (GET status, POST save config, POST test-connection) — `src/app/api/setup/route.ts`, `src/app/api/setup/test-connection/route.ts`
- [x] Minimal service clients (connection testing only) — `src/lib/services/test-connection.ts`
- [x] Setup wizard UI (multi-step form with connection testers) — `src/app/setup/page.tsx`
- [x] Root page redirect logic (setup -> login -> chat) — `src/app/page.tsx`

### Phase 3: Authentication
- [x] Plex OAuth implementation (PIN-based flow) — `src/lib/services/plex-auth.ts`
- [x] Session management (create/validate/destroy + httpOnly cookie) — `src/lib/auth/session.ts`
- [x] Auth API routes (plex, callback, session) — `src/app/api/auth/{plex,callback,session}/route.ts`
- [x] Next.js middleware (cookie check, redirects) — `src/middleware.ts`
- [x] Login page UI with Plex popup flow — `src/app/login/page.tsx`

### Phase 4: Chat UI
- [x] App layout with collapsible sidebar — `src/app/chat/page.tsx`
- [x] Sidebar (conversation list, new chat button, user menu) — `src/components/chat/sidebar.tsx`
- [x] Conversation CRUD API routes + useConversations hook — `src/app/api/conversations/`, `src/hooks/use-conversations.ts`
- [x] Chat components (message-list, message-bubble, message-content, chat-input) — `src/components/chat/`
- [x] useChat hook with SSE stream reading — `src/hooks/use-chat.ts`
- [x] useAutoScroll hook — `src/hooks/use-auto-scroll.ts`

### Phase 5: LLM Integration
- [x] OpenAI client factory from DB config — `src/lib/llm/client.ts`
- [x] System prompt builder — `src/lib/llm/system-prompt.ts`
- [x] Chat orchestrator (async generator with streaming, text-only first) — `src/lib/llm/orchestrator.ts`
- [x] POST /api/chat route with SSE response — `src/app/api/chat/route.ts`
- [x] End-to-end wiring: type -> save -> stream -> render — `useChat` sends to `/api/chat`, reads SSE, renders via `MessageList`
- [x] Auto-title generation for new conversations — `generateTitle()` in orchestrator, called after first response

### Phase 6: MCP Tools
- [x] Tool registry with Zod -> JSON Schema -> OpenAI function format — `src/lib/tools/registry.ts`
- [x] Full service clients (plex, sonarr, radarr, overseerr) — `src/lib/services/{plex,sonarr,radarr,overseerr}.ts`
- [x] MCP tool definitions + auto-init — `src/lib/tools/{plex,sonarr,radarr,overseerr}-tools.ts`, `src/lib/tools/init.ts`
- [x] Tool call loop in chat orchestrator (max 5 rounds) — `src/lib/llm/orchestrator.ts`
- [x] Tool call display component in chat UI — `src/components/chat/tool-call.tsx`, updated `message-bubble.tsx`, `message-list.tsx`, `use-chat.ts`

### Phase 7: Docker & Polish
- [x] Multi-stage Dockerfile — `Dockerfile`, `.dockerignore`
- [x] Entrypoint script (PUID/PGID, migrations, start) — `entrypoint.sh`
- [x] docker-compose.yml example — `docker-compose.yml`
- [x] Settings page (reconfigure services, admin only) — `src/app/settings/page.tsx`, `src/app/api/settings/route.ts`
- [x] README with full documentation — `README.md`
- [x] Loading states, error handling, responsive design — chat page loading spinner, auto-collapse sidebar on mobile

## Current File Structure

```
├── Dockerfile                       # Multi-stage Alpine/Node build
├── .dockerignore                    # Excludes node_modules, .next, etc.
├── entrypoint.sh                    # PUID/PGID user creation + server start
├── docker-compose.yml               # Development/example compose
├── drizzle/
│   └── 0000_short_gressill.sql      # Initial migration (5 tables)
src/
├── middleware.ts                     # Auth cookie check + route protection
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── plex/route.ts        # POST create Plex PIN
│   │   │   ├── callback/route.ts    # POST exchange PIN for session
│   │   │   └── session/route.ts     # GET current user / DELETE logout
│   │   ├── chat/route.ts            # POST send message, stream SSE response
│   │   ├── conversations/
│   │   │   ├── route.ts             # GET list / POST create
│   │   │   └── [id]/
│   │   │       ├── route.ts         # GET with messages / DELETE
│   │   │       └── title/route.ts   # PATCH rename
│   │   ├── settings/route.ts        # GET masked config / PATCH update (admin)
│   │   └── setup/
│   │       ├── route.ts             # GET status + POST save config
│   │       └── test-connection/
│   │           └── route.ts         # POST test service connectivity
│   ├── chat/
│   │   └── page.tsx                 # Full chat page (sidebar + messages + input)
│   ├── login/
│   │   └── page.tsx                 # Plex OAuth popup login flow
│   ├── settings/
│   │   └── page.tsx                 # Admin settings page (reconfigure services)
│   ├── setup/
│   │   └── page.tsx                 # Setup wizard (multi-step form)
│   ├── globals.css                  # Dark theme CSS variables + Tailwind 4
│   ├── layout.tsx                   # Root layout with Geist fonts
│   ├── page.tsx                     # Root redirect (setup -> login -> chat)
│   └── favicon.ico
├── components/
│   ├── chat/
│   │   ├── chat-input.tsx           # Auto-resizing textarea + send/stop buttons
│   │   ├── message-bubble.tsx       # User/assistant message styling + avatar + tool calls
│   │   ├── message-content.tsx      # Markdown rendering (react-markdown + remark-gfm)
│   │   ├── message-list.tsx         # Scrollable message container + empty state
│   │   ├── sidebar.tsx              # Collapsible sidebar + conversation list + user menu
│   │   └── tool-call.tsx            # Expandable tool call display (args, result, status)
│   └── ui/
│       ├── avatar.tsx               # Image/fallback avatar (sm/md/lg)
│       ├── badge.tsx                # 4 variants
│       ├── button.tsx               # 6 variants + 4 sizes
│       ├── card.tsx                 # Card + Header/Title/Description/Content/Footer
│       ├── input.tsx                # Styled input field
│       ├── label.tsx                # Form label
│       ├── spinner.tsx              # Animated loading spinner
│       └── textarea.tsx             # Multi-line text input
├── hooks/
│   ├── use-auto-scroll.ts           # Auto-scroll on new messages, respects manual scroll
│   ├── use-chat.ts                  # Messages state, SSE streaming, send/stop
│   └── use-conversations.ts         # Conversation CRUD (list, create, delete, rename)
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
│   │   ├── client.ts                # OpenAI client factory from DB config
│   │   ├── orchestrator.ts          # Chat streaming engine + auto-title generation
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
    ├── chat.ts                      # SSE events, ChatRequest, ToolCallDisplay types
    └── index.ts                     # User, Session, Conversation, Message interfaces
```

## Database Schema

| Table | Key Columns |
|-------|-------------|
| app_config | key (PK), value, encrypted, updatedAt |
| users | id, plexId (unique), plexUsername, plexEmail, plexAvatarUrl, plexToken, isAdmin |
| sessions | id (UUID PK), userId (FK), expiresAt |
| conversations | id (UUID PK), userId (FK), title, createdAt, updatedAt |
| messages | id (UUID PK), conversationId (FK), role, content, toolCalls, toolCallId, toolName |

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /api/setup | Check if setup complete |
| POST | /api/setup | Save initial config |
| POST | /api/setup/test-connection | Test service connectivity |
| POST | /api/auth/plex | Initiate Plex OAuth (returns PIN + URL) |
| POST | /api/auth/callback | Exchange PIN for token, create session |
| GET | /api/auth/session | Get current user session |
| DELETE | /api/auth/session | Logout |
| POST | /api/chat | Send message, stream LLM response (SSE) |
| GET | /api/settings | Get config (secrets masked, admin only) |
| PATCH | /api/settings | Update config (admin only) |
| GET | /api/conversations | List user's conversations |
| POST | /api/conversations | Create new conversation |
| GET | /api/conversations/[id] | Get conversation with messages |
| DELETE | /api/conversations/[id] | Delete conversation |
| PATCH | /api/conversations/[id]/title | Rename conversation |

## MCP Tools

| Server | Tools |
|--------|-------|
| Plex | plex_search_library, plex_get_watch_history, plex_get_on_deck, plex_check_availability |
| Sonarr | sonarr_search_series, sonarr_get_calendar, sonarr_get_queue, sonarr_list_series, sonarr_monitor_series |
| Radarr | radarr_search_movie, radarr_list_movies, radarr_get_queue, radarr_monitor_movie |
| Overseerr | overseerr_search, overseerr_request_movie, overseerr_request_tv, overseerr_list_requests |
