CREATE TABLE `account` (
	`did` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`password_scrypt` text,
	`email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_handle_unique` ON `account` (`handle`);--> statement-breakpoint
CREATE TABLE `refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`expires_at` integer NOT NULL,
	`app_password_name` text,
	`next_id` text
);
--> statement-breakpoint
CREATE INDEX `refresh_token_did_idx` ON `refresh_token` (`did`);--> statement-breakpoint
CREATE TABLE `secret` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `token_revocation`;