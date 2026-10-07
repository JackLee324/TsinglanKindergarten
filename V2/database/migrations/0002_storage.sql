-- ============================================================================
-- 0002_storage.sql —— 阶段 6：上传票据 + 孤儿对象标记
-- ============================================================================
-- 阶段 2 的 0001 已经建好资源与文件（resource_files），阶段 6 只补两张表。
--
-- 为什么需要 upload_tickets（而不是"注册时带上全部字段"）：
--
--   浏览器的上传分两步：先申请上传地址，再 PUT，然后登记。如果登记时
--   由客户端把 fileName / size / sha256 再报一次，那服务端就有一个缺口 ——
--   它无法证明"报上来的 sha256"就是"上传时被存储层强制校验的那个 sha256"。
--   于是有人可以先申请一个 sha256=A 的地址、上传 A，然后登记时声称 sha256=B。
--
--   票据把这件事钉死：申请上传地址时就把 (size, sha256, mime, name, key)
--   写进数据库，并且**同样的值进了签名**（本地是 HMAC 令牌，S3 是已签名头）。
--   登记时只认票据 id，客户端没有任何字段可以"再声明一次"。
--
-- 为什么需要 storage_orphans（业主 §29）：
--
--   真实会发生的情况：PUT 成功了，但登记失败（哈希不符、票据过期、进程重启、
--   用户关掉页面）。对象就在桶里，而数据库里没有它 —— 一个不可追踪的孤儿。
--   本阶段不引入任务系统（业主明确不要），所以**至少留下 marker**：
--   记录 key + 原因，交给 scripts/cleanup-orphans.mjs 处理。
--
-- 本文件在**阶段 6 内部**还可能被修改（它还没有发布到任何环境）；
-- 阶段 6 收口之后它就和 0001 一样"一旦应用即永不修改"，由 scripts/migrate.mjs 做 SHA-256 校验。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. upload_tickets —— 一次上传的票据（服务端记住了客户端声明的全部元数据）
-- ---------------------------------------------------------------------------
CREATE TABLE upload_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  -- 谁申请的就只能谁登记：否则 A 可以拿 B 的上传地址去登记。
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 对象 key 在申请时就定下来（`resources/{resourceId}/{uuid}-{safeName}`），
  -- 登记时不再接受客户端传 key —— 猜 key、换 key 都没有入口。
  storage_key  text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size         bigint NOT NULL,
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 票据的有效期与上传地址的有效期一致；过期后不再允许登记。
  expires_at   timestamptz NOT NULL,
  consumed_file_id uuid REFERENCES resource_files (id) ON DELETE SET NULL,
  consumed_at  timestamptz,
  CONSTRAINT upload_tickets_size_positive CHECK (size > 0),
  CONSTRAINT upload_tickets_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT upload_tickets_name_not_blank CHECK (btrim(file_name) <> ''),
  -- 一张票据只能被用掉一次。
  --
  -- ⚠️ 这个约束**不能**要求"consumed_at 与 consumed_file_id 同时为空或同时有值"。
  -- 第一版就是那么写的，结果：删掉一个文件时 `consumed_file_id` 被
  -- ON DELETE SET NULL 置空，而 consumed_at 还在 → 直接违反约束，
  -- 删除接口 500。这个 bug 是集成测试跑出来的（"删除后对象真的消失了"）。
  --
  -- 约束真正要保证的只有一件事：**不能指向一个文件却没标记成已消费**。
  -- 反过来（已消费、但文件后来被删了）是完全合法的历史状态 ——
  -- 票据记录的是"这次上传发生过"，不是"文件现在还在"。
  CONSTRAINT upload_tickets_consumed_pair CHECK (
    consumed_at IS NOT NULL OR consumed_file_id IS NULL
  )
);

-- 一个对象 key 只允许一张票据：防止同一个 key 被两次登记成不同文件。
CREATE UNIQUE INDEX upload_tickets_storage_key_key ON upload_tickets (storage_key);
CREATE INDEX upload_tickets_resource_idx ON upload_tickets (resource_id, created_at DESC);
-- 清理过期未使用的票据时用。
CREATE INDEX upload_tickets_open_idx ON upload_tickets (expires_at) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. storage_orphans —— 上传成功但没能登记的对象的清理标记（§29）
-- ---------------------------------------------------------------------------
CREATE TABLE storage_orphans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key  text NOT NULL,
  -- 资源可能随后被删掉，所以这里用 SET NULL，marker 本身要留住。
  resource_id  uuid REFERENCES resources (id) ON DELETE SET NULL,
  -- 机器可读的原因：HASH_MISMATCH / SIZE_MISMATCH / TICKET_EXPIRED /
  -- TICKET_UNUSED / REGISTER_FAILED / SWEEP_UNREGISTERED
  reason       text NOT NULL,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  cleaned_at   timestamptz
);

-- 同一个 key 在没有清理掉之前只留一条待处理记录（重复登记失败不该堆积）。
CREATE UNIQUE INDEX storage_orphans_pending_key
  ON storage_orphans (storage_key) WHERE cleaned_at IS NULL;
CREATE INDEX storage_orphans_pending_idx ON storage_orphans (created_at) WHERE cleaned_at IS NULL;
