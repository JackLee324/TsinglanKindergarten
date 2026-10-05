-- =============================================================================
-- 0009 — directories  (ROLLBACK)
-- =============================================================================
-- 与 0007 的刻意"拒绝回滚"不同：本迁移**只新增一张表**，没有改动任何既有表、
-- 也没有改写任何 resources 行（见 0009 头部 "ADDITIVE ONLY"）。所以回滚是安全的，
-- 唯一丢失的是目录树本身 —— 而它可以从 0009_directories.sql 原样重建（幂等 seed）。
--
-- 仍然显式拒绝一种情况：如果已经有一条真实 FK 指向 directories（例如后续那个
-- "把 resources 接到目录"的迁移已经跑过），直接 DROP 会让外键悬空、并静默丢掉
-- 那些行与目录的挂载关系。这时必须显式开逃生阀：
--     SET LOCAL qls.directories_force_down = 'on';
-- 与 0007 的 qls.soft_delete_force_down 同一套约定。
DO $$
DECLARE
  v_dependents text;
BEGIN
  SELECT string_agg(DISTINCT format('%s.%s', c.conrelid::regclass, a.attname), ', ')
    INTO v_dependents
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.confrelid = 'directories'::regclass
     -- 排除本表自身的 parent_id 自引用：它是这棵树的一部分，随表一起消失，
     -- 不构成"外部依赖"。第一版忘了排除，导致回滚被自己的树挡住。
     AND c.conrelid <> 'directories'::regclass;

  IF v_dependents IS NOT NULL
     AND coalesce(current_setting('qls.directories_force_down', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      '0009 down refused: % 仍引用 directories。回滚会丢失这些挂载关系；'
      '确认要回滚请先执行 SET LOCAL qls.directories_force_down = ''on'';', v_dependents;
  END IF;
END $$;

DROP TABLE IF EXISTS directories;
