Fetch diagnostic context from the beta server before responding. Uses Langfuse when
available (richer trace data); falls back to application logs otherwise.

---

## Step 1 — Check whether Langfuse is configured

Check whether `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are set in your
environment (e.g. via `.claude/settings.json` `env` block).

- **If both keys are present** → use the Langfuse API (§ A).
- **If either key is missing** → use `AskUserQuestion` to request them from the
  user before proceeding. Ask:

  > "Langfuse credentials aren't configured. Please provide your
  > `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (find them in the beta admin
  > UI under **Settings → Logs → Langfuse Observability**), and I'll add them to
  > `.claude/settings.json` for you."

  Once the user supplies the keys, write them into `.claude/settings.json` under
  `env` (creating the file if it doesn't exist), then proceed to § A.
  Do **not** fall back to application logs (§ B) when Langfuse credentials are
  missing and a Langfuse trace ID or session ID is available — logs lack the
  per-trace detail needed to diagnose LLM issues.

---

## § A — Fetch from Langfuse (preferred)

### If you have a session ID or trace ID (e.g. from a GitHub issue):

```bash
# Single trace — full LLM inputs/outputs, tool calls, token usage, scores
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/traces/<TRACE_ID>"

# All traces for a conversation session (most recent first)
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/traces?sessionId=<SESSION_ID>&limit=10"

# Scores on a trace (includes user-report scores from the Report Issue button)
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/scores?traceId=<TRACE_ID>"
```

### If you only have a username or time window:

```bash
# List recent traces (adjust limit/page as needed)
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/traces?limit=20&userId=<USER_ID>"
```

### If Langfuse credentials are missing:

This case is handled in Step 1 — use `AskUserQuestion` to request the keys from
the user, then write them to `.claude/settings.json` under `env`:

```json
{
  "env": {
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_HOST": "https://cloud.langfuse.com"
  }
}
```

Do not commit or log key values.

---

## § B — Fetch from application logs (fallback)

Use when Langfuse is not configured, or for server-level issues not captured in traces
(startup errors, migration failures, auth problems).

```bash
curl -s -H "X-Api-Key: $THINKARR_INTERNAL_KEY" \
  "https://ai-beta.plexorcist.synology.me/api/internal/logs?tail=300"
```

**Optional filters** — append to the URL as needed:

| Param | Example | Effect |
|-------|---------|--------|
| `tail` | `?tail=500` | Return last N lines (max 2000, default 300) |
| `level` | `?level=error` | Only lines at that severity (`error`, `warn`, `info`) |
| `conversationId` | `?conversationId=abc123` | Only lines for a specific conversation |

Filters can be combined: `?level=error&conversationId=abc123&tail=100`

`tail` applies to the filtered result set, not the raw line count.

### If `THINKARR_INTERNAL_KEY` is missing or returns 401:

1. Open the beta admin UI and go to **Settings → Logs → Internal API Key**
2. Copy the key
3. Add it to `.claude/settings.json` under `env` as `THINKARR_INTERNAL_KEY`
4. Re-run this command

Do not commit or log the key value.
