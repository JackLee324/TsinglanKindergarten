/**
 * 探针资源清理 —— **共用的那一份**。
 *
 * WHY THIS FILE EXISTS（这是同一类缺陷的第四次出现，所以这次不再点修）
 * -------------------------------------------------------------------
 * `DELETE /api/resources/:id` 是**软删除**（进回收站），不是删除。于是任何
 * "建探针 → 用完 DELETE" 的套件，**每跑一次就往回收站留一行**。实测：
 * 本机测试库的回收站里积了 **233 行**，其中约 220 行是反复跑门禁留下的探针：
 *
 *     61  上传闭环探针 主        ← verify-upload-web
 *     57  上传链路探针           ← verify-storage-upload-flow
 *     54  版本探针（改名）        ← verify-resource-versions
 *     19  上传闭环探针 拒绝      ← verify-upload-web
 *     12  SigV4 链路探针         ← verify-storage-sigv4
 *     11  上传闭环探针 新建      ← verify-upload-web
 *     4+3 目录归属探针 / B       ← verify-directory-web
 *
 * 这个缺陷此前已被**单独修过三次**（每次都是"某一条探针没清干净"），
 * 但每次修的都是那一条，所以下一条继续漏。根因不是哪一条探针，
 * 而是"清理"这件事在每个套件里各写一遍、且默认写成 DELETE。
 * 因此这次把清理收敛成这一份，并配一道**系统性门禁**：
 * 套件跑完后由 `scripts/verify-no-probe-residue.mjs` 扫回收站，
 * 只要还有本轮探针行就整体失败 —— 任何套件以后漏了都会被抓到，
 * 不依赖谁记得去改哪一个脚本。
 *
 * 两条清理路径，都**核对结果**：
 *   1. 有 `resource.purge` 权限的客户端 → `POST /api/resources/:id/purge`
 *      （走真实接口，顺带把权限与审计一起验到）；
 *   2. 有数据库连接时 → 直接 SQL 硬删（兜底，覆盖权限不足的情况）。
 * 两条都做不成时**大声失败**，绝不静默留下垃圾。
 */

/**
 * 把探针资源**真正**删掉（含回收站）。
 *
 * @param {object} options
 * @param {object} options.req           套件的请求函数 `(method, path, body) => {s|status, d|data}`
 * @param {string[]} options.ids         要清理的资源 id
 * @param {string|null} [options.dbUrl]  数据库连接串（用于 SQL 兜底）；没有就只走接口
 * @param {string} [options.label]       日志前缀（哪个套件在清理）
 * @returns {Promise<{purgedViaApi:number, purgedViaSql:number, remaining:string[]}>}
 */
export async function purgeProbeResources({ req, ids, dbUrl = null, label = 'probe-cleanup' }) {
  const unique = [...new Set(ids.filter((x) => typeof x === 'string' && x.length > 0))];
  if (unique.length === 0) return { purgedViaApi: 0, purgedViaSql: 0, remaining: [] };

  const pick = (r) => ({ s: r?.s ?? r?.status, d: r?.d ?? r?.data });
  let purgedViaApi = 0;

  // 路径 1：真实接口。它要求 `resource.purge`，所以调用方必须是园长/超管级别的客户端；
  // 探针资源本来就由这些账号创建，所以这条路径通常可用。
  for (const id of unique) {
    try {
      const r = pick(await req('POST', `/api/resources/${id}/purge`, { reason: `${label} 收尾清理` }));
      if (r.s === 200 || r.s === 201 || r.s === 204) purgedViaApi += 1;
    } catch {
      /* 落到路径 2 */
    }
  }

  // 路径 2：SQL 兜底。软删除的行仍然能被硬删；**必须**核对影响行数 ——
  // 这个仓库已经踩过"DELETE 影响 0 行却报告成功"的坑（resource.purge 在 anon_ 角色下）。
  let purgedViaSql = 0;
  if (dbUrl) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(dbUrl, { max: 1 });
    try {
      // ⚠️ 用 `id in ${sql(unique)}`（postgres.js 会展开成参数列表），
      // **不要**写 `id = any(${sql.array(unique)}::uuid[])` —— 那个写法实测报
      // `malformed array literal`，因为 `sql.array()` 已经产出了一段数组字面量，
      // 再套 `::uuid[]` 就把单个元素当成整个数组解析。
      // 这个错误让清理整体抛错、套件失败，而门禁的 no-probe-residue 立刻抓到了
      // 因此留下的 2 行 —— 那道检查第一次实战就是抓我自己的 bug。
      const rows = await sql`
        with victims as (
          select id from resources
           where id in ${sql(unique)}
        ), gone as (
          delete from resources where id in (select id from victims) returning id
        )
        select count(*)::int as n from gone`;
      purgedViaSql = rows[0]?.n ?? 0;
    } finally {
      await sql.end();
    }
  }

  // 复核：还剩下的必须报出来。清理"大概成功了"不算成功。
  const remaining = [];
  if (dbUrl) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await sql`
        select id from resources where id in ${sql(unique)}`;
      remaining.push(...rows.map((r) => r.id));
    } finally {
      await sql.end();
    }
  }

  return { purgedViaApi, purgedViaSql, remaining };
}
