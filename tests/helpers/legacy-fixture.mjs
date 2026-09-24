/**
 * tests/helpers/legacy-fixture.mjs
 * ================================
 * Builds a REALISTIC "before" database for migration testing — i.e. the worst
 * case the hardening migration must survive.
 *
 * It deliberately reproduces the shipped-broken state:
 *   - schema created from `server/database/init.sql` verbatim, so `teachers` has
 *     NONE of the v1.3.0 authentication columns and `wecom_user_id` is NOT NULL;
 *   - the platform prerequisites (`user_profile` type, anon/authenticated/
 *     service_role roles) created first, because otherwise init.sql cannot run
 *     at all;
 *   - real business data loaded on top: the 20 seeded teacher accounts and the
 *     347 curriculum resources from `seed-curriculum.sql`, plus review records
 *     and audit logs, so the migration is exercised against non-empty tables.
 *
 * Any migration that loses a row, a column or an account is detected by
 * scripts/db-snapshot.mjs --compare.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function adminUrl(port = process.env.QLS_DEV_PGPORT || '55432') {
  const user = process.env.QLS_DEV_PGUSER || 'qlsadmin';
  const pass = process.env.QLS_DEV_PGPASSWORD || 'qlsdev_local_only';
  return `postgres://${user}:${pass}@127.0.0.1:${port}/postgres`;
}

export function dbUrl(name, port = process.env.QLS_DEV_PGPORT || '55432') {
  const user = process.env.QLS_DEV_PGUSER || 'qlsadmin';
  const pass = process.env.QLS_DEV_PGPASSWORD || 'qlsdev_local_only';
  return `postgres://${user}:${pass}@127.0.0.1:${port}/${name}`;
}

/** The 20 accounts the shipped seed-teachers.ts defines, with realistic hashes. */
const TEACHER_ROWS = [
  ['qlsadmin', '园长/平台管理员', 'Principal / Platform Admin', ['principal']],
  ['qlsdirector', '教学主任/教研主管', 'Curriculum Director', ['curriculum_director']],
  ['prek-head01', 'Pre-K主教01', 'Pre-K Head Teacher 01', ['prek_head']],
  ['prek-head02', 'Pre-K主教02', 'Pre-K Head Teacher 02', ['prek_head']],
  ['prek-head03', 'Pre-K主教03', 'Pre-K Head Teacher 03', ['prek_head']],
  ['k-head01', 'K主教01', 'K Head Teacher 01', ['k_head']],
  ['k-head02', 'K主教02', 'K Head Teacher 02', ['k_head']],
  ['k-head03', 'K主教03', 'K Head Teacher 03', ['k_head']],
  ['prek-teacher01', 'Pre-K教师01', 'Pre-K Teacher 01', ['prek_assistant']],
  ['prek-teacher02', 'Pre-K教师02', 'Pre-K Teacher 02', ['prek_assistant']],
  ['prek-teacher03', 'Pre-K教师03', 'Pre-K Teacher 03', ['prek_assistant']],
  ['prek-teacher04', 'Pre-K教师04', 'Pre-K Teacher 04', ['prek_assistant']],
  ['k-teacher01', 'K教师01', 'K Teacher 01', ['k_assistant']],
  ['k-teacher02', 'K教师02', 'K Teacher 02', ['k_assistant']],
  ['k-teacher03', 'K教师03', 'K Teacher 03', ['k_assistant']],
  ['k-teacher04', 'K教师04', 'K Teacher 04', ['k_assistant']],
  ['pe-teacher01', '体能教师01', 'PE Teacher 01', ['pe_specialist']],
  ['pe-teacher02', '体能教师02', 'PE Teacher 02', ['pe_specialist']],
  ['pe-teacher03', '体能教师03', 'PE Teacher 03', ['pe_specialist']],
  ['pe-teacher04', '体能教师04', 'PE Teacher 04', ['pe_specialist']],
];

export async function dropAndCreateDatabase(name) {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    // terminate other connections so DROP DATABASE cannot fail
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Populate `name` with the legacy (shipped) schema and realistic data.
 * Returns a summary of what was created.
 */
export async function buildLegacyFixture(name) {
  await dropAndCreateDatabase(name);
  const sql = postgres(dbUrl(name), { max: 1, onnotice: () => {} });

  try {
    // --- platform prerequisites (a vanilla cluster lacks all of these) --------
    for (const role of ['anon', 'authenticated', 'service_role']) {
      try {
        await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
      } catch (e) {
        if (e.code !== '42710') throw e; // 42710 = duplicate_object (already exists cluster-wide)
      }
    }
    try {
      await sql.unsafe('CREATE TYPE user_profile AS (user_id text)');
    } catch (e) {
      if (e.code !== '42710') throw e;
    }

    // --- the shipped DDL, verbatim -------------------------------------------
    await sql.unsafe(readFileSync(join(ROOT, 'server/database/init.sql'), 'utf8'));

    // --- legacy accounts. init.sql declares wecom_user_id NOT NULL and has no
    //     username column, so this is exactly how a pre-v1.3.0 or init.sql-based
    //     database would look. -------------------------------------------------
    for (const [username, name_zh, name_en, roles] of TEACHER_ROWS) {
      await sql`
        INSERT INTO teachers (wecom_user_id, name, name_en, roles, status, email)
        VALUES (${'legacy_' + username}, ${name_zh}, ${name_en}, ${roles}, 'active',
                ${username + '@example.invalid'})
      `;
    }

    // --- the uploader the curriculum seed depends on -------------------------
    await sql`
      INSERT INTO teachers (wecom_user_id, name, name_en, roles, status)
      VALUES ('system_initializer', '系统初始化', 'System Initializer', ARRAY['principal'], 'active')
    `;

    // --- 347 curriculum resources -------------------------------------------
    await sql.unsafe(readFileSync(join(ROOT, 'server/database/seed-curriculum.sql'), 'utf8'));

    // --- some review history -------------------------------------------------
    const resources = await sql`SELECT id, uploader_id FROM resources ORDER BY id LIMIT 18`;
    const reviewer = await sql`SELECT id FROM teachers WHERE wecom_user_id = 'legacy_qlsdirector' LIMIT 1`;
    for (let i = 0; i < resources.length; i += 1) {
      await sql`
        INSERT INTO review_records (resource_id, reviewer_id, action, comment)
        VALUES (${resources[i].id}, ${reviewer[0].id}, ${i % 3 === 0 ? 'reject' : 'approve'},
                ${i % 3 === 0 ? '需要补充材料' : null})
      `;
      await sql`
        UPDATE resources
        SET reviewer_id = ${reviewer[0].id},
            reviewed_at = CURRENT_TIMESTAMP,
            review_comment = ${i % 3 === 0 ? '需要补充材料' : null}
        WHERE id = ${resources[i].id}
      `;
    }

    // --- audit history -------------------------------------------------------
    for (let i = 0; i < 25; i += 1) {
      await sql`
        INSERT INTO audit_logs (action, teacher_id, teacher_name, ip_address, success, detail)
        VALUES (${i % 4 === 0 ? 'login_failed' : 'login'}, ${reviewer[0].id}, '教学主任',
                '203.0.113.7', ${i % 4 !== 0}, ${'fixture row ' + i})
      `;
    }

    const summary = {
      teachers: Number((await sql`SELECT count(*)::int c FROM teachers`)[0].c),
      resources: Number((await sql`SELECT count(*)::int c FROM resources`)[0].c),
      review_records: Number((await sql`SELECT count(*)::int c FROM review_records`)[0].c),
      audit_logs: Number((await sql`SELECT count(*)::int c FROM audit_logs`)[0].c),
      subject_permissions: Number((await sql`SELECT count(*)::int c FROM subject_permissions`)[0].c),
      hasAuthColumns: (
        await sql`SELECT count(*)::int c FROM information_schema.columns
                  WHERE table_name='teachers' AND column_name IN
                  ('username','password_hash','must_change_password',
                   'failed_login_attempts','locked_until','password_updated_at')`
      )[0].c,
    };
    return summary;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export { TEACHER_ROWS };
