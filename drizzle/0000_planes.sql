CREATE TABLE `planes` (
	`id` integer PRIMARY KEY NOT NULL,
	`pid` text,
	`name` text NOT NULL,
	`design` text NOT NULL,
	`paint` integer DEFAULT false NOT NULL,
	`p` text NOT NULL,
	`q` text NOT NULL,
	`dist` real NOT NULL,
	`where` text NOT NULL,
	`time` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `planes_pid` ON `planes` (`pid`);