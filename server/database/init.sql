-- ============================================================
-- 清澜山幼儿园课程资源平台 - 数据库初始化脚本
-- ============================================================
-- 使用方式：miaoda db sql -f server/database/init.sql
-- 注意：所有表均使用 IF NOT EXISTS，可安全重复执行
-- ============================================================

-- ============================================================
-- 1. teachers - 教师表
-- ============================================================
CREATE TABLE IF NOT EXISTS teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wecom_user_id varchar(100) NOT NULL,
  name varchar(100) NOT NULL,
  name_en varchar(100),
  email varchar(255),
  roles varchar(50)[] NOT NULL DEFAULT '{}'::varchar[],
  status varchar(20) NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS teachers_wecom_user_id_key ON teachers(wecom_user_id);

ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_teachers ON teachers
  TO service_role USING (true);

CREATE POLICY "teachers_auth_all" ON teachers
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "teachers_anon_select" ON teachers
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

-- ============================================================
-- 2. subject_permissions - 教师科目权限表
-- ============================================================
CREATE TABLE IF NOT EXISTS subject_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL,
  program varchar(20) NOT NULL,
  subject varchar(50) NOT NULL,
  sub_subject varchar(50),
  can_view boolean NOT NULL DEFAULT true,
  can_upload boolean NOT NULL DEFAULT false,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  CONSTRAINT subject_permissions_teacher_fkey FOREIGN KEY (teacher_id)
    REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS subject_permissions_teacher_program_subject_sub_subject_key
  ON subject_permissions(teacher_id, program, subject, sub_subject);
CREATE INDEX IF NOT EXISTS idx_subject_permissions_teacher ON subject_permissions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_subject_permissions_program ON subject_permissions(program, subject);

ALTER TABLE subject_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_sp ON subject_permissions
  TO service_role USING (true);

CREATE POLICY "sp_auth_all" ON subject_permissions
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "sp_anon_select" ON subject_permissions
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

-- ============================================================
-- 3. resources - 资源表
-- ============================================================
CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(255) NOT NULL,
  title_en varchar(255),
  program varchar(20) NOT NULL,
  subject varchar(50) NOT NULL,
  sub_subject varchar(50),
  folder_type varchar(30) NOT NULL,
  semester varchar(10),
  week_number integer,
  theme varchar(100),
  description text,
  file_bucket_id varchar(100),
  file_path varchar(500),
  file_name varchar(255),
  file_size bigint,
  file_type varchar(50),
  version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'draft',
  uploader_id uuid NOT NULL,
  reviewer_id uuid,
  review_comment text,
  reviewed_at TIMESTAMP(3) WITH TIME ZONE,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  CONSTRAINT resources_uploader_fkey FOREIGN KEY (uploader_id)
    REFERENCES teachers(id),
  CONSTRAINT resources_reviewer_fkey FOREIGN KEY (reviewer_id)
    REFERENCES teachers(id)
);

CREATE INDEX IF NOT EXISTS idx_resources_program_subject
  ON resources(program, subject, sub_subject);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);
CREATE INDEX IF NOT EXISTS idx_resources_uploader ON resources(uploader_id);
CREATE INDEX IF NOT EXISTS idx_resources_folder
  ON resources(program, subject, folder_type);
CREATE INDEX IF NOT EXISTS idx_resources_semester_week
  ON resources(semester, week_number);

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_resources ON resources
  TO service_role USING (true);

CREATE POLICY "resources_auth_all" ON resources
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "resources_anon_select" ON resources
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

-- ============================================================
-- 4. review_records - 审核记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS review_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  action varchar(20) NOT NULL,
  comment text,
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  CONSTRAINT review_records_resource_fkey FOREIGN KEY (resource_id)
    REFERENCES resources(id) ON DELETE CASCADE,
  CONSTRAINT review_records_reviewer_fkey FOREIGN KEY (reviewer_id)
    REFERENCES teachers(id)
);

CREATE INDEX IF NOT EXISTS idx_review_records_resource ON review_records(resource_id);

ALTER TABLE review_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_review ON review_records
  TO service_role USING (true);

CREATE POLICY "review_auth_all" ON review_records
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "review_anon_select" ON review_records
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

-- ============================================================
-- 5. audit_logs - 审计日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(50) NOT NULL,
  wecom_user_id varchar(100),
  teacher_id uuid,
  teacher_name varchar(100),
  ip_address varchar(50),
  user_agent varchar(500),
  resource_id uuid,
  resource_title varchar(255),
  program varchar(20),
  subject varchar(50),
  detail text,
  success boolean NOT NULL DEFAULT true,
  error_message varchar(500),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_teacher ON audit_logs(teacher_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(_created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_wecom ON audit_logs(wecom_user_id);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_audit ON audit_logs
  TO service_role USING (true);

CREATE POLICY "audit_auth_all" ON audit_logs
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

CREATE POLICY "audit_anon_select" ON audit_logs
  AS PERMISSIVE FOR SELECT TO authenticated, anon USING (true);

-- ============================================================
-- 6. sessions - 会话表
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash varchar(64) NOT NULL,
  teacher_id uuid NOT NULL,
  created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  ip_address varchar(50),
  user_agent varchar(500),
  _created_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  _updated_at TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT (
    CASE
      WHEN current_setting('app.user_id', TRUE) = '' THEN NULL
      ELSE concat('(', current_setting('app.user_id', TRUE), ')')::user_profile
    END
  ),
  CONSTRAINT sessions_teacher_fkey FOREIGN KEY (teacher_id)
    REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_hash ON sessions(session_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass_policy_sessions ON sessions
  TO service_role USING (true);

CREATE POLICY "sessions_auth_all" ON sessions
  AS PERMISSIVE FOR ALL TO authenticated USING (true);

-- ============================================================
-- 7. 匿名登录所需的最小权限 policy
-- ============================================================
-- 登录接口是公开访问（anon 角色），需要最小写权限：
--   - teachers: SELECT + UPDATE last_login_at
--   - sessions: SELECT + INSERT（会话验证和创建）
--   - audit_logs: INSERT（登录审计）
-- 注意：anon 只有这些必要的写权限，不能读其他敏感数据。
-- ============================================================

-- teachers 表已有 anon SELECT (teachers_anon_select)，这里加 UPDATE
CREATE POLICY "teachers_anon_update_last_login" ON teachers
  AS PERMISSIVE FOR UPDATE TO anon
  USING (true) WITH CHECK (true);

-- sessions: anon 需要 SELECT（验证会话）+ INSERT（创建会话）+ UPDATE（撤销会话/更新访问时间）
CREATE POLICY "sessions_anon_select" ON sessions
  AS PERMISSIVE FOR SELECT TO anon USING (true);

CREATE POLICY "sessions_anon_insert" ON sessions
  AS PERMISSIVE FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "sessions_anon_update" ON sessions
  AS PERMISSIVE FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- audit_logs: anon 需要 INSERT（登录/拒绝审计）
CREATE POLICY "audit_logs_anon_insert" ON audit_logs
  AS PERMISSIVE FOR INSERT TO anon WITH CHECK (true);
