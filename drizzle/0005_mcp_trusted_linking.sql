CREATE TABLE `mcp_actor_bindings` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `actor_hash` text NOT NULL,
  `context_hash` text NOT NULL,
  `channel` text NOT NULL,
  `context_kind` text NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `plex_id` text NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_actor_bindings_scope_unique` ON `mcp_actor_bindings` (`principal_id`, `actor_hash`, `context_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_actor_bindings_user_idx` ON `mcp_actor_bindings` (`user_id`);
--> statement-breakpoint
CREATE TABLE `mcp_link_challenges` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `credential_id` text NOT NULL REFERENCES `mcp_service_credentials`(`id`) ON DELETE CASCADE,
  `verification_key_id` text NOT NULL REFERENCES `mcp_service_keys`(`id`) ON DELETE CASCADE,
  `token_hash` text NOT NULL,
  `actor_hash` text NOT NULL,
  `context_hash` text NOT NULL,
  `channel` text NOT NULL,
  `context_kind` text NOT NULL,
  `browser_user_id` integer REFERENCES `users`(`id`) ON DELETE CASCADE,
  `browser_plex_id` text,
  `browser_session_hash` text,
  `completion_code_hash` text,
  `browser_prepared_at` integer,
  `consumed_at` integer,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_link_challenges_token_unique` ON `mcp_link_challenges` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_link_challenges_code_unique` ON `mcp_link_challenges` (`completion_code_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_link_challenges_scope_idx` ON `mcp_link_challenges` (`principal_id`, `actor_hash`, `context_hash`);
