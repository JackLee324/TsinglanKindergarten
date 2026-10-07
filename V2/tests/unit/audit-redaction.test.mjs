/**
 * 审计里绝不允许出现凭据。
 *
 * 静态约定挡不住"某人顺手把整个 request body 塞进 detail"，
 * 所以写入前有一次**运行时**剔除，并且这里直接测那个函数。
 * V1 曾经出现过运维接口把密钥回显出来的事故 —— 这类东西必须在源头拦住。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { auditActions, auditService } from '../helpers/modules.mjs'
const { AUDIT_ACTIONS, AUDIT_FORBIDDEN_DETAIL_KEYS } = auditActions

const { sanitize } = auditService

describe('审计写入前的凭据剔除', () => {
  test('顶层敏感 key 被替换', () => {
    const out = sanitize({ password: 'hunter2', token: 'abc', title: '教案' })
    assert.equal(out.password, '[已剔除]')
    assert.equal(out.token, '[已剔除]')
    assert.equal(out.title, '教案')
  })

  test('大小写不敏感', () => {
    const out = sanitize({ Password: 'x', STORAGEKEY: 'y' })
    assert.equal(out.Password, '[已剔除]')
    assert.equal(out.STORAGEKEY, '[已剔除]')
  })

  test('嵌套对象与数组也要剔干净', () => {
    const out = sanitize({
      request: { body: { password: 'x', keep: 1 } },
      files: [{ storageKey: 'k', name: 'a.pdf' }],
    })
    assert.equal(out.request.body.password, '[已剔除]')
    assert.equal(out.request.body.keep, 1)
    assert.equal(out.files[0].storageKey, '[已剔除]')
    assert.equal(out.files[0].name, 'a.pdf')
  })

  test('深度过深时截断而不是无限递归', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }
    const out = sanitize(deep)
    assert.ok(JSON.stringify(out).includes('depth-limit'))
  })

  test('禁止列表本身覆盖了业主点名的三类凭据', () => {
    const lower = AUDIT_FORBIDDEN_DETAIL_KEYS.map((k) => k.toLowerCase())
    assert.ok(lower.includes('password'))
    assert.ok(lower.includes('token'))
    assert.ok(lower.includes('secret'))
    assert.ok(lower.includes('storagekey'))
  })

  test('审计动作清单包含业主点名的每一项', () => {
    for (const required of [
      'auth.login',
      'user.create',
      'user.update',
      'user.disable',
      'user.permissions.update',
      'directory.create',
      'directory.update',
      'directory.delete',
      'resource.create',
      'resource.update',
      // 阶段 7 起动作名与业主 §20 的清单逐字一致（原来的 resource.submit /
      // review.approve / review.reject / review.recall 就是这四个）。
      'resource.submit_review',
      'resource.approve',
      'resource.reject',
      'resource.recall',
      'resource.delete',
      'resource.restore',
      'resource.purge',
      'resource.download',
    ]) {
      assert.ok(required in AUDIT_ACTIONS, `审计动作缺少 ${required}`)
    }
  })
})
