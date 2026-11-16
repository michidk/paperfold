CREATE TABLE `collections` (
	`pid` text PRIMARY KEY NOT NULL,
	`owned` text NOT NULL,
	`equipped` text
);
--> statement-breakpoint
ALTER TABLE `planes` ADD `hat` text;