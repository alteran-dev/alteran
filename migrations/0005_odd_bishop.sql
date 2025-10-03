CREATE TABLE `account_state` (
	`did` text PRIMARY KEY NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blob_usage` (
	`record_uri` text NOT NULL,
	`key` text NOT NULL,
	PRIMARY KEY(`record_uri`, `key`)
);
--> statement-breakpoint
INSERT INTO `__new_blob_usage`("record_uri", "key") SELECT "record_uri", "key" FROM `blob_usage`;--> statement-breakpoint
DROP TABLE `blob_usage`;--> statement-breakpoint
ALTER TABLE `__new_blob_usage` RENAME TO `blob_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `blob_usage_record_uri_idx` ON `blob_usage` (`record_uri`);