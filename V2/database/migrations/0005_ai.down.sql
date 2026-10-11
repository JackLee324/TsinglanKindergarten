-- 0005_ai.down.sql —— 只回滚 AI 相关的新表。
-- ============================================================================
-- ⚠️ 这个 down 迁移**故意不动任何既有表**：AI 功能是纯新增，
--    回滚它就意味着"AI 的表没了"，而不是"顺带把资源/文件也改了"。
--    也**不删除 pg_trgm 扩展** —— 扩展是库级别的共享对象，可能已被别的用途使用，
--    卸载它属于运维决定，不该由一次回滚悄悄做掉。
DROP TABLE IF EXISTS ai_usage_events;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS ai_index_jobs;
DROP TABLE IF EXISTS ai_chunks;
