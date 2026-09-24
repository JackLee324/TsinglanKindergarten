-- ============================================================
-- RLS Policy 角色修复脚本
-- ============================================================
-- 背景：部分平台环境的数据库角色带 workspace 后缀
--   （如 authenticated_workspace_xxx / service_role_workspace_xxx / anon_workspace_xxx）
--   而 init.sql 中使用标准角色名 authenticated / service_role / anon
--
-- 症状：后端 API 返回 42501 permission denied
--
-- 使用方式：
--   miaoda db sql -f server/database/fix-rls-policies.sql
--
-- 注意：执行前请确认角色名是否正确，可通过下列命令检查：
--   miaoda db sql "SELECT rolname FROM pg_roles WHERE rolname LIKE 'authenticated%' OR rolname LIKE 'service_role%' OR rolname LIKE 'anon%' ORDER BY rolname;"
-- ============================================================

DO $$
DECLARE
  t text;
  p_name text;
  p_cmd text;
  p_roles text[];
  new_roles text[];
  r text;
  auth_role text := 'authenticated_workspace_aadkvzfw5lges';
  srv_role text  := 'service_role_workspace_aadkvzfw5lges';
  anon_role text := 'anon_workspace_aadkvzfw5lges';
BEGIN
  -- 如果标准角色名在你的环境中有效，可直接退出
  -- 取消下面一行的注释来跳过：
  -- RAISE NOTICE 'skipping: using standard role names'; RETURN;

  FOREACH t IN ARRAY ARRAY[
    'teachers',
    'subject_permissions',
    'resources',
    'review_records',
    'audit_logs',
    'sessions'
  ]
  LOOP
    FOR p_name, p_cmd, p_roles IN
      SELECT
        pol.polname,
        CASE pol.polcmd
          WHEN '*' THEN 'ALL'
          WHEN 'r' THEN 'SELECT'
          WHEN 'a' THEN 'INSERT'
          WHEN 'w' THEN 'UPDATE'
          WHEN 'd' THEN 'DELETE'
          ELSE 'ALL'
        END,
        array_agg(pg_get_userbyid(u.role_oid) ORDER BY u.n)
      FROM pg_policy pol
      JOIN pg_class c ON pol.polrelid = c.oid,
      unnest(pol.polroles) WITH ORDINALITY AS u(role_oid, n)
      WHERE c.relname = t
      GROUP BY pol.polname, pol.polcmd
    LOOP
      -- 替换角色名
      new_roles := ARRAY[]::text[];
      FOREACH r IN ARRAY p_roles
      LOOP
        IF r = 'authenticated' THEN
          new_roles := array_append(new_roles, auth_role);
        ELSIF r = 'service_role' THEN
          new_roles := array_append(new_roles, srv_role);
        ELSIF r = 'anon' THEN
          new_roles := array_append(new_roles, anon_role);
        ELSE
          new_roles := array_append(new_roles, r);
        END IF;
      END LOOP;

      -- 排序后比较，有变化才重建
      IF (
        SELECT array_agg(x ORDER BY x)
        FROM unnest(new_roles) AS x
      ) <> (
        SELECT array_agg(x ORDER BY x)
        FROM unnest(p_roles) AS x
      ) THEN
        -- 删除旧 policy
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_name, t);

        -- 创建新 policy
        IF p_cmd = 'SELECT' THEN
          EXECUTE format(
            'CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT TO %s USING (true)',
            p_name, t, array_to_string(new_roles, ', ')
          );
        ELSE
          EXECUTE format(
            'CREATE POLICY %I ON %I AS PERMISSIVE FOR %s TO %s USING (true) WITH CHECK (true)',
            p_name, t, p_cmd, array_to_string(new_roles, ', ')
          );
        END IF;

        RAISE NOTICE 'updated policy % on %: % -> %', p_name, t, array_to_string(p_roles, ', '), array_to_string(new_roles, ', ');
      END IF;
    END LOOP;
  END LOOP;
END $$;
