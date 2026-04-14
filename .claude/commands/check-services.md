Diagnostic skill for Thinkarr service troubleshooting. Calls the same API
endpoints with the same parameters the application uses, so you can reproduce
reported issues and validate fixes without a running app instance.

Usage: /check-services [service] [operation] [args...]

Examples:
  /check-services                          → health check all services
  /check-services sonarr search 2026       → replicate sonarr_search_series
  /check-services radarr search dune       → replicate radarr_search_movie
  /check-services plex search "breaking bad" → replicate plex_search_library
  /check-services overseerr search "star wars" → replicate overseerr_search
  /check-services sonarr raw /series/lookup?term=2026  → raw endpoint call

Arguments passed: $ARGUMENTS

---

## Step 1 — Credentials

Check `.claude/settings.json` (under `env`) for whichever keys the requested
operation needs:

| Key | Used by |
|-----|---------|
| `SONARR_URL` | All Sonarr operations |
| `SONARR_API_KEY` | All Sonarr operations |
| `RADARR_URL` | All Radarr operations |
| `RADARR_API_KEY` | All Radarr operations |
| `PLEX_URL` | All Plex operations |
| `PLEX_TOKEN` | All Plex operations |
| `OVERSEERR_URL` | All Overseerr operations |
| `OVERSEERR_API_KEY` | All Overseerr operations |

If any needed key is absent, ask the user for all missing values in a single
prompt before proceeding. Offer to save them to `.claude/settings.json` — they
are gitignored and will never be committed. Do not log or print key values.

---

## Step 2 — Dispatch on arguments

Parse `$ARGUMENTS`. If empty or "health", run § A (health check). Otherwise
dispatch to the relevant service section below.

---

## § A — Health check (no args)

Run all four service checks in parallel and present a status table.

For **Sonarr** and **Radarr**, call `/api/v3/system/status`. On success, also
fetch queue size (`/api/v3/queue?pageSize=1` → `totalRecords`) and missing
count (`/api/v3/wanted/missing?pageSize=1` → `totalRecords`).

For **Plex**, call `/identity` with `X-Plex-Token` header.

For **Overseerr**, call `/api/v1/status`. On success, also fetch pending request
count (`/api/v1/request?filter=pending&take=1` → `pageInfo.results`).

Present results as:

```
Service     Status  Version   Notes
────────────────────────────────────────────────────
Sonarr      🟢      4.x.x     Queue: 3  Missing: 12
Radarr      🟢      5.x.x     Queue: 0  Missing: 4
Plex        🟢      1.x.x     Machine: abc123
Overseerr   🟡      2.x.x     Reachable, auth failed
```

Use 🟢 (200 + auth OK), 🟡 (reachable but auth failed or unexpected status),
🔴 (unreachable / timeout). For amber/red, show the raw HTTP status and error.

---

## § B — Sonarr operations

All Sonarr requests: `curl -s "SONARR_URL/api/v3PATH" -H "X-Api-Key: SONARR_API_KEY"`

### `sonarr search <term>`

Replicates `sonarr_search_series`. The app calls `/series` and filters
client-side — it does NOT use `/series/lookup` (fixed in #361).

```bash
# What the app calls
curl -s "$SONARR_URL/api/v3/series" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
results = json.load(sys.stdin)
term = '$TERM'
needle = term.lower()
year_match = int(term) if term.isdigit() and len(term) == 4 else None
matches = [r for r in results if
    needle in r.get('title','').lower() or
    (year_match is not None and r.get('year') == year_match)][:10]
print(f'Library total: {len(results)}  Matches: {len(matches)}')
for r in matches:
    print(f'  id={r[\"id\"]:>4}  monitored={r[\"monitored\"]}  year={r.get(\"year\")}  title={r[\"title\"]}')
"
```

Show: total library size, match count, and for each match: id, title, year,
monitored, hasFile (if present), status.

Also run the OLD (broken) endpoint for comparison when diagnosing regressions:
```bash
# Old /series/lookup for comparison — shows why it was wrong
curl -s "$SONARR_URL/api/v3/series/lookup?term=$TERM" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
results = json.load(sys.stdin)
print(f'Lookup total: {len(results)}  (all have monitored=True by default)')
in_lib = [r for r in results if r.get('id')]
not_in_lib = [r for r in results if not r.get('id')]
print(f'  In library: {len(in_lib)}  Not in library: {len(not_in_lib)}')
"
```

### `sonarr status <title>`

Replicates `sonarr_get_series_status`. The app calls `/series` then `/series/{id}`.

```bash
# Step 1: find the series
curl -s "$SONARR_URL/api/v3/series" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
results = json.load(sys.stdin)
needle = '$TITLE'.lower()
exact = next((r for r in results if r['title'].lower() == needle), None)
match = exact or next((r for r in results if needle in r['title'].lower()), None)
if match:
    print(match['id'])
else:
    print('NOT_FOUND')
"
# Step 2: get full detail (replace ID from step 1)
curl -s "$SONARR_URL/api/v3/series/ID" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
stats = d.get('statistics', {})
print(f'Title: {d[\"title\"]}  Year: {d.get(\"year\")}')
print(f'Monitored: {d[\"monitored\"]}  Status: {d[\"status\"]}')
print(f'Total episodes: {stats.get(\"totalEpisodeCount\")}  Downloaded: {stats.get(\"episodeCount\")}')
print(f'Next airing: {d.get(\"nextAiring\", \"N/A\")}')
"
```

### `sonarr calendar [days]`

Replicates `sonarr_get_calendar` (default 7 days).

```bash
START=$(date -u +%Y-%m-%d)
END=$(date -u -d "+${DAYS:-7} days" +%Y-%m-%d 2>/dev/null || date -u -v+${DAYS:-7}d +%Y-%m-%d)
curl -s "$SONARR_URL/api/v3/calendar?start=$START&end=$END" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
entries = json.load(sys.stdin)
print(f'Episodes airing in next ${DAYS:-7} days: {len(entries)}')
for e in entries:
    show = e.get('series', {}).get('title', 'Unknown')
    print(f'  {e[\"airDateUtc\"][:10]}  S{e[\"seasonNumber\"]:02d}E{e[\"episodeNumber\"]:02d}  {show} — {e[\"title\"]}  hasFile={e[\"hasFile\"]}')
"
```

### `sonarr queue`

Replicates `sonarr_get_queue`.

```bash
curl -s "$SONARR_URL/api/v3/queue?pageSize=20" -H "X-Api-Key: $SONARR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
records = d.get('records', [])
print(f'Queue total: {d.get(\"totalRecords\",0)}  Showing: {len(records)}')
for q in records:
    size = q.get('size', 0)
    left = q.get('sizeleft', 0)
    pct = round((size - left) / size * 100) if size else 0
    show = (q.get('series') or {}).get('title', 'Unknown')
    ep = q.get('episode') or {}
    print(f'  {show} S{ep.get(\"seasonNumber\",0):02d}E{ep.get(\"episodeNumber\",0):02d}  {pct}%  {q.get(\"status\")}  ETA: {q.get(\"timeleft\",\"?\")}')
"
```

### `sonarr raw <path>`

Call any Sonarr endpoint directly. Useful for endpoints not covered above.

```bash
curl -s "$SONARR_URL/api/v3$PATH" -H "X-Api-Key: $SONARR_API_KEY" | python3 -m json.tool
```

---

## § C — Radarr operations

All Radarr requests: `curl -s "RADARR_URL/api/v3PATH" -H "X-Api-Key: RADARR_API_KEY"`

### `radarr search <term>`

Replicates `radarr_search_movie`. The app calls `/movie` and filters
client-side — it does NOT use `/movie/lookup` (fixed in #361).

```bash
curl -s "$RADARR_URL/api/v3/movie" -H "X-Api-Key: $RADARR_API_KEY" | python3 -c "
import sys, json
results = json.load(sys.stdin)
term = '$TERM'
needle = term.lower()
year_match = int(term) if term.isdigit() and len(term) == 4 else None
matches = [r for r in results if
    needle in r.get('title','').lower() or
    (year_match is not None and r.get('year') == year_match)][:10]
print(f'Library total: {len(results)}  Matches: {len(matches)}')
for r in matches:
    print(f'  id={r[\"id\"]:>4}  monitored={r[\"monitored\"]}  hasFile={r[\"hasFile\"]}  year={r.get(\"year\")}  title={r[\"title\"]}')
"
```

### `radarr status <title>`

Replicates `radarr_get_movie_status`.

```bash
curl -s "$RADARR_URL/api/v3/movie" -H "X-Api-Key: $RADARR_API_KEY" | python3 -c "
import sys, json
results = json.load(sys.stdin)
needle = '$TITLE'.lower()
match = next((r for r in results if needle in r.get('title','').lower()), None)
if not match:
    print('NOT_FOUND'); sys.exit()
print(f'Title: {match[\"title\"]}  Year: {match.get(\"year\")}')
print(f'Status: {match[\"status\"]}  Monitored: {match[\"monitored\"]}  hasFile: {match[\"hasFile\"]}')
print(f'tmdbId: {match.get(\"tmdbId\")}  imdbId: {match.get(\"imdbId\")}')
print(f'Movie id: {match[\"id\"]}  (use radarr raw /queue to check download status)')
"
```

### `radarr queue`

Replicates `radarr_get_queue`.

```bash
curl -s "$RADARR_URL/api/v3/queue?pageSize=20" -H "X-Api-Key: $RADARR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
records = d.get('records', [])
print(f'Queue total: {d.get(\"totalRecords\",0)}  Showing: {len(records)}')
for q in records:
    size = q.get('size', 0)
    left = q.get('sizeleft', 0)
    pct = round((size - left) / size * 100) if size else 0
    movie = (q.get('movie') or {}).get('title', 'Unknown')
    print(f'  {movie}  {pct}%  {q.get(\"status\")}  ETA: {q.get(\"timeleft\",\"?\")}')
"
```

### `radarr raw <path>`

```bash
curl -s "$RADARR_URL/api/v3$PATH" -H "X-Api-Key: $RADARR_API_KEY" | python3 -m json.tool
```

---

## § D — Plex operations

All Plex requests: `curl -s "PLEX_URL/PATH" -H "X-Plex-Token: PLEX_TOKEN" -H "Accept: application/json"`

### `plex search <query>`

Replicates `plex_search_library`. The app calls `/hubs/search?query=...&limit=50`.

```bash
curl -s "$PLEX_URL/hubs/search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")&limit=50" \
  -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
hubs = d.get('MediaContainer', {}).get('Hub', [])
for hub in hubs:
    items = hub.get('Metadata', []) or hub.get('Directory', [])
    if not items: continue
    print(f'Hub: {hub.get(\"title\")} ({hub.get(\"type\")}) — {len(items)} results')
    for item in items[:3]:
        t = item.get('type','')
        media_type = 'tv' if t == 'show' else t
        print(f'  [{media_type}] {item.get(\"title\")} ({item.get(\"year\",\"?\")})  key={item.get(\"ratingKey\")}')
"
```

### `plex availability <title>`

Replicates `plex_check_availability`. Same endpoint as search but checks for
an exact title match.

```bash
curl -s "$PLEX_URL/hubs/search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TITLE'))")&limit=50" \
  -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
title_lower = '$TITLE'.lower()
hubs = d.get('MediaContainer', {}).get('Hub', [])
found = []
for hub in hubs:
    for item in (hub.get('Metadata', []) or hub.get('Directory', [])):
        if item.get('title','').lower() == title_lower:
            found.append(item)
if found:
    for item in found:
        t = item.get('type','')
        print(f'FOUND: [{\"tv\" if t==\"show\" else t}] {item[\"title\"]} ({item.get(\"year\",\"?\")})  key={item.get(\"ratingKey\")}')
else:
    print('NOT FOUND in Plex library')
"
```

### `plex ondeck`

Replicates `plex_get_on_deck`.

```bash
curl -s "$PLEX_URL/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=20" \
  -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('MediaContainer', {}).get('Metadata', [])
print(f'On deck: {len(items)} items')
for item in items:
    show = item.get('grandparentTitle', '')
    print(f'  {show+\" — \" if show else \"\"}{item.get(\"title\")} ({item.get(\"year\",\"?\")})  type={item.get(\"type\")}')
"
```

### `plex recent`

Replicates `plex_get_recently_added`.

```bash
curl -s "$PLEX_URL/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=20" \
  -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('MediaContainer', {}).get('Metadata', [])
print(f'Recently added: {len(items)} items')
for item in items:
    print(f'  [{item.get(\"type\")}] {item.get(\"title\")} ({item.get(\"year\",\"?\")})  added={item.get(\"addedAt\")}')
"
```

### `plex raw <path>`

```bash
curl -s "$PLEX_URL$PATH" \
  -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" | python3 -m json.tool
```

---

## § E — Overseerr operations

All Overseerr requests: `curl -s "OVERSEERR_URL/api/v1/PATH" -H "X-Api-Key: OVERSEERR_API_KEY"`

### `overseerr search <query>`

Replicates `overseerr_search`. The app sanitizes the query (strips `()[]{}`
etc.), then calls `/search?query=...&page=1&language=en`.

```bash
SANITIZED=$(python3 -c "import re, sys; print(re.sub(r'[\s]+', ' ', re.sub(r'[()\\[\\]{}!\$&\'*+,;=?#@/\\\\]', ' ', sys.argv[1])).strip())" "$QUERY")
curl -s "$OVERSEERR_URL/api/v1/search?query=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$SANITIZED")&page=1&language=en" \
  -H "X-Api-Key: $OVERSEERR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])[:10]
total = d.get('totalResults', 0)
print(f'Results: {len(results)} of {total}')
for r in results:
    media_info = r.get('mediaInfo') or {}
    status_map = {1:'unknown',2:'pending',3:'processing',4:'partial',5:'available'}
    status = status_map.get(media_info.get('status', 1), 'not_requested')
    title = r.get('title') or r.get('name', '?')
    year_raw = r.get('releaseDate') or r.get('firstAirDate', '')
    year = year_raw[:4] if year_raw else '?'
    print(f'  [{r.get(\"mediaType\")}] id={r[\"id\"]}  {title} ({year})  mediaStatus={status}')
"
```

### `overseerr details <id> <movie|tv>`

Replicates `overseerr_get_details`. The app calls `/movie/{id}` or `/tv/{id}`.

```bash
curl -s "$OVERSEERR_URL/api/v1/$MEDIA_TYPE/$ID" \
  -H "X-Api-Key: $OVERSEERR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
media_info = d.get('mediaInfo') or {}
status_map = {1:'unknown',2:'pending',3:'processing',4:'partial',5:'available'}
status = status_map.get(media_info.get('status', 1), 'not_requested')
print(f'Title: {d.get(\"title\") or d.get(\"name\")}  Year: {(d.get(\"releaseDate\") or d.get(\"firstAirDate\",\"\"))[:4]}')
print(f'mediaStatus: {status}')
print(f'tmdbId: {d.get(\"id\")}  imdbId: {d.get(\"externalIds\",{}).get(\"imdbId\",\"N/A\")}')
cast = [c[\"name\"] for c in (d.get(\"credits\",{}).get(\"cast\") or [])[:5]]
print(f'Cast: {cast}')
"
```

### `overseerr requests`

Replicates `overseerr_list_requests` (first page).

```bash
curl -s "$OVERSEERR_URL/api/v1/request?take=20&skip=0&sort=added" \
  -H "X-Api-Key: $OVERSEERR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])
page_info = d.get('pageInfo', {})
print(f'Total requests: {page_info.get(\"results\",0)}  Showing: {len(results)}')
status_names = {1:'PENDING',2:'APPROVED',3:'DECLINED',4:'AVAILABLE',5:'PROCESSING',6:'PARTIAL'}
for r in results:
    media = r.get('media', {})
    title = media.get('mediaInfo',{}).get('title') or str(media.get('tmdbId','?'))
    status = status_names.get(r.get('status', 0), str(r.get('status')))
    print(f'  [{r.get(\"type\")}] {title}  status={status}  by={r.get(\"requestedBy\",{}).get(\"displayName\",\"?\")}')
"
```

### `overseerr discover [trending|upcoming|movies|tv] [genre:<name>]`

Replicates `overseerr_discover`.

```bash
# trending movies (default)
curl -s "$OVERSEERR_URL/api/v1/discover/movies?page=1&language=en" \
  -H "X-Api-Key: $OVERSEERR_API_KEY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('results', [])[:10]
print(f'Discover results: {len(results)}')
for r in results:
    status_map = {1:'unknown',2:'pending',3:'processing',4:'partial',5:'available'}
    mi = r.get('mediaInfo') or {}
    status = status_map.get(mi.get('status',1), 'not_requested')
    print(f'  {r.get(\"title\",r.get(\"name\",\"?\"))} ({(r.get(\"releaseDate\") or r.get(\"firstAirDate\",\"\"))[:4]})  status={status}')
"
```

Adjust the path for TV (`/discover/tv`), upcoming (`/discover/movies/upcoming`),
or genre (first fetch `/discover/genres/movie` for the genre ID, then pass
`?genreId=ID` to the discover endpoint).

### `overseerr raw <path>`

```bash
curl -s "$OVERSEERR_URL/api/v1$PATH" \
  -H "X-Api-Key: $OVERSEERR_API_KEY" | python3 -m json.tool
```

---

## Presenting results

For any operation, show:
1. **The exact curl command used** — so the user can re-run it independently
2. **Key fields from the response** — processed the same way the app would process them
3. **Total count** where relevant (library size, result count)
4. If the result differs from what was reported in an issue, note the discrepancy

For issue reproduction, show both the raw API result and what `mediaStatus` the
app would assign, so mismatches between the API response and displayed status
are immediately visible.
