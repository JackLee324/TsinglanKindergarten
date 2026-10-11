/**
 * scripts/lib/file-integrity.mjs —— 文件完整性基线：采集与比对（**纯只读**）
 * ============================================================================
 * 业主 Stage 15 §二.10 / §三.11 的要求：
 *   "上线前后使用只读检查对比现有资源、文件记录、storage key、文件哈希和对象清单；
 *    如果核对不一致，停止发布并查明原因。" / "不得用'数据库迁移成功'代替文件数据完整性验证。"
 *
 * 所以这里定义一份**基线**：某一时刻的
 *   · 资源身份（id / 所属目录 / 状态 / 更新时间）
 *   · 文件引用（resource_files：id、所属资源、**storage key**、文件名、mime、字节数、sha256）
 *   · 对象清单（桶里每个 key 的字节数与 ETag）
 * 以及**比对规则**（见 `diffBaselines`）：
 *   · 新增资源/文件/对象 → **允许**（正常上传会让它们变多）；
 *   · 已记录的文件行消失、storage key 被改、字节数或 sha256 变了 → **漂移**；
 *   · 桶里原有对象消失、字节数或 ETag 变了 → **漂移**；
 *   · 已记录的资源 id 消失、所属目录被改 → **漂移**；
 *   · 资源**状态**变化（发布/撤回）属于正常业务，只作为"变化提示"记录，不判失败。
 *
 * 这一层是"AI 不许碰原始文件"的可执行判据：AI 相关改动的前后各跑一次比对，
 * 任何一条漂移都说明动了不该动的东西。
 */

/** 把一行行采集结果整理成稳定的基线对象（排序，便于逐字节比较）。 */
export function buildBaseline({ takenAt, database, storage, counts, resources, files, objects }) {
  return {
    version: 1,
    takenAt,
    database,
    storage,
    counts,
    resources: [...resources].sort((a, b) => (a.id < b.id ? -1 : 1)),
    files: [...files].sort((a, b) => (a.id < b.id ? -1 : 1)),
    objects: [...objects].sort((a, b) => (a.key < b.key ? -1 : 1)),
  }
}

/** 数据库里被引用、但桶里不存在的对象 —— 任何时刻都应该是空的。 */
export function findMissingObjects(files, objects) {
  const present = new Set(objects.map((o) => o.key))
  return files.filter((f) => !present.has(f.storageKey)).map((f) => ({
    fileId: f.id,
    resourceId: f.resourceId,
    storageKey: f.storageKey,
  }))
}

/**
 * 比对两份基线。返回 `{ drift: [...], notes: [...], added: {...} }`。
 *
 * drift 为空 = 数据完整性门禁通过；任何一条 drift 都应当停止发布。
 */
export function diffBaselines(before, after) {
  const drift = []
  const notes = []
  const added = { resources: 0, files: 0, objects: 0 }

  // ── 文件引用：**最要紧的一条**（storage key / 哈希 / 大小都不许变）──────────
  const afterFiles = new Map((after.files ?? []).map((f) => [f.id, f]))
  for (const f of before.files ?? []) {
    const now = afterFiles.get(f.id)
    if (now === undefined) {
      drift.push({ kind: 'file-row-removed', id: f.id, detail: `文件记录消失（storageKey=${f.storageKey}）` })
      continue
    }
    if (now.storageKey !== f.storageKey) {
      drift.push({ kind: 'storage-key-changed', id: f.id, detail: `${f.storageKey} → ${now.storageKey}` })
    }
    if (String(now.sha256) !== String(f.sha256)) {
      drift.push({ kind: 'file-sha256-changed', id: f.id, detail: `${String(f.sha256).slice(0, 12)}… → ${String(now.sha256).slice(0, 12)}…` })
    }
    if (String(now.size) !== String(f.size)) {
      drift.push({ kind: 'file-size-changed', id: f.id, detail: `${f.size} → ${now.size}` })
    }
    if (now.resourceId !== f.resourceId) {
      drift.push({ kind: 'file-resource-changed', id: f.id, detail: `${f.resourceId} → ${now.resourceId}` })
    }
  }
  added.files = Math.max(0, (after.files ?? []).length - (before.files ?? []).length)

  // ── 对象清单：原有对象不许消失/改内容 ─────────────────────────────────────
  const afterObjects = new Map((after.objects ?? []).map((o) => [o.key, o]))
  for (const o of before.objects ?? []) {
    const now = afterObjects.get(o.key)
    if (now === undefined) {
      drift.push({ kind: 'object-removed', id: o.key, detail: `对象消失（${o.size} 字节）` })
      continue
    }
    if (String(now.size) !== String(o.size)) {
      drift.push({ kind: 'object-size-changed', id: o.key, detail: `${o.size} → ${now.size}` })
    }
    if (String(now.etag) !== String(o.etag)) {
      drift.push({ kind: 'object-etag-changed', id: o.key, detail: `${String(o.etag).slice(0, 12)}… → ${String(now.etag).slice(0, 12)}…（对象内容被改写过）` })
    }
  }
  added.objects = Math.max(0, (after.objects ?? []).length - (before.objects ?? []).length)

  // ── 资源身份：id 与所属目录不许变；状态变化只记提示 ────────────────────────
  const afterResources = new Map((after.resources ?? []).map((r) => [r.id, r]))
  for (const r of before.resources ?? []) {
    const now = afterResources.get(r.id)
    if (now === undefined) {
      drift.push({ kind: 'resource-removed', id: r.id, detail: `资源消失（${r.title}）` })
      continue
    }
    if (now.directoryId !== r.directoryId) {
      drift.push({ kind: 'resource-directory-changed', id: r.id, detail: `${r.directoryId} → ${now.directoryId}` })
    }
    if (now.status !== r.status) {
      notes.push({ kind: 'resource-status-changed', id: r.id, detail: `${r.status} → ${now.status}（正常业务变化，不算漂移）` })
    }
  }
  added.resources = Math.max(0, (after.resources ?? []).length - (before.resources ?? []).length)

  // ── 计数：只允许"变多"，不许变少 ─────────────────────────────────────────
  for (const key of ['resources', 'resource_files', 'directories']) {
    const b = before.counts?.[key]
    const a = after.counts?.[key]
    if (b === undefined || a === undefined) continue
    if (Number(a) < Number(b)) {
      drift.push({ kind: 'count-decreased', id: key, detail: `${b} → ${a}` })
    }
  }

  // ── 桶里的对象必须覆盖数据库里的每一条文件引用 ───────────────────────────
  for (const row of findMissingObjects(after.files ?? [], after.objects ?? [])) {
    drift.push({ kind: 'referenced-object-missing', id: row.fileId, detail: `数据库引用的对象不在桶里：${row.storageKey}` })
  }

  return { drift, notes, added }
}
