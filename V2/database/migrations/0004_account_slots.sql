-- ---------------------------------------------------------------------------
-- 0004_account_slots —— 教师账号**名额**（业主 Stage 14A §2）
-- ---------------------------------------------------------------------------
-- 为什么要"名额"和"账号"分开：
--   学校有固定的岗位编制（5 个 K 班 + 8 个 Pre-K 班，每班中/外方主班 + 助教 = 39 个），
--   但真实姓名、登录名、口令要等管理员拿到花名册才能填。
--   如果初始化时就直接建 39 个能登录的账号，等于凭空造出 39 个**未知人员**的入口。
--   所以：名额先建好（UNASSIGNED），**绑定了真实人员并启用之后**才成为可登录账号。
--
-- 状态机：
--   UNASSIGNED    名额已生成，尚未绑定真实人员 —— **不能登录、没有口令、没有任何授权**
--   PENDING_SETUP 管理员已填资料，等待完成账号配置 —— 仍不能登录
--   ACTIVE        已绑定并在 users 表里创建了账号（按岗位授权）
--   DISABLED      停用（账号会话应被立即撤销）
-- ---------------------------------------------------------------------------

CREATE TABLE teacher_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 内部编号：K-01 / K-01-F / K-01-A / PK-01 …（见 scripts/report-teacher-slots.mjs 的 SLOT_SPEC）
  code          text NOT NULL,
  track         text NOT NULL,                       -- K | PREK
  class_no      text NOT NULL,                       -- 班级位（K-01 / PK-03），可改名
  class_label   text,                                -- 真实班级名（如「K1 班」），管理员填
  position      text NOT NULL,                       -- LEAD_CN | LEAD_INTL | ASSISTANT
  status        text NOT NULL DEFAULT 'UNASSIGNED',
  -- 绑定关系只存这一列（不双向存，避免两处真相打架）
  bound_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT teacher_slots_code_unique    UNIQUE (code),
  CONSTRAINT teacher_slots_track_check    CHECK (track IN ('K', 'PREK')),
  CONSTRAINT teacher_slots_position_check CHECK (position IN ('LEAD_CN', 'LEAD_INTL', 'ASSISTANT')),
  CONSTRAINT teacher_slots_status_check   CHECK (status IN ('UNASSIGNED', 'PENDING_SETUP', 'ACTIVE', 'DISABLED')),
  -- 只有 ACTIVE 才允许挂着账号：防止"没启用却已经能登录"这种状态组合
  CONSTRAINT teacher_slots_active_needs_user CHECK (status <> 'ACTIVE' OR bound_user_id IS NOT NULL)
);

-- 一个账号只能占一个名额（并发下由唯一索引保证，不靠应用层判断）
CREATE UNIQUE INDEX teacher_slots_bound_user_unique
  ON teacher_slots (bound_user_id) WHERE bound_user_id IS NOT NULL;

CREATE INDEX teacher_slots_status_idx ON teacher_slots (status, track, position);
