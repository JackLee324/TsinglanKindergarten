/**
 * 权限目录的形状必须与业主的最终决定逐字一致。
 *
 * 这条测试存在的理由：权限目录是**整个授权模型的词汇表**。
 * 它多一项、少一项、或者顺序被改，管理界面上就会多一个/少一个勾选框，
 * 而那种改动不会被任何接口测试发现。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { permissions } from '../helpers/modules.mjs'
const { PERMISSION_CODES, PERMISSIONS, permissionChecklist, isGrantable, USER_ROLES } = permissions

describe('权限目录（业主最终确认的 12 项）', () => {
  test('恰好 12 项', () => {
    assert.equal(PERMISSION_CODES.length, 12)
  })

  test('勾选框清单与业主清单一致（顺序也要对）**减去不可授予的那一项**', () => {
    /*
      权限码本身仍是 12 项（上一条断言），但"可以发给某个账号的"只有 11 项：
      `user.manage` 是**身份自带**的能力（业主 Stage 13 §4），
      账号管理的门槛是超级管理员身份，不再是一个可授予的权限 ——
      它既不进勾选框，服务端也会拒绝把它写进 user_permissions。
    */
    assert.deepEqual([...permissionChecklist()], [
      'resource.view',
      'resource.create',
      'resource.update.own',
      'resource.delete.own',
      'resource.download',
      'resource.submit',
      'resource.review',
      'resource.publish',
      'directory.manage',
      'directory.create_folder',
      'audit.view',
    ])
    assert.equal(isGrantable('user.manage'), false, '「管理教师」不可授予')
    assert.equal(PERMISSION_CODES.includes('user.manage'), true, '权限码本身仍在目录里（12 项不变）')
    for (const code of permissionChecklist()) assert.equal(isGrantable(code), true)
  })

  test('每一项都有中文标签（管理员看到的是中文，不是权限码）', () => {
    for (const code of PERMISSION_CODES) {
      const meta = PERMISSIONS[code]
      assert.ok(meta, `${code} 没有元数据`)
      assert.match(meta.label, /[\u4e00-\u9fa5]/, `${code} 的标签必须是中文`)
      assert.ok(meta.labelEn.length > 0, `${code} 缺英文标签`)
      assert.ok(meta.description.length > 10, `${code} 缺说明`)
      assert.ok(['directory', 'global'].includes(meta.scope))
    }
  })

  test('业主禁止的概念一个都不在权限模型里', () => {
    const serialized = JSON.stringify(PERMISSIONS).toLowerCase()
    for (const banned of ['deny', 'grant', 'override', 'scope_kind', 'ceiling', 'version']) {
      assert.ok(!serialized.includes(banned), `权限模型里不应出现「${banned}」`)
    }
  })

  test('只有 ADMIN / TEACHER 两种身份', () => {
    assert.deepEqual([...USER_ROLES], ['ADMIN', 'TEACHER'])
  })

  test('「下载资源」是独立权限（不与查看资源合并）', () => {
    assert.ok(PERMISSION_CODES.includes('resource.download'))
    assert.notEqual(PERMISSIONS['resource.download'].label, PERMISSIONS['resource.view'].label)
  })
})
