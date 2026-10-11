-- ---------------------------------------------------------------------------
-- 0005_ai.sql —— AI 助手与知识索引（业主 Stage 15）
-- ---------------------------------------------------------------------------
-- 三条硬约束（业主 Stage 15 §二）：
--   1. **只新增**：不改 `resources` / `resource_files` / `upload_tickets` /
--      `storage_orphans` 任何一列，也不动它们的约束与索引；
--   2. AI 索引与原始文件**分开**：这里存的是**文本片段**，不是文件本体，
--      也不存对象存储的 key —— 文件在哪、叫什么、多大、哈希是多少，
--      永远由 `resource_files` + 存储层说了算（索引只记 file_id 引用）；
--   3. 索引**不是权限事实源**：`ai_chunks` 里没有"谁能看"的任何字段，
--      检索时一律回到 `resources` / `directories` / `user_permissions` 现算。
--
-- 为什么把"幂等"做进数据库：业主 §五 要求"同一文件重复入队时必须幂等，
-- 不得反复生成相同内容或无限增加索引记录"。所以：
--   · `ai_chunks` 用 UNIQUE NULLS NOT DISTINCT (来源键, chunk_index) 去重；
--   · `ai_index_jobs` 对"同一目标 + 未结束状态"只允许一条（部分唯一索引）。
-- PG15+ 的 `NULLS NOT DISTINCT` 正好解决"resource_id 为空时唯一性失效"这个老问题
-- （唯一索引默认把 NULL 当作互不相同，于是同一文件的元数据片段会被重复插入）。
-- ---------------------------------------------------------------------------

-- trigram 索引用于中文片段检索（生产库实测只有 pg_trgm / unaccent 可用，
-- **没有 pgvector** —— 见 docs/STAGE15_AI_DESIGN.md §检索）。
-- 这是 PostgreSQL 官方自带扩展，不引入任何外部服务依赖。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 文本片段（索引的产物）──────────────────────────────────────────────────
CREATE TABLE ai_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 来源指向：资源元数据只有 resource_id；文件正文/OCR 还带 file_id。
  resource_id   uuid REFERENCES resources (id) ON DELETE CASCADE,
  file_id       uuid REFERENCES resource_files (id) ON DELETE CASCADE,
  -- 目录快照：只为**检索排序**方便（按目录聚合），权限判定不使用它。
  directory_id  uuid REFERENCES directories (id) ON DELETE CASCADE,
  source_kind   text NOT NULL,
  chunk_index   int  NOT NULL,
  text          text NOT NULL,
  -- 生成该片段时的来源指纹：文件用 sha256，元数据用内容哈希。
  -- 来源变了 → 指纹变了 → 旧片段可被识别并置为 STALE（业主 §五 增量重索引）。
  source_sha256 text,
  status        text NOT NULL DEFAULT 'READY',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_chunks_source_kind_check CHECK (
    source_kind IN ('RESOURCE_META', 'DIRECTORY_META', 'FILE_TEXT', 'FILE_OCR', 'SITE_RULE')
  ),
  CONSTRAINT ai_chunks_status_check CHECK (status IN ('READY', 'STALE')),
  CONSTRAINT ai_chunks_chunk_index_check CHECK (chunk_index >= 0),
  CONSTRAINT ai_chunks_text_not_blank CHECK (btrim(text) <> ''),
  -- 幂等：同一来源的同一下标只能有一条（NULL 也参与判等，见文件头注释）
  CONSTRAINT ai_chunks_source_unique UNIQUE NULLS NOT DISTINCT
    (source_kind, resource_id, file_id, chunk_index)
);

CREATE INDEX ai_chunks_resource_idx  ON ai_chunks (resource_id);
CREATE INDEX ai_chunks_file_idx      ON ai_chunks (file_id);
CREATE INDEX ai_chunks_directory_idx ON ai_chunks (directory_id);
-- 检索用：中文走 trigram 相似度，英文走 simple 全文（生产库没有 pgvector）
CREATE INDEX ai_chunks_text_trgm_idx ON ai_chunks USING gin (text gin_trgm_ops);
CREATE INDEX ai_chunks_text_fts_idx  ON ai_chunks USING gin (to_tsvector('simple', text));

-- ── 索引任务队列（异步、可重试、幂等）──────────────────────────────────────
CREATE TABLE ai_index_jobs (
  id              bigserial PRIMARY KEY,
  resource_id     uuid REFERENCES resources (id) ON DELETE CASCADE,
  file_id         uuid REFERENCES resource_files (id) ON DELETE CASCADE,
  -- 为什么入队：上传后 / 资源更新 / 手动重索引 / 存量回填
  reason          text NOT NULL,
  state           text NOT NULL DEFAULT 'PENDING',
  attempts        int  NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_index_jobs_reason_check CHECK (reason IN ('UPLOADED', 'UPDATED', 'MANUAL', 'BACKFILL')),
  CONSTRAINT ai_index_jobs_state_check  CHECK (state IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
  CONSTRAINT ai_index_jobs_attempts_check CHECK (attempts >= 0)
);

-- 每个目标只允许一条"没结束"的任务：重复入队 = 幂等（不会无限堆任务）
CREATE UNIQUE INDEX ai_index_jobs_active_unique
  ON ai_index_jobs (COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(file_id,     '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state IN ('PENDING', 'RUNNING');

-- 取任务用：按可执行时间排队
CREATE INDEX ai_index_jobs_due_idx ON ai_index_jobs (state, next_attempt_at);

-- ── 对话与消息（按用户隔离；AI 不冒充他人、也不能被他人读到）────────────────
CREATE TABLE ai_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  -- 引用来源：只存"当时检索到的"资源/文件 id 与标题快照；
  -- **展示前必须重新核验当前权限**（业主 §六.8）。
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  model           text,
  input_tokens    int,
  output_tokens   int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT ai_messages_content_not_blank CHECK (btrim(content) <> '')
);

CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);

-- ── 用量与异常（业主 §四.7：成本统计与异常监控，防止循环请求烧钱）────────────
CREATE TABLE ai_usage_events (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  kind          text NOT NULL,
  model         text,
  input_tokens  int,
  output_tokens int,
  latency_ms    int,
  outcome       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_events_kind_check    CHECK (kind IN ('CHAT', 'OCR', 'EMBED')),
  CONSTRAINT ai_usage_events_outcome_check CHECK (outcome IN ('ok', 'timeout', 'rate_limited', 'auth_error', 'provider_error', 'disabled', 'cancelled'))
);

CREATE INDEX ai_usage_events_created_idx ON ai_usage_events (created_at DESC);
CREATE INDEX ai_usage_events_user_idx    ON ai_usage_events (user_id, created_at DESC);
