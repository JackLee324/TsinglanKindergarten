-- 0001 的回滚：按依赖倒序删除。
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS resource_reviews;
DROP TABLE IF EXISTS resource_files;
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS user_permissions;
DROP TABLE IF EXISTS directories;
DROP TABLE IF EXISTS users;
