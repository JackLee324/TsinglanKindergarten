/**
 * tests/unit/password-v1-compat.test.mjs —— 「V1 的口令能搬到 V2 吗」的**证明**
 * ============================================================================
 * 业主 Stage 9 §8 的原话是：
 *
 *   > 绝不能把 V1 password_hash 直接当作 V2 password_hash，
 *   > 除非**已经确认算法兼容**。如果不兼容：要求首次登录设置新密码。
 *
 * 两边都是 scrypt，存储格式也一样（`scrypt$N$r$p$salt$hash`）——
 * 但"长得一样"不是"能校验"。两边有两处实现差异：
 *
 *   · V1 把 base64 **文本**当 salt，V2 把 base64 **解码后的字节**当 salt；
 *   · V1 派生 32 字节，V2 派生 64 字节。
 *
 * 所以下面**用 V1 的代码原样**（参数、salt 用法、长度都照抄 V1 的
 * `server/modules/auth/auth.service.ts`）造一个哈希，再拿 V2 的校验器去验。
 * 这个文件存在的意义就是：把"兼容"从一句声明变成一条会红的断言。
 *
 * ⚠️ 这里**故意硬编码** V1 的参数与写法。V1 已经冻结，它的磁盘格式不会变；
 * 如果哪天这里红了，说明 V2 的校验器动了老格式 —— 那正是要发现的事。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { password, v1Migration } from '../helpers/modules.mjs'

const { hashPassword, verifyPassword } = password
const { isUnusablePassword, makeUnusablePassword, isV1PasswordFormat } = v1Migration

// ── V1 的实现（照抄 server/modules/auth/auth.service.ts 的常量与写法）──────────
const V1_N = 16384
const V1_R = 8
const V1_P = 1
const V1_KEYLEN = 32
const V1_SALT_LEN = 16

/** V1 的 hashPassword：salt 是 base64 **字符串**，直接参与 scrypt。 */
function v1Hash(password, saltBase64) {
  const salt = saltBase64 ?? randomBytes(V1_SALT_LEN).toString('base64')
  const derived = scryptSync(password, salt, V1_KEYLEN, { N: V1_N, r: V1_R, p: V1_P })
  return `scrypt$${V1_N}$${V1_R}$${V1_P}$${salt}$${derived.toString('base64')}`
}

describe('V1 → V2 口令兼容（业主 Stage 9 §8）', () => {
  test('V1 造的哈希，V2 的校验器认得', () => {
    const stored = v1Hash('ZhangPass!123')
    assert.equal(verifyPassword('ZhangPass!123', stored), true)
  })

  test('V1 的哈希，错口令必须被拒（不能"兼容"到谁都能进）', () => {
    const stored = v1Hash('ZhangPass!123')
    for (const wrong of ['', 'zhangpass!123', 'ZhangPass!124', 'ZhangPass!123 ', 'ZhangPass!1234']) {
      assert.equal(verifyPassword(wrong, stored), false, `「${wrong}」不该被接受`)
    }
  })

  test('换了 salt 就不认（确认校验真的用到了 salt）', () => {
    const saltA = Buffer.alloc(16, 7).toString('base64')
    const saltB = Buffer.alloc(16, 9).toString('base64')
    const stored = v1Hash('SamePass!123', saltA)
    // 只换 salt、保留派生值 —— 这样才是在问"salt 有没有参与运算"。
    // （拿"另一个 salt 造出来的完整哈希"去验当然会过：那是它自己的哈希。）
    const [s, n, r, p, , digest] = stored.split('$')
    const swapped = [s, n, r, p, saltB, digest].join('$')
    assert.equal(verifyPassword('SamePass!123', stored), true)
    assert.equal(verifyPassword('SamePass!123', swapped), false)
  })

  test('V2 自己造的口令没被兼容分支弄坏（64 字节那条路照旧）', () => {
    const stored = hashPassword('NewPass!2026')
    assert.equal(stored.split('$').length, 6)
    // V2 的派生长度仍是 64 字节 —— 兼容分支没有把新口令"降级"成旧格式。
    assert.equal(Buffer.from(stored.split('$')[5], 'base64').length, 64)
    assert.equal(verifyPassword('NewPass!2026', stored), true)
    assert.equal(verifyPassword('NewPass!2025', stored), false)
  })

  test('32 字节 = V1，64 字节 = V2（判据本身也要被钉住）', () => {
    assert.equal(isV1PasswordFormat(v1Hash('x')), true)
    assert.equal(isV1PasswordFormat(hashPassword('x')), false)
    assert.equal(isV1PasswordFormat('v1$no-password$abc'), false)
    assert.equal(isV1PasswordFormat(''), false)
  })

  test('两边格式相同（这就是"看起来能通用"的原因，所以必须有上面那条测试）', () => {
    const v1 = v1Hash('x').split('$')
    const v2 = hashPassword('x').split('$')
    assert.equal(v1.length, 6)
    assert.equal(v2.length, 6)
    assert.equal(v1[0], 'scrypt')
    assert.equal(v2[0], 'scrypt')
    assert.equal(v1[1], v2[1]) // N 相同
    assert.equal(v1[2], v2[2]) // r 相同
    assert.equal(v1[3], v2[3]) // p 相同
    assert.notEqual(v1[5], v2[5]) // 派生长度不同 —— 真正的差别在这里
  })

  test('V1 没有口令的账号：占位值任何口令都进不去（绝不给默认口令）', () => {
    const placeholder = makeUnusablePassword()
    assert.equal(isUnusablePassword(placeholder), true)
    for (const guess of ['', 'password', '12345678', 'qls12345', placeholder]) {
      assert.equal(verifyPassword(guess, placeholder), false, `「${guess}」不该能登录`)
    }
  })
})
