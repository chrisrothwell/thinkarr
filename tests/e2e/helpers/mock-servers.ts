/**
 * Lightweight HTTP mock servers for E2E testing.
 *
 * plexServer  — stands in for https://plex.tv (PIN creation, PIN check, user profile)
 *               and also handles the Plex media server /accounts endpoint used for
 *               library access checks.
 *
 * llmServer   — OpenAI-compatible endpoint for the LLM.
 *               Serves both streaming (chat) and non-streaming (title generation)
 *               responses in the exact format the OpenAI SDK expects.
 *
 * Both servers bind to 127.0.0.1 on an OS-assigned port so they never conflict
 * with other processes. The chosen ports are returned so they can be passed to
 * Next.js via environment variables.
 */

import http from "http";
import { AddressInfo } from "net";

// ---------------------------------------------------------------------------
// Plex mock
// ---------------------------------------------------------------------------

function plexHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

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
// LLM (OpenAI-compatible) mock
// ---------------------------------------------------------------------------

// A short delay between SSE chunks makes the streaming look realistic in tests
const CHUNK_DELAY_MS = 30;

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
      let parsed: { stream?: boolean; messages?: { role: string; content: string }[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      if (parsed.stream) {
        // Streaming chat response
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
  stop: () => Promise<void>;
}

export async function startMockServers(): Promise<MockServers> {
  const plexServer = http.createServer(plexHandler);
  const llmServer = http.createServer(llmHandler);

  const [plexPort, llmPort] = await Promise.all([listen(plexServer), listen(llmServer)]);

  return {
    plexUrl: `http://127.0.0.1:${plexPort}`,
    llmUrl: `http://127.0.0.1:${llmPort}`,
    stop: () => Promise.all([close(plexServer), close(llmServer)]).then(() => {}),
  };
}
