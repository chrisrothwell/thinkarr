/**
 * Lightweight HTTP mock servers for E2E testing.
 *
 * plexServer      — stands in for https://plex.tv (PIN creation, PIN check, user profile)
 *                   and also handles the Plex media server /accounts endpoint used for
 *                   library access checks, and GET / for the machine identifier.
 *
 * llmServer       — OpenAI-compatible endpoint for the LLM.
 *                   Serves both streaming (chat) and non-streaming (title generation)
 *                   responses in the exact format the OpenAI SDK expects.
 *                   Supports tool call responses when the user message contains
 *                   specific E2E trigger phrases (see TRIGGER_ constants below).
 *
 * overseerrServer — Minimal Overseerr mock: accepts POST /api/v1/request.
 *
 * Both servers bind to 127.0.0.1 on an OS-assigned port so they never conflict
 * with other processes. The chosen ports are returned so they can be passed to
 * Next.js via environment variables.
 */

import http from "http";
import { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Trigger phrases — user messages that cause the LLM mock to return tool calls
// ---------------------------------------------------------------------------

/** User message trigger → LLM returns display_titles with an available movie */
export const TRIGGER_AVAILABLE = "e2e show available movie";
/** User message trigger → LLM returns display_titles with a not_requested movie (has overseerrId) */
export const TRIGGER_UNAVAILABLE = "e2e show unavailable movie";
/** User message trigger → LLM returns display_titles with multiple movies (carousel) */
export const TRIGGER_MULTIPLE = "e2e show multiple movies";
/** User message trigger → LLM returns display_titles with a pending TV show (has overseerrId + imdbId, no plexKey) */
export const TRIGGER_PENDING = "e2e show pending tv";

// ---------------------------------------------------------------------------
// Plex mock
// ---------------------------------------------------------------------------

function plexHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // GET / — Plex media server identity (machineIdentifier)
  if (method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: { machineIdentifier: "e2e-machine-id" } }));
    return;
  }

  // POST /api/v2/pins — client requests a new auth PIN
  if (method === "POST" && url === "/api/v2/pins") {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: 10001, code: "e2ecode", authToken: null }));
    return;
  }

  // GET /api/v2/pins/:id — client polls to see if PIN was claimed.
  // We return authToken immediately so the polling succeeds on the first try.
  if (method === "GET" && /^\/api\/v2\/pins\/\d+/.test(url)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: 10001, code: "e2ecode", authToken: "e2e-plex-token" }));
    return;
  }

  // GET /api/v2/user — resolve an auth token to a Plex user profile
  if (method === "GET" && url === "/api/v2/user") {
    const token = req.headers["x-plex-token"] as string | undefined;
    // Second user has a different token so they get a different plexId
    const isSecondUser = token === "e2e-plex-token-user2";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: isSecondUser ? "20002" : "10001",
        username: isSecondUser ? "e2euser" : "e2eadmin",
        email: isSecondUser ? "e2euser@example.com" : "e2eadmin@example.com",
        thumb: "",
        authToken: token,
      }),
    );
    return;
  }

  // GET /accounts — Plex media server library access check.
  // Returns both the admin (10001) and the second user (20002) so both pass.
  if (method === "GET" && url === "/accounts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        MediaContainer: {
          Account: [{ id: 10001 }, { id: 20002 }],
        },
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// Overseerr mock
// ---------------------------------------------------------------------------

function overseerrHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // POST /api/v1/request — submit a media request
  if (method === "POST" && url === "/api/v1/request") {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: 1, status: 1, message: "Request submitted successfully" }));
    return;
  }

  // GET /api/v1/status — health check (used during connection test if any)
  if (method === "GET" && url === "/api/v1/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "1.0.0-e2e" }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// LLM (OpenAI-compatible) mock
// ---------------------------------------------------------------------------

// A short delay between SSE chunks makes the streaming look realistic in tests
const CHUNK_DELAY_MS = 30;

/** Send a streaming tool call response for display_titles */
function sendToolCallResponse(
  res: http.ServerResponse,
  toolArgs: string,
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const callId = "call_e2e_display_001";

  // Chunk 1: tool call start (name, id, empty args)
  const startChunk = {
    id: "chatcmpl-e2e-tc",
    object: "chat.completion.chunk",
    model: "e2e-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name: "display_titles", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };

  // Chunk 2: tool call arguments
  const argsChunk = {
    id: "chatcmpl-e2e-tc",
    object: "chat.completion.chunk",
    model: "e2e-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: toolArgs } }],
        },
        finish_reason: null,
      },
    ],
  };

  // Chunk 3: finish
  const stopChunk = {
    id: "chatcmpl-e2e-tc",
    object: "chat.completion.chunk",
    model: "e2e-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };

  setTimeout(() => {
    res.write(`data: ${JSON.stringify(startChunk)}\n\n`);
    setTimeout(() => {
      res.write(`data: ${JSON.stringify(argsChunk)}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, CHUNK_DELAY_MS);
    }, CHUNK_DELAY_MS);
  }, CHUNK_DELAY_MS);
}

function llmHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // GET /v1/models — model list
  if (method === "GET" && url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "e2e-model", object: "model", created: 0, owned_by: "e2e" }],
      }),
    );
    return;
  }

  // POST /v1/chat/completions — main chat endpoint
  if (method === "POST" && url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed: {
        stream?: boolean;
        messages?: { role: string; content: string }[];
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      const messages = parsed.messages ?? [];

      // If any message is a tool result, the orchestrator is in the second pass —
      // return a plain text response so the conversation completes.
      const hasToolResult = messages.some((m) => m.role === "tool");

      if (!hasToolResult && parsed.stream) {
        // Find last user message to check for E2E trigger phrases
        const userMessages = messages.filter((m) => m.role === "user");
        const lastUserContent = userMessages[userMessages.length - 1]?.content ?? "";

        if (lastUserContent.includes(TRIGGER_AVAILABLE)) {
          // Return a display_titles tool call: single available movie with plexKey
          const args = JSON.stringify({
            titles: [
              {
                mediaType: "movie",
                title: "Ghostbusters",
                year: 1984,
                mediaStatus: "available",
                plexKey: "/library/metadata/100",
                rating: 8.5,
                summary: "Who ya gonna call?",
              },
            ],
          });
          sendToolCallResponse(res, args);
          return;
        }

        if (lastUserContent.includes(TRIGGER_UNAVAILABLE)) {
          // Return a display_titles tool call: single not_requested movie with overseerrId
          const args = JSON.stringify({
            titles: [
              {
                mediaType: "movie",
                title: "Inception",
                year: 2010,
                mediaStatus: "not_requested",
                overseerrId: 27205,
                overseerrMediaType: "movie",
                rating: 8.8,
                summary: "Dreams within dreams.",
              },
            ],
          });
          sendToolCallResponse(res, args);
          return;
        }

        if (lastUserContent.includes(TRIGGER_PENDING)) {
          // Return a display_titles tool call: single pending TV show with overseerrId + imdbId
          const args = JSON.stringify({
            titles: [
              {
                mediaType: "tv",
                title: "Star City",
                year: 2026,
                mediaStatus: "pending",
                overseerrId: 252107,
                overseerrMediaType: "tv",
                imdbId: "tt32140872",
                summary: "A space race drama set behind the Iron Curtain.",
              },
            ],
          });
          sendToolCallResponse(res, args);
          return;
        }

        if (lastUserContent.includes(TRIGGER_MULTIPLE)) {
          // Return a display_titles tool call: multiple movies (carousel path)
          const args = JSON.stringify({
            titles: [
              {
                mediaType: "movie",
                title: "Movie Alpha",
                year: 2020,
                mediaStatus: "available",
                plexKey: "/library/metadata/201",
              },
              {
                mediaType: "movie",
                title: "Movie Beta",
                year: 2021,
                mediaStatus: "pending",
              },
              {
                mediaType: "tv",
                title: "Show Gamma",
                year: 2022,
                mediaStatus: "not_requested",
                overseerrId: 99901,
                overseerrMediaType: "tv",
              },
            ],
          });
          sendToolCallResponse(res, args);
          return;
        }
      }

      if (parsed.stream) {
        // Streaming chat response (default / after tool execution)
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const words = ["Here", " is", " the", " answer", "."];
        words.forEach((word, i) => {
          setTimeout(
            () => {
              const chunk = {
                id: "chatcmpl-e2e",
                object: "chat.completion.chunk",
                model: "e2e-model",
                choices: [{ delta: { content: word }, index: 0, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);

              if (i === words.length - 1) {
                const stop = {
                  id: "chatcmpl-e2e",
                  object: "chat.completion.chunk",
                  model: "e2e-model",
                  choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
                };
                setTimeout(() => {
                  res.write(`data: ${JSON.stringify(stop)}\n\n`);
                  res.write("data: [DONE]\n\n");
                  res.end();
                }, CHUNK_DELAY_MS);
              }
            },
            i * CHUNK_DELAY_MS,
          );
        });
      } else {
        // Non-streaming (used for title generation)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e-title",
            object: "chat.completion",
            model: "e2e-model",
            choices: [
              {
                message: { role: "assistant", content: "E2E Test Title" },
                index: 0,
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MockServers {
  plexUrl: string;
  llmUrl: string;
  overseerrUrl: string;
  stop: () => Promise<void>;
}

export async function startMockServers(): Promise<MockServers> {
  const plexServer = http.createServer(plexHandler);
  const llmServer = http.createServer(llmHandler);
  const overseerrServer = http.createServer(overseerrHandler);

  const [plexPort, llmPort, overseerrPort] = await Promise.all([
    listen(plexServer),
    listen(llmServer),
    listen(overseerrServer),
  ]);

  return {
    plexUrl: `http://127.0.0.1:${plexPort}`,
    llmUrl: `http://127.0.0.1:${llmPort}`,
    overseerrUrl: `http://127.0.0.1:${overseerrPort}`,
    stop: () =>
      Promise.all([close(plexServer), close(llmServer), close(overseerrServer)]).then(() => {}),
  };
}
