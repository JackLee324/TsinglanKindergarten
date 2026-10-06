import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { logger } from '@client/src/lib/logger';

import type { AuthUser, RoleCode } from '@shared/api.interface';
import { hasAnyRole } from '@shared/rbac';
import * as api from '@client/src/api/auth';
import { AUTH_UNAUTHORIZED_EVENT } from '@client/src/api/client';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (user: AuthUser) => void;
  logout: () => Promise<void>;
  hasRole: (roles: RoleCode[]) => boolean;
  /**
   * 生效权限集合（**服务端算出来的那一份**，见 GET /api/auth/me/permissions）。
   *
   * 有了它，界面就能按**能力**而不是按角色字面量来决定"显示什么、能进哪个页面"：
   * 服务端每个路由已经用 `@RequirePermission('…')` 声明了自己要什么能力，
   * 客户端照同一套权限码判断即可。此前侧边栏与路由守卫各自维护了 6 张角色数组
   * （`UPLOAD_ROLES` / `REVIEW_ROLES` / `ADMIN_ROLES` / …），那些是**第二份真相**：
   * 一旦服务端调整某个角色的权限，界面就会与它不一致 —— 而且这类不一致
   * 既不会报错也不会被现有测试发现。
   */
  permissions: string[];
  hasPermission: (permission: string) => boolean;
  /**
   * 权限是否**仍在加载**。
   *
   * 这个标志是必需的，不是锦上添花：`permissions` 是在 `user` 就绪之后**另一个
   * effect** 里去拉的，于是存在一个窗口 —— `loading` 已经是 false、`user` 已存在、
   * 但 `permissions` 还是空数组。按能力守卫的路由在这段时间里会把用户判成
   * "无权限"并跳到 /unauthorized。
   *
   * 实测就是如此：`/admin/recycle-bin` 刷新后直接落到「无权访问」，
   * 而同一个账号的 `resource.restore` 明明是有的（接口查得到）。
   * 所以守卫必须能区分"**还没有**"和"**确实没有**"。
   */
  permissionsLoading: boolean;
  refreshUser: () => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  /** 当前这份 `permissions` 属于哪个用户；null = 还没有任何一份。 */
  const [permissionsFor, setPermissionsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchUser = useCallback(async (): Promise<boolean> => {
    try {
      const me = await api.getMe();
      if (me) {
        setUser(me);
        return true;
      }
      setUser(null);
      return false;
    } catch (err) {
      logger.warn('[Auth] Failed to fetch current user (network error), keeping state');
      return false;
    }
  }, []);

  useEffect(() => {
    const init = async (): Promise<void> => {
      await fetchUser();
      setLoading(false);
    };
    void init();

    const handleUnauthorized = (): void => {
      logger.warn('[Auth] Received 401 unauthorized event, clearing user');
      setUser(null);
    };

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, [fetchUser]);

  const login = useCallback((userData: AuthUser) => {
    setUser(userData);
  }, []);

  // 权限只在"已登录"时拉一次；登录/登出都会让 user 变化从而重新拉取。
  useEffect(() => {
    if (!user) {
      setPermissions([]);
      setPermissionsFor(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const perms = await api.getMyPermissions();
        if (!cancelled) setPermissions(perms.permissions ?? []);
      } catch (err) {
        // 拉不到就当作**没有权限**（fail closed）：界面少显示几个入口，
        // 总好过按"猜"给出入口然后让用户点进去吃 403。
        logger.warn('[Auth] load effective permissions failed', String(err));
        if (!cancelled) setPermissions([]);
      } finally {
        // 标记"这一份权限属于谁"。用**归属**而不是布尔标志：
        // 布尔标志只能在 effect 里置位，而 effect 在"会跳走的那一次渲染之后"才跑，
        // 于是守卫看到的是"未知"却被当成"没有"（实测刷新即落 /unauthorized）。
        if (!cancelled) setPermissionsFor(user.id);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } catch (err) {
      logger.warn('[Auth] Logout API failed', String(err));
    }
    setUser(null);
  }, []);

  // Delegates to the shared rule so the sidebar's role gating cannot disagree
  // with `ProtectedRoute` or with the server (see `hasAnyRole` in
  // shared/rbac.ts). Before this, `hasRole(['principal'])` was false for a
  // super_admin, so the administration menu was hidden from the one account
  // that holds every permission.
  const hasRole = useCallback(
    (roles: RoleCode[]): boolean => {
      if (!user) return false;
      return hasAnyRole(user.roles, roles);
    },
    [user],
  );

  /**
   * 权限是否**尚未就绪**（当前用户的生效权限还没拉回来）。
   * 守卫必须能区分"还没有"与"确实没有"，否则刷新带权限守卫的页面会闪「无权访问」。
   */
  const permissionsLoading = user !== null && permissionsFor !== user.id;

  const hasPermission = useCallback(
    (permission: string): boolean => {
      // 未就绪时一律返回 false —— 但调用方应先看 permissionsLoading。
      if (permissionsFor === null) return false;
      return permissions.includes(permission);
    },
    [permissions, permissionsFor],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, hasRole, permissions, hasPermission, permissionsLoading, refreshUser: fetchUser }),
    [user, loading, login, logout, hasRole, permissions, hasPermission, permissionsLoading, fetchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
