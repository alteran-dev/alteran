CREATE INDEX `blob_usage_record_uri_idx` ON `blob_usage` (`record_uri`);--> statement-breakpoint
CREATE INDEX `record_did_idx` ON `record` (`did`);--> statement-breakpoint
CREATE INDEX `record_cid_idx` ON `record` (`cid`);--> statement-breakpoint
CREATE INDEX `token_revocation_exp_idx` ON `token_revocation` (`exp`);