/**
 * 目录归属（§8）—— 给验证套件用的最小助手。
 *
 * WHY THIS EXISTS
 * ---------------
 * §8 把 `directoryId` 变成了**新建资源时的必填项**
 * （「没有 directoryId → 不能提交保存」）。这是业主明确要求的接口契约变更，
 * 但它一次性打断了所有"直接 POST /api/resources"的套件 —— 于是每一个都会
 * 因为 400「必须选择所属目录」而红。
 *
 * 处理方式有两种，这里刻意选后者：
 *   · 在每个套件里各自写一段"查目录树、挑一个资料夹"的代码 ——
 *     六份副本，改一次口径要改六处；
 *   · **一份助手**，所有套件共用。口径只有一处，与页面上
 *     「候选 = 资料夹叶节点」以及服务端 `requireLeafFolder` 三条一致。
 *
 * 重要：**这不是把断言放宽**。套件仍然真的去建资源，只是按新契约多带一个
 * 合法字段；如果服务端拒绝，助手会**抛错并让套件失败**，不会静默跳过。
 */

/**
 * 从目录树里找一个资料夹节点的 id。
 *
 * @param {object} client  任意带 `req(method, path, body)` 的套件客户端
 * @param {{ program: string, subject: string, suffix?: string }} want
 *        `suffix` 对应四个 PDF 资料夹的 code 后缀：
 *        `outline`(课程大纲) / `lesson`(教学详案) / `resource`(教学资源) /
 *        `assessment`(考核评估)，默认 `outline`。
 * @returns {Promise<string>} 资料夹节点的 uuid
 */
export async function folderIdFor(client, want) {
  const suffix = want.suffix ?? 'outline';
  const tree = await client.req('GET', '/api/directories/tree');
  // 套件里的客户端有两种返回形状：`{s, d}`（HTTP 套件的惯例）与
  // `{status, data}`（files-http / naming-http 的惯例）。两种都要认 ——
  // 只认一种的后果是"取不到目录树"这种**与产品无关**的报错，
  // 而它会以套件整体失败的形式出现，浪费掉一整轮排查。
  const roots = tree?.d?.roots ?? tree?.roots ?? tree?.data?.roots ?? [];
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(
      '取不到目录树（GET /api/directories/tree 返回空）。' +
        '§8 要求新建资源必须带 directoryId，拿不到资料夹就无法继续 —— 这里刻意抛错而不是跳过。',
    );
  }

  /**
   * 深度优先收集资料夹。
   *
   * 判定**只看 code 前缀 + 后缀**，不看 `subject`（规范 token）也与显示名无关。
   * 为什么：`want.subject` 允许写成 `chinese:arts` 这种**路径式**写法
   * （子科在 code 里是一段，`k:chinese:arts_resource`），
   * 而 `node.subject` 对子科节点是规范 token（`chinese`），两者不是一回事。
   * 第一版拿 `node.subject` 去比，于是 `k/chinese:arts` 一个都匹配不上，
   * 套件直接以"找不到资料夹"失败 —— 而这与产品毫无关系。
   *
   * 规则：资料夹的 code 必须
   *   · 以 `<program>:<subject>_` 开头（`k:chinese:arts_resource` 满足
   *     `k:chinese:arts_`），或
   *   · 对科目本身以 `<program>:<subject>` 开头再跟 `_suffix`
   * 且以 `_<suffix>` 结尾。
   */
  const prefix = `${want.program}:${want.subject}`;
  const hits = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (
        node.type === 'folder' &&
        node.code.endsWith(`_${suffix}`) &&
        (node.code.startsWith(`${prefix}_`) || node.code === `${prefix}_${suffix}`)
      ) {
        hits.push(node);
      }
      walk(node.children ?? []);
    }
  };
  walk(roots);

  if (hits.length === 0) {
    throw new Error(
      `目录树里找不到 ${want.program}/${want.subject} 下以 _${suffix} 结尾的资料夹；` +
        '§8 的目录归属无法满足，套件必须失败而不是绕过。' +
        `（已看到的资料夹 code：${JSON.stringify(
          (() => {
            const all = [];
            const collect = (ns) => {
              for (const n of ns ?? []) {
                if (n.type === 'folder') all.push(n.code);
                collect(n.children ?? []);
              }
            };
            collect(roots);
            return all.slice(0, 8);
          })(),
        )}）`,
    );
  }
  return hits[0].id;
}
