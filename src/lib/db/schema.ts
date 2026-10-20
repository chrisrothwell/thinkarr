import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const mcpChannelIdentities = sqliteTable("mcp_channel_identities", {
  channelType: text("channel_type").notNull(),
  channelUserId: text("channel_user_id").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.channelType, t.channelUserId] })]);

export const mcpRegistrationTokens = sqliteTable("mcp_registration_tokens", {
  token: text("token").primaryKey(),
  channelType: text("channel_type").notNull(),
  channelUserId: text("channel_user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const mcpPendingBaskets = sqliteTable("mcp_pending_baskets", {
  token: text("token").primaryKey(),
  itemsJson: text("items_json").notNull(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

// Machine callers deliberately do not have Plex identities or user roles.
export const mcpServicePrincipals = sqliteTable("mcp_service_principals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  allowedOperations: text("allowed_operations").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const mcpServiceCredentials = sqliteTable("mcp_service_credentials", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  prefix: text("prefix").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
}, (t) => [
  uniqueIndex("mcp_service_credentials_token_hash_unique").on(t.tokenHash),
  index("mcp_service_credentials_principal_idx").on(t.principalId),
]);

export const mcpServiceKeys = sqliteTable("mcp_service_keys", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  keyId: text("key_id").notNull(),
  publicKeyPem: text("public_key_pem").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
}, (t) => [uniqueIndex("mcp_service_keys_issuer_key_unique").on(t.principalId, t.issuer, t.keyId)]);

export const mcpServiceAudit = sqliteTable("mcp_service_audit", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "restrict" }),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetId: text("target_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("mcp_service_audit_principal_created_idx").on(t.principalId, t.createdAt)]);

export const mcpDelegationNonces = sqliteTable("mcp_delegation_nonces", {
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.principalId, t.issuer, t.nonce] }),
  index("mcp_delegation_nonces_expiry_idx").on(t.expiresAt),
]);

export const mcpDelegationEvents = sqliteTable("mcp_delegation_events", {
  eventHash: text("event_hash").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("mcp_delegation_events_expiry_idx").on(t.expiresAt)]);

// Trusted bindings are separate from legacy unsigned-header identities.
export const mcpActorBindings = sqliteTable("mcp_actor_bindings", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  actorHash: text("actor_hash").notNull(),
  contextHash: text("context_hash").notNull(),
  channel: text("channel").notNull(),
  contextKind: text("context_kind", { enum: ["direct", "group"] }).notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  plexId: text("plex_id").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("mcp_actor_bindings_scope_unique").on(t.principalId, t.actorHash, t.contextHash),
  index("mcp_actor_bindings_user_idx").on(t.userId),
]);

export const mcpLinkChallenges = sqliteTable("mcp_link_challenges", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => mcpServicePrincipals.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().references(() => mcpServiceCredentials.id, { onDelete: "cascade" }),
  verificationKeyId: text("verification_key_id").notNull().references(() => mcpServiceKeys.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  actorHash: text("actor_hash").notNull(),
  contextHash: text("context_hash").notNull(),
  channel: text("channel").notNull(),
  contextKind: text("context_kind", { enum: ["direct", "group"] }).notNull(),
  browserUserId: integer("browser_user_id").references(() => users.id, { onDelete: "cascade" }),
  browserPlexId: text("browser_plex_id"),
  browserSessionHash: text("browser_session_hash"),
  completionCodeHash: text("completion_code_hash"),
  browserPreparedAt: integer("browser_prepared_at", { mode: "timestamp_ms" }),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [
  uniqueIndex("mcp_link_challenges_token_unique").on(t.tokenHash),
  uniqueIndex("mcp_link_challenges_code_unique").on(t.completionCodeHash),
  index("mcp_link_challenges_scope_idx").on(t.principalId, t.actorHash, t.contextHash),
]);

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
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
