CREATE TABLE `mcp_service_principals` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `enabled` integer DEFAULT false NOT NULL,
  `allowed_operations` text NOT NULL,
  `created_by_user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_service_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `token_hash` text NOT NULL,
  `prefix` text NOT NULL,
  `created_by_user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  `last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_service_credentials_token_hash_unique` ON `mcp_service_credentials` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_service_credentials_principal_idx` ON `mcp_service_credentials` (`principal_id`);
--> statement-breakpoint
CREATE TABLE `mcp_service_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `issuer` text NOT NULL,
  `key_id` text NOT NULL,
  `public_key_pem` text NOT NULL,
  `created_at` integer NOT NULL,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_service_keys_issuer_key_unique` ON `mcp_service_keys` (`principal_id`, `issuer`, `key_id`);
--> statement-breakpoint
CREATE TABLE `mcp_service_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE RESTRICT,
  `actor_user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
  `action` text NOT NULL,
  `target_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_service_audit_principal_created_idx` ON `mcp_service_audit` (`principal_id`, `created_at`);
