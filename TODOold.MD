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

Production Issues
1. [x] FIXED - When deployed as a docker container running on a different machine using the docker-compose.yml in this source folder - after attempting the first login, The frontend displays Authenticated...redirecting - but it never redirects.
   ROOT CAUSE: Session cookie set with `secure: true` in production (NODE_ENV=production) — browsers silently drop Secure cookies over plain HTTP. The cookie was never sent back so the proxy saw no session and looped to /login.
   FIX: Changed `secure` flag to only activate when `SECURE_COOKIES=true` env var is explicitly set. Default is false (suitable for local HTTP Docker deployments). Set SECURE_COOKIES=true in docker-compose.yml if running behind HTTPS reverse proxy.
   FILES: src/lib/auth/session.ts

Chat Frontend
2. [x] FIXED - The first message in a new chat does not produce an answer, we have to ask the question a second time.
   ROOT CAUSE: When a new conversation is created in handleSend(), setActiveConversationId(convId) triggers a useEffect that calls loadMessages(), which fetches from the DB and calls setMessages([]) — overwriting the optimistic placeholder message (with its unique assistantId) mid-stream. Subsequent SSE text_delta events tried to update a message ID that no longer existed in state, so tokens were silently dropped.
   FIX: Added streamingRef (useRef) alongside the streaming state in useChat. loadMessages() returns early if streamingRef.current is true, preventing it from clobbering an active stream. streamingRef is set synchronously (unlike setState) so there is no race window.
   FILES: src/hooks/use-chat.ts

3. [x] FIXED - New chats show up as 'Unknown' user but they can immediately be tagged to the logged in user.
   ROOT CAUSE: POST /api/conversations returned no userId or ownerName. The optimistic update in useConversations added the conversation to state without ownerName, so the admin sidebar grouped it under "Unknown".
   FIX: POST /api/conversations now returns userId and ownerName (from session) alongside id/title/timestamps.
   FILES: src/app/api/conversations/route.ts

4. [x] FIXED - The chat should be named immediately after the first conversation to avoid them staying as 'New Chat'.
   ROOT CAUSE: generateTitle() was fire-and-forget after controller.close() — the stream was already closed before the title was available, so it could never be sent to the client.
   FIX: generateTitle() now returns the title (string | null). In the chat route, it is awaited inside the stream before [DONE] is sent, and a title_update SSE event is emitted. useChat handles title_update by calling an optional onTitleUpdate callback. chat/page.tsx wires this to updateConversationTitle() in useConversations, which updates local sidebar state immediately.
   FILES: src/lib/llm/orchestrator.ts, src/app/api/chat/route.ts, src/types/chat.ts, src/hooks/use-chat.ts, src/hooks/use-conversations.ts, src/app/chat/page.tsx

5. [x] FIXED - The services traffic light goes amber after changing the model in the default profile but chats are working fine.
   ROOT CAUSE: checkLlm() in the status route used max_tokens: 1 in its health check — same problem as the test-connection bug. Non-OpenAI endpoints reject this parameter, causing the check to throw and return amber even when the endpoint is working correctly.
   FIX: Retry without max_tokens if the first attempt fails (same pattern as test-connection fix).
   FILES: src/app/api/services/status/route.ts

MCP additional features

6. [x] FIXED - Review the MCPs to determine which additional tools or changes to existing tools may be needed and how best to structure the response for the LLM
   FIX: Replaced bulk list tools with focused status tools. Added richer metadata across all services:
   - Plex: Extended PlexSearchResult with seasons, totalEpisodes, watchedEpisodes, dateAdded. New mapMetadata() helper.
   - Sonarr: Added getSeriesStatus() returning per-season breakdown (totalEpisodes, downloadedEpisodes, monitored). Removed sonarr_list_series tool, added sonarr_get_series_status. Queue now includes downloadPercent, seasonNumber, episodeNumber.
   - Radarr: Added getMovieStatus() returning downloaded/inQueue/downloadPercent/timeLeft. Removed radarr_list_movies tool, added radarr_get_movie_status. Queue now includes downloadPercent.
   - Overseerr: search() returns per-season availability status and year. listRequests() returns seasonsRequested array.
   FILES: src/lib/services/plex.ts, src/lib/services/sonarr.ts, src/lib/services/radarr.ts, src/lib/services/overseerr.ts, src/lib/tools/sonarr-tools.ts, src/lib/tools/radarr-tools.ts

Settings frontend bugs
7. [x] FIXED - Testing the connection for Plex & Arrs gives error: type, url, and apiKey are required
   ROOT CAUSE: Settings GET response masks secrets as "••••••••". Frontend testConnection replaced masked value with "" before sending. Backend rejected empty apiKey with the field-required error.
   FIX: Test-connection route now resolves credentials server-side: if apiKey is blank/masked, it looks up the stored credential from config (by service type, or by endpointId for multi-LLM). Frontend passes endpointId for LLM endpoints. Error message updated to be actionable ("save settings first").
   FILES: src/app/api/setup/test-connection/route.ts, src/types/api.ts, src/app/settings/page.tsx

8. [x] FIXED - The default system prompt (system-prompt.ts) should pre-fill in the system prompt box and be stored in the database. Some format should be used for the serviceList variable.
   FIX: Extracted DEFAULT_SYSTEM_PROMPT to src/lib/llm/default-prompt.ts (client-safe, no server imports). Uses {{serviceList}} placeholder substituted at runtime. buildSystemPrompt() now accepts an optional custom prompt (from the endpoint's systemPrompt field) and substitutes the placeholder. Orchestrator passes the active endpoint's systemPrompt. Settings page imports DEFAULT_SYSTEM_PROMPT and uses it as the textarea placeholder; hint text explains the {{serviceList}} variable.
   FILES: src/lib/llm/default-prompt.ts (new), src/lib/llm/system-prompt.ts, src/lib/llm/orchestrator.ts, src/lib/llm/client.ts, src/app/settings/page.tsx

9. [x] FIXED - Plex should not get a token via Plex Login, it should accept a direct token input.
   FIX: Removed the Plex OAuth PIN-based connect button (handlePlexConnect, plexConnecting state, LinkIcon). Replaced with a simple password input field ("Paste your Plex token") matching the pattern used by Arr services. Users get their token from plex.tv/account.
   FILES: src/app/settings/page.tsx

10. [x] FIXED - Testing the connection for LLM variously gives error: type, url, and apiKey are required or something about Max-something not supported by the model endpoint.
    ROOT CAUSE (field errors): Same masked apiKey issue as #7.
    ROOT CAUSE (Max-something): testLlm() sent max_tokens: 1 — some non-OpenAI endpoints (Ollama, LM Studio etc.) reject this parameter.
    FIX: Server-side credential lookup (from #7 fix) handles the field errors. testLlm() now retries the completion without max_tokens if the first attempt fails.
    FILES: src/lib/services/test-connection.ts, src/app/api/setup/test-connection/route.ts

11. [x] FIXED - There is no option to set any of the LLM models as default. One (any one, but only one) should be allowed to be toggled as default.
    FIX: Added isDefault boolean field to LlmEndpoint type everywhere (api.ts, settings/route.ts, models/route.ts, settings page). Settings page shows a radio button group (name="defaultEndpoint") so only one endpoint can be default at a time. PATCH handler enforces one default (auto-assigns to first enabled if none set). models/route.ts picks the isDefault endpoint as system default instead of first enabled.
    FILES: src/app/api/settings/route.ts, src/app/api/models/route.ts, src/app/settings/page.tsx

12. [x] FIXED - In User Management, the first user to register (Master Administrator) should not be allowed to be made a user.
    FIX: PATCH /api/settings/users now queries for the lowest user ID and blocks isAdmin=false for that user with a 403. Frontend identifies master admin as Math.min(users.map(u => u.id)) and renders "Administrator (locked)" text instead of a role selector.
    FILES: src/app/api/settings/users/route.ts, src/app/settings/page.tsx
