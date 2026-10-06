import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  Dumbbell,
  FileText,
  FolderTree,
  GraduationCap,
  Heart,
  Layers,
  Loader2,
  Palette,
  Puzzle,
  Shapes,
  ShieldCheck,
  Sparkles,
  Sprout,
  Wrench,
} from 'lucide-react';

import type { DirectoryNode, ProgramCode, Resource } from '@shared/api.interface';
import { normalizeSubSubject, themeDbValue } from '@shared/curriculum';

import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { PageHeader } from '@client/src/components/ui/page-header';
import { ResourceCard } from '@client/src/components/resource-card';
import { resources as resourcesApi } from '@client/src/api';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { readListResponse } from '@client/src/api/client';
import { codeToPath, useDirectory } from './DirectoryProvider';

/**
 * 目录浏览渲染器 —— **全站唯一的"目录长什么样"的实现**。
 *
 * WHY ONE RENDERER
 * ----------------
 * 业主的原话：「`/directory` 不能只是管理树，它必须能浏览。**必须是同一套 Directory Renderer**。」
 *
 * 在那之前，同一棵数据库树在两个地方被渲染成两种东西：
 *   * `/directory` —— 缩进的管理树，带新建/改名/删除按钮，是给管理员看的；
 *   * `/prek`、`/k`、`/prek/virtue`… —— 各自写死的科目卡片，是给教师看的。
 * 两者读的是**同一份数据**，却由**两套代码**渲染，于是改名字只动一处时另一处不动。
 *
 * 本组件把两种情况统一：**同一个节点，同样的卡片、同样的面包屑、同样的资源列表**，
 * 差别只有一个 —— 有 `curriculum.manage` 的账号额外看到一个"管理此目录"入口。
 * 也就是说，"浏览"与"管理"不是两种渲染，而是同一个渲染器 + 一个入口。
 *
 * 卡片视觉**刻意沿用既有 `PreKHomePage` 的样式**（14×14 圆角图标块 +
 * text-lg 标题 + 英文副标题 + Badge 计数 + 右侧箭头），不做任何视觉重设计。
 */

/**
 * 节点 → 图标与底色。
 *
 * ⚠️ 这里**不是**第二份目录结构：它只回答"这种节点画什么图标"，
 * 没有任何层级、名称、顺序信息。未知节点一律退回通用图标，
 * 于是**新增一个科目不需要改这个文件**（只是图标不够贴切，不会被挡）。
 */
interface IconSpec {
  icon: React.ReactNode;
  bg: string;
}

const ICON_BY_SUBJECT: Record<string, IconSpec> = {
  virtue: { icon: <Heart className="size-6" />, bg: 'bg-pink-100 text-pink-500' },
  montessori: { icon: <Puzzle className="size-6" />, bg: 'bg-purple-100 text-primary' },
  physical_education: { icon: <Dumbbell className="size-6" />, bg: 'bg-orange-100 text-orange-500' },
  chinese: { icon: <BookOpen className="size-6" />, bg: 'bg-red-100 text-red-500' },
  english: { icon: <Sparkles className="size-6" />, bg: 'bg-sky-100 text-sky-500' },
  arts: { icon: <Palette className="size-6" />, bg: 'bg-rose-100 text-rose-500' },
  science: { icon: <Shapes className="size-6" />, bg: 'bg-teal-100 text-teal-500' },
};

const ICON_BY_TYPE: Record<string, IconSpec> = {
  root: { icon: <FolderTree className="size-6" />, bg: 'bg-primary/10 text-primary' },
  section: { icon: <Layers className="size-6" />, bg: 'bg-primary/10 text-primary' },
  program: { icon: <BookOpen className="size-6" />, bg: 'bg-primary/10 text-primary' },
  growth_level: { icon: <GraduationCap className="size-6" />, bg: 'bg-emerald-100 text-emerald-600' },
  growth_node: { icon: <Sprout className="size-6" />, bg: 'bg-emerald-100 text-emerald-600' },
  folder: { icon: <FileText className="size-6" />, bg: 'bg-amber-100 text-amber-600' },
  subject: { icon: <Layers className="size-6" />, bg: 'bg-primary/10 text-primary' },
  sub_subject: { icon: <Wrench className="size-6" />, bg: 'bg-slate-100 text-slate-500' },
};

const iconFor = (node: DirectoryNode): IconSpec =>
  (node.subject !== null ? ICON_BY_SUBJECT[node.subject] : undefined) ??
  ICON_BY_TYPE[node.type] ?? {
    icon: <FolderTree className="size-6" />,
    bg: 'bg-[#FAF8FF] text-primary',
  };

/** 节点的一句话说明：优先数据库的 description，退到 i18n，再退到空。 */
function describeNode(
  node: DirectoryNode,
  t: (key: string) => string,
): string {
  if (node.description !== null && node.description.trim() !== '') return node.description;
  const key = `subject.${node.code.split(':').pop() ?? ''}Desc`;
  const translated = t(key);
  // i18n 缺 key 时 useTranslation 会回传 key 本身 —— 那种情况当作"没有说明"，
  // 而不是把 `subject.xxxDesc` 这种内部串显示给老师。
  return translated === key ? '' : translated;
}

export interface DirectoryBrowserProps {
  /**
   * 要浏览的目录节点 code；`null` = 两个根（教育教学 / 教师成长）。
   * 由路由解析后传入 —— 本组件不认识 URL，也不认识 legacy 路径。
   */
  code: string | null;
  /** 目录管理入口（仅 `curriculum.manage` 账号会传）。 */
  onManage?: (node: DirectoryNode | null) => void;
  /**
   * 旧 URL 里**没能对应到目录节点**的尾部片段（见 `resolveLegacyTarget`）。
   * 非空时说明这个地址指的是一层"不在 PDF 目录树里"的分组
   * （蒙氏子分类、K 英文 Theme）——此时按该分组**筛选资源**，
   * 而不是显示子文件夹卡片，更不是 404。
   */
  leftover?: string[];
  /**
   * 路由层已经确认"这个 URL 解析不出任何可见节点"时传进来的原始路径。
   *
   * 与"code 有值但当前查不到"必须区分：后者可能是树还在加载
   * （此时该显示 loading），前者已经是确定的不存在。把两者混在一起，
   * 刷新页面时就会先闪一个 404 再出现内容。
   */
  unresolvedPath?: string;
}

interface DirectoryResourcesProps {
  node: DirectoryNode;
  /**
   * 额外筛选条件（旧 URL 的第三层）。
   *
   * 取值必须与数据库里**实际存的字符串**一致：`sub_subject` 存 `practical_life`
   * 而不是路由用的 `practical-life`；英文 Theme 存 `主题1：我自己` 而不是
   * 路由用的 `myself`。这两个换算由 `@shared/curriculum` 负责 ——
   * 以前 SubjectPage 里那段"路由 slug → 库里存的值"的换算现在住在这里，
   * 仍然只有一份。
   */
  extraFilter?: { subSubject?: string; theme?: string };
}

/**
 * 叶节点下的资源列表。**同一个渲染器**在这一层退化成资源列表。
 *
 * 这里承载了原本住在 `SubjectPage` 里的全部列表能力 —— 学期 / 周次筛选、
 * 分页（第 51 条之后可达）、403 与"暂无数据"的区分。
 * 它们不是被删掉，而是**搬到了唯一的那份渲染逻辑里**：
 * 以前只有 `/prek/virtue` 这类地址能用这些筛选，现在任何目录叶节点都能用。
 */
const PAGE_SIZE = 50;
const SEMESTER_OPTIONS = ['S1', 'S2'];
const WEEK_OPTIONS = Array.from({ length: 20 }, (_, i) => i + 1);

interface DirectoryResourcesProps {
  node: DirectoryNode;
  /**
   * 额外筛选条件（旧 URL 的第三层）。
   *
   * 取值必须与数据库里**实际存的字符串**一致：`sub_subject` 存 `practical_life`
   * 而不是路由用的 `practical-life`；英文 Theme 存 `主题1：我自己` 而不是
   * 路由用的 `myself`。这两个换算由 `@shared/curriculum` 负责 ——
   * 以前 SubjectPage 里那段"路由 slug → 库里存的值"的换算现在住在这里，
   * 仍然只有一份。
   */
  extraFilter?: { subSubject?: string; theme?: string };
}

const DirectoryResources: React.FC<DirectoryResourcesProps> = ({ node, extraFilter }) => {
  const { t, language } = useTranslation();
  const { flatten } = useDirectory();
  const [items, setItems] = useState<Resource[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  /** 服务端 403 与"真的 0 条"必须分开 —— 混为一谈就是在骗老师。 */
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [semester, setSemester] = useState<string>('');
  const [weekNumber, setWeekNumber] = useState<string>('');
  /** 上面那批"我自己未发布"的条数，用于在界面里说明它们为什么会出现。 */
  const [mineOnly, setMineOnly] = useState<number>(0);

  // 筛选变化回到第 1 页：否则"加载更多"会把上一组筛选的第 N 页接在新结果后面。
  useEffect(() => {
    setPage(1);
  }, [node.code, extraFilter?.subSubject, extraFilter?.theme, semester, weekNumber]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const resp = await resourcesApi.getResources({
          directory: node.code,
          /**
           * ⚠️ `status: 'published'` **必须显式传**，不能省。
           *
           * 服务端 `listResources` **只按科目权限过滤，不按状态过滤**
           * （见 resources.service.ts：conditions 里只有 activeOnly + 科目权限 +
           * 目录子树；status 只在调用方传了才加）。
           * 所以不传 status 就等于"把同科目下所有人、所有状态的资源都列出来" ——
           * 包括**别的老师还没提交审核的草稿**。那是一条真实的信息泄露，
           * 而且和界面上"目录浏览"的语义完全不符。
           *
           * 我一度在报告里写"浏览视图只列 published"，但代码里其实**没有传这个参数** ——
           * 文档与实现不一致，而接口测试发现不了（它不报错，只是多返回了行）。
           * 现在显式传上；老师自己的未发布资源由下面 `mine` 那一段单独补，
           * 那一条走的是服务端按 uploaderId 过滤的接口，不可能看到别人的。
           */
          status: 'published',
          ...(extraFilter?.subSubject === undefined ? {} : { subSubject: extraFilter.subSubject }),
          ...(extraFilter?.theme === undefined ? {} : { theme: extraFilter.theme }),
          ...(semester === '' ? {} : { semester }),
          ...(weekNumber === '' ? {} : { weekNumber: Number(weekNumber) }),
          page,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        const list = readListResponse<Resource>(resp, 'resources.list(directory)');
        setTotal(list.total);
        setForbidden(list.forbidden);
        // 第 1 页替换，后续页追加（「加载更多」）。
        const publishedItems = page === 1 ? list.items : null;

        /**
         * **把"我自己还没发布的资源"一并列出来。**
         *
         * WHY: 列表只查 `status=published` —— 与被我删掉的那些页面口径一致。
         * 但目录浏览多了一层现实问题：老师刚把资源传进某个资料夹、点了保存，
         * 回头进这个目录**什么都看不到**（草稿要等审核通过才出现），
         * 看起来就像"我传的东西丢了"。§15 明确要求
         * 「上传资源 → 保存 → **资源出现在该目录**」，这条链路必须成立。
         *
         * 为什么不能直接去掉 `status` 过滤：那会把**别人**的草稿也列出来
         * （服务端的数据范围是按班型/科目授权的，不按状态）。所以这里走
         * `GET /api/resources/mine`（服务端只返回**调用者自己**的行），
         * 再按目录子树过滤 —— 既补上了自己的草稿，又不可能看到别人的。
         */
        let mineItems: Resource[] = [];
        try {
          const subtreeIds = new Set([node.id, ...flatten(node).map((n) => n.id)]);
          const mineResp = await resourcesApi.getMyResources({ pageSize: 100 });
          const mineList = readListResponse<Resource>(mineResp, 'resources.mine(directory)');
          const already = new Set((publishedItems ?? []).map((r) => r.id));
          mineItems = mineList.items.filter(
            (r) => r.directoryId !== null && r.directoryId !== undefined
              && subtreeIds.has(r.directoryId)
              && !already.has(r.id)
              && r.status !== 'published',
          );
        } catch {
          // 拿不到"我的资源"不该让整个浏览页失败 —— 少列几行自己的草稿，
          // 好过整页报错。已发布的那部分照常显示。
          mineItems = [];
        }

        if (cancelled) return;
        setMineOnly(mineItems.length);
        const merged = [...(publishedItems ?? []), ...mineItems];
        setItems((prev) => (page === 1 ? merged : [...prev, ...mineItems, ...list.items]));
      } catch (err) {
        if (cancelled) return;
        // 失败就说失败。把 403/500 渲染成"暂无数据"会让人以为目录里真的没东西。
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node, flatten, extraFilter?.subSubject, extraFilter?.theme, semester, weekNumber, page]);

  const semesterLabel = (value: string): string => {
    if (value === 'S1') return t('semester.s1');
    if (value === 'S2') return t('semester.s2');
    return value;
  };

  const weekLabel = (w: number): string =>
    language === 'zh-CN'
      ? `${t('semester.week')}${w}${t('semester.weekSuffix')}`
      : `${t('semester.week')} ${w}`;

  const filters = (
    <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="directory-resource-filters">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('filter.semester')}:</span>
        <Select value={semester} onValueChange={setSemester}>
          <SelectTrigger className="w-36" size="sm" data-testid="directory-filter-semester">
            <SelectValue placeholder={t('filter.allSemesters')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('filter.allSemesters')}</SelectItem>
            {SEMESTER_OPTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {semesterLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('filter.week')}:</span>
        <Select value={weekNumber} onValueChange={setWeekNumber}>
          <SelectTrigger className="w-32" size="sm" data-testid="directory-filter-week">
            <SelectValue placeholder={t('filter.allWeeks')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('filter.allWeeks')}</SelectItem>
            {WEEK_OPTIONS.map((w) => (
              <SelectItem key={w} value={String(w)}>
                {weekLabel(w)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  if (loading && items.length === 0) {
    return (
      <div>
        {filters}
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="text-sm">{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div>
        {filters}
        <div
          className="rounded-xl border border-[#D98B8B] bg-[#FFF7F7] p-4"
          data-testid="directory-browse-error"
        >
          <p className="text-sm text-[#2D2A3E]">{t('directory.resourcesFailed')}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  /**
   * ⚠️ 判空必须看 `items.length`，**不能**只看 `total`。
   *
   * 第一版这里是 `if (total === 0)`，而 `total` 是**已发布**的条数。
   * 于是出现一个很别扭的结果：老师把自己的资源传进这个资料夹，
   * 界面却显示"暂无资源" —— 因为他的草稿在 `mine` 合并进来的 `items` 里，
   * 而这个 early return 在渲染 `items` 之前就把整块换成了空态。
   * 这正是我自己写的那段注释在警告的形态（"传完看起来像丢了"），
   * 而它被 early return 挡住了。
   */
  const publishedTotal = total;
  const grandTotal = publishedTotal + mineOnly;
  if (items.length === 0 && grandTotal === 0) {
    return (
      <div>
        {filters}
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-base font-medium text-foreground" data-testid="directory-browse-empty">
            {forbidden ? t('unauthorized.title') : t('resource.noResources')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {forbidden ? t('unauthorized.subtitle') : t('resource.noResourcesDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="directory-browse-resources" data-dir-resources={node.code}>
      {filters}
      <p className="mb-3 text-sm text-[#6B6878]">
        {t('directory.resourcesCount')
          .replace('{shown}', String(items.length))
          // 计数要如实反映**界面上看到的全部**：已发布 + 我自己的未发布。
          // 只报已发布会让"显示 1 / 共 0 条"这种自相矛盾的文案出现。
          .replace('{total}', String(grandTotal))}
      </p>
      {/* data-testid 供浏览器 E2E 直接数卡片个数：读"已显示 X / 共 Y 条"那一行
          不可靠 —— 全部加载完时它（正确地）消失，断言会读到 null 而把成功误判成失败。 */}
      {mineOnly > 0 && (
        <p className="mb-3 text-sm text-[#6B8878]" data-testid="directory-mine-note">
          {t('directory.mineUnpublishedNote').replace('{count}', String(mineOnly))}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="resource-list">
        {items.map((r) => (
          <ResourceCard
            key={r.id}
            resource={r}
            showSemester={semester !== ''}
            showWeek={weekNumber !== ''}
            showTheme={extraFilter?.theme !== undefined}
          />
        ))}
      </div>
      {!forbidden && grandTotal > items.length && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <Button variant="outline" onClick={() => setPage((prev) => prev + 1)} data-testid="directory-load-more">
            {language === 'zh-CN' ? '加载更多' : 'Load more'}
          </Button>
          <p className="text-xs text-muted-foreground">
            {language === 'zh-CN'
              ? `已显示 ${items.length} / 共 ${grandTotal} 条`
              : `Showing ${items.length} of ${grandTotal}`}
          </p>
        </div>
      )}
    </div>
  );
};

const DirectoryBrowser: React.FC<DirectoryBrowserProps> = ({
  code,
  onManage,
  leftover,
  unresolvedPath,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { roots, loading, error, findByCode, pathTo, refresh } = useDirectory();

  const node = useMemo(() => (code === null ? null : findByCode(code)), [code, findByCode]);
  const trail = useMemo(() => (code === null ? [] : pathTo(code)), [code, pathTo]);

  /**
   * 旧 URL 的第三层 → 实际能发给接口的筛选值。
   *
   * 只能算一次换算，且**换算不出来就不发** —— 猜一个值等于向数据库要一个
   * 永远匹配不到的条件，界面会显示"暂无资源"，与"真的有 0 条"长得一模一样。
   *
   * ⚠️ 这个 useMemo **必须放在所有 early return 之前**。
   * 第一版把它放在了下面 loading / notFound 分支之后，于是：
   * 首帧（树还没到）走 early return、不调用它；第二帧树到了才调用它 ——
   * React 报 "Rendered more hooks than during the previous render"，
   * 整页被 AppErrorBoundary 接住，界面上是「页面出现错误」。
   * 症状极具误导性：`/directory` 正常，`/directory/prek` 白屏 ——
   * 看起来像路由坏了，其实是 hook 顺序。
   */
  const extraFilter = useMemo(() => {
    if (leftover === undefined || leftover.length === 0) return undefined;
    if (node === null || node.program === null) return undefined;
    const program = node.program as ProgramCode;
    const subject = node.subject ?? node.code;
    const tail = leftover[0];
    const subSubject = normalizeSubSubject(program, subject, tail);
    if (subSubject !== null) return { subSubject };
    const theme = themeDbValue(program, subject, tail);
    if (theme !== null) return { theme };
    return undefined;
  }, [leftover, node]);

  /**
   * 树是异步来的：code 有值但这一刻还查不到，可能是"还在加载"，也可能是
   * "这个 code 根本不在我的可见范围里"。**必须区分**，否则刷新页面会闪一下 404。
   * `unresolvedPath` 是路由层给出的确定结论，优先级最高。
   */
  const notFound = unresolvedPath !== undefined || (code !== null && !loading && node === null);

  if (loading && code !== null && node === null) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-primary" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  if (error !== null && code === null) {
    return (
      <div
        className="rounded-xl border border-[#D98B8B] bg-[#FFF7F7] p-4"
        data-testid="directory-browse-error"
      >
        <p className="text-sm text-[#2D2A3E]">{t('directory.treeFailed')}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div data-testid="directory-browse-notfound">
        <PageHeader title={t('directory.notFoundTitle')} description={t('directory.notFoundDesc')} />
        {unresolvedPath !== undefined && (
          <p className="mb-4 break-all rounded-lg border border-border bg-[#FAF8FF] p-3 text-xs text-muted-foreground">
            {unresolvedPath}
          </p>
        )}
        <button
          type="button"
          onClick={() => navigate('/directory')}
          className="rounded-lg bg-primary px-5 py-2 text-white hover:bg-primary-dark"
        >
          {t('directory.backToRoot')}
        </button>
      </div>
    );
  }

  const children = node === null ? roots : node.children;
  const title = node === null ? t('page.directory') : node.name;
  const subtitle = node === null ? t('page.directoryDesc') : node.nameEn;

  // 旧 URL 指的是一层分组（蒙氏子分类 / 英文 Theme）时，直接显示**筛选后的资源**，
  // 而不是这个科目的 4 个资料夹卡片 —— 用户要的就是那一层的内容。
  const showLeftoverResources = leftover !== undefined && leftover.length > 0 && extraFilter !== undefined;

  return (
    <div data-testid="directory-browser" data-dir-browse={code ?? '__root__'}>
      <PageHeader title={title} description={subtitle}>
        <div className="flex items-center gap-2">
          {onManage !== undefined && (
            <button
              type="button"
              onClick={() => onManage(node)}
              data-testid="directory-manage-entry"
              className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground hover:border-primary hover:text-primary"
            >
              {t('directory.manageEntry')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            data-testid="directory-browse-refresh"
            className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground hover:border-primary hover:text-primary"
          >
            {t('common.refresh')}
          </button>
        </div>
      </PageHeader>

      {/* 面包屑：与侧边栏、首页、上传页读的是同一份树，所以名字天然一致。 */}
      <nav
        className="mb-6 flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
        data-testid="directory-breadcrumb"
        aria-label={t('directory.breadcrumb')}
      >
        <button
          type="button"
          onClick={() => navigate('/directory')}
          className="rounded px-1 hover:text-primary"
          data-testid="directory-crumb-root"
        >
          {t('page.directory')}
        </button>
        {trail.map((ancestor) => (
          <React.Fragment key={ancestor.id}>
            <ChevronRight className="size-3.5 shrink-0" />
            {ancestor.code === code ? (
              <span className="px-1 font-medium text-foreground" data-testid="directory-crumb-current">
                {ancestor.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => navigate(codeToPath(ancestor.code))}
                className="rounded px-1 hover:text-primary"
                data-testid="directory-crumb"
                data-dir-crumb={ancestor.code}
              >
                {ancestor.name}
              </button>
            )}
          </React.Fragment>
        ))}
      </nav>

      {showLeftoverResources && (
        <div
          className="mb-4 rounded-lg border border-border bg-[#FAF8FF] p-3 text-sm text-muted-foreground"
          data-testid="directory-leftover-notice"
        >
          {t('directory.legacyFilterNote')
            .replace('{segment}', leftover?.[0] ?? '')
            .replace('{name}', node?.name ?? '')}
        </div>
      )}

      {/* 旧链接的第三层不在权威目录里（§4 不自行增加 PDF 没有的固定目录），
          所以这里退化成"按该层筛选的资源列表"，而不是一个死链接。 */}
      {showLeftoverResources &&
        (node !== null ? (
          <DirectoryResources node={node} extraFilter={extraFilter} />
        ) : null)}

      {children.length === 0 && node !== null && !showLeftoverResources && (
        <DirectoryResources node={node} />
      )}

      {children.length === 0 && node === null && (
        <p className="py-10 text-sm text-muted-foreground" data-testid="directory-browse-empty">
          {t('directory.resourcesEmpty')}
        </p>
      )}

      {children.length > 0 && !showLeftoverResources && (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-ai-section-type="card-list">
          {children.map((child) => {
            const spec = iconFor(child);
            return (
              <Card
                key={child.id}
                onClick={() => navigate(codeToPath(child.code))}
                data-testid="directory-card"
                data-dir-card={child.code}
                className="group cursor-pointer border-border shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
              >
                <CardContent className="p-6">
                  <div className={`mb-4 flex size-14 items-center justify-center rounded-xl ${spec.bg}`}>
                    {spec.icon}
                  </div>
                  <h3 className="text-lg font-semibold text-foreground" data-testid="directory-card-name">
                    {child.name}
                  </h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{child.nameEn}</p>
                  <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                    {describeNode(child, t)}
                  </p>
                  <div className="mt-5 flex items-center justify-between">
                    <Badge variant="secondary">
                      {child.children.length > 0
                        ? t('directory.childCount').replace('{count}', String(child.children.length))
                        : t('directory.resourceCount').replace('{count}', String(child.resourceCount))}
                    </Badge>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-transform group-hover:translate-x-0.5">
                      <ArrowRight className="size-4" />
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/*
        非叶节点也**必须**列出资源 —— 这一条不是锦上添花，而是补一个真实的黑洞。

        迁移报告实测：346 条已发布资源挂在**科目节点**上（`prek:montessori` 292 条、
        `k:english` 44 条、`prek:virtue` 10 条），而不是四个资料夹之下。
        如果非叶节点只画资料夹卡片，这 346 条在浏览视图里**一个都看不到** ——
        老师在蒙台梭利页面点进去只有四个空资料夹，而库里躺着 292 条内容。
        那正是业主反复说的"资源明明在，界面上找不到"。

        为什么用子树口径（含资料夹内）：`?directory=` 本来就把该节点**及其全部后代**
        纳入，于是"挂在科目上的"与"已经精确到资料夹的"会一起出现，
        不需要先做完数据补齐才能看见东西。资料夹卡片仍然在，想只看某一类就点进去。
      */}
      {children.length > 0 && node !== null && !showLeftoverResources && (
        <section className="mt-8" data-testid="directory-subtree-resources">
          <h2 className="text-xl font-semibold text-[#2D2A3E]">
            {t('directory.subtreeTitle').replace('{name}', node.name)}
          </h2>
          <p className="mb-4 mt-1 text-sm text-muted-foreground" data-testid="directory-subtree-note">
            {t('directory.resourcesSubtreeNote')}
          </p>
          <DirectoryResources node={node} />
        </section>
      )}

      <div className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" />
        <span>{t('directory.browseFootnote')}</span>
        <button
          type="button"
          onClick={() => refresh()}
          className="underline hover:text-primary"
          data-testid="directory-browse-reload-inline"
        >
          {t('common.refresh')}
        </button>
      </div>
    </div>
  );
};

export default DirectoryBrowser;
