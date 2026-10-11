/**
 * scripts/lib/sequences.mjs —— 序列落后检测（"审计写不进去"那类事故的门闩）
 * ============================================================================
 * 2026-10-11 线上发现：`audit_logs.id` 的自增序列停在 **5**，而表里最大 id 已经是 **621**
 * —— 于是**任何一次审计写入都会主键冲突**。而 `audit.service.write()` 的策略是
 * "绝不因为审计失败而让业务失败"（只记 error 日志），所以表现是**静默丢审计**：
 * 登录成功、上传成功，但审计里查不到。这个缺陷在离线重置口令时才暴露出来
 * （重置脚本在一个事务里写审计 → 冲突 → 整个事务回滚，一个字都没改）。
 *
 * 根因：`import-v1.mjs` 写审计**不带显式 id**（序列会自己推进），
 * 而 `push-v2-rows.mjs` 是"按批搬运已经导入好的行"，会把 **id 原样带过去** ——
 * 序列不会因为显式插入而前进，于是停在初始值。
 *
 * 所以这里提供两件事：
 *   · `compareSequenceLag()` —— **纯函数**，判断哪些序列落后（可单测、无副作用）；
 *   · `listSequenceState()` / `repairSequenceLag()` —— 读实际序列与表内最大值、并按需 setval。
 * 判据用 `>`/`<` 比大小而不是"相等"：序列**超前**是正常的（回滚/删除会让表内最大变小），
 * 只有**落后**才会撞主键。
 */

/** 纯函数：从采集结果里挑出"落后"的序列。 */
export function compareSequenceLag(rows) {
  return (rows ?? [])
    .map((r) => ({
      table: r.table,
      column: r.column,
      lastValue: r.lastValue === null || r.lastValue === undefined ? null : String(r.lastValue),
      maxValue: String(r.maxValue ?? '0'),
    }))
    .filter((r) => {
      const last = BigInt(r.lastValue ?? '0')
      const max = BigInt(r.maxValue)
      return last < max
    })
}

/** 采集所有"owned sequence"（serial/identity 列背后的序列）与对应表内最大值。 */
export async function listSequenceState(sql) {
  const seqs = await sql`
    SELECT c.relname AS seq, t.relname AS tbl, a.attname AS col,
           pg_sequence_last_value(c.oid) AS last_value
    FROM pg_class c
    JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE c.relkind = 'S'
    ORDER BY 1
  `
  const out = []
  for (const s of seqs) {
    const [row] = await sql.unsafe(
      `SELECT COALESCE(max(${s.col}), 0)::text AS max FROM ${s.tbl}`,
    )
    out.push({
      sequence: s.seq,
      table: s.tbl,
      column: s.col,
      lastValue: s.last_value === null ? null : String(s.last_value),
      maxValue: String(row.max),
    })
  }
  return out
}

/**
 * 把落后的序列推到表内最大值。
 *
 * `setval(seq, max)` 的语义是"下一次 nextval 返回 max+1"（第三个参数默认 is_called=true），
 * 正是我们要的。表为空（max=0）时 setval(seq, 0) 也会让 nextval 从 1 开始 —— 安全。
 * 已经超前的序列不动。
 */
export async function repairSequenceLag(sql, state = null) {
  // 默认参数里不能用 await（语法不允许），所以在这里取
  const current = state ?? (await listSequenceState(sql))
  const behind = compareSequenceLag(current)
  for (const row of behind) {
    const seqName = current.find((s) => s.table === row.table && s.column === row.column)?.sequence
    await sql.unsafe(`SELECT setval('${seqName}', ${row.maxValue})`)
  }
  return behind
}
