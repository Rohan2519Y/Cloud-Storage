-- Fixes: Table 'cloud_storage.storage_quota' doesn't exist
-- These triggers write to a storage_quota table that no longer exists, so every
-- INSERT into users and every INSERT/DELETE on uploaded_files fails.
-- Nothing in the app reads or writes storage_quota, so we drop the triggers.
-- (Original definitions are backed up in %TEMP%\storage_quota_triggers_backup.sql)

DROP TRIGGER IF EXISTS after_user_insert_quota;
DROP TRIGGER IF EXISTS after_file_upload_update_quota;
DROP TRIGGER IF EXISTS after_file_delete_update_quota;

-- Optional: this stored procedure also references storage_quota and would fail if called.
-- The app never calls it.
-- DROP PROCEDURE IF EXISTS GetUserStorageStats;
