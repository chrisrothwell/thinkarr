CREATE TABLE `mcp_delegation_nonces` (
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `issuer` text NOT NULL,
  `nonce` text NOT NULL,
  `expires_at` integer NOT NULL,
  PRIMARY KEY (`principal_id`, `issuer`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `mcp_delegation_nonces_expiry_idx` ON `mcp_delegation_nonces` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `mcp_delegation_events` (
  `event_hash` text PRIMARY KEY NOT NULL,
  `principal_id` text NOT NULL REFERENCES `mcp_service_principals`(`id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_delegation_events_expiry_idx` ON `mcp_delegation_events` (`expires_at`);
