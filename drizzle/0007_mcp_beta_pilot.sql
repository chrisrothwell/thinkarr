ALTER TABLE `mcp_service_principals` ADD `pilot_group` text;
--> statement-breakpoint
CREATE TABLE `mcp_media_selections` (
  `id` text PRIMARY KEY NOT NULL,
  `binding_id` text NOT NULL REFERENCES `mcp_actor_bindings`(`id`) ON DELETE CASCADE,
  `binding_version` integer NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `media_type` text NOT NULL, `media_id` integer NOT NULL,
  `selection_json` text NOT NULL, `state` text NOT NULL, `requires_quote` integer NOT NULL,
  `prompt_message_id` text, `created_at` integer NOT NULL, `presented_at` integer,
  `expires_at` integer NOT NULL, `outcome` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_media_selection_active` ON `mcp_media_selections` (`binding_id`) WHERE `state` IN ('draft', 'pending');
--> statement-breakpoint
CREATE INDEX `mcp_media_selection_target` ON `mcp_media_selections` (`user_id`, `media_type`, `media_id`);
