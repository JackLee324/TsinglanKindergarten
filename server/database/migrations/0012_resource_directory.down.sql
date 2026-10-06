-- =============================================================================
-- 0012 — resources.directory_id  (ROLLBACK)
-- =============================================================================
-- 回滚就是丢掉这一列连同外键与索引。
--
-- 必须显式拒绝的情况：如果**已经有人真的把资源归到目录上**（即存在与回填结果
-- 不一致的 directory_id），直接 DROP 会丢掉那些人工归属，而它们无法从任何地方
-- 重建 —— 资源的 (program, subject) 推导不出老师手工选择的目录节点。
--
-- 判定方式：重新算一遍回填映射，凡是 directory_id 与"回填应该得到的值"不同的行，
-- 都视为人工/新增归属。
--
-- 逃生阀与 0009/0010/0011 同一套约定：
--     SET LOCAL qls.directories_force_down = 'on';
DO $$
DECLARE
  v_manual int;
BEGIN
  -- 列可能已经不存在（例如回滚跑第二次），此时无事可做。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'resources' AND column_name = 'directory_id'
  ) THEN
    RAISE NOTICE '0012 down: directory_id 不存在，跳过';
    RETURN;
  END IF;

  WITH subject_node(program, subject_token, directory_code) AS (
    VALUES
      ('prek', 'virtue',             'prek:virtue'),
      ('prek', 'montessori',         'prek:montessori'),
      ('prek', 'physical_education', 'prek:pe'),
      ('prek', 'english',            'prek:english'),
      ('k',    'virtue',             'k:virtue'),
      ('k',    'chinese',            'k:chinese'),
      ('k',    'english',            'k:english'),
      ('k',    'physical_education', 'k:pe')
  ),
  expected AS (
    SELECT r.id, d.id AS want
      FROM resources r
      JOIN subject_node m ON m.program = r.program AND m.subject_token = r.subject
      JOIN directories d ON d.code = m.directory_code AND d.type = 'subject'
  )
  SELECT count(*) INTO v_manual
    FROM resources r
    LEFT JOIN expected e ON e.id = r.id
   WHERE r.directory_id IS NOT NULL
     AND (e.want IS NULL OR e.want <> r.directory_id);

  IF v_manual > 0
     AND coalesce(current_setting('qls.directories_force_down', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      '0012 down refused: 有 % 行资源带有人工/新增的目录归属，回滚会丢失它们。'
      '确认要放弃这些归属时用：SET LOCAL qls.directories_force_down = ''on'';', v_manual;
  END IF;
END $$;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_directory_id_fkey;
DROP INDEX IF EXISTS resources_directory_id_idx;
ALTER TABLE resources DROP COLUMN IF EXISTS directory_id;
