import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FolderPlus, Loader2 } from 'lucide-react';

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
      // 默认展开两个根，便于一眼看到全貌；下层点开。
      setExpanded(new Set((data?.roots ?? []).map((r) => r.code)));
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
          />
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  label,
  t,
}: {
  node: DirectoryNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (code: string) => void;
  label: (node: DirectoryNode) => string;
  t: (key: TranslationKey) => string;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.code);
  const isRoot = node.type === 'root';

  return (
    <div
      className={isRoot ? 'rounded-xl border border-[#E8E4F0] bg-white shadow-sm' : ''}
      data-dir-code={node.code}
      data-dir-type={node.type}
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
      </div>

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
