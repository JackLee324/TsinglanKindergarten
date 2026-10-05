-- =============================================================================
-- 0010 — directories 可编辑化  (ROLLBACK)
-- =============================================================================
-- 回滚会**删除所有自建文件夹行**（它们的唯一存在依据就是 is_system = false），
-- 并去掉 is_system / created_by 两列。系统节点（PDF 结构）不受影响。
--
-- 与 0009 同一套约定：如果真的已经有东西挂在自建文件夹上（外键指向），
-- 直接删会丢数据，所以明确拒绝、要求显式开逃生阀：
--     SET LOCAL qls.directories_force_down = 'on';
DO $$
DECLARE
  v_user int; v_dependents text;
BEGIN
  SELECT count(*) INTO v_user FROM directories WHERE NOT is_system;

  SELECT string_agg(DISTINCT format('%s.%s', c.conrelid::regclass, a.attname), ', ')
    INTO v_dependents
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.confrelid = 'directories'::regclass
     AND c.conrelid <> 'directories'::regclass;

  IF (v_user > 0 OR v_dependents IS NOT NULL)
     AND coalesce(current_setting('qls.directories_force_down', true), 'off') <> 'on' THEN
    -- 注意 PostgreSQL 的 RAISE 里只有 `%` 是占位符，`%s` 会被解析成
    -- 「% 占位 + 字面量 s」—— 第一版写 `节点%s`，报错信息里就真的多出一个 "s"。
    RAISE EXCEPTION
      '0010 down refused: 存在 % 个自建文件夹节点%。回滚会删除它们。'
      '确认要回滚请先执行 SET LOCAL qls.directories_force_down = ''on'';',
      v_user,
      CASE
        WHEN v_dependents IS NULL THEN ''
        ELSE format('，且仍有 %s 引用 directories', v_dependents)
      END;
  END IF;
END $$;

DELETE FROM directories WHERE NOT is_system;

DROP INDEX IF EXISTS directories_sibling_name_key;

ALTER TABLE directories
  DROP CONSTRAINT IF EXISTS directories_created_by_pairing,
  DROP CONSTRAINT IF EXISTS directories_user_node_is_folder,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS is_system;
