-- =============================================================================
-- 0009 — directories: 把 PDF《教师平台》的目录树变成数据
-- =============================================================================
-- WHY
--   业主提供的 `教师平台.pdf` 给出了一棵固定的目录树（教育教学 → Pre-K/K → 科目 → 资料夹，
--   以及 教师成长 → L1/L2/L3 → …），其中部分「教学详案 / 教学资源」节点明确标注
--   **允许自建文件夹**。而当前实现里这棵树的每一层都硬编码在前端：
--
--     client/src/pages/PreKHome/PreKHomePage.tsx        PREK_SUBJECTS
--     client/src/pages/KHome/KHomePage.tsx              K_SUBJECTS
--     client/src/pages/PermissionAdmin/PermissionAdminPage.tsx  自己一份课程树
--
--   于是"改目录"必须改代码重新发布；管理员在后台改不了任何东西。
--
-- THIS MIGRATION IS ADDITIVE ONLY — 刻意不碰 resources
--   资料夹类型在 PDF 里是 **4 种**（课程大纲/教学详案/教学资源/考核评估），而现有
--   `resources.folder_type` 是 **6 种**（curriculum_outline/weekly_plans/courseware/
--   materials/observation/research_archive），347 条种子数据全部使用后者。
--
--   这个映射（6→4 还是保留 6、把 PDF 的 4 个名字作为分组）是**业主尚未决定**的事，
--   涉及 347 行数据改写。所以本迁移**只建表 + 灌目录树**，一行 `resources` 都不动：
--   目录结构与资源存储方式是两件事，前者可以先行落地、且完全可回滚。
--   等业主定了映射，再单独出一个数据迁移把 resources 接上 directory_id。
--
-- 表结构同时保留 `program` / `subject` 两列（冗余于树）：后续把 347 行接到目录上时，
-- 需要能按 (program, subject) 反查目录节点，而不必递归。
-- =============================================================================

CREATE TABLE IF NOT EXISTS directories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id             uuid REFERENCES directories(id) ON DELETE RESTRICT,
  code                  varchar(120) NOT NULL UNIQUE,
  name                  varchar(120) NOT NULL,
  name_en               varchar(160) NOT NULL,
  -- 节点种类：决定 UI 怎么渲染、权限怎么挂
  type                  varchar(32)  NOT NULL,
  program               varchar(16),
  subject               varchar(64),
  sort_order            integer      NOT NULL DEFAULT 0,
  enabled               boolean      NOT NULL DEFAULT true,
  -- PDF 里「允许自建文件夹」只标在特定叶节点上（不是整层默认开）
  allow_custom_folders  boolean      NOT NULL DEFAULT false,
  description           text,
  _created_at           timestamptz  NOT NULL DEFAULT now(),
  _updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT directories_type_check CHECK (type IN (
    'root', 'section', 'program', 'subject', 'sub_subject', 'folder',
    'growth_level', 'growth_node'
  )),
  -- 只有叶节点能开"允许自建文件夹"：根/班型/科目上开没有意义，且会让 UI 误判
  CONSTRAINT directories_custom_folders_leaf_only
    CHECK (allow_custom_folders = false OR type IN ('folder'))
);
CREATE INDEX IF NOT EXISTS directories_parent_idx ON directories(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS directories_lookup_idx ON directories(program, subject);

DO $$
DECLARE
  v_edu uuid;
  v_growth uuid;
  v_prek uuid;
  v_k uuid;
  v_subject uuid;
  v_subtopic uuid;
  s record;   -- 科目
  t record;   -- K 中文的子主题
  g record;   -- t 下面的资料夹（与 t 分开命名，避免遮蔽）
  f record;   -- 其它循环用的记录变量
BEGIN
  -- ---------- 根 ----------
  INSERT INTO directories (code, name, name_en, type, sort_order)
    VALUES ('root:edu', '教育教学', 'Teaching & Curriculum', 'root', 10) RETURNING id INTO v_edu;
  INSERT INTO directories (code, name, name_en, type, sort_order)
    VALUES ('root:growth', '教师成长', 'Teacher Growth', 'root', 20) RETURNING id INTO v_growth;

  -- ---------- 教育教学 → 班型 ----------
  INSERT INTO directories (parent_id, code, name, name_en, type, program, sort_order)
    VALUES (v_edu, 'prek', 'Pre-K', 'Pre-K', 'program', 'prek', 10) RETURNING id INTO v_prek;
  INSERT INTO directories (parent_id, code, name, name_en, type, program, sort_order)
    VALUES (v_edu, 'k', 'K', 'K', 'program', 'k', 20) RETURNING id INTO v_k;

  -- ---------- 统一的 4 个资料夹（PDF 里每个叶科都是这 4 个）----------
  -- 「允许自建文件夹」只落在 教学详案 / 教学资源 上，且只对 PDF 标注过的科目为真。
  FOR s IN
    SELECT * FROM (VALUES
      -- 班型, 目录码, 中文名, 英文名, 是否允许自建(教学详案/教学资源)
      ('prek', 'prek:virtue',      '美德',     'Virtue',             false),
      ('prek', 'prek:montessori',  '蒙特梭利', 'Montessori',         false),
      ('prek', 'prek:pe',          '体能',     'Physical Education', true),
      ('prek', 'prek:english',     '英文',     'English',            true),
      ('k',    'k:chinese',        '中文教学', 'Chinese',            true),
      ('k',    'k:english',        '英文教学', 'English',            true),
      ('k',    'k:pe',             '体能',     'Physical Education', true)
    ) AS t(program, code, name, name_en, custom)
  LOOP
    INSERT INTO directories (parent_id, code, name, name_en, type, program, subject, sort_order)
      VALUES (CASE WHEN s.program = 'prek' THEN v_prek ELSE v_k END,
              s.code, s.name, s.name_en, 'subject', s.program, s.code, 10)
      RETURNING id INTO v_subject;

    -- K 的中文教学在 PDF 里还有一层子科（绘本阅读/古诗/STEM/美育）
    IF s.code = 'k:chinese' THEN
      -- 注意：这里必须用**不同的**记录变量 —— 外层主题用 t、内层资料夹用 g。
      -- 第一版我两处都用 `f`，内层把外层遮蔽掉，`f.code` 于是指向资料夹记录（没有 code 列），
      -- 迁移直接报 `record "f" has no field "code"`。列名不同就没人会踩这个坑。
      FOR t IN SELECT * FROM (VALUES
        ('k:chinese:reading',  '绘本阅读', 'Picture Book Reading', 10),
        ('k:chinese:poetry',   '古诗',     'Classical Poetry',    20),
        ('k:chinese:stem',     'STEM',     'STEM',                30),
        ('k:chinese:arts',     '美育',     'Aesthetic Education', 40)
      ) AS x(code, name, name_en, sort)
      LOOP
        INSERT INTO directories (parent_id, code, name, name_en, type, program, subject, sort_order)
          VALUES (v_subject, t.code, t.name, t.name_en, 'sub_subject', s.program, t.code, t.sort)
          RETURNING id INTO v_subtopic;
        FOR g IN SELECT * FROM (VALUES
          ('outline',    '课程大纲', 'Curriculum Outline',    10, false),
          ('lesson',     '教学详案', 'Lesson Plans',          20, true),
          ('resource',   '教学资源', 'Teaching Resources',    30, true),
          ('assessment', '考核评估', 'Assessment',            40, false)
        ) AS x(suffix, name, name_en, sort, custom)
        LOOP
          INSERT INTO directories (parent_id, code, name, name_en, type, program, subject, sort_order, allow_custom_folders)
            VALUES (v_subtopic, t.code || '_' || g.suffix, g.name, g.name_en, 'folder',
                    s.program, t.code, g.sort, (g.custom AND s.custom));
        END LOOP;
      END LOOP;
    ELSE
      FOR f IN SELECT * FROM (VALUES
        ('outline',    '课程大纲', 'Curriculum Outline',    10, false),
        ('lesson',     '教学详案', 'Lesson Plans',          20, true),
        ('resource',   '教学资源', 'Teaching Resources',    30, true),
        ('assessment', '考核评估', 'Assessment',            40, false)
      ) AS x(suffix, name, name_en, sort, custom)
      LOOP
        INSERT INTO directories (parent_id, code, name, name_en, type, program, subject, sort_order, allow_custom_folders)
          VALUES (v_subject, s.code || '_' || f.suffix, f.name, f.name_en, 'folder',
                  s.program, s.code, f.sort, (f.custom AND s.custom));
      END LOOP;
    END IF;
  END LOOP;

  -- ---------- 教师成长（PDF 里的第二根；应用此前完全没有对应实现）----------
  FOR f IN SELECT * FROM (VALUES
    ('growth:l1', 'L1 基础规范', 'L1 Foundations',   10, true),
    ('growth:l2', 'L2 独立胜任', 'L2 Independent',   20, true),
    ('growth:l3', 'L3 卓越引领', 'L3 Leading',       30, true)
  ) AS x(code, name, name_en, sort, _unused)
  LOOP
    INSERT INTO directories (parent_id, code, name, name_en, type, sort_order)
      VALUES (v_growth, f.code, f.name, f.name_en, 'growth_level', f.sort);
  END LOOP;

  -- L1 的下级（PDF 逐字：职业道德规范→师风师德建设；安全施教规范→应急预案→两项）
  FOR f IN SELECT * FROM (VALUES
    ('growth:l1:ethics',  '职业道德规范', 'Professional Ethics',   10),
    ('growth:l1:safety',  '安全施教规范', 'Safe Teaching',         20),
    ('growth:l1:know',    '专业知识',     'Professional Knowledge',30),
    ('growth:l1:skill',   '专业技能',     'Professional Skills',   40)
  ) AS x(code, name, name_en, sort)
  LOOP
    INSERT INTO directories (parent_id, code, name, name_en, type, sort_order)
      SELECT id, f.code, f.name, f.name_en, 'growth_node', f.sort FROM directories WHERE code = 'growth:l1'
      RETURNING id INTO v_subtopic;
    IF f.code = 'growth:l1:ethics' THEN
      INSERT INTO directories (parent_id, code, name, name_en, type, sort_order)
        VALUES (v_subtopic, 'growth:l1:ethics:conduct', '师风师德建设', 'Teacher Conduct', 'growth_node', 10);
    ELSIF f.code = 'growth:l1:safety' THEN
      INSERT INTO directories (parent_id, code, name, name_en, type, sort_order)
        VALUES (v_subtopic, 'growth:l1:safety:plan', '应急预案', 'Emergency Plans', 'growth_node', 10)
        RETURNING id INTO v_subject;
      INSERT INTO directories (parent_id, code, name, name_en, type, sort_order) VALUES
        (v_subject, 'growth:l1:safety:plan:disease', '传染病识别与防治', 'Infectious Disease Prevention', 'growth_node', 10),
        (v_subject, 'growth:l1:safety:plan:injury',  '意外伤害预防与处置', 'Injury Prevention & Response', 'growth_node', 20);
    ELSIF f.code = 'growth:l1:skill' THEN
      INSERT INTO directories (parent_id, code, name, name_en, type, sort_order) VALUES
        (v_subtopic, 'growth:l1:skill:daily',    '一日生活规范', 'Daily Routine Standards', 'growth_node', 10),
        (v_subtopic, 'growth:l1:skill:connect',  '与幼儿建立连接', 'Building Connections',   'growth_node', 20),
        (v_subtopic, 'growth:l1:skill:play',     '游戏化教学',   'Play-based Teaching',     'growth_node', 30);
    END IF;
  END LOOP;
END $$;

-- 自检：必须出现的节点数量与"允许自建文件夹"的数量
DO $$
DECLARE
  v_total int; v_roots int; v_folders int; v_custom int; v_levels int;
BEGIN
  SELECT count(*) INTO v_total FROM directories;
  SELECT count(*) INTO v_roots FROM directories WHERE type = 'root';
  SELECT count(*) INTO v_folders FROM directories WHERE type = 'folder';
  SELECT count(*) INTO v_custom FROM directories WHERE allow_custom_folders;
  SELECT count(*) INTO v_levels FROM directories WHERE type = 'growth_level';

  RAISE NOTICE '0009: directories 共 % 个节点（root=% folders=% growth_level=%）', v_total, v_roots, v_folders, v_levels;
  RAISE NOTICE '0009: 允许自建文件夹的叶节点 = % 个（PDF 标注：8 个叶科的 教学详案+教学资源）', v_custom;

  IF v_roots <> 2 THEN RAISE EXCEPTION '0009: 期望 2 个根（教育教学/教师成长），实际 %', v_roots; END IF;
  IF v_levels <> 3 THEN RAISE EXCEPTION '0009: 期望 3 个成长层级，实际 %', v_levels; END IF;
  IF v_custom <> 16 THEN RAISE EXCEPTION '0009: 期望 16 个可自建文件夹的叶节点，实际 %', v_custom; END IF;
  IF v_folders <> 40 THEN RAISE EXCEPTION '0009: 期望 40 个资料夹叶节点，实际 %', v_folders; END IF;
END $$;
