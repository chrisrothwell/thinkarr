Fetch the last 300 log lines from the beta server and use them as diagnostic context before responding.

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

If `THINKARR_INTERNAL_KEY` is not set or the request returns 401:
1. Open the beta admin UI and navigate to **Settings → Logs → Internal API Key**
2. Copy the key
3. Add it to your `.claude/settings.json` under `env` as `THINKARR_INTERNAL_KEY`
4. Re-run this command

Do not commit or log the key value.
