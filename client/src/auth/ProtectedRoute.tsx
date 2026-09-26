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
