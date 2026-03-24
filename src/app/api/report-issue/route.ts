import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

function getGitHubConfig(): { token: string; owner: string; repo: string } | null {
  // Environment variables take precedence over stored config
  const token = process.env.GITHUB_TOKEN || getConfig("github.token");
  const owner = process.env.GITHUB_OWNER || getConfig("github.owner") || "chrisrothwell";
  const repo = process.env.GITHUB_REPO || getConfig("github.repo") || "thinkarr";
  if (!token) return null;
  return { token, owner, repo };
}

function formatTranscript(
  messages: Array<{
    role: string;
    content: string | null;
    toolCalls: string | null;
    toolCallId: string | null;
    toolName: string | null;
    durationMs: number | null;
    createdAt: Date;
  }>,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const ts = msg.createdAt instanceof Date
      ? msg.createdAt.toISOString()
      : new Date(msg.createdAt).toISOString();

    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const name = msg.toolName ?? "unknown_tool";
      const duration = msg.durationMs != null ? ` (${msg.durationMs}ms)` : "";
      lines.push(`**[${ts}] Tool result: ${name}${duration}**`);
      if (msg.content) lines.push("```\n" + msg.content.slice(0, 500) + (msg.content.length > 500 ? "\n...(truncated)" : "") + "\n```");
      lines.push("");
      continue;
    }

    const roleLabel = msg.role === "user" ? "User" : "Assistant";
    lines.push(`**[${ts}] ${roleLabel}:**`);

    if (msg.toolCalls) {
      try {
        const calls = JSON.parse(msg.toolCalls) as Array<{ function?: { name?: string; arguments?: string } }>;
        for (const call of calls) {
          const fnName = call.function?.name ?? "unknown";
          const args = call.function?.arguments ?? "{}";
          lines.push(`> Tool call: \`${fnName}\``);
          lines.push("```json\n" + args.slice(0, 300) + (args.length > 300 ? "\n...(truncated)" : "") + "\n```");
        }
      } catch {
        lines.push("> (tool calls — parse error)");
      }
    }

    if (msg.content) {
      lines.push(msg.content.slice(0, 1000) + (msg.content.length > 1000 ? "\n...(truncated)" : ""));
    }

    lines.push("");
  }
  return lines.join("\n");
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: { conversationId?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { conversationId, description } = body;

  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "conversationId is required" },
      { status: 400 },
    );
  }

  if (!description || typeof description !== "string" || !description.trim()) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "description is required" },
      { status: 400 },
    );
  }

  const db = getDb();

  // Fetch conversation — admin can report on any, users only their own
  let conversation;
  if (session.user.isAdmin) {
    conversation = db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
  } else {
    conversation = db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.userId, session.user.id),
        ),
      )
      .get();
  }

  if (!conversation) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Conversation not found" },
      { status: 404 },
    );
  }

  const messages = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt))
    .all();

  const reportedAt = new Date().toISOString();
  const transcript = formatTranscript(messages);
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const issueBody = `## User-Reported Issue

**Reported by:** ${session.user.plexUsername}
**Reported at:** ${reportedAt}
**Conversation ID:** \`${conversationId}\`

---

## Issue Description

${description.trim()}

---

## Conversation Details

| Field | Value |
|-------|-------|
| Title | ${conversation.title ?? "Untitled"} |
| Created | ${conversation.createdAt instanceof Date ? conversation.createdAt.toISOString() : new Date(conversation.createdAt).toISOString()} |
| Messages | ${nonSystemMessages.length} |

---

## Transcript

${transcript || "_No messages in this conversation._"}

---

_This issue was automatically generated by Thinkarr's report-issue feature. Correlate with application logs using the conversation ID above._
`;

  // Always log the full report so it can be retrieved even if GitHub creation fails
  logger.info("report-issue: issue submitted", {
    userId: session.user.id,
    plexUsername: session.user.plexUsername,
    conversationId,
    reportedAt,
    description: description.trim(),
    issueBody,
  });

  const ghConfig = getGitHubConfig();

  if (!ghConfig) {
    logger.warn("report-issue: GITHUB_TOKEN not configured — issue not created", {
      userId: session.user.id,
      conversationId,
    });
    return NextResponse.json<ApiResponse>({
      success: true,
      data: { message: "Report logged. GitHub integration not configured." },
    });
  }

  const apiUrl = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/issues`;

  let issueUrl: string | undefined;
  try {
    const ghRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghConfig.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "thinkarr",
      },
      body: JSON.stringify({
        title: `[User Report] ${conversation.title ?? "Chat issue"} — ${session.user.plexUsername}`,
        body: issueBody,
        labels: ["user-reported"],
      }),
    });

    if (!ghRes.ok) {
      const errText = await ghRes.text();
      logger.error("report-issue: GitHub API error", {
        status: ghRes.status,
        body: errText.slice(0, 500),
        conversationId,
        userId: session.user.id,
      });
      return NextResponse.json<ApiResponse>(
        { success: false, error: "Failed to create GitHub issue" },
        { status: 502 },
      );
    }

    const ghData = await ghRes.json() as { html_url?: string; number?: number };
    issueUrl = ghData.html_url;

    logger.info("User issue report submitted", {
      userId: session.user.id,
      plexUsername: session.user.plexUsername,
      conversationId,
      reportedAt,
      githubIssue: ghData.number,
      githubIssueUrl: issueUrl,
    });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Network error";
    logger.error("report-issue: Failed to call GitHub API", { error, conversationId, userId: session.user.id });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to create GitHub issue" },
      { status: 502 },
    );
  }

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { issueUrl },
  });
}
