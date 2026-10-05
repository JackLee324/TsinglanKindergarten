-- =============================================================================
-- 0011 — resource_versions：资源版本生命周期的落库（§15）
-- =============================================================================
-- WHY
--   `resources.version` 这一列一直存在，界面上也一直显示"版本 v1" —— 但**从来没有人
--   写过它**：既没有自增逻辑，也没有任何地方记录"上一版长什么样"。实测：迁移前
--   348 行的 version 全部等于 1，也就是说那个数字是装饰，不是事实。
--
--   这一轮把它变成事实：
--     * `resource_versions` 每次内容变化追加一行（不可变历史）；
--     * `resources.version` 指向最新版本号；
--     * 读接口 `GET /api/resources/:id/versions` 提供历史。
--
-- 为什么快照整行而不是只存差异
--   · 一行资源的所有可编辑字段加起来不过几百字节，348 行量级下存全量毫无压力；
--   · 差异存法要写 diff/apply 两侧逻辑，任何一侧写错都会让历史"看起来对、回放不对"；
--   · 版本历史的价值在于**可回放与可举证**，为此多存一点字节是划算的。
--
-- WHY A TABLE AND NOT JUST THE AUDIT LOG
--   `audit_logs` 是全局流水，按人/按动作检索；版本历史是按**资源**检索
--   （"这个文件被改过几次、每一版是什么"）。两者查询形态不同，且审计日志的 detail
--   是自由文本（`文件登记通过：name=…`），不是结构化字段，无法用于回放。
--
-- BACKFILL
--   迁移同时为**每一个现存资源**写入 version=1 的快照，并把 change_kind 标为
--   'backfilled'。这样历史是完整的：任何一行都能查到"它的第 1 版是什么"，
--   而不是只有被改过的行才有历史。
--
-- ADDITIVE ONLY
--   只新增一张表 + 回填快照；`resources` 表**一列都不加、一行都不改**
--   （`resources.version` 本来就都是 1，与回填出的第 1 版一致，无需改写）。
-- =============================================================================

CREATE TABLE IF NOT EXISTS resource_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id     uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  version         integer NOT NULL,

  -- 快照字段：与 resources 上可编辑的列一一对应
  title           varchar(255) NOT NULL,
  title_en        varchar(255),
  description     text,
  folder_type     varchar(30) NOT NULL,
  semester        varchar(10),
  week_number     integer,
  theme           varchar(100),
  file_bucket_id  varchar(100),
  file_path       varchar(500),
  file_name       varchar(255),
  file_size       bigint,
  file_type       varchar(50),
  status          varchar(20) NOT NULL,

  -- 这一版是**因为什么**产生的
  change_kind     varchar(24) NOT NULL,
  changed_by      uuid NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resource_versions_kind_check CHECK (change_kind IN (
    'backfilled',        -- 迁移回填：这一版来自迁移前的既有数据
    'created',           -- 创建
    'metadata_edited',   -- 标题/说明/学期/周次/主题等被改
    'file_attached',     -- 附加或替换了文件
    'status_changed'     -- 审批状态变化（draft → pending_review → published …）
  )),
  CONSTRAINT resource_versions_unique UNIQUE (resource_id, version)
);

-- "这个资源的历次版本，新的在前" —— 读接口唯一的访问形态
CREATE INDEX IF NOT EXISTS resource_versions_resource_idx
  ON resource_versions (resource_id, version DESC);

COMMENT ON TABLE resource_versions IS
  '资源版本快照（§15）。每次内容变化追加一行，不可变；resources.version 指向最新版本。';

-- -----------------------------------------------------------------------------
-- 回填：为每个现存资源写入 version=1 的快照
-- -----------------------------------------------------------------------------
INSERT INTO resource_versions (
  resource_id, version, title, title_en, description, folder_type,
  semester, week_number, theme, file_bucket_id, file_path, file_name,
  file_size, file_type, status, change_kind, changed_by, changed_at
)
SELECT
  r.id, 1, r.title, r.title_en, r.description, r.folder_type,
  r.semester, r.week_number, r.theme, r.file_bucket_id, r.file_path, r.file_name,
  r.file_size, r.file_type, r.status,
  -- 已删除的资源：它的第 1 版仍然存在过，回填时如实标记它的状态即可。
  -- 这里刻意**不**跳过回收站中的行 —— 跳过会让"历史完整"变成"大部分行有历史"。
  'backfilled', r.uploader_id,
  COALESCE(r._created_at, now())
FROM resources r
WHERE NOT EXISTS (
  SELECT 1 FROM resource_versions v WHERE v.resource_id = r.id AND v.version = 1
);

-- -----------------------------------------------------------------------------
-- 自检：回填必须覆盖**每一个**资源，且版本号与 resources.version 一致
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_resources int;
  v_missing   int;
  v_versions  int;
  v_mismatch  int;
BEGIN
  SELECT count(*) INTO v_resources FROM resources;
  SELECT count(*) INTO v_missing
    FROM resources r
   WHERE NOT EXISTS (SELECT 1 FROM resource_versions v WHERE v.resource_id = r.id);
  SELECT count(*) INTO v_versions FROM resource_versions;
  SELECT count(*) INTO v_mismatch
    FROM resources r
    JOIN (SELECT resource_id, max(version) AS latest FROM resource_versions GROUP BY resource_id) m
      ON m.resource_id = r.id
   WHERE m.latest <> r.version;

  RAISE NOTICE '0011: resources=% 回填版本行=% 未覆盖=% 版本号不一致=%',
    v_resources, v_versions, v_missing, v_mismatch;

  IF v_missing <> 0 THEN
    RAISE EXCEPTION '0011: 有 % 个资源没有被回填版本快照', v_missing;
  END IF;
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION '0011: 有 % 个资源的 resources.version 与最新快照版本号不一致', v_mismatch;
  END IF;
END $$;
