Chat Frontend
1. ✅ DONE - Tool calls now show "Running {Action} on {Service}..." with expandable args/results. Historical tool calls from DB are parsed and displayed when loading conversations.
2. ✅ DONE - Model selector dropdown in chat header, respects per-user canChangeModel setting and default model. Routes through to orchestrator with endpoint-specific client resolution.
3. ✅ DONE - Traffic light dots in sidebar showing service status (Green/Amber/Red) with expandable detail list. Polls every 60s via /api/services/status endpoint.
4. ✅ DONE - Admin sees all conversations grouped by user in sidebar via ?all=true query param. Users see only their own. Admin can also view any conversation's messages.

MCP Exposure and Security
5. ✅ DONE - MCP exposed at /api/mcp with GET (list tools) and POST (execute tool / list). Supports OpenAI function format. Bearer token authentication. Proxy allows unauthenticated access (bearer handles auth).
6. ✅ DONE - MCP validates bearer token from app_config. Permission framework: Admin can call all tools; User can query/read all tools and make requests on own behalf but cannot delete others' requests. X-User-Id header for user-scoped operations.

Settings
7. ✅ DONE - Settings split into 4 tabs:
    a) LLM Setup - Multi-endpoint support with name, Base URL (pre-filled OpenAI), API Key, model (pre-filled gpt-4.1), System Prompt, enable/disable toggle
    b) Plex & Arrs - Plex URL + "Connect to Plex" OAuth button, Sonarr/Radarr/Overseerr with URL hints
    c) MCP Settings - Tool summary grid, endpoint URL + bearer token with copy/regenerate
    d) User Settings - User list with role selector (Admin/User), default model dropdown, can-change-model checkbox


Setup Wizard
8. ✅ DONE - Setup page replaced with welcome splash ("Login with Plex" + "This user will become the Server Administrator"). First user → admin → redirected to Settings. Admin login with missing LLM config → redirected to Settings. Otherwise → chat.

Code Hygiene
9. ✅ DONE - Renamed middleware.ts to proxy.ts with updated export function name per Next.js 16 convention
10. ✅ DONE - Added TZ environment variable to Dockerfile (with tzdata package) and docker-compose.yml
