/**
 * tests/unit/reset-user-password-guards.test.mjs —— 改生产口令的脚本必须"先拦后动手"
 * ============================================================================
 * `scripts/reset-user-password.mjs` 会改**生产**账号的口令（不可逆：旧口令立即失效）。
 * 所以它的每一条守卫都必须在**建立任何数据库连接之前**生效 ——
 * 这份测试用一个连不上的假地址证明这件事：如果守卫漏了，脚本会去连库并报错，
 * 退出码就不再是 2，而"连库失败"和"参数不合法"是**完全不同的两件事**。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'reset-user-password.mjs')

/** 指向一个**不可能连上**的地址：守卫若失效，脚本会尝试连接并因此报出别的错。 */
const BOGUS_DB = 'postgresql://probe@127.0.0.1:9/nonexistent_db'

function run(env) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 20000,
  })
  return { status: res.status, out: `${res.stdout}${res.stderr}` }
}

describe('① 缺参数一律退出码 2，而且不连库', () => {
  test('没有 DATABASE_URL → 拒绝，并说清"不接受默认库"', () => {
    const { status, out } = run({ RESET_USERNAME: 'someone', RESET_PASSWORD: 'a-strong-password-1', RESET_CONFIRM: 'RESET-USER-PASSWORD' })
    assert.equal(status, 2, out)
    assert.match(out, /DATABASE_URL/, '要点名缺的是哪个变量')
    assert.match(out, /不接受任何默认库/, '要说清为什么不给默认值')
  })

  test('没有 RESET_USERNAME → 拒绝（不点名就不动手）', () => {
    const { status, out } = run({ DATABASE_URL: BOGUS_DB, RESET_PASSWORD: 'a-strong-password-1', RESET_CONFIRM: 'RESET-USER-PASSWORD' })
    assert.equal(status, 2, out)
    assert.match(out, /RESET_USERNAME/)
  })

  test('没有确认字面量 → 拒绝（改口令不可逆）', () => {
    const { status, out } = run({ DATABASE_URL: BOGUS_DB, RESET_USERNAME: 'someone', RESET_PASSWORD: 'a-strong-password-1' })
    assert.equal(status, 2, out)
    assert.match(out, /RESET-USER-PASSWORD/, '要把需要敲的字面量原样告诉操作者')
  })

  test('口令太短 / 含用户名 / 首尾有空白 → 一律拒绝', () => {
    const base = { DATABASE_URL: BOGUS_DB, RESET_USERNAME: 'someone', RESET_CONFIRM: 'RESET-USER-PASSWORD' }
    for (const [label, password, pattern] of [
      ['太短', 'short1234', /至少 12 位/],
      ['含用户名', 'someone-password-2026', /不能包含用户名/],
      ['首尾空白', ' a-strong-password-1 ', /首尾不能有空白/],
    ]) {
      const { status, out } = run({ ...base, RESET_PASSWORD: password })
      assert.equal(status, 2, `${label}：${out}`)
      assert.match(out, pattern, `${label} 的拒绝理由要说清`)
    }
  })

  test('空口令（连密码文件都没给）→ 拒绝', () => {
    const { status, out } = run({ DATABASE_URL: BOGUS_DB, RESET_USERNAME: 'someone', RESET_PASSWORD: '', RESET_CONFIRM: 'RESET-USER-PASSWORD' })
    assert.equal(status, 2, out)
    assert.match(out, /RESET_PASSWORD_FILE|RESET_PASSWORD/)
  })
})
