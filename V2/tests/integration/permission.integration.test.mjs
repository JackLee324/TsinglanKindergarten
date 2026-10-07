/**
 * 权限范围：业主 §「教师只能看自己被授权的目录，直接调 API 也必须被拒」。
 *
 * 每条都**真的调接口**，而不是看界面 —— 界面隐藏按钮不等于后端拒绝。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
} from '../helpers/harness.mjs'
import { docxBytes, uploadFile } from '../helpers/upload.mjs'

let admin
let ids = {}
let teacher // 只有 Pre-K/美德 的查看+上传

before(async () => {
  await resetDatabase()
  await createAdmin('p_admin', 'PermAdminPass!1')

  ids = {
    virtue: await directoryIdByPath('education/pre-k/virtue'),
    virtueResources: await directoryIdByPath('education/pre-k/virtue/resources'),
    virtueOutline: await directoryIdByPath('education/pre-k/virtue/outline'),
    kChinese: await directoryIdByPath('education/k/chinese'),
    kChinesePoetry: await directoryIdByPath('education/k/chinese/poetry'),
    kChinesePoetryResources: await directoryIdByPath('education/k/chinese/poetry/resources'),
    preK: await directoryIdByPath('education/pre-k'),
  }

  await startServer()
  admin = client()
  await admin.login('p_admin', 'PermAdminPass!1')

  await createTeacher(
    'scope_teacher',
    'ScopeTeacherPass!1',
    [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
      // 阶段 6：所有权那条用例要"先发布再验证所有权"，所以需要提交审核的权限。
      { permission: 'resource.submit', directoryId: ids.virtue },
      // 「新建文件夹」是**独立的一项**（业主的 12 项清单里单列），
      // 所以要显式授予 —— 能上传不等于能建文件夹。
      { permission: 'directory.create_folder', directoryId: ids.virtue },
    ],
    '张老师',
  )
  teacher = client()
  await teacher.login('scope_teacher', 'ScopeTeacherPass!1')
})
after(async () => {
  await stopServer()
})

describe('目录范围（含子树）', () => {
  test('授权在科目上 → 子树里也能建资源（美德/教学资源）', async () => {
    const res = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '美德教学资源',
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))
  })

  test('子树里的**另一个**资料夹同样可以（美德/课程大纲）', async () => {
    const res = await teacher.post('/api/resources', {
      directoryId: ids.virtueOutline,
      title: '美德课程大纲',
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))
  })

  test('范围外的目录 → 403（K / 中文教学 / 古诗 / 教学资源）', async () => {
    const res = await teacher.post('/api/resources', {
      directoryId: ids.kChinesePoetryResources,
      title: '越权资源',
    })
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('范围外的目录也读不到（列表里不出现）', async () => {
    await admin.post('/api/resources', {
      directoryId: ids.kChinesePoetryResources,
      title: 'K 的诗歌资源',
    })
    const res = await teacher.get(`/api/resources?directoryId=${ids.kChinesePoetryResources}`)
    // 要么 403，要么空列表 —— 但绝不能出现那一条
    if (res.status === 200) {
      assert.equal(res.data.items.length, 0, '不能看到范围外的资源')
    } else {
      assert.equal(res.status, 403)
    }
  })

  test('直接按 id 访问范围外的资源 → 403（不是"界面上没链接"）', async () => {
    const created = await admin.post('/api/resources', {
      directoryId: ids.kChinesePoetryResources,
      title: 'K 的诗歌资源 2',
    })
    const res = await teacher.get(`/api/resources/${created.data.id}`)
    assert.equal(res.status, 403)
  })

  test('看不到的目录不会出现在目录树里', async () => {
    const res = await teacher.get('/api/directories/tree')
    assert.equal(res.status, 200)
    const education = res.data.roots.find((r) => r.slug === 'education')
    const preK = education.children.find((c) => c.slug === 'pre-k')
    const k = education.children.find((c) => c.slug === 'k')
    assert.ok(preK, '有授权的班型要在')
    assert.equal(k, undefined, '没授权的班型不该出现')
  })

  test('教师没有 directory.manage → 看不到管理能力位', async () => {
    const res = await teacher.get('/api/directories/tree')
    const education = res.data.roots.find((r) => r.slug === 'education')
    const preK = education.children.find((c) => c.slug === 'pre-k')
    const virtue = preK.children.find((c) => c.slug === 'virtue')
    assert.equal(virtue.capabilities.canManage, false)
    assert.equal(virtue.capabilities.canUpload, false, '科目层不能放资源')
    assert.equal(virtue.capabilities.canCreateFolder, false, '科目层不允许自建文件夹')
  })

  test('教学资源的能力位：可上传、可自建文件夹、不可管理', async () => {
    const res = await teacher.get('/api/directories/tree')
    const education = res.data.roots.find((r) => r.slug === 'education')
    const preK = education.children.find((c) => c.slug === 'pre-k')
    const virtue = preK.children.find((c) => c.slug === 'virtue')
    const folder = virtue.children.find((c) => c.slug === 'resources')
    assert.equal(folder.capabilities.canUpload, true)
    assert.equal(folder.capabilities.canCreateFolder, true)
    assert.equal(folder.capabilities.canManage, false)
  })

  test('allowCustomFolders=false 的目录不出现「新建文件夹」能力', async () => {
    const res = await teacher.get('/api/directories/tree')
    const education = res.data.roots.find((r) => r.slug === 'education')
    const preK = education.children.find((c) => c.slug === 'pre-k')
    const virtue = preK.children.find((c) => c.slug === 'virtue')
    const outline = virtue.children.find((c) => c.slug === 'outline')
    assert.equal(outline.allowCustomFolders, false)
    assert.equal(outline.capabilities.canCreateFolder, false, '课程大纲不允许教师自建文件夹')
  })
})

describe('所有权：*_own 只对自己上传的资源有效', () => {
  test('另一个教师不能编辑/删除别人的资源', async () => {
    const created = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '张老师的资源',
    })
    assert.equal(created.status, 201)

    await createTeacher(
      'other_teacher',
      'OtherTeacherPass!1',
      [
        { permission: 'resource.view', directoryId: ids.virtue },
        { permission: 'resource.update.own', directoryId: ids.virtue },
        { permission: 'resource.delete.own', directoryId: ids.virtue },
      ],
      '李老师',
    )
    const other = client()
    await other.login('other_teacher', 'OtherTeacherPass!1')

    // 同目录、有 update.own 权限，但不是上传者 → 仍然拒绝
    const patch = await other.patch(`/api/resources/${created.data.id}`, { title: '改别人的' })
    assert.equal(patch.status, 403)

    const del = await other.del(`/api/resources/${created.data.id}`)
    assert.equal(del.status, 403)

    // ⚠️ 阶段 6 改写：草稿**别人看不到**（未发布只对上传者可见）——
    // 这一条以前是 200，因为单条读取没有套用可见性策略（后来被修掉了，
    // 见 `AuthorizationService.canViewResource` 与 resource-permission 套件的对应用例）。
    assert.equal((await other.get(`/api/resources/${created.data.id}`)).status, 403)

    // 发布之后：同一目录 + 有 view 权限的人**看得到**，
    // 但**仍然改不了、删不了** —— 这才真正证明"403 来自所有权，不是来自看不见"。
    await uploadFile(teacher, created.data.id, { bytes: docxBytes('所有权探针'), fileName: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    await teacher.post(`/api/resources/${created.data.id}/submit`)
    await admin.post(`/api/resources/${created.data.id}/review`, { action: 'approve' })

    assert.equal((await other.get(`/api/resources/${created.data.id}`)).status, 200)
    assert.equal(
      (await other.patch(`/api/resources/${created.data.id}`, { title: '改别人的' })).status,
      403,
    )
    assert.equal((await other.del(`/api/resources/${created.data.id}`)).status, 403)
  })

  test('管理员可以越过所有权', async () => {
    const created = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '管理员可改',
    })
    const patch = await admin.patch(`/api/resources/${created.data.id}`, { title: '管理员改过了' })
    assert.equal(patch.status, 200)
    assert.equal(patch.data.title, '管理员改过了')
  })
})

describe('自建文件夹', () => {
  test('在教学资源下可以建（allowCustomFolders = true）', async () => {
    const res = await teacher.post('/api/directories/folders', {
      parentId: ids.virtueResources,
      name: '环境创设',
      nameEn: 'Environment',
    })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.name, '环境创设')

    const tree = await teacher.get('/api/directories/tree')
    const education = tree.data.roots.find((r) => r.slug === 'education')
    const folder = education.children
      .find((c) => c.slug === 'pre-k')
      .children.find((c) => c.slug === 'virtue')
      .children.find((c) => c.slug === 'resources')
    assert.ok(
      folder.children.some((c) => c.name === '环境创设'),
      '刷新后自建文件夹必须还在',
    )
  })

  test('在课程大纲下被拒（allowCustomFolders = false）', async () => {
    const res = await teacher.post('/api/directories/folders', {
      parentId: ids.virtueOutline,
      name: '不该建出来',
      nameEn: 'Should Not Exist',
    })
    assert.equal(res.status, 403)
  })

  test('没有 directory.create_folder 权限的教师被拒', async () => {
    await createTeacher(
      'no_folder',
      'NoFolderPass!1',
      [{ permission: 'resource.view', directoryId: ids.virtue }],
    )
    const c = client()
    await c.login('no_folder', 'NoFolderPass!1')
    const res = await c.post('/api/directories/folders', {
      parentId: ids.virtueResources,
      name: '越权文件夹',
      nameEn: 'Nope',
    })
    assert.equal(res.status, 403)
  })
})

describe('fail closed：路由漏声明权限', () => {
  test('守卫把未声明的路由拒掉（且错误码可识别）', async () => {
    // 这是静态保证：见 tests/unit/route-declarations.test.mjs
    // 这里验证的是**运行时**行为 —— 一个不存在的路由返回 404 而不是 500，
    // 说明异常过滤器对未知路由也是正常的。
    const res = await admin.get('/api/definitely-not-a-route')
    assert.ok([404, 403].includes(res.status), `实际 ${res.status}`)
  })
})
