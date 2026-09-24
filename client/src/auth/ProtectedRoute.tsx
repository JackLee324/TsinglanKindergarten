import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

import type { RoleCode } from '@shared/api.interface';
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

  if (requiredRoles.length > 0 && !user.roles.some((r: RoleCode) => requiredRoles.includes(r))) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
