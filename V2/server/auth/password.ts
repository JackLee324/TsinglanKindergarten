import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 口令散列：scrypt + 每账号独立 salt。
 *
 * 存储格式与 V1 一致（`scrypt$N$r$p$salt$hash`），所以 V1 的口令**可以原样搬过来**，
 * 老师不需要重设密码。参数写在字符串里，以后调参也不会让旧口令失效。
 *
 * ⚠️ 但"格式一致"**不等于**"能互相校验" —— V1 与 V2 有两处实现差异：
 *
 *   | | V1 | V2 |
 *   |---|---|---|
 *   | salt 参与运算的形式 | base64 **文本本身** | **解码后的 16 字节** |
 *   | 派生长度 | 32 字节 | 64 字节 |
 *
 * 所以校验器里有一个**只对 32 字节旧串生效**的兼容分支。兼容性是
 * `tests/unit/password-v1-compat.test.mjs` 用 V1 的代码原样造串**测出来**的，
 * 不是"看着像"推断出来的。来历见 docs/V1_MIGRATION.md §7.1。
 */
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

/** V1 的派生长度，用来识别"这是迁移过来的老串"。 */
const V1_KEYLEN = 32

export function hashPassword(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = parts[4]
  const expected = Buffer.from(parts[5], 'base64')
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  /*
    V1 兼容分支（见文件头）。

    判据是**派生长度**而不是参数值：N/r/p 两边本来就相同（16384/8/1），
    真正不同的是 salt 的用法和长度。keylen 取存储值自身的长度，
    于是 V1 的 32 字节串按 32 字节派生，数量自然对得上。
  */
  const saltInput = expected.length === V1_KEYLEN ? salt : Buffer.from(salt, 'base64')
  const actual = scryptSync(plain, saltInput, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
