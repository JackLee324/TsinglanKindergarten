import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { directories as directoriesApi } from '../../api';
import { useTranslation } from '../../i18n/useTranslation';
import type { TranslationKey } from '../../i18n/translations';
import type { DirectoryNode, DirectoryTreeResponse } from '@shared/api.interface';

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await directoriesApi.getDirectoryTree();
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 写操作（§24/§25/§26）：新建 / 改名 / 删除自建文件夹 ----
  // 入口是否显示由**服务端算出的 tree.canManage** 决定（生效权限），不是按角色猜。
  // 就算显示错了也不会越权：写接口自己有 @RequirePermission，服务层还有规则校验。
  const [editing, setEditing] = useState<{ mode: 'create' | 'rename'; code: string } | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const submitEdit = useCallback(
    async (parentOrSelfCode: string, mode: 'create' | 'rename') => {
      const name = draftName.trim();
      if (name === '') {
        setActionError(t('directory.nameRequired'));
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        if (mode === 'create') {
          await directoriesApi.createDirectoryFolder({ parentCode: parentOrSelfCode, name });
          // 展开父节点，让新建出来的子文件夹**立刻可见**（见 load() 的注释）
          setExpanded((prev) => new Set(prev).add(parentOrSelfCode));
        } else {
          await directoriesApi.updateDirectoryNode(parentOrSelfCode, { name });
        }
        setEditing(null);
        setDraftName('');
        await load();
      } catch (e) {
        // 失败必须显示出来。吞掉错误会让"点了没反应"变成用户唯一能得到的反馈，
        // 而这正是这一轮要消灭的假成功形态。
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [draftName, load, t],
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
        <p className="mt-2 text-sm text-[#6B6878]">
          {t('directory.summary')
            .replace('{nodes}', String(totalNodes))
            .replace('{custom}', String(tree.customFolderLeafCount))}
        </p>
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
            editing={editing}
            draftName={draftName}
            busy={busy}
            onStartCreate={(code) => {
              setActionError(null);
              setDraftName('');
              setEditing({ mode: 'create', code });
            }}
            onStartRename={(code, current) => {
              setActionError(null);
              setDraftName(current);
              setEditing({ mode: 'rename', code });
            }}
            onDraftChange={setDraftName}
            onSubmitEdit={submitEdit}
            onCancelEdit={() => {
              setEditing(null);
              setDraftName('');
            }}
            onDelete={removeNode}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeActions {
  canManage: boolean;
  editing: { mode: 'create' | 'rename'; code: string } | null;
  draftName: string;
  busy: boolean;
  onStartCreate: (code: string) => void;
  onStartRename: (code: string, currentName: string) => void;
  onDraftChange: (value: string) => void;
  onSubmitEdit: (code: string, mode: 'create' | 'rename') => void;
  onCancelEdit: () => void;
  onDelete: (code: string, name: string) => void;
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  label,
  t,
  ...actions
}: {
  node: DirectoryNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (code: string) => void;
  label: (node: DirectoryNode) => string;
  t: (key: TranslationKey) => string;
} & TreeNodeActions) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.code);
  const isRoot = node.type === 'root';
  // 只有"允许自建"的资料夹、或自建文件夹本身，才可能出现新建入口 ——
  // 与服务层的规则一致（服务端仍会独立校验，这里只是不显示点不动的按钮）。
  const canCreateHere =
    actions.canManage && (node.allowCustomFolders || (node.type === 'folder' && !node.isSystem));
  const canRenameHere = actions.canManage && !node.isSystem;
  const canDeleteHere = actions.canManage && !node.isSystem;
  const isCreating = actions.editing?.mode === 'create' && actions.editing.code === node.code;
  const isRenaming = actions.editing?.mode === 'rename' && actions.editing.code === node.code;

  return (
    <div
      className={isRoot ? 'rounded-xl border border-[#E8E4F0] bg-white shadow-sm' : ''}
      data-dir-code={node.code}
      data-dir-type={node.type}
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

        <span
          className={
            isRoot
              ? 'text-xl font-semibold text-[#2D2A3E]'
              : node.type === 'program' || node.type === 'subject' || node.type === 'growth_level'
                ? 'text-lg font-semibold text-[#2D2A3E]'
                : 'text-base text-[#2D2A3E]'
          }
        >
          {label(node)}
        </span>

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
              onClick={() => actions.onStartRename(node.code, node.name)}
              title={t('directory.rename')}
              className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF] hover:text-primary-dark"
            >
              <Pencil className="size-4" />
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
          className="flex items-center gap-2 px-4 pb-3"
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
          {node.children.map((child) => (
            <TreeNode
              key={child.code}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              label={label}
              t={t}
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
