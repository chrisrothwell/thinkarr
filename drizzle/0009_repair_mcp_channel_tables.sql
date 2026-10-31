-- 0002 predates 0000 in the journal and was skipped on existing databases.
-- Keep historical timestamps intact; repair after the latest deployed migration.
CREATE TABLE IF NOT EXISTS `mcp_channel_identities` (
	`channel_type` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel_type`, `channel_user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_registration_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`channel_type` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_pending_baskets` (
	`token` text PRIMARY KEY NOT NULL,
	`items_json` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL
);
