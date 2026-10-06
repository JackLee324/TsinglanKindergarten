import React, { useMemo } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import type { DirectoryNode } from '@shared/api.interface';

import DirectoryBrowser from './DirectoryBrowser';
import { codeToPath, resolveLegacyTarget, useDirectory } from './DirectoryProvider';

/**
 * 目录浏览的路由壳。
 *
 * WHY A SHELL
 * -----------
 * `DirectoryBrowser` 只认 code，不认 URL —— 这是刻意的：**一个渲染器只有一份输入**，
 * 于是"侧边栏点进去"和"直接敲 URL 进来"必然渲染出同一个东西。
 * URL ↔ code 的翻译全部集中在本文件，翻译规则在 `DirectoryProvider` 里（三条机械规则）。
 */

/**
 * 目录管理入口。只有 `curriculum.manage` 账号会拿到这个回调 ——
 * "浏览"与"管理"不是两种页面，而是**同一个渲染器 + 一个有权限才有的入口**。
 */
const useManageHandler = (): ((node: DirectoryNode | null) => void) | undefined => {
  const { canManage } = useDirectory();
  const navigate = useNavigate();
  return useMemo(
    () =>
      // 没有 curriculum.manage 就返回 undefined —— 浏览页据此**不渲染**管理按钮。
      // 服务端当然还会再挡一次，但界面上摆一个点进去必然 403 的按钮，
      // 是把"你没权限"伪装成"这个功能坏了"。
      canManage
        ? (node: DirectoryNode | null) => {
            navigate(
              node === null
                ? '/directory/manage'
                : `/directory/manage?code=${encodeURIComponent(node.code)}`,
            );
          }
        : undefined,
    [canManage, navigate],
  );
};

/**
 * 把 URL 片段解析成"要浏览哪个节点、还剩哪些筛选条件"。
 * 单抽出来是因为 `/directory/*` 与 `/growth/*` 用的是**同一套规则**，
 * 只是前缀不同 —— 复制一份解析逻辑就又造出了第二份真相。
 */
const useResolvedTarget = (
  segments: string[],
): { code: string | null; leftover: string[]; unresolved: string | null; loading: boolean } => {
  // 用 `ready`（已有确定结论）而不是 `loading`：`loading` 首帧是 false，
  // 那时树还没开始拉，拿它当"加载完了"会立刻把一切判成不存在。
  const { byCode, ready } = useDirectory();
  const target = resolveLegacyTarget(segments, byCode);
  return {
    code: target?.code ?? null,
    leftover: target?.leftover ?? [],
    // 树没到就下结论会让刷新页面先闪 404，所以只有树就绪后才给 unresolved。
    unresolved: target === null && ready ? `/${segments.join('/')}` : null,
    loading: !ready,
  };
};

/** `/directory` 与 `/directory/*` 共用。 */
export const DirectoryBrowseRoute: React.FC = () => {
  const params = useParams<{ '*': string }>();
  const onManage = useManageHandler();
  const raw = params['*'];
  const segments = (raw ?? '').split('/').filter(Boolean);
  const { code, leftover, unresolved, loading } = useResolvedTarget(segments);

  // 根：`/directory` 本身。两个根并排显示。
  if (segments.length === 0) return <DirectoryBrowser code={null} onManage={onManage} />;
  // 树还在路上：先渲染根（带 loading），不要闪 404。
  if (code === null) {
    return loading ? (
      <DirectoryBrowser code={null} onManage={onManage} />
    ) : (
      <DirectoryBrowser code={null} onManage={onManage} unresolvedPath={unresolved ?? ''} />
    );
  }
  return <DirectoryBrowser code={code} leftover={leftover} onManage={onManage} />;
};

/** `/growth` 与 `/growth/*` —— 教师成长（§10：一等导航入口，不藏在 `/directory` 里）。 */
export const GrowthBrowseRoute: React.FC = () => {
  const params = useParams<{ '*': string }>();
  const onManage = useManageHandler();
  const raw = params['*'];
  // 补回 `growth` 这一层：`/growth/l1` 的 `*` 只有 `l1`，
  // 而目录 code 是 `growth:l1`（`root:growth` 的短写是 `growth`）。
  const segments = ['growth', ...(raw ?? '').split('/').filter(Boolean)];
  const { code, leftover, unresolved, loading } = useResolvedTarget(segments);

  if (code === null) {
    return loading ? (
      <DirectoryBrowser code="root:growth" onManage={onManage} />
    ) : (
      <DirectoryBrowser code={null} onManage={onManage} unresolvedPath={unresolved ?? `/${segments.join('/')}`} />
    );
  }
  return <DirectoryBrowser code={code} leftover={leftover} onManage={onManage} />;
};

/**
 * 旧 URL 兼容层（§11）。
 *
 * `/prek/virtue`、`/k/chinese/reading`、`/prek/montessori/practical-life`…
 * 这些地址已经发出去过（书签、企业微信里的链接、老师的习惯），不能 404。
 * 做法是**解析成目录 code 之后跳到规范地址**，而不是再写一套指向旧页面的路由：
 * 旧 URL 仍然可用，但它指向的东西只有一份。
 *
 * 解析不出来时不猜，落到 `/directory` 根 —— 让老师看到真实存在的结构，
 * 而不是一个"看起来有这个科目、点进去什么都没有"的空壳。
 */
export const LegacyDirectoryRedirect: React.FC = () => {
  const { byCode, ready } = useDirectory();
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  // 树没到就跳，会跳到错的地方：`/k/virtue` 此刻看起来"没有这个科目"，
  // 但真实原因只是树还没拉回来。等有了确定结论（成功或失败）再决定。
  if (!ready) return null;

  const target = resolveLegacyTarget(segments, byCode);
  return (
    <Navigate to={target === null ? '/directory' : codeToPath(target.code)} replace />
  );
};
