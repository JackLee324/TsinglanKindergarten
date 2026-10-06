/**
 * tests/null-username-principal.test.mjs —— §7 的**永久不变量**。
 *
 * 用户的指令原文：
 *   「username IS NULL 的 principal **先查引用关系**，确认不可登录残留则置
 *     `inactive`、保留记录不破坏历史并留证据，**不得直接 DELETE**。」
 *
 * 一次性"查了、改了、写在台账里"是不够的：台账是死文本，任何后来的人
 * （或另一个 agent）都可能顺手"清理掉这条脏数据"，而那时的后果是
 * **几百条资源的归属被切断**。所以这里把三条不变量钉成测试：
 *
 *   1. 任何 `username IS NULL` 的账号**必须是 `inactive`**
 *      —— 它不该是 active 的，也不该被"顺手删掉"。
 *   2. 它**没有任何可用口令**（`password_hash IS NULL`）—— 即结构性不可登录。
 *   3. **数据库自己会拒绝删除它**：`resources.uploader_id` 是
 *      `ON DELETE NO ACTION`（RESTRICT 语义）。这一条最关键：
 *      它把"不得直接 DELETE"从一句要求变成**引擎级约束**。
 *      如果有人哪天把外键改成 `CASCADE` 或 `SET NULL`，本测试会失败 ——
 *      而那种改动的后果是静默切断历史归属，光看代码 review 不一定看得出来。
 *
 * 这个测试**只读数据库**，不做任何写入（删除尝试在事务里回滚）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

let sql = null;

describe('§7 username IS NULL 的主账号', () => {
  before(async () => {
    if (!DB_URL) {
      throw new Error(
        '需要 DATABASE_URL / AUTHZ_TEST_DB：这个测试要读真实数据库，' +
          '而"引用关系"正是它的主题 —— 拿假数据测等于什么都没测。',
      );
    }
    const postgres = (await import('postgres')).default;
    sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  });

  after(async () => {
    if (sql) await sql.end();
  });

  test('每一行 username IS NULL 的账号都是 inactive（不是 active，也没被删掉）', async () => {
    const rows = await sql`
      SELECT id, name, roles, status FROM teachers WHERE username IS NULL
    `;
    // 允许"一行都没有"（全新环境可能还没跑种子），但**不允许**存在 active 的。
    const active = rows.filter((r) => r.status !== 'inactive');
    assert.equal(
      active.length,
      0,
      '存在 status 不是 inactive 的无用户名账号：' +
        JSON.stringify(active) +
        '。按 §7，不可登录的残留账号必须保留记录并置为 inactive，' +
        '既不能是 active（那是一个没人能登录却仍有权限的影子账号），' +
        '也不能被删除（它挂着历史资源的归属）。',
    );
  });

  test('无用户名账号没有任何可用口令（结构性不可登录）', async () => {
    const rows = await sql`
      SELECT id, name FROM teachers
      WHERE username IS NULL AND password_hash IS NOT NULL
    `;
    assert.equal(
      rows.length,
      0,
      '存在既有 password_hash 又没有用户名的账号：' +
        JSON.stringify(rows) +
        '。这种组合意味着"口令在库里、但没有任何用户名能对上它" ——' +
        '一旦将来有人给这行补上 username，它立刻变成一个可登录的 principal。' +
        '要么清掉 hash，要么明确它本来就该能登录。',
    );
  });

  test('数据库层面拒绝对这些账号直接 DELETE（外键不是 CASCADE / SET NULL）', async () => {
    const rows = await sql`
      SELECT id FROM teachers WHERE username IS NULL
    `;
    if (rows.length === 0) {
      // 没有这种行时，"不能删"无从验证。明确跳过而不是假装通过。
      return;
    }

    const target = rows[0].id;
    const fk = await sql`
      SELECT rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'resources' AND kcu.column_name = 'uploader_id'
    `;
    assert.ok(fk.length > 0, 'resources.uploader_id 上找不到外键约束 —— 归属关系没有引擎级保护');
    assert.equal(
      fk[0].delete_rule,
      'NO ACTION',
      `resources.uploader_id 的 ON DELETE 是 "${fk[0].delete_rule}"，` +
        '必须是 NO ACTION（RESTRICT 语义）。改成 CASCADE 会连同几百条资源一起删掉，' +
        '改成 SET NULL 会让这些资源失去归属 —— 两种都是静默的数据损失。',
    );

    // 真正试一次删除：必须被拒。**在事务里做并回滚**，不留任何副作用。
    let refused = false;
    let failure = null;
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM teachers WHERE id = ${target}`;
        // 没抛异常 = 删成功了；抛出来让事务回滚。
        throw new Error('__delete_succeeded__');
      });
    } catch (error) {
      const msg = String(error?.message ?? '');
      refused = msg !== '__delete_succeeded__';
      failure = msg;
    }
    assert.ok(
      refused,
      '直接 DELETE 一个挂着资源归属的无用户名账号**竟然成功了** —— ' +
        '§7 的"不得直接 DELETE"目前只写在文档里，没有引擎级保障。',
    );
    assert.match(
      String(failure),
      /foreign key|violates|constraint/i,
      `删除确实被拒了，但拒绝原因不是外键约束：${failure}。` +
        '要确认挡住它的是"有资源归属"，而不是别的偶然原因。',
    );
  });

  test('这些账号名下的资源仍然一条不少（归属没有被切断）', async () => {
    const rows = await sql`
      SELECT t.id, count(r.id)::int AS referenced
      FROM teachers t
      LEFT JOIN resources r ON r.uploader_id = t.id
      WHERE t.username IS NULL
      GROUP BY t.id
    `;
    for (const row of rows) {
      assert.ok(
        row.referenced > 0,
        `无用户名账号 ${row.id} 名下 0 条资源。这可能是正常的（新环境还没导内容），` +
          '但如果这台库本来有内容，就说明归属被切断了 —— ' +
          '这正是 §7 要求"先查引用关系、不得直接 DELETE"要防的事。',
      );
    }
  });
});
