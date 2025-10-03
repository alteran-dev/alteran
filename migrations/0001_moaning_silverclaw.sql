CREATE TABLE `login_attempts` (
	`ip` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_attempt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_revocation` (
	`jti` text PRIMARY KEY NOT NULL,
	`exp` integer NOT NULL,
	`revoked_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_commit_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`cid` text NOT NULL,
	`rev` text NOT NULL,
	`data` text NOT NULL,
	`sig` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_commit_log`("seq", "cid", "rev", "data", "sig", "ts") SELECT "seq", "cid", "rev", "data", "sig", "ts" FROM `commit_log`;--> statement-breakpoint
DROP TABLE `commit_log`;--> statement-breakpoint
ALTER TABLE `__new_commit_log` RENAME TO `commit_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;