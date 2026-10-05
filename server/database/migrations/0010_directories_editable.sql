-- =============================================================================
-- 0010 — directories 可编辑化：区分「PDF 权威结构」与「管理员自建」
-- =============================================================================
-- WHY
--   0009 把 PDF《教师平台》的目录树落成了数据（69 个节点）。接下来要让它
--   **可编辑**（PDF 明确要求部分叶节点「允许自建文件夹」）。但"可编辑"如果
--   不加限制，就等于"可以把 PDF 的权威结构删掉"—— 而那棵树是 §1 的验收基准。
--
--   所以需要一条**数据层面**的界线，而不是只靠服务层判断：
--     * `is_system = true`  → 来自 PDF 的权威节点。**不允许删除**。
--     * `is_system = false` → 管理员自建。可改名、可删除（无子节点时）。
--
--   用数据库列而不是"看 code 里有没有某段字符串"来区分，是因为后者
--   一旦有人按新的 code 规则建节点就会静默判定错误 —— 权限相关的判断
--   不应该依赖字符串启发式。
--
-- 为什么允许改**系统节点的名字**但默认不做：改名会让界面显示与 PDF 不一致，
--   而 PDF 是验收基准。所以服务层只允许改自建节点；系统节点要改先改 PDF 再改种子。
--
-- THIS MIGRATION IS ADDITIVE ONLY
--   只加两列 + 一个唯一索引 + 两条 CHECK；不改任何既有行的语义
--   （69 行全部标成 is_system = true，与它们"来自种子"的事实一致）。
--   同样一行 `resources` 都不动。
-- =============================================================================

ALTER TABLE directories
  ADD COLUMN IF NOT EXISTS is_system  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by uuid;

COMMENT ON COLUMN directories.is_system IS
  'PDF《教师平台》权威节点（不可删除）。管理员自建节点为 false。';
COMMENT ON COLUMN directories.created_by IS
  '自建节点的创建者。系统节点必须为 NULL。';

-- 自建节点必须有创建者；系统节点必须没有。
-- 这条约束让「这是谁建的」无法被伪造，也让"自建"与"系统"不能同时为真。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'directories_created_by_pairing'
  ) THEN
    ALTER TABLE directories
      ADD CONSTRAINT directories_created_by_pairing
      CHECK ((is_system = true AND created_by IS NULL)
          OR (is_system = false AND created_by IS NOT NULL));
  END IF;
END $$;

-- 只有 folder 类型的节点可以是"自建"。
-- 理由：允许自建文件夹（PDF 的 `allowCustomFolders`）只标在资料夹上；
-- 若有人把班型/科目标成自建，那意味着"管理员可以删掉 K 班型" —— 不是产品意图。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'directories_user_node_is_folder'
  ) THEN
    ALTER TABLE directories
      ADD CONSTRAINT directories_user_node_is_folder
      CHECK (is_system = true OR type = 'folder');
  END IF;
END $$;

-- 同层不允许重名。加之前已实测 69 个节点无冲突（见提交信息）。
-- 用 lower(name) 而不是 name：中文没有大小写，但自建文件夹名可能含英文，
-- 「Art」和「art」是同一个名字，不该并存。
-- 注意：parent_id IS NULL 的根节点不受唯一索引约束（PostgreSQL 里 NULL 互不相等），
-- 而根节点只有两个、由种子固定，不需要约束。
CREATE UNIQUE INDEX IF NOT EXISTS directories_sibling_name_key
  ON directories (parent_id, lower(name))
  WHERE parent_id IS NOT NULL;

-- 自检：既有 69 行必须全部是系统节点，且没有自建节点残留。
DO $$
DECLARE
  v_total int; v_system int; v_user int;
BEGIN
  SELECT count(*) INTO v_total  FROM directories;
  SELECT count(*) INTO v_system FROM directories WHERE is_system;
  SELECT count(*) INTO v_user   FROM directories WHERE NOT is_system;

  RAISE NOTICE '0010: directories 共 % 个节点（系统 % / 自建 %）', v_total, v_system, v_user;

  IF v_total <> 69 THEN
    RAISE EXCEPTION '0010: 期望 69 个节点（0009 的种子），实际 %', v_total;
  END IF;
  IF v_user <> 0 THEN
    RAISE EXCEPTION '0010: 期望既有节点全部标记为系统节点，实际有 % 个自建节点', v_user;
  END IF;
END $$;
