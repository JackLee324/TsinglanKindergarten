-- =============================================================================
-- V2 0001_init.sql —— 初始 schema（8 张表）
-- =============================================================================
-- 设计说明见 V2/DATA_MODEL.md。这里是**唯一**的 schema 权威。
--
-- 与 V1 的关键差别（V1 有 13 张表）：
--   · 没有 subject_permissions / account_permission_overrides / account_scopes
--     —— 权限只有 user_permissions 一张表，一个可空外键表达目录范围。
--   · 没有 teacher_mfa / mfa_recovery_codes / mfa_challenges（业主：不做 MFA）
--   · resources 没有 folder_type / program / subject / sub_subject /
--     semester / week_number / theme，也没有内联的文件列 —— 文件在 resource_files。
--   · users 与 sessions 上**没有** permissions_version（业主明确不要这个概念）。
--
-- 这个文件一旦被应用就**永不修改**；由 scripts/migrate.mjs 做 SHA-256 校验。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text NOT NULL,
  name        text NOT NULL,
  name_en     text,
  password_hash text NOT NULL,
  role        text NOT NULL DEFAULT 'TEACHER',
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check   CHECK (role IN ('ADMIN', 'TEACHER')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'inactive')),
  -- 用户名不允许为空、不允许全空白：V1 里出现过 username IS NULL 的残留主账号，
  -- 那种行既不能登录、又挂着历史资源，只能靠人工处理。
  CONSTRAINT users_username_not_blank CHECK (btrim(username) <> ''),
  CONSTRAINT users_name_not_blank     CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE INDEX users_status_idx ON users (status);

-- ---------------------------------------------------------------------------
-- 2. directories —— V2 唯一的导航/分类真相（通用树）
-- ---------------------------------------------------------------------------
CREATE TABLE directories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id            uuid REFERENCES directories (id) ON DELETE RESTRICT,
  slug                 text NOT NULL,
  name                 text NOT NULL,
  name_en              text,
  description          text,
  type                 text NOT NULL DEFAULT 'SECTION',
  sort_order           integer NOT NULL DEFAULT 0,
  enabled              boolean NOT NULL DEFAULT true,
  allow_children       boolean NOT NULL DEFAULT true,
  allow_files          boolean NOT NULL DEFAULT false,
  allow_custom_folders boolean NOT NULL DEFAULT false,
  icon                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directories_type_check  CHECK (type IN ('ROOT', 'CATEGORY', 'SECTION', 'FOLDER')),
  CONSTRAINT directories_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT directories_name_not_blank CHECK (btrim(name) <> ''),
  -- 不能把自己当父节点
  CONSTRAINT directories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

-- slug 在同一父节点下唯一（根节点用全零 uuid 代替 NULL 参与唯一性）
CREATE UNIQUE INDEX directories_sibling_slug_key
  ON directories (
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slug
  );
CREATE INDEX directories_parent_idx  ON directories (parent_id, sort_order, name);
CREATE INDEX directories_enabled_idx ON directories (enabled);

-- ---------------------------------------------------------------------------
-- 3. user_permissions —— V2 **唯一**的授权真相
-- ---------------------------------------------------------------------------
-- 语义：`directory_id IS NULL` = 全平台；否则 = 该节点**及其整棵子树**。
-- 契约里有意识地不存在的列：deny、grant、override、scope_kind、program、subject。
CREATE TABLE user_permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission   text NOT NULL,
  directory_id uuid REFERENCES directories (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT user_permissions_permission_not_blank CHECK (btrim(permission) <> '')
);

CREATE UNIQUE INDEX user_permissions_uniq
  ON user_permissions (
    user_id,
    permission,
    COALESCE(directory_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX user_permissions_user_idx ON user_permissions (user_id);
CREATE INDEX user_permissions_dir_idx  ON user_permissions (directory_id);

-- ---------------------------------------------------------------------------
-- 4. resources
-- ---------------------------------------------------------------------------
CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  directory_id uuid NOT NULL REFERENCES directories (id) ON DELETE RESTRICT,
  title        text NOT NULL,
  title_en     text,
  description  text,
  status       text NOT NULL DEFAULT 'DRAFT',
  version      integer NOT NULL DEFAULT 1,
  uploader_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_status_check CHECK (
    status IN ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'RECALLED')
  ),
  CONSTRAINT resources_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT resources_version_positive CHECK (version >= 1)
);

CREATE INDEX resources_directory_idx ON resources (directory_id) WHERE deleted_at IS NULL;
CREATE INDEX resources_uploader_idx  ON resources (uploader_id, status) WHERE deleted_at IS NULL;
CREATE INDEX resources_status_idx    ON resources (status) WHERE deleted_at IS NULL;
CREATE INDEX resources_active_idx    ON resources (updated_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. resource_files —— 一个资源 0..n 个文件
-- ---------------------------------------------------------------------------
CREATE TABLE resource_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  storage_key text NOT NULL,
  mime_type   text NOT NULL,
  size        bigint NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT resource_files_size_non_negative CHECK (size >= 0),
  CONSTRAINT resource_files_name_not_blank CHECK (btrim(file_name) <> ''),
  CONSTRAINT resource_files_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX resource_files_storage_key_key ON resource_files (storage_key);
CREATE INDEX resource_files_resource_idx ON resource_files (resource_id, created_at);

-- ---------------------------------------------------------------------------
-- 6. resource_reviews —— 审核流水（含 from/to，能渲染完整时间线）
-- ---------------------------------------------------------------------------
CREATE TABLE resource_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  action      text NOT NULL,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_reviews_action_check CHECK (
    action IN ('submit', 'review.approve', 'review.reject', 'review.recall')
  ),
  CONSTRAINT resource_reviews_from_check CHECK (
    from_status IN ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'RECALLED')
  ),
  CONSTRAINT resource_reviews_to_check CHECK (
    to_status IN ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'RECALLED')
  ),
  -- 退回必须带原因（业主：教师必须能看到退回原因）
  CONSTRAINT resource_reviews_reject_needs_comment CHECK (
    action <> 'review.reject' OR (comment IS NOT NULL AND btrim(comment) <> '')
  )
);

CREATE INDEX resource_reviews_resource_idx ON resource_reviews (resource_id, created_at);

-- ---------------------------------------------------------------------------
-- 7. audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- 冗余保存：账号被删（SET NULL）之后审计仍然读得出"当时是谁"
  actor_name  text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  result      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_result_check CHECK (result IN ('success', 'denied', 'failed')),
  CONSTRAINT audit_logs_target_type_check CHECK (
    target_type IN ('user', 'directory', 'resource', 'file', 'session', 'system')
  )
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx  ON audit_logs (target_type, target_id);

-- ---------------------------------------------------------------------------
-- 8. sessions
-- ---------------------------------------------------------------------------
-- 只存 token 的 sha256；**没有 permissions_version 列** ——
-- 权限变更时直接把这些会话置 revoked_at，效果一样而无须引入版本号概念。
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  ip         text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx   ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
