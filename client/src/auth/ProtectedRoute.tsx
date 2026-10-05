import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

import type { RoleCode } from '@shared/api.interface';
import { hasAnyRole } from '@shared/rbac';
import { Spinner } from '@client/src/components/ui/spinner';
import { useAuth } from './useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRoles?: RoleCode[];
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRoles = [],
}) => {
  const { user, loading } = useAuth();
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
  if (!hasAnyRole(user.roles, requiredRoles)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
