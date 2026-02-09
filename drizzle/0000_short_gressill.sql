CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`title` text DEFAULT 'New Chat',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls` text,
	`tool_call_id` text,
	`tool_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plex_id` text NOT NULL,
	`plex_username` text NOT NULL,
	`plex_email` text,
	`plex_avatar_url` text,
	`plex_token` text,
	`is_admin` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_plex_id_unique` ON `users` (`plex_id`);