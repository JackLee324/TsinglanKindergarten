/**
 * tests/helpers/resource-fixture.mjs —— 资源夹具
 * ============================================================================
 * 为什么用 SQL 造资源、而不是走 `POST /api/resources` + 上传：
 *
 * 阶段 5 测的是**读取**（列表 / 搜索 / 分页 / 可见性）。要测"已发布资源
 * 大家都能看到"，就得先有一条 PUBLISHED 的资源；而按业务规则，
 * 发布必须先有文件、再提交审核、再裁决 —— 那条链路属于阶段 6/7。
 *
 * 所以夹具直接写库来**搭建状态**，被测的行为仍然全部走 API。
 * 夹具有两条纪律：
 *   · 只创建，不删除别人的东西；
 *   · 每个套件结尾用 `purgeResources()` 清掉自己造的探针，并核对残留。
 */
import { withSql } from './harness.mjs'

let counter = 0
function probeTitle(label) {
  counter += 1
  return `${label}·探针${Date.now().toString().slice(-6)}-${counter}`
}

/**
 * 造一条资源。
 * @param options.status 默认 'PUBLISHED'（列表里能直接看到，便于测可见性）
 */
export async function makeResource({
  directoryId,
  uploaderId,
  title,
  titleEn = null,
  description = null,
  status = 'PUBLISHED',
}) {
  return withSql(async (sql) => {
    const rows = await sql`
      INSERT INTO resources (directory_id, title, title_en, description, status, uploader_id, published_at)
      VALUES (${directoryId}, ${title ?? probeTitle('资源')}, ${titleEn}, ${description},
              ${status}, ${uploaderId}, ${status === 'PUBLISHED' ? new Date() : null})
      RETURNING id::text
    `
    return rows[0].id
  })
}

/** 批量造资源（分页/搜索测试要几十条才看得出问题）。 */
export async function makeResources({ directoryId, uploaderId, count, prefix, status = 'PUBLISHED' }) {
  const ids = []
  for (let i = 1; i <= count; i += 1) {
    ids.push(
      await makeResource({
        directoryId,
        uploaderId,
        title: `${prefix} ${String(i).padStart(2, '0')}`,
        status,
      }),
    )
  }
  return ids
}

/** 清掉本套件造的探针（硬删）。返回删掉的行数，供残留核对。 */
export async function purgeResources(ids) {
  if (ids.length === 0) return 0
  return withSql(async (sql) => {
    const rows = await sql`DELETE FROM resources WHERE id = ANY(${ids}::uuid[]) RETURNING id::text`
    return rows.length
  })
}

/** 取某个目录下当前有多少条资源（残留核对的基线）。 */
export async function countResourcesIn(directoryId) {
  return withSql(async (sql) => {
    const rows = await sql`SELECT count(*)::int AS n FROM resources WHERE directory_id = ${directoryId}`
    return rows[0].n
  })
}
