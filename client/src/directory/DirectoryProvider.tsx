import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DirectoryNode, DirectoryTreeResponse } from '@shared/api.interface';

import { getDirectoryTree } from '../api/directories';
import { useAuth } from '../auth/useAuth';
import { logger } from '@client/src/lib/logger';

/**
 * 目录（Directory）的**唯一前端数据源**。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 在它之前，"目录"这件事在前端有**五份互不知情的副本**：
 *   * `Layout.tsx` 里手写一份 `menuItems`（侧边栏菜单）；
 *   * `PreKHomePage.tsx` 里手写 `PREK_SUBJECTS`（Pre-K 科目卡片）；
 *   * `KHomePage.tsx` 里手写 `K_SUBJECTS`（K 科目卡片）；
 *   * `SubjectPage.tsx` / `MontessoriPage.tsx` / `ChinesePage.tsx` /
 *     `EnglishPage.tsx` / `PEPage.tsx` 各自再写一份要渲染哪些子分类与资料夹；
 *   * `UploadPage.tsx` 里再写一份"资料夹选项"。
 *
 * 于是"改目录"= 改五个文件 + 重新发布，而**数据库里那棵权威树根本没被这些页面读过**。
 * `/directory` 页读的是数据库，但它只被当成"管理员维护目录的后台"，
 * 教师日常浏览走的是那五份硬编码 —— 这就是业主说的
 * 「目录页叫 A、首页叫 B、侧边栏叫 C」的机制性来源：
 * 它们在**不同时间、由不同代码**渲染，改一处不会动另一处。
 *
 * 本文件把数据源收敛成**一处**：数据库 → `GET /api/directories/tree` → 这里 → 所有页面。
 * 任何页面（侧边栏 / 首页 / 科目页 / 上传 / 资源列表 / 面包屑）都只允许通过
 * `useDirectory()` 拿目录，不再自己定义科目表。
 *
 * ⚠️ 注意这里**没有菜单常量**。侧边栏将来渲染什么，完全由服务端按角色剪枝后的
 * `roots` 决定；本文件只提供"怎么按 code 找、怎么从 code 生成 URL"这类纯函数。
 */

export interface DirectoryContextValue {
  /** 服务端按当前账号角色剪枝后的树；未就绪时为 null。 */
  tree: DirectoryTreeResponse | null;
  roots: DirectoryNode[];
  loading: boolean;
  /**
   * **是否已经拿到过一份确定的结论**（成功拿到树，或明确失败）。
   *
   * 为什么不能只看 `loading`：`loading` 的初始值是 `false`（此时 fetch 还没开始，
   * 因为要等权限就绪）。于是"首帧"与"加载完了但树是空的"在 `loading` 上长得一样，
   * 任何"等树就绪再决定"的逻辑都会在首帧用**空树**下结论。
   * 实测后果：旧 URL 兼容层在首帧就把 `/prek/virtue` 判成"解析不出来"，
   * 于是跳到 `/directory` —— 老师的书签变成一个不相关的页面。
   */
  ready: boolean;
  /**
   * 加载失败的原因（已本地化前的原始串）。**不要**把它和"没有目录"混为一谈：
   * 失败时 `roots` 是空数组，页面若直接渲染空数组就会显示成"这里什么都没有"，
   * 而真实原因是网络或权限接口挂了。
   */
  error: string | null;
  /** 调用方是否有 `curriculum.manage`（决定 `/directory` 是否露出"管理"入口）。 */
  canManage: boolean;
  /** 重新拉取（改名 / 新建 / 停用之后必须调用，否则页面还显示旧名字）。 */
  refresh: () => Promise<void>;
  /** code → 节点。包含**全部**已取回的节点（含被剪掉的子树里不存在的部分）。 */
  byCode: Map<string, DirectoryNode>;
  /** id → 节点。上传页拿到的是 directoryId，需要反查名字。 */
  byId: Map<string, DirectoryNode>;
  findByCode: (code: string | null | undefined) => DirectoryNode | null;
  findById: (id: string | null | undefined) => DirectoryNode | null;
  /** 深度优先展平（父在子前），便于做下拉选择。 */
  flatten: (from?: DirectoryNode | null) => DirectoryNode[];
  /** 从根到该节点的路径（含自己）。面包屑用它，避免每页各写一遍。 */
  pathTo: (code: string | null | undefined) => DirectoryNode[];
}

const DirectoryContext = createContext<DirectoryContextValue | null>(null);

/**
 * `code` 与 URL 的关系：**URL 由 code 推导**，不是另写一张路由表。
 *
 * code 是路径式稳定标识（`prek:virtue`、`k:chinese:reading`），
 * 把分隔符换成 `/` 就是规范 URL（`/directory/prek/virtue`）。
 * 这样"目录树长什么样"只有一个答案；新增一个科目不需要动路由文件。
 *
 * 两条规则，**都由"code 长什么样"机械决定**，调用方不需要各自拼前缀：
 *   1. `root:` 前缀不出现在 URL 里。两个根是 `root:edu`（教育教学）与
 *      `root:growth`（教师成长），照搬会得到 `/directory/root/edu` ——
 *      多一层没有任何意义的层级。
 *   2. **教师成长分支挂在 `/growth` 下**，其余挂在 `/directory` 下。
 *      §10 明确要求教师成长是一等导航入口（"不能藏在 /directory 里面"），
 *      所以 `growth:l1` 的地址是 `/growth/l1`，而不是 `/directory/growth/l1`。
 *
 * ⚠️ 第二条是本文件里**唯一**一处"知道分支叫什么"的地方，而且只影响 URL 拼写，
 * 不影响谁能看到什么（可见性完全由服务端剪枝后的树决定）。
 * 第一版没有这一条，于是所有卡片都无脑拼 `/directory` + code →
 * `/directory/growth/l1`，而侧边栏自己拼 `/growth` + code →
 * `/growth/growth/l1`：**同一个节点两个地址，其中一个还是错的**。
 * 这正是"菜单是第二份真相"的老毛病换了个位置重演，所以把它收敛到这里。
 */
export const codeToPath = (code: string): string => {
  if (code === 'root:growth' || code.startsWith('growth:')) {
    return `/${code.split(':').join('/')}`;
  }
  const tail = code.replace(/^root:/, '').split(':').join('/');
  return tail === '' ? '/directory' : `/directory/${tail}`;
};

/** `/directory/prek/virtue` 的 `prek/virtue` → `prek:virtue`。 */
export const pathToCode = (segments: string[]): string => segments.filter(Boolean).join(':');

/**
 * 旧 URL → 目录 code。**这是兼容层，不是第三份菜单。**
 *
 * 只登记那些**无法从 code 机械推导**的历史入口：
 *   * `/virtue`、`/montessori` 是跨班型的旧页面（美德在 Pre-K 与 K 各有一份）；
 *   * `/prek`、`/k` 是班型首页；
 *   * `/directory/<code 的点分写法>` 是早期 `/directory` 用过的参数形式。
 * 其余旧 URL（`/prek/virtue`、`/k/chinese/reading`…）与 code 的点分写法**逐字一致**，
 * 由 `pathToCode()` 直接命中，不需要在这里列。
 *
 * 解析失败时返回 null —— 调用方据此走 404，而不是猜一个节点出来。
 */
const LEGACY_PATH_TO_CODE: Record<string, string> = {
  virtue: 'prek:virtue',
  montessori: 'prek:montessori',
  'prek/pe': 'prek:pe',
  'k/pe': 'k:pe',
  'k/chinese': 'k:chinese',
  'k/english': 'k:english',
};

export interface LegacyTarget {
  /** 解析出来的目录节点 code。 */
  code: string;
  /**
   * **没能对应到目录节点的尾部片段**。
   *
   * 为什么允许"解析不完"而不是直接判 404：
   * 旧页面里有几层分组**不在 PDF 目录树里**，但资源确实按它们归档：
   *   · 蒙氏的子分类（日常生活 / 感官 / 数学 / 语言 / 文化）；
   *   · K 英文按 Big Unit Theme 的分组。
   * 例如 `/prek/montessori/practical-life` 有 80 条资源、`/k/english/<theme>`
   * 有 44 条。§4 明确要求「不要自行增加 PDF 没有的固定目录」，
   * 所以**不能**为了这些 URL 往树里加节点；但它们也不能变成一个死链接。
   * 于是退到最近的可解析祖先（这里是 `prek:montessori`），把尾部片段
   * 作为**筛选条件**带上 —— 老师的书签仍然打开同一个科目的同一批内容。
   */
  leftover: string[];
}

/**
 * URL 片段 → 目录节点。规则全部是机械的，**没有菜单表**：
 *   1. 原名：`prek/virtue` → `prek:virtue`
 *   2. 补根前缀：`edu` → `root:edu`（`root:` 被 codeToPath 剪掉了，这里补回来）
 *   3. 旧 URL 兼容表（只含无法机械推导的跨班型旧入口）
 *   4. 逐段回退：`prek/montessori/practical-life` → `prek:montessori` + leftover
 */
export function resolveLegacyTarget(
  segments: string[],
  byCode: Map<string, DirectoryNode>,
): LegacyTarget | null {
  const parts = segments.filter(Boolean);
  if (parts.length === 0) return null;

  const direct = pathToCode(parts);
  if (byCode.has(direct)) return { code: direct, leftover: [] };
  const rooted = `root:${direct}`;
  if (byCode.has(rooted)) return { code: rooted, leftover: [] };
  const legacy = LEGACY_PATH_TO_CODE[parts.join('/')];
  if (legacy !== undefined && byCode.has(legacy)) return { code: legacy, leftover: [] };

  // 逐段回退：每退一段再试一轮（含补 root: 前缀），第一命中即返回。
  for (let cut = parts.length - 1; cut >= 1; cut -= 1) {
    const head = parts.slice(0, cut);
    const tail = parts.slice(cut);
    const candidate = pathToCode(head);
    if (byCode.has(candidate)) return { code: candidate, leftover: tail };
    const candidateRooted = `root:${candidate}`;
    if (byCode.has(candidateRooted)) return { code: candidateRooted, leftover: tail };
    const candidateLegacy = LEGACY_PATH_TO_CODE[head.join('/')];
    if (candidateLegacy !== undefined && byCode.has(candidateLegacy)) {
      return { code: candidateLegacy, leftover: tail };
    }
  }

  return null;
}

/** 只关心 code 的调用方用这个（内部走同一条规则）。 */
export function resolveDirectoryCode(
  segments: string[],
  byCode: Map<string, DirectoryNode>,
): string | null {
  return resolveLegacyTarget(segments, byCode)?.code ?? null;
}

export const DirectoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, hasPermission, permissionsLoading } = useAuth();
  const [tree, setTree] = useState<DirectoryTreeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 防止"上一次请求慢、下一次请求快"导致旧数据覆盖新数据。
   * 改名之后 `refresh()` 与在途的首次加载竞争，是这里最现实的竞态。
   */
  const requestSeq = useRef(0);

  const canManage = hasPermission('curriculum.manage');
  // 成功或失败都算"已有结论"；只有"还没开始 / 正在进行"才是 false。
  const ready = tree !== null || error !== null;

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const resp = await getDirectoryTree();
      if (seq !== requestSeq.current) return;
      setTree(resp);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // 失败时**清空** tree：留着上一次的树会让页面显示一份已经不成立的目录，
      // 而用户以为自己看的是最新的。
      setTree(null);
      setError(err instanceof Error ? err.message : String(err));
      logger.warn('[Directory] load tree failed', String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 未登录不拉。权限集合就绪之前也不拉 —— 服务端会按角色剪枝，
    // 用"权限还没加载完"的那一刻去拉，会拿到一份被误剪的树。
    if (user === null || permissionsLoading) return;
    void load();
  }, [user, permissionsLoading, load]);

  /**
   * `code → 节点` 与 `id → 父节点` 两张索引，**在同一次遍历里建立**。
   *
   * 为什么需要父指针，而不是"从 code 的前缀推祖先"：
   * 资料夹的 code 形如 `prek:virtue_outline` —— `virtue_outline` 是**一段**，
   * 而不是 `virtue` / `outline` 两段。于是按前缀回溯只能得到
   * `['prek', 'prek:virtue_outline']`，**中间那个科目节点 `prek:virtue` 永远取不到**。
   * 实测后果有两个，都很隐蔽：
   *   · 面包屑显示「Pre-K / 课程大纲」，中间少了「美德」；
   *   · 上传页的目录下拉显示「Pre-K / 课程大纲」，四组资料夹长得一模一样、
   *     看不出属于哪个科目 —— 老师只能靠猜。
   * 而树本身就是父子关系最可靠的来源，遍历时顺手记下来即可。
   */
  const { byCode, parentById } = useMemo(() => {
    const map = new Map<string, DirectoryNode>();
    const parents = new Map<string, DirectoryNode>();
    const walk = (node: DirectoryNode): void => {
      map.set(node.code, node);
      for (const child of node.children) {
        parents.set(child.id, node);
        walk(child);
      }
    };
    for (const root of tree?.roots ?? []) walk(root);
    return { byCode: map, parentById: parents };
  }, [tree]);

  const byId = useMemo<Map<string, DirectoryNode>>(() => {
    const map = new Map<string, DirectoryNode>();
    for (const node of byCode.values()) map.set(node.id, node);
    return map;
  }, [byCode]);

  const findByCode = useCallback(
    (code: string | null | undefined): DirectoryNode | null =>
      code === null || code === undefined ? null : byCode.get(code) ?? null,
    [byCode],
  );

  const findById = useCallback(
    (id: string | null | undefined): DirectoryNode | null =>
      id === null || id === undefined ? null : byId.get(id) ?? null,
    [byId],
  );

  const flatten = useCallback((from?: DirectoryNode | null): DirectoryNode[] => {
    const out: DirectoryNode[] = [];
    const walk = (node: DirectoryNode): void => {
      out.push(node);
      for (const child of node.children) walk(child);
    };
    if (from === undefined || from === null) {
      for (const root of tree?.roots ?? []) walk(root);
    } else {
      walk(from);
    }
    return out;
  }, [tree]);

  const pathTo = useCallback(
    (code: string | null | undefined): DirectoryNode[] => {
      if (code === null || code === undefined) return [];
      const target = byCode.get(code);
      if (target === undefined) return [];
      // 沿**父指针**向上收集；父指针来自树本身，不受 code 拼写方式影响。
      const chain: DirectoryNode[] = [target];
      const seen = new Set<string>([target.id]);
      let cursor: DirectoryNode | undefined = parentById.get(target.id);
      // 上限 16 层 + 去重：目录被手工改成环时，面包屑会挂死在这里 ——
      // 症状是"整页卡住"，而原因在数据里，相距极远。
      for (let depth = 0; cursor !== undefined && depth < 16; depth += 1) {
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        chain.unshift(cursor);
        cursor = parentById.get(cursor.id);
      }
      return chain;
    },
    [byCode, parentById],
  );

  const value = useMemo<DirectoryContextValue>(
    () => ({
      tree,
      roots: tree?.roots ?? [],
      loading,
      ready,
      error,
      canManage,
      refresh: load,
      byCode,
      byId,
      findByCode,
      findById,
      flatten,
      pathTo,
    }),
    [tree, loading, ready, error, canManage, load, byCode, byId, findByCode, findById, flatten, pathTo],
  );

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>;
};

/** 所有目录读操作都必须经此 hook（禁止页面自己 `getDirectoryTree()`）。 */
export function useDirectory(): DirectoryContextValue {
  const ctx = useContext(DirectoryContext);
  if (ctx === null) {
    throw new Error('useDirectory() 必须在 <DirectoryProvider> 内使用');
  }
  return ctx;
}
