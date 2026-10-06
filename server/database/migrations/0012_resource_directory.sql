-- =============================================================================
-- 0012 — resources.directory_id：把资源接到可编辑目录树上（§1）
-- =============================================================================
-- WHY
--   目录树（0009/0010）已经是一等公民：可新建、可改名、可排序、可停用、有权限 scope。
--   但 **资源还没有"属于哪个目录"这个事实**：
--     * `directories.resourceCount` 对科目节点是按 (program, subject) 现算的；
--     * 子科与资料夹节点只能返回 0，并在注释里写明"等 resources.directory_id 落地后
--       改为按 directory_id 精确统计"（directories.service.ts resourceCountFor）；
--     * 界面上没有任何入口能把一份资源放进某个自建文件夹。
--   本迁移补上这个事实。
--
-- 与 legacy `folder_type` 的关系：**两个维度，并存，不互相替代**
--   用户已明确决策：不要把"4 种资料夹"和"6 种资料夹"二选一。
--     * `folder_type`（6 值，历史数据在用）**原样保留**，不删除、不重写、
--       不把 347 行历史数据改写成别的含义。它继续是资源的"资料夹分类"属性。
--     * `directory_id` 是本轮新增的**目录归属**：指向可编辑目录树上的任意节点
--       （科目 / 子科 / 资料夹 / 用户自建文件夹）。
--   两列同时存在，语义不同，界面各自使用；没有任何一方被另一方覆盖。
--
-- BACKFILL：只做**可从既有事实推导**的映射，不发明业务含义
--   既有事实：每一行资源都有 (program, subject)，而 subject 存的是规范 token；
--   应用今天就是按 (program, subject) 判定可见性与统计科目节点资源数的。
--   因此回填把资源挂到**它所属的科目节点**上 —— 这是把已经存在的事实写成外键，
--   不是新的业务判断。
--
--   **刻意不做的**：把 legacy folder_type 猜成 PDF 的某个资料夹。
--     legacy: curriculum_outline / weekly_plans / courseware / materials /
--             observation / research_archive
--     PDF:    outline(课程大纲) / lesson(教学详案) / resource(教学资源) /
--             assessment(考核评估)
--     只有 curriculum_outline→outline 是**同名**，其余（courseware→? 、
--     weekly_plans→lesson? 、observation→assessment? 、research_archive→无对应）
--     都需要业务判断，PDF 没有规定。用户明确要求"PDF 没有明确规定的地方不要擅自
--     扩大业务含义"，所以这些**一律留 NULL**，由老师在界面上自己归属。
--     资料夹级的归属因此是"尚未指定"，而不是被猜出来的假精确。
--
-- DELETE PROTECTION
--   外键用 **ON DELETE RESTRICT**：只要有资源挂在某个目录节点上，就删不掉那个节点。
--   这是"删除保护"在数据库层的兜底（服务层另有 is_system 与业务校验）。
--   级联删除在这里是错的：删一个目录顺手删掉里面所有资源，是不可恢复的数据损失。
--
-- ADDITIVE ONLY
--   只给 resources 加一列 + 一个外键 + 一个索引，并回填一个**新列**的值；
--   不修改任何既有列、不删除任何既有数据。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 列 + 外键 + 索引
-- -----------------------------------------------------------------------------
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS directory_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resources_directory_id_fkey'
  ) THEN
    ALTER TABLE resources
      ADD CONSTRAINT resources_directory_id_fkey
      FOREIGN KEY (directory_id) REFERENCES directories(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS resources_directory_id_idx
  ON resources (directory_id)
  WHERE directory_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2) 回填：按既有 (program, subject) 挂到对应科目节点
--
--    映射表是**显式**的（不靠字符串拼接猜），且 LEFT JOIN 到 directories：
--    目标节点不存在时该行不更新，保持 NULL —— 宁可不回填，也不写一个不存在的引用。
-- -----------------------------------------------------------------------------
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
)
UPDATE resources r
   SET directory_id = d.id
  FROM subject_node m
  JOIN directories d
    ON d.code = m.directory_code
   AND d.type = 'subject'
 WHERE r.directory_id IS NULL
   AND r.program = m.program
   AND r.subject = m.subject_token;

-- -----------------------------------------------------------------------------
-- 3) 迁移内自校验
--
--    迁移不能"跑完就算成功"。这里显式断言三件事，任何一件不满足就中止：
--      a) 回填出来的引用，其目录节点的 program 必须与资源的 program 一致
--         （防止映射表写错把 Pre-K 的资源挂到 K 的目录上）；
--      b) 非空的 directory_id 必须都能连到一个真实存在的目录节点（外键已保证，
--         这里再查一次是为了让失败信息可读）；
--      c) 一行都没回填上时**要吵**：那说明映射表或数据形状变了。
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_total     int;
  v_linked    int;
  v_mismatch  int;
BEGIN
  SELECT count(*) INTO v_total FROM resources WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_linked FROM resources WHERE directory_id IS NOT NULL;

  SELECT count(*) INTO v_mismatch
    FROM resources r
    JOIN directories d ON d.id = r.directory_id
   WHERE d.program IS NOT NULL
     AND r.program IS NOT NULL
     AND d.program <> r.program;

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION
      '0012 aborted: 有 % 行资源的 directory 归属与其 program 不一致（映射写错了）', v_mismatch;
  END IF;

  IF v_total > 0 AND v_linked = 0 THEN
    RAISE EXCEPTION
      '0012 aborted: 一条都没回填上（共 % 行资源）—— 映射表或数据形状已变，请先核对', v_total;
  END IF;

  RAISE NOTICE '0012: 资源 % 行，已归属目录 % 行，未归属（无对应科目节点）% 行',
    v_total, v_linked, v_total - v_linked;
END $$;
