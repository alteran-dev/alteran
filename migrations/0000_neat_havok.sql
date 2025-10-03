CREATE TABLE `blob` (
	`cid` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`key` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blob_usage` (
	`record_uri` text NOT NULL,
	`key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blockstore` (
	`cid` text PRIMARY KEY NOT NULL,
	`bytes` text
);
--> statement-breakpoint
CREATE TABLE `commit_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`cid` text,
	`rev` integer,
	`ts` integer
);
--> statement-breakpoint
CREATE TABLE `record` (
	`uri` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`cid` text NOT NULL,
	`json` text NOT NULL,
	`created_at` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `repo_root` (
	`did` text PRIMARY KEY NOT NULL,
	`commit_cid` text NOT NULL,
	`rev` integer NOT NULL
);
