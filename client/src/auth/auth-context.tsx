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
  refreshUser: () => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
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

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, hasRole, refreshUser: fetchUser }),
    [user, loading, login, logout, hasRole, fetchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
