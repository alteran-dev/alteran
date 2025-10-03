CREATE TABLE `blob_quota` (
	`did` text PRIMARY KEY NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`blob_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
