-- 回滚 0003：删掉迁移记账表与审计去重索引。
--
-- ⚠️ 这一步**不删**导入进来的业务数据（用户 / 资源 / 审计都在原表里）。
-- 它只让"这批数据是从 V1 搬来的"这件事不再可查。真要撤掉一次导入，
-- 必须先按 v1_migration_map 把行找出来（所以顺序是：先导出、再回滚）。
DROP INDEX IF EXISTS audit_logs_v1_dedup;

DROP INDEX IF EXISTS v1_migration_map_entity_idx;
DROP INDEX IF EXISTS v1_migration_map_review_idx;
DROP TABLE IF EXISTS v1_migration_map;

DROP INDEX IF EXISTS v1_import_runs_started_idx;
DROP TABLE IF EXISTS v1_import_runs;
