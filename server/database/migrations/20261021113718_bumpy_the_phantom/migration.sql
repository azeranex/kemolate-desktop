CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`page_id` integer NOT NULL,
	`kind` text DEFAULT 'bubble' NOT NULL,
	`cx` real NOT NULL,
	`cy` real NOT NULL,
	`w` real NOT NULL,
	`h` real NOT NULL,
	`angle` real DEFAULT 0 NOT NULL,
	`skew_x` real DEFAULT 0 NOT NULL,
	`skew_y` real DEFAULT 0 NOT NULL,
	`quad` text,
	`room` text,
	`source` text DEFAULT '' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`parent_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_blocks_page_id_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_blocks_parent_id_blocks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `blocks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `cast_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` integer NOT NULL,
	`source` text NOT NULL,
	`names` text,
	`gender` text DEFAULT 'unknown' NOT NULL,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_cast_members_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `glossaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` integer NOT NULL,
	`locale` text,
	`name` text DEFAULT 'Glossary' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_glossaries_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `glossary_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`glossary_id` integer NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_glossary_terms_glossary_id_glossaries_id_fk` FOREIGN KEY (`glossary_id`) REFERENCES `glossaries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `layers` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` integer NOT NULL,
	`uid` text NOT NULL,
	`page_id` integer,
	`parent_id` integer,
	`plate` text,
	`label` text NOT NULL,
	`hint` text,
	`visible` integer DEFAULT true NOT NULL,
	`opacity` integer DEFAULT 100 NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`paint` integer DEFAULT false NOT NULL,
	`fixed` integer DEFAULT false NOT NULL,
	`clipped` integer DEFAULT false NOT NULL,
	`adjust` text,
	`image` text,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_layers_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_layers_page_id_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_layers_parent_id_layers_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `layers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` integer NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`subject` text,
	`subject_id` integer,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_logs_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` integer NOT NULL,
	`uid` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`width` integer,
	`height` integer,
	`byte_size` integer,
	`hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_pages_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `repairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`page_id` integer NOT NULL,
	`block_id` integer,
	`key` text NOT NULL,
	`hash` text NOT NULL,
	`from` text NOT NULL,
	`box` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_repairs_page_id_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_repairs_block_id_blocks_id_fk` FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `strokes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`surface_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`client_id` text NOT NULL,
	`author_id` integer,
	`tool` text NOT NULL,
	`composite` text,
	`params` text NOT NULL,
	`points` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`w` real NOT NULL,
	`h` real NOT NULL,
	`retracted` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_strokes_surface_id_surfaces_id_fk` FOREIGN KEY (`surface_id`) REFERENCES `surfaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `surfaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`page_id` integer NOT NULL,
	`layer_id` integer NOT NULL,
	`block_id` integer,
	`key` text NOT NULL,
	`hash` text,
	`width` integer,
	`height` integer,
	`baked_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_surfaces_page_id_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_surfaces_layer_id_layers_id_fk` FOREIGN KEY (`layer_id`) REFERENCES `layers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_surfaces_block_id_blocks_id_fk` FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `translation_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`translation_id` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT 'human' NOT NULL,
	`model` text,
	`batch` text,
	`author_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_translation_revisions_translation_id_translations_id_fk` FOREIGN KEY (`translation_id`) REFERENCES `translations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`block_id` integer NOT NULL,
	`locale` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT 'human' NOT NULL,
	`model` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`style` text,
	`cx` real,
	`cy` real,
	`w` real,
	`h` real,
	`angle` real,
	`skew_x` real,
	`skew_y` real,
	`quad` text,
	`author_id` integer,
	`revision_id` integer,
	`pinned` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_translations_block_id_blocks_id_fk` FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`public_id` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`direction` text DEFAULT 'rtl' NOT NULL,
	`source_locale` text DEFAULT 'ja' NOT NULL,
	`target_locale` text DEFAULT 'en' NOT NULL,
	`cast_notes` text,
	`engine` text DEFAULT 'ai-text' NOT NULL,
	`model` text,
	`effort` text DEFAULT 'fast' NOT NULL,
	`honorifics` integer DEFAULT true NOT NULL,
	`whole_page` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blocks_page_position_idx` ON `blocks` (`page_id`,`position`);--> statement-breakpoint
CREATE INDEX `blocks_parent_idx` ON `blocks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `blocks_page_parent_position_idx` ON `blocks` (`page_id`,`parent_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `cast_members_workspace_source_idx` ON `cast_members` (`workspace_id`,`source`);--> statement-breakpoint
CREATE INDEX `glossaries_workspace_idx` ON `glossaries` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `glossaries_workspace_locale_idx` ON `glossaries` (`workspace_id`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `glossary_terms_glossary_source_idx` ON `glossary_terms` (`glossary_id`,`source`);--> statement-breakpoint
CREATE INDEX `layers_workspace_idx` ON `layers` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `layers_page_idx` ON `layers` (`page_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `layers_page_uid_idx` ON `layers` (`page_id`,`uid`);--> statement-breakpoint
CREATE INDEX `layers_parent_position_idx` ON `layers` (`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `logs_workspace_created_at_idx` ON `logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `pages_workspace_uid_idx` ON `pages` (`workspace_id`,`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `pages_workspace_path_idx` ON `pages` (`workspace_id`,`path`);--> statement-breakpoint
CREATE INDEX `pages_workspace_hash_idx` ON `pages` (`workspace_id`,`hash`);--> statement-breakpoint
CREATE INDEX `pages_workspace_position_idx` ON `pages` (`workspace_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `repairs_page_key_idx` ON `repairs` (`page_id`,`key`);--> statement-breakpoint
CREATE INDEX `repairs_block_idx` ON `repairs` (`block_id`);--> statement-breakpoint
CREATE INDEX `repairs_hash_idx` ON `repairs` (`hash`);--> statement-breakpoint
CREATE INDEX `strokes_surface_seq_idx` ON `strokes` (`surface_id`,`seq`,`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `strokes_surface_client_seq_idx` ON `strokes` (`surface_id`,`client_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `surfaces_page_key_idx` ON `surfaces` (`page_id`,`key`);--> statement-breakpoint
CREATE INDEX `surfaces_page_layer_idx` ON `surfaces` (`page_id`,`layer_id`);--> statement-breakpoint
CREATE INDEX `surfaces_layer_idx` ON `surfaces` (`layer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `surfaces_block_idx` ON `surfaces` (`block_id`);--> statement-breakpoint
CREATE INDEX `translation_revisions_translation_idx` ON `translation_revisions` (`translation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `translation_revisions_batch_idx` ON `translation_revisions` (`batch`);--> statement-breakpoint
CREATE UNIQUE INDEX `translations_block_locale_idx` ON `translations` (`block_id`,`locale`);