-- =============================================================================
-- 0011 — resource_versions  (ROLLBACK)
-- =============================================================================
-- 本迁移是纯加法（只新建一张表并回填快照），回滚就是删掉这张表。
--
-- 必须显式拒绝的情况：如果**已经有真实的版本历史**（即存在 change_kind 不是
-- 'backfilled' 的行，说明版本自增逻辑已经真的在工作、有人在用），
-- 直接 DROP 会丢掉那些历史，而它们无法从任何地方重建。
-- 逃生阀与 0009/0010 同一套约定：
--     SET LOCAL qls.directories_force_down = 'on';
DO $$
DECLARE
  v_live int;
BEGIN
  SELECT count(*) INTO v_live FROM resource_versions WHERE change_kind <> 'backfilled';

  IF v_live > 0
     AND coalesce(current_setting('qls.directories_force_down', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      '0011 down refused: 存在 % 条**真实**版本历史（非回填）%。回滚会丢失它们。'
      '确认要回滚请先执行 SET LOCAL qls.directories_force_down = ''on'';',
      v_live,
      CASE WHEN v_live > 0 THEN '（例如已有人编辑过资源）' ELSE '' END;
  END IF;
END $$;

DROP TABLE IF EXISTS resource_versions;
