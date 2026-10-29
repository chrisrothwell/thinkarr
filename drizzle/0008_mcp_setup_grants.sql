CREATE TABLE `mcp_setup_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `created_by_user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `token_hash` text NOT NULL UNIQUE,
  `config_hash` text NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer
);
