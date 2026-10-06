import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { RoleCode } from '@shared/api.interface';
import { hasAnyRole } from '@shared/rbac';
import { Spinner } from '@client/src/components/ui/spinner';
import { useAuth } from './useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** @deprecated 优先用 `requiredPermission`：角色数组是第二份真相。 */
  requiredRoles?: RoleCode[];
  /**
   * 需要的**能力**，与服务端 `@RequirePermission('…')` 同一套权限码。
   *
   * 服务端每个路由都声明了自己要什么能力；客户端守卫照同一套判断即可，
   * 不必再维护"哪些角色能进哪个页面"的映射 —— 那种映射一旦与服务端分叉，
   * 既不会报错也不会被测试发现。
   */
  requiredPermission?: string;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRoles = [],
  requiredPermission,
}) => {
  const { user, loading, hasPermission, permissionsLoading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // §13 首次登录强制改密。
  //
  // 服务端一直在 `AuthUser.mustChangePassword` 里给出这个事实，但前端**从来没读过它**
  // —— 于是"强制改密"实际上只是侧边栏里一个可以无视的入口：账号在临时密码状态下
  // 照样能用全部功能，直到它自己愿意改。现在它是一道路由级闸门。
  //
  // 例外只有一个：`/change-password` 自身，否则会无限重定向。
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  // One role model, shared with the server. A super_admin holds every
  // permission at scope ALL server-side, so it must not be refused here either:
  // doing a bare intersection made a super_admin-only account — the account a
  // fresh deployment gets — land on 「无权访问」 for every route, while the API
  // returned 200 for the same user. See `hasAnyRole` in shared/rbac.ts.
  // 能力守卫：与服务端同一权限码。
  //
  // ⚠️ 权限还没加载完时**不能**判"没有" —— 那是把"还没到"当成"没有"，
  //    表现为刷新页面时闪一下「无权访问」。`permissions` 为空且仍在加载时先等着。
  if (requiredPermission !== undefined && !hasPermission(requiredPermission)) {
    // "还没有" 与 "确实没有" 必须分开：权限是**另一个请求**拉回来的，
    // 在这个窗口里 permissions 是空数组 —— 直接判"无权限"会让刷新页面时
    // 必然闪一下「无权访问」（实测：有 resource.restore 的账号也照样被跳走）。
    if (loading || permissionsLoading) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-background">
          <Spinner className="size-8" />
        </div>
      );
    }
    return <Navigate to="/unauthorized" replace />;
  }

  if (!hasAnyRole(user.roles, requiredRoles)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
