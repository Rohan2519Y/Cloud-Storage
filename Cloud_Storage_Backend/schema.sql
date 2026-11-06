-- Schema for the Cloud Storage backend (MySQL 8 / Aiven).
-- Source of truth for the database structure: apply this to a fresh database, and add
-- any future change here in the same commit as the code that needs it.
--
-- NOTE: the old storage_quota triggers are intentionally absent. They referenced a table
-- that no longer exists and broke signup/upload/delete (see fix_storage_quota_triggers.sql).

CREATE TABLE IF NOT EXISTS `users` (
  `id` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone_number` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_profile_complete` tinyint(1) DEFAULT '0',
  `telegram_session` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `telegram_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `username` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `telegram_api_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `telegram_api_hash` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `default_group_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `default_channel_username` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `password_changed_at` datetime DEFAULT NULL,
  `telegram_2fa_password_enc` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `phone_number` (`phone_number`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_phone_number` (`phone_number`),
  KEY `idx_telegram_id` (`telegram_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_channels` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `channel_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `channel_username` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `channel_title` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_channel` (`user_id`,`channel_id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_channel_id` (`channel_id`),
  CONSTRAINT `user_channels_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `folders` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `parent_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `folders_user_fk` (`user_id`),
  CONSTRAINT `folders_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uploaded_files` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` bigint NOT NULL DEFAULT '0',
  `mime_type` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `telegram_message_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `channel_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `folder_id` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_message_id` (`telegram_message_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `uploaded_files_folder_fk` (`folder_id`),
  FULLTEXT KEY `idx_file_name` (`original_name`),
  CONSTRAINT `uploaded_files_folder_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `uploaded_files_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- KNOWN ORPHAN: this scheduled event deletes from `login_sessions`, a table that does not exist
-- (it errors every hour). The app never uses it. Safe to remove with: DROP EVENT clean_expired_sessions;
-- Kept here only as a record of what exists in the live database.
-- CREATE DEFINER=`avnadmin`@"%" EVENT `clean_expired_sessions` ON SCHEDULE EVERY 1 HOUR STARTS '2026-05-08 07:21:46' ON COMPLETION NOT PRESERVE ENABLE DO DELETE FROM login_sessions 
--     WHERE expires_at < NOW()
