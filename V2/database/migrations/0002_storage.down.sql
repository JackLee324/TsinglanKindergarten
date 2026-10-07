-- 回滚 0002：只删本迁移建的两张表。
-- 顺序与 up 相反，且 storage_orphans 引用了 resource_files，所以先删它。
DROP INDEX IF EXISTS storage_orphans_pending_idx;
DROP INDEX IF EXISTS storage_orphans_pending_key;
DROP TABLE IF EXISTS storage_orphans;

DROP INDEX IF EXISTS upload_tickets_open_idx;
DROP INDEX IF EXISTS upload_tickets_resource_idx;
DROP INDEX IF EXISTS upload_tickets_storage_key_key;
DROP TABLE IF EXISTS upload_tickets;
