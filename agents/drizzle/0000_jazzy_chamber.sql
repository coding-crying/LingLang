CREATE TABLE `grammar_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`description` text,
	`example` text,
	`unit_id` text,
	`embedding` blob,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `learning_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`lexeme_id` text NOT NULL,
	`srs_level` integer DEFAULT 0 NOT NULL,
	`next_review` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`encounters` integer DEFAULT 0 NOT NULL,
	`correct_uses` integer DEFAULT 0 NOT NULL,
	`form_stats` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lexeme_id`) REFERENCES `lexemes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lexemes` (
	`id` text PRIMARY KEY NOT NULL,
	`lemma` text NOT NULL,
	`pos` text NOT NULL,
	`language` text NOT NULL,
	`translation` text NOT NULL,
	`gender` text,
	`morph_features` text,
	`unit_id` text,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`language` text NOT NULL,
	`order` integer NOT NULL,
	`difficulty` text,
	`estimated_hours` integer,
	`prerequisites` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
