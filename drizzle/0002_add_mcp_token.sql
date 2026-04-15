ALTER TABLE `users` ADD `mcp_token` text;
CREATE UNIQUE INDEX `users_mcp_token_unique` ON `users` (`mcp_token`) WHERE `mcp_token` IS NOT NULL;
