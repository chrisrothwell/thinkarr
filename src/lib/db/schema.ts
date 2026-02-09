import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  encrypted: integer("encrypted", { mode: "boolean" }).default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  plexId: text("plex_id").notNull().unique(),
  plexUsername: text("plex_username").notNull(),
  plexEmail: text("plex_email"),
  plexAvatarUrl: text("plex_avatar_url"),
  plexToken: text("plex_token"),
  isAdmin: integer("is_admin", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").default("New Chat"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", {
    enum: ["system", "user", "assistant", "tool"],
  }).notNull(),
  content: text("content"),
  toolCalls: text("tool_calls"),
  toolCallId: text("tool_call_id"),
  toolName: text("tool_name"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
