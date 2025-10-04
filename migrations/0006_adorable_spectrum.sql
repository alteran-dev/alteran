PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repo_root` (
	`did` text PRIMARY KEY NOT NULL,
	`commit_cid` text NOT NULL,
	`rev` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_repo_root`("did", "commit_cid", "rev") SELECT "did", "commit_cid", "rev" FROM `repo_root`;--> statement-breakpoint
DROP TABLE `repo_root`;--> statement-breakpoint
ALTER TABLE `__new_repo_root` RENAME TO `repo_root`;--> statement-breakpoint
PRAGMA foreign_keys=ON;