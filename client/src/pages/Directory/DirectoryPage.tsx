import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { directories as directoriesApi, resources as resourcesApi } from '../../api';
import { useTranslation } from '../../i18n/useTranslation';
import type { TranslationKey } from '../../i18n/translations';
import { ResourceCard } from '../../components/resource-card';
import type { DirectoryNode, DirectoryTreeResponse, Resource } from '@shared/api.interface';

/**
 * 目录页（§1/§2/§20/§24/§25/§26）—— PDF《教师平台》权威目录树的渲染器。
 *
 * 与既有页面（PreKHomePage / KHomePage / SubjectPage）的关系：
 *   既有页面渲染的是「课程卡片」，其结构常量在 `shared/curriculum.ts`；
 *   本页渲染的是**数据库里那棵完整目录树**，含 PDF 的两个根
 *   （教育教学 / 教师成长）、PDF 新增的科目，以及「允许自建文件夹」标记。
 *
 * 关键约束：**这一页不许有任何写死的结构兜底**。
 * 如果接口失败，就显示失败与重试，而不是回退到一份硬编码的旧目录 ——
 * 后者会让"管理员改了目录但页面没变"这种静默失败重新出现，
 * 而静默失败正是这一轮要消灭的东西。
 */
export default function DirectoryPage() {
  const { t, language } = useTranslation();
  const [tree, setTree] = useState<DirectoryTreeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * 是否把已停用节点也显示出来。
   *
   * 默认 false（看不到），但**必须能打开** —— 否则"停用"是单向门：
   * 停掉之后节点从树上消失，界面上再也找不回来（实测确认过）。
   * 这个开关只在 `canManage` 时显示；服务端也只在有管理权时才认这个参数。
   */
  const [showDisabled, setShowDisabled] = useState<boolean>(false);
  /**
   * 当前**选中**的目录节点（§1：目录页要能查到该目录下的资源）。
   * 存整节而不是只存 code：面板标题要显示名字，只存 code 就得再遍历一次树，
   * 而且刷新后名字变了会对不上。
   */
  const [selected, setSelected] = useState<DirectoryNode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await directoriesApi.getDirectoryTree({ includeDisabled: showDisabled });
      setTree(data);
      // 只**首次**设置默认展开（两个根）；之后刷新保留用户当前的展开状态。
      //
      // 第一版每次 load 都重置成"只展开根"，后果很实际：新建一个文件夹后视图
      // 立刻折叠回顶部，用户看不到自己刚建的东西，也丢了原来的位置。
      // 这个缺陷是浏览器测试暴露的 —— 接口层全绿，界面却"点了没反应"。
      setExpanded((prev) => {
        if (prev.size === 0) return new Set((data?.roots ?? []).map((r) => r.code));
        const known = new Set<string>();
        const walk = (nodes: DirectoryNode[]) => {
          for (const n of nodes) { known.add(n.code); walk(n.children); }
        };
        walk(data?.roots ?? []);
        // 丢掉已经不存在的节点，避免状态里堆积无效 code（例如刚被删掉的）
        const next = new Set<string>();
        for (const code of prev) if (known.has(code)) next.add(code);
        return next;
      });
    } catch (e) {
      // handleApiError 会把后端错误转成可读文本并以 reject 形式抛出，
      // 这里**必须**把失败显示出来，不能吞掉后渲染空树。
      setError(e instanceof Error ? e.message : String(e));
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, [showDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 写操作（§24/§25/§26）：新建 / 改名 / 删除自建文件夹 ----
  // 入口是否显示由**服务端算出的 tree.canManage** 决定（生效权限），不是按角色猜。
  // 就算显示错了也不会越权：写接口自己有 @RequirePermission，服务层还有规则校验。
  const [editing, setEditing] = useState<{ mode: 'create' | 'rename'; code: string } | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  /**
   * 英文名（§1「改中英文名」）。中文名与英文名是两个独立字段：
   * 英文界面（en-US）读 `nameEn`，丢掉它就等于英文界面看不到自己改的名字。
   */
  const [draftNameEn, setDraftNameEn] = useState<string>('');
  /**
   * 中文说明（§5「说明/内容可编辑」）。
   *
   * ⚠️ 这一格此前**根本不存在**：数据库有 `directories.description` 列、
   * 服务层也接受并写入它，但管理界面只有名称与英文名两个输入框 ——
   * 于是"说明"在界面上**完全不可编辑**。一个"库里支持、界面上够不着"的字段，
   * 等价于没有。§16 把"目录说明可编辑"单独列成一条验收项，正是因为这种
   * "后端有、前端没有"的半成品最难被发现：接口测试全绿。
   */
  const [draftDescription, setDraftDescription] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const submitEdit = useCallback(
    async (parentOrSelfCode: string, mode: 'create' | 'rename') => {
      const name = draftName.trim();
      if (name === '') {
        setActionError(t('directory.nameRequired'));
        return;
      }
      const nameEn = draftNameEn.trim();
      // 说明可以留空 —— 留空表示**清空说明**（服务端把空串落成 NULL）。
      // 所以这里总是把输入框的当前值传下去，让"清空"成为一个可执行的操作，
      // 而不是靠"不传字段"来表达（那会变成"不改动"，两者语义完全不同）。
      const description = draftDescription.trim();
      setBusy(true);
      setActionError(null);
      try {
        if (mode === 'create') {
          await directoriesApi.createDirectoryFolder({
            parentCode: parentOrSelfCode,
            name,
            // 留空就不传：服务端会以中文名兜底，而不是写入空字符串。
            ...(nameEn === '' ? {} : { nameEn }),
          });
          // 展开父节点，让新建出来的子文件夹**立刻可见**（见 load() 的注释）
          setExpanded((prev) => new Set(prev).add(parentOrSelfCode));
        } else {
          await directoriesApi.updateDirectoryNode(parentOrSelfCode, {
            name,
            ...(nameEn === '' ? {} : { nameEn }),
            description,
          });
        }
        setEditing(null);
        setDraftName('');
        setDraftNameEn('');
        setDraftDescription('');
        await load();
      } catch (e) {
        // 失败必须显示出来。吞掉错误会让"点了没反应"变成用户唯一能得到的反馈，
        // 而这正是这一轮要消灭的假成功形态。
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [draftName, draftNameEn, draftDescription, load, t],
  );

  const removeNode = useCallback(
    async (code: string, name: string) => {
      if (typeof window !== 'undefined' && !window.confirm(t('directory.confirmDelete').replace('{name}', name))) {
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        await directoriesApi.deleteDirectoryNode(code);
        await load();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  /**
   * 排序（§1「排序」）—— 与**相邻兄弟**交换相对位置。
   *
   * 实现选择：只 PATCH **当前节点**一个值，而不是把整组兄弟按新顺序重写一遍。
   *   * 上移：把 sortOrder 设为「上一个兄弟的 sortOrder − 1」
   *   * 下移：把 sortOrder 设为「下一个兄弟的 sortOrder + 1」
   *
   * 这样一次点击 = 一次请求，失败时不会留下"改了一半"的中间状态。
   * 如果两个兄弟的 sortOrder 相同（历史数据里很常见），上面的算法**依然**能
   * 得到正确的相对顺序（5 → 4、6），不需要先做一次归一化。
   *
   * 代价：反复移动会让数值缓慢漂移。服务端把范围钳在 ±100000 并会在超界时
   * 明确报错，而不是静默夹断 —— 真到那一步用户会看到错误提示，
   * 由管理员重新排序即可，不会出现"点了没反应"。
   */
  const moveNode = useCallback(
    async (node: DirectoryNode, siblings: DirectoryNode[], direction: 'up' | 'down') => {
      const idx = siblings.findIndex((s) => s.code === node.code);
      if (idx < 0) return;
      const neighbor = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
      if (!neighbor) return;
      const base = Number(neighbor.sortOrder ?? 0);
      const next = direction === 'up' ? base - 1 : base + 1;
      setBusy(true);
      setActionError(null);
      try {
        await directoriesApi.updateDirectoryNode(node.code, { sortOrder: next });
        await load();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /**
   * 启用 / 停用（§1「启用停用」）。
   *
   * 停用后节点会从**普通**树上消失，所以列表里必须有一个"显示已停用"开关，
   * 否则这是单向门。停用与启用走同一个接口，只是 `enabled` 取反。
   */
  const toggleEnabled = useCallback(
    async (node: DirectoryNode) => {
      setBusy(true);
      setActionError(null);
      try {
        await directoriesApi.updateDirectoryNode(node.code, { enabled: !node.enabled });
        await load();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const toggle = useCallback((code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const label = useCallback(
    (node: DirectoryNode) => (language === 'en-US' ? node.nameEn : node.name),
    [language],
  );

  const totalNodes = useMemo(() => countNodes(tree?.roots ?? []), [tree]);

  if (loading) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-primary" />
        <span className="text-muted-foreground">{t('common.loading')}</span>
      </Centered>
    );
  }

  if (error || !tree) {
    return (
      <Centered>
        <AlertCircle className="size-8 text-[#D98B8B]" />
        <p className="text-[#2D2A3E] font-medium">{t('directory.loadFailed')}</p>
        <p className="text-sm text-muted-foreground max-w-lg text-center break-all">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 bg-primary hover:bg-primary-dark text-white rounded-lg px-5 py-2"
        >
          {t('common.retry')}
        </button>
      </Centered>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-[#2D2A3E]">{t('directory.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('directory.subtitle')}</p>
        <p className="mt-1 text-sm text-[#6B6878]" data-testid="directory-browse-hint">
          {t('directory.browseHint')}
        </p>
        <p className="mt-2 text-sm text-[#6B6878]">
          {t('directory.summary')
            .replace('{nodes}', String(totalNodes))
            .replace('{custom}', String(tree.customFolderLeafCount))}
        </p>

        {/*
          「显示已停用」开关（仅管理权可见）。
          没有它，"停用"就是单向门 —— 节点从树上消失后再也找不回来，
          于是"停用"实际上等于"删除"，而这与 §1 要求的"启用停用"是两回事。
        */}
        {tree.canManage && (
          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-[#6B6878]">
            <input
              type="checkbox"
              data-testid="directory-show-disabled"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
              className="size-4 rounded border-[#E8E4F0]"
            />
            {t('directory.showDisabled')}
          </label>
        )}
      </header>

      {/*
        被权限剪掉的科目要**说出来**。否则页面只是少了几个分支，用户无法区分
        「这个科目没有资源」与「你没有这个科目的权限」—— 这正是 §17/§22 要求
        消除的那种「把 403 渲染成暂无数据」的误导。
      */}
      {tree.hiddenSubjectCodes.length > 0 && (
        <div className="mb-5 rounded-xl border border-[#E8E4F0] bg-white p-4">
          <p className="text-sm text-[#6B6878]">
            {t('directory.scopeNote').replace('{count}', String(tree.hiddenSubjectCodes.length))}
          </p>
        </div>
      )}

      {/* data-testid：浏览器 E2E 必须能**只读这棵树**。
          第一版断言直接读整页 innerText，结果读到的是左侧导航栏 ——
          于是「Pre-K 下有美德/蒙特梭利/体能」被侧边栏满足、看起来通过了，
          而真正要断言的目录树根本没被检查。测试读错元素 = 假证据。 */}
      {actionError && (
        <div
          className="mb-4 rounded-xl border border-[#D98B8B] bg-white p-4"
          data-testid="directory-action-error"
        >
          <p className="text-sm text-[#2D2A3E]">{actionError}</p>
        </div>
      )}

      <div className="space-y-3" data-testid="directory-tree">
        {tree.roots.map((root) => (
          <TreeNode
            key={root.code}
            node={root}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            label={label}
            t={t}
            canManage={tree.canManage}
            onSelect={setSelected}
            editing={editing}
            draftName={draftName}
            busy={busy}
            onStartCreate={(code) => {
              setActionError(null);
              setDraftName('');
              setDraftNameEn('');
              setDraftDescription('');
              setEditing({ mode: 'create', code });
            }}
            onStartRename={(code, current, currentEn, currentDesc) => {
              setActionError(null);
              setDraftName(current);
              // 英文名与说明一并预填：只预填中文会让用户在不知情的情况下
              // **清空**英文名与说明（保存时我们把输入框的值原样提交）。
              setDraftNameEn(currentEn ?? '');
              setDraftDescription(currentDesc ?? '');
              setEditing({ mode: 'rename', code });
            }}
            onDraftChange={setDraftName}
            onDraftNameEnChange={setDraftNameEn}
            onDraftDescriptionChange={setDraftDescription}
            draftNameEn={draftNameEn}
            draftDescription={draftDescription}
            onSubmitEdit={submitEdit}
            onCancelEdit={() => {
              setEditing(null);
              setDraftName('');
              setDraftNameEn('');
              setDraftDescription('');
            }}
            onDelete={removeNode}
            onMove={moveNode}
            onToggleEnabled={toggleEnabled}
            siblings={tree.roots}
            siblingIndex={0}
          />
        ))}
      </div>

      {/*
        §1「目录页能查到该目录下资源」。
        用目录页**已有**的卡片组件渲染（ResourceCard），不另造一套列表 UI ——
        整站 UI 不重做是明确要求。
      */}
      {selected && (
        <DirectoryResourcesPanel
          node={selected}
          label={label(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * 某个目录下的资源列表。
 *
 * 口径说明（容易误解，所以写在代码里）：
 *   服务端 `?directory=` 过滤的是**子树**，不只是这一个节点 —— 选「蒙特梭利」
 *   会看到它下面四个资料夹的全部资源。面板上明确写出这一点，否则用户会以为
 *   数字对不上（父节点 0 条、点开却有 20 条）。
 */
function DirectoryResourcesPanel({
  node,
  label,
  onClose,
}: {
  node: DirectoryNode;
  label: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Resource[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const resp = await resourcesApi.getResources({ directory: node.code, pageSize: 24 });
        if (cancelled) return;
        setItems(resp.items ?? []);
        setTotal(resp.total ?? 0);
      } catch (err) {
        if (cancelled) return;
        // 失败就说失败。把 403/500 渲染成"暂无数据"正是这一轮要消灭的误导。
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.code]);

  return (
    <section
      className="mt-6 rounded-xl border border-[#E8E4F0] bg-white p-6 shadow-sm"
      data-testid="directory-resources"
      data-dir-resources={node.code}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[#2D2A3E]">
            {t('directory.resourcesTitle').replace('{name}', label)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('directory.resourcesSubtreeNote')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="directory-resources-close"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[#6B6878] hover:bg-[#FAF8FF]"
          aria-label={t('common.close')}
        >
          <X className="size-4" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="text-sm">{t('common.loading')}</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-[#D98B8B] bg-[#FFF7F7] p-4" data-testid="directory-resources-error">
          <p className="text-sm text-[#2D2A3E]">{t('directory.resourcesFailed')}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
        </div>
      )}

      {!loading && !error && total === 0 && (
        <p className="py-6 text-sm text-muted-foreground" data-testid="directory-resources-empty">
          {t('directory.resourcesEmpty')}
        </p>
      )}

      {!loading && !error && total > 0 && (
        <>
          <p className="mb-3 text-sm text-[#6B6878]">
            {t('directory.resourcesCount')
              .replace('{shown}', String(items.length))
              .replace('{total}', String(total))}
          </p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((r) => (
              <ResourceCard key={r.id} resource={r} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface TreeNodeActions {
  canManage: boolean;
  onSelect: (node: DirectoryNode) => void;
  editing: { mode: 'create' | 'rename'; code: string } | null;
  draftName: string;
  busy: boolean;
  onStartCreate: (code: string) => void;
  onStartRename: (
    code: string,
    currentName: string,
    currentNameEn?: string,
    currentDescription?: string | null,
  ) => void;
  onDraftChange: (value: string) => void;
  onDraftNameEnChange: (value: string) => void;
  onDraftDescriptionChange: (value: string) => void;
  draftNameEn: string;
  draftDescription: string;
  onSubmitEdit: (code: string, mode: 'create' | 'rename') => void;
  onCancelEdit: () => void;
  onDelete: (code: string, name: string) => void;
  onMove: (node: DirectoryNode, siblings: DirectoryNode[], direction: 'up' | 'down') => void;
  onToggleEnabled: (node: DirectoryNode) => void;
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  label,
  t,
  // ⚠️ siblings / siblingIndex 必须在这里**被解构掉**，不能留在 `actions` 里。
  // 它们会原样透传给子节点（`{...actions}`），而 JSX 里后写的同名 prop 生效 ——
  // 于是显式的 `siblings={node.children}` 被覆盖，每个节点都以为自己有一堆兄弟，
  // 上移/下移查不到自己的位置，点了没反应（实测踩到过）。
  siblings,
  siblingIndex,
  ...actions
}: {
  node: DirectoryNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (code: string) => void;
  label: (node: DirectoryNode) => string;
  t: (key: TranslationKey) => string;
  /** 同级兄弟列表（判断能不能上移/下移）。由父节点给出，TreeNode 不自己去树里反查。 */
  siblings: DirectoryNode[];
  siblingIndex: number;
} & TreeNodeActions) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.code);
  const isRoot = node.type === 'root';
  // 只有"允许自建"的资料夹、或自建文件夹本身，才可能出现新建入口 ——
  // 与服务层的规则一致（服务端仍会独立校验，这里只是不显示点不动的按钮）。
  const canCreateHere =
    actions.canManage && (node.allowCustomFolders || (node.type === 'folder' && !node.isSystem));
  /**
   * ⚠️ **改名对所有节点开放（含正式目录）**，这不是疏忽，是 §5 的明确要求：
   *   「删除 isSystem => 不允许改名的限制（那是之前擅自增加的）……
   *     显示名可改，内部稳定 code 不变。」
   *
   * 上一轮我只删掉了**服务端**那条 403，却漏了界面上这个开关 ——
   * 于是"能不能改名"在界面上仍然是否定的：管理员根本看不到改名按钮。
   * 而当时的验证走的是 **API**（直接 PATCH），所以看起来是通过的：
   * 一个"接口能做、界面做不到"的半成品，接口测试全绿。
   * 这正是必须**真浏览器**回归的理由。
   *
   * 删除**仍然**只对自建节点开放：`is_system` 的行是 PDF 权威结构，
   * 删掉它会让历史资源与审计失去锚点。§5 放宽的是"改名"，不是"删除"。
   */
  const canRenameHere = actions.canManage;
  const canDeleteHere = actions.canManage && !node.isSystem;
  const isCreating = actions.editing?.mode === 'create' && actions.editing.code === node.code;
  const isRenaming = actions.editing?.mode === 'rename' && actions.editing.code === node.code;
  const isDisabled = !node.enabled;
  // 排序与启停都属于"改结构"。改名已对全部节点开放（见上），
  // 删除仍限自建节点；排序/启停对全部节点开放（不改任何业务含义）。
  const canSortHere = actions.canManage && siblings.length > 1;
  const canMoveUp = canSortHere && siblingIndex > 0;
  const canMoveDown = canSortHere && siblingIndex < siblings.length - 1;
  const canToggleEnabledHere = actions.canManage && !isRoot;

  return (
    <div
      className={
        (isRoot ? 'rounded-xl border border-[#E8E4F0] bg-white shadow-sm' : '') +
        // 已停用的节点整行变暗：它出现在列表里只因为开了「显示已停用」，
        // 如果和正常节点长得一样，用户会以为它还在生效。
        (isDisabled ? ' opacity-55' : '')
      }
      data-dir-code={node.code}
      data-dir-type={node.type}
      data-dir-enabled={node.enabled ? 'true' : 'false'}
      // 节点**自己**的名字。不能靠 innerText 找节点：父节点的 innerText 包含
      // 整棵子树，用"文本包含"去定位会命中根节点（我在 E2E 里就踩过，
      // 于是"删掉刚建的那个"变成了"删根节点"，被 403 拒绝）。
      data-dir-name={node.name}
    >
      <div
        className={`flex items-center gap-2 ${isRoot ? 'p-6' : `${depth > 1 ? 'py-2' : 'py-3'} px-4`}`}
        style={!isRoot ? { paddingLeft: `${16 + depth * 20}px` } : undefined}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.code)}
            aria-expanded={isOpen}
            aria-label={label(node)}
            data-dir-toggle={node.code}
            className="flex size-5 shrink-0 items-center justify-center rounded text-[#6B6878] hover:bg-[#FAF8FF]"
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}

        {/*
          目录名本身是**按钮**：§1 要求"目录页能查到该目录下资源"，所以要有一个
          明确的、可点的入口。根节点不可点（根下面就是班型，列资源没有意义）。
        */}
        {isRoot ? (
          <span className="text-xl font-semibold text-[#2D2A3E]">{label(node)}</span>
        ) : (
          <button
            type="button"
            onClick={() => actions.onSelect(node)}
            data-testid="directory-browse"
            data-dir-browse={node.code}
            className={
              'rounded text-left hover:underline ' +
              (node.type === 'program' || node.type === 'subject' || node.type === 'growth_level'
                ? 'text-lg font-semibold text-[#2D2A3E]'
                : 'text-base text-[#2D2A3E]')
            }
          >
            {label(node)}
          </button>
        )}

        {/* 「允许自建文件夹」是 PDF 的明确标注，必须在页面上看得见 */}
        {node.allowCustomFolders && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#FAF8FF] px-3 py-1 text-xs font-medium text-primary-dark">
            <FolderPlus className="size-3" />
            {t('directory.allowCustomFolders')}
          </span>
        )}

        {/* 资源数只在服务端给出可信数字的节点上显示（科目层）。 */}
        {node.resourceCount > 0 && (
          <span className="rounded-full bg-[#FAF8FF] px-3 py-1 text-xs font-medium text-[#6B6878]">
            {t('directory.resourceCount').replace('{count}', String(node.resourceCount))}
          </span>
        )}

        {/* 已停用徽标 —— 必须显式写出来，不能只靠"变暗"这一个视觉线索 */}
        {isDisabled && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[#FFF7F7] px-3 py-1 text-xs font-medium text-[#D98B8B]"
            data-dir-disabled-badge={node.code}
          >
            <EyeOff className="size-3" />
            {t('directory.disabled')}
          </span>
        )}

        {/* 「可自建」标记：自建节点也标出来，便于与 PDF 权威节点区分 */}
        {!node.isSystem && (
          <span
            className="rounded-full bg-[#FAF8FF] px-3 py-1 text-xs font-medium text-[#6B6878]"
            data-dir-user-node={node.code}
          >
            {t('directory.userCreated')}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          {canCreateHere && !isCreating && (
            <button
              type="button"
              data-dir-create={node.code}
              onClick={() => actions.onStartCreate(node.code)}
              title={t('directory.newFolder')}
              className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark"
            >
              <Plus className="size-4" />
            </button>
          )}
          {canRenameHere && !isRenaming && (
            <button
              type="button"
              data-dir-rename={node.code}
              onClick={() =>
                actions.onStartRename(node.code, node.name, node.nameEn, node.description)
              }
              title={t('directory.rename')}
              className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark"
            >
              <Pencil className="size-4" />
            </button>
          )}
          {canSortHere && (
            <>
              <button
                type="button"
                data-dir-move-up={node.code}
                onClick={() => actions.onMove(node, siblings, 'up')}
                disabled={!canMoveUp || actions.busy}
                title={t('directory.moveUp')}
                className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
              <button
                type="button"
                data-dir-move-down={node.code}
                onClick={() => actions.onMove(node, siblings, 'down')}
                disabled={!canMoveDown || actions.busy}
                title={t('directory.moveDown')}
                className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark disabled:opacity-30"
              >
                <ArrowDown className="size-4" />
              </button>
            </>
          )}
          {canToggleEnabledHere && (
            <button
              type="button"
              data-dir-toggle-enabled={node.code}
              onClick={() => actions.onToggleEnabled(node)}
              disabled={actions.busy}
              title={isDisabled ? t('directory.enable') : t('directory.disable')}
              className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark disabled:opacity-40"
            >
              {isDisabled ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
            </button>
          )}
          {canDeleteHere && (
            <button
              type="button"
              data-dir-delete={node.code}
              onClick={() => actions.onDelete(node.code, node.name)}
              disabled={actions.busy}
              title={t('directory.delete')}
              className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-[#D98B8B] disabled:opacity-40"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </span>
      </div>

      {/* 内联表单：新建/改名。刻意不用弹窗 —— 这是一棵长列表，
          弹窗会遮住"这个文件夹在树里的哪个位置"，而那正是用户要确认的事。 */}
      {(isCreating || isRenaming) && (
        <div
          className="flex flex-wrap items-center gap-2 px-4 pb-3"
          style={{ paddingLeft: `${16 + (depth + 1) * 20}px` }}
        >
          <input
            autoFocus
            value={actions.draftName}
            data-dir-name-input={node.code}
            onChange={(e) => actions.onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') actions.onSubmitEdit(node.code, isCreating ? 'create' : 'rename');
              if (e.key === 'Escape') actions.onCancelEdit();
            }}
            placeholder={t('directory.namePlaceholder')}
            className="rounded-lg border border-[#E8E4F0] px-3 py-1.5 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {/*
            英文名（§1「改中英文名」）。中文名必填、英文名可空 ——
            留空时服务端以中文名兜底，不会写入空串。
          */}
          <input
            value={actions.draftNameEn}
            data-dir-name-en-input={node.code}
            onChange={(e) => actions.onDraftNameEnChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') actions.onSubmitEdit(node.code, isCreating ? 'create' : 'rename');
              if (e.key === 'Escape') actions.onCancelEdit();
            }}
            placeholder={t('directory.nameEnPlaceholder')}
            className="rounded-lg border border-[#E8E4F0] px-3 py-1.5 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {/*
            说明（§5「说明/内容可编辑」）。
            刻意**只在重命名态**出现：新建一个文件夹时先写说明没有意义，
            而且会让新建行变得很宽、把树的位置感挤掉。
          */}
          {isRenaming && (
            <input
              value={actions.draftDescription}
              data-dir-desc-input={node.code}
              onChange={(e) => actions.onDraftDescriptionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') actions.onSubmitEdit(node.code, 'rename');
                if (e.key === 'Escape') actions.onCancelEdit();
              }}
              placeholder={t('directory.descriptionPlaceholder')}
              className="min-w-[14rem] flex-1 rounded-lg border border-[#E8E4F0] px-3 py-1.5 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          )}
          <button
            type="button"
            data-dir-submit={node.code}
            disabled={actions.busy}
            onClick={() => actions.onSubmitEdit(node.code, isCreating ? 'create' : 'rename')}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-dark disabled:opacity-40"
          >
            {isCreating ? t('directory.newFolder') : t('directory.rename')}
          </button>
          <button
            type="button"
            onClick={actions.onCancelEdit}
            className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {hasChildren && isOpen && (
        <div className={isRoot ? 'border-t border-[#E8E4F0] py-2' : ''}>
          {node.children.map((child, childIndex) => (
            <TreeNode
              key={child.code}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              label={label}
              t={t}
              // 兄弟列表与下标由**父节点**给出：TreeNode 自己去树里反查父级既慢
              // 又容易在过滤后的树上算错（被权限剪掉的兄弟不该参与排序判断）。
              siblings={node.children}
              siblingIndex={childIndex}
              {...actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countNodes(nodes: DirectoryNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + countNodes(node.children);
  }
  return n;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-3 p-16">{children}</div>;
}
