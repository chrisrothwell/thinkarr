# Thinkarr

LLM-powered chat assistant for managing your media stack. Connect your Plex, Sonarr, Radarr, and Overseerr instances and interact with them through a conversational AI interface.

## Features

- **Chat-based interface** — Ask about your media library, request new content, check download queues, and more
- **Plex integration** — Search your library, check availability, see what's on deck
- **Sonarr/Radarr** — Search for series/movies, view calendars, monitor download queues
- **Overseerr** — Request new content directly through chat
- **OpenAI-compatible** — Works with any OpenAI-compatible LLM API (OpenAI, Anthropic via proxy, Ollama, LiteLLM, etc.)
- **Plex authentication** — Sign in with your Plex account
- **Streaming responses** — Real-time streaming with tool call visualization
- **Dark theme** — Purpose-built dark UI

## Quick Start

```yaml
# docker-compose.yml
services:
  thinkarr:
    image: thinkarr
    container_name: thinkarr
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open `http://localhost:3000` to start the setup wizard.

## Setup

On first launch, the setup wizard will guide you through configuring:

1. **LLM Provider** (required) — Base URL, API key, and model name for your OpenAI-compatible endpoint
2. **Plex** (required) — Your Plex server URL and access token
3. **Sonarr** (optional) — For TV show management
4. **Radarr** (optional) — For movie management
5. **Overseerr** (optional) — For media requests

## Configuration

All configuration is stored in an SQLite database at `/config/thinkarr.db`. Settings can be changed after setup via the Settings page (gear icon in sidebar, admin only).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | User ID for file permissions |
| `PGID` | `1000` | Group ID for file permissions |
| `CONFIG_DIR` | `/config` | Directory for database and config |
| `PORT` | `3000` | Server port |

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Generate database migrations
npx drizzle-kit generate
```

## Tech Stack

- Next.js 16 (App Router, standalone output)
- TypeScript
- SQLite via better-sqlite3 + Drizzle ORM
- OpenAI SDK (compatible with any OpenAI-format API)
- Tailwind CSS 4
- React 19
