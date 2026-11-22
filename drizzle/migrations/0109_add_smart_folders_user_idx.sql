-- The fork's per-user smart-folder lookups filter on user_id; keep the
-- declared index after the pre-rename 0052_index_fk_columns file was dropped
-- (its other indexes live in 0075_index_fk_columns).
CREATE INDEX IF NOT EXISTS `smart_folders_user_idx` ON `smart_folders` (`user_id`);
