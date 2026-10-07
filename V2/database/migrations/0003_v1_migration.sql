-- ============================================================================
-- 0003_v1_migration.sql —— 阶段 9：V1 → V2 迁移记账
-- ============================================================================
-- 这一版**不加任何业务表、不加任何业务列**。它只加两张"记账"表和一个去重索引，
-- 解决迁移必须回答的三个问题：
--
--   1. 这条 V2 记录原来是 V1 的哪一行？（可追溯）
--   2. 再跑一次导入，怎么保证不重复搬？（幂等）
--   3. V1 有、V2 故意没有的字段（folder_type / semester / roles …）去哪了？（不丢）
--
-- 为什么记账要进数据库而不是只写一个 JSON 报告：
--
--   幂等键必须是**数据库层的约束**。如果幂等只靠脚本"先查一下再插"，
--   那么并发、中断重跑、两个运维同时执行这三种情况里，至少有一种会重复导入。
--   而重复导入的资源在老师那边表现为"同一份教案出现两次"——很难被发现，
--   因为两条都长得对。
--
-- 为什么不去动业务表的形状：
--
--   业主明确要求 V2 的资源只用 directory_id 表达归属，folder_type / semester /
--   week_number / theme 不再作为业务字段（见 DATA_MODEL.md §「V2 没有的列」）。
--   所以历史字段进 v1_migration_map.legacy（jsonb），业务表保持干净。
--
-- 命名前缀 v1_ 是有意的：一眼能看出这不是产品概念，而是迁移的产物。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. v1_import_runs —— 每次导入一行
-- ---------------------------------------------------------------------------
CREATE TABLE v1_import_runs (
  id            bigserial PRIMARY KEY,
  -- 源库的**标签**（不是连接串，绝不能把含口令的 URL 写进数据库）。
  -- 例如 `v1@localhost:55432/qls_test_0005`。
  source_label  text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- 各表实际搬运计数：{ "users": {"inserted": 27, "skipped": 0}, ... }
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 报告路径、参数摘要（admin-roles 之类），便于事后复盘"当时是怎么跑的"。
  note          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT v1_import_runs_source_label_not_blank CHECK (btrim(source_label) <> '')
);

CREATE INDEX v1_import_runs_started_idx ON v1_import_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- 2. v1_migration_map —— 每条搬过来的对象一行
-- ---------------------------------------------------------------------------
CREATE TABLE v1_migration_map (
  -- 源库标签 + 实体类型 + V1 的主键，三者构成幂等键。
  -- 同一个 V2 库将来若要合并多个 V1 源，也分得开。
  source      text NOT NULL,
  entity      text NOT NULL,
  v1_id       text NOT NULL,
  -- V2 侧的对象 id（用户/资源保持 V1 的 uuid；目录是 V2 seed 建的，所以不同）。
  -- 某些实体没有对应行（例如"被报告的 deny 覆盖"），此时为 NULL。
  v2_id       text,
  -- V1 有、V2 没有的字段。**不丢数据的落点。**
  legacy      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 该条是否需要人工确认（NEEDS_MANUAL_REVIEW），以及原因。
  needs_review boolean NOT NULL DEFAULT false,
  review_note  text,
  run_id      bigint REFERENCES v1_import_runs (id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, entity, v1_id),
  CONSTRAINT v1_migration_map_entity_check CHECK (
    entity IN ('user', 'directory', 'resource', 'resource_file', 'review', 'audit', 'permission')
  ),
  CONSTRAINT v1_migration_map_source_not_blank CHECK (btrim(source) <> '')
);

-- 报告要按"需要人工确认"和"按实体统计"两种方式查询。
CREATE INDEX v1_migration_map_review_idx ON v1_migration_map (source, entity) WHERE needs_review;
CREATE INDEX v1_migration_map_entity_idx ON v1_migration_map (source, entity);

-- ---------------------------------------------------------------------------
-- 3. 审计去重：靠约束，不靠脚本自觉
-- ---------------------------------------------------------------------------
-- V1 的审计主键是 uuid，V2 的审计主键是 bigserial，所以不能靠"保留同一个 id"去重。
-- 把 V1 的审计 id 放进 detail，然后用表达式唯一索引把它钉死：
-- 第二次导入到同一行时，数据库直接拒绝，脚本不需要"先查后插"。
--
-- 部分索引（WHERE detail ? 'v1AuditId'）保证只约束**迁移来的**行：
-- V2 自己产生的审计没有这个键，完全不受影响。
CREATE UNIQUE INDEX audit_logs_v1_dedup
  ON audit_logs ((detail ->> 'v1AuditId'))
  WHERE detail ? 'v1AuditId';
