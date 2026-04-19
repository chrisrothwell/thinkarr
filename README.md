# Thinkarr

[![CI](https://github.com/chrisrothwell/thinkarr/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/chrisrothwell/thinkarr/actions/workflows/docker-publish.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/chrisrothwell/thinkarr)](https://hub.docker.com/r/chrisrothwell/thinkarr)
[![Docker Image Version](https://img.shields.io/docker/v/chrisrothwell/thinkarr?sort=semver)](https://hub.docker.com/r/chrisrothwell/thinkarr)

LLM-powered chat assistant for managing your media stack. Connect your Plex, Sonarr, Radarr, and Seerr instances and interact with them through a conversational AI interface.

## Features

- **Chat-based interface** — Ask about your media library, discover and request new content, check download queues, and more
- **Plex integration** — Search your library, check availability, see what's on deck
- **Sonarr/Radarr** — Search for series/movies, view calendars, monitor download queues
- **Seerr/Overseerr** — Discover content and request directly through chat
- **Supports multiple LLMs** — Works with any OpenAI-compatible LLM API (OpenAI, OpenRouter, Anthropic via proxy, Ollama, LiteLLM, etc.) and multiple can be configured at once
- **Customizable System Prompt** — Modify the system prompt per LLM to get the best experience, or use the Default system prompt
- **Plex authentication** — Sign in with your Plex account
- **Streaming responses** — Real-time streaming with tool call visualization
- **Supports Voice and Realtime** — In-built support for Voice and Realtime modes when using ChatGPT model
- **Exposes an MCP Server** — MCP wrapper over Seerr/Arrs/Plex APIs to integrate any LLM or GenAI harness
- **In-built Observability** — connect to Langfuse Cloud or Self-Hosted Langfuse
- **Integration with GitHub** — Allow users to report issues with conversations and automatically generate a GitHub issue with traceid's to enable quick correlation of issues to Langfuse traces.
- **Dark theme** — Purpose-built dark UI

## Quick Start

- It is recommended to run this as a Docker container, alongside your other Arrs tools.
- The docker-compose.yml is designed to be similar to these other Arrs for ease of set up.
- If you are already running Sonarr/Radarr/Overseerr as Docker containers, you can follow the same steps to run the Thinkarr container on your chosen platform.

```yaml
# docker-compose.yml
services:
  thinkarr:
    image: chrisrothwell/thinkarr:latest
    container_name: thinkarr
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Singapore
      #- SECURE_COOKIES=true # Optional; recommended to prevent session cookies from being sent over HTTP.
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open `http://localhost:3000` to start the setup wizard.

## Setup

On first launch, the setup wizard will guide you through configuring:

1. **LLM Provider** (required) — Base URL, API key, and model name for your OpenAI-compatible endpoint
2. **Plex** (required) — Auto discovers your Plex server URL and access token
3. **Sonarr** (optional) — For TV show management
4. **Radarr** (optional) — For movie management
5. **Seerr** (optional) — For media discovery and requests

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | User ID for file permissions |
| `PGID` | `1000` | Group ID for file permissions |
| `TZ` | `UTC` | Timezone (e.g. `Asia/Singapore`) |
| `CONFIG_DIR` | `/config` | Directory for database and config |
| `PORT` | `3000` | Server port |
| `SECURE_COOKIES` | `false` | Set to `true` when ONLY running behind a reverse proxy with HTTPS, and you don't want to access locally over HTTP. |

## Setting up LLMs

Depending on your preference and willingness to pay, you can sign up for and configure API keys for any OpenAI-compatible model and endpoint.

| Organisation | Model Availability | Platform Link | Model Documentation |
|--------------|--------------------|---------------|---------------------|
| OpenAI | GPT 4, GPT 5 | [OpenAI Platform](https://platform.openai.com) | [Models](https://developers.openai.com/api/docs/models) |
| Google | Gemini 2.5, 3 | [Google AI Studio](https://aistudio.google.com) | [Models](https://ai.google.dev/gemini-api/docs/models) |
| OpenRouter | Many | [OpenRouter Homepage](https://openrouter.ai/) | [Models](https://openrouter.ai/models) |

- You may also wish to run your own LLMs e.g. OLlama, which is outside the scope of this document.
- Any OpenAI compatible endpoint should work, although models and providers have various quirks which may require a code fix before they work.

## Choosing an LLM

The system prompt, tools and LLM call flow has been tested in the following configurations:

| Model | Base URL | Capabilities | Quality | Cost per turn $USD |
|-------|-----------|--------------|---------|--------------------|
| `OpenAI gpt-4.1` | https://api.openai.com/v1 | Text, STT (Whisper), TTS | Very Good | $0.04342 |
| `OpenAI gpt-5-mini` | https://api.openai.com/v1 | Text, STT (Whisper), TTS | Under testing | $X.XX |
| `gemini-2.5-flash-lite` | https://generativelanguage.googleapis.com/v1beta/openai | Text | Medium, hallucinates tool calls, struggles with JSON handling, quickly forgets context | $0.002 |
| `gemini-3.1-flash-lite-preview` | https://generativelanguage.googleapis.com/v1beta/openai | Text | Very Good | $0.0068 |
| `moonshotai/kimi-k2.5` | https://openrouter.ai/api/v1 | Text | Very Good, when available | Free Tier |

- Cost per turn is the approximate token cost observed during testing for a question which results in one API tool call and displaying the title carousel.
- These were all tested using the Default prompt.  You may be able to achieve better results on cheaper models by tweaking the system prompt.
- When selecting a model, you may wish to consider that the input:output ratio is approximately 60:1 so you should prioritize models with cheaper input / cached input costs.
- Please let me know which combination of model & prompt works best for you!!

## Development

- Contributions are welcome! Feel free to fork the repo and clone to your local device.
- Please make changes on a new branch with a meaningful name, and be sure to test before pushing upstream.

### Building from source:

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

## Support and Feedback

- You can ask questions in the Help category of our [GitHub Discussions](https://github.com/chrisrothwell/thinkarr/discussions).
- Bug reports and feature requests can be submitted via [GitHub Issues](https://github.com/chrisrothwell/thinkarr/issues).
- I would love to get your input!
