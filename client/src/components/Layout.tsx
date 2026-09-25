import React, { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Home,
  BookOpen,
  Menu,
  X,
  Upload,
  FolderOpen,
  ClipboardCheck,
  Settings,
  LogOut,
  KeyRound,
  User,
} from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Button } from '@client/src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@client/src/components/ui/dropdown-menu';
import { LanguageToggle } from '@client/src/i18n/LanguageToggle';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { useIsMobile } from '@client/src/hooks/use-mobile';
import { useAuth } from '@client/src/auth/useAuth';
import type { RoleCode } from '@shared/api.interface';

const UPLOAD_ROLES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'prek_head',
  'k_head',
  'pe_specialist',
];

const REVIEW_ROLES: RoleCode[] = ['principal', 'curriculum_director'];
const ADMIN_ROLES: RoleCode[] = ['principal'];
const PREK_ROLES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'prek_head',
  'prek_assistant',
  'pe_specialist',
];
const K_ROLES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'k_head',
  'k_assistant',
  'pe_specialist',
];
const PE_ONLY_ROLES: RoleCode[] = ['pe_specialist'];

interface MenuItem {
  path: string;
  labelKey: string;
  icon?: React.ReactNode;
  children?: MenuItem[];
  roles?: RoleCode[];
}

const Layout: React.FC = () => {
  const { t } = useTranslation();
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(!isMobile);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    prek: false,
    k: false,
    admin: false,
  });
  const userMenuRef = useRef<HTMLDivElement>(null);

  const toggleExpanded = (key: string): void => {
    setExpanded((prev: Record<string, boolean>) => ({ ...prev, [key]: !prev[key] }));
  };

  const hasAnyRole = (roles: RoleCode[] | undefined): boolean => {
    if (!roles || roles.length === 0) return true;
    return hasRole(roles);
  };

  const filterMenuByRoles = (items: MenuItem[]): MenuItem[] => {
    return items
      .filter((item: MenuItem) => hasAnyRole(item.roles))
      .map((item: MenuItem) => {
        if (item.children && item.children.length > 0) {
          const filteredChildren = filterMenuByRoles(item.children);
          if (filteredChildren.length === 0) return null;
          return { ...item, children: filteredChildren };
        }
        return item;
      })
      .filter((item): item is MenuItem => item !== null);
  };

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      logger.warn('[Layout] Logout failed', String(err));
    }
  };

  const handleChangePassword = (): void => {
    navigate('/change-password');
  };

  const displayName = user?.name || user?.username || '';

  const roleLabels = user?.roles?.map((r: RoleCode) =>
    t(`role.${r}` as Parameters<typeof t>[0]),
  ) || [];

  const menuItems: MenuItem[] = [
    { path: '/', labelKey: 'nav.home', icon: <Home className="size-5" /> },
    {
      path: '/prek',
      labelKey: 'nav.prek',
      icon: <BookOpen className="size-5" />,
      roles: PREK_ROLES,
      children: [
        { path: '/prek/virtue', labelKey: 'nav.virtue', roles: PREK_ROLES.filter((r) => !PE_ONLY_ROLES.includes(r)) },
        { path: '/prek/montessori', labelKey: 'nav.montessori', roles: PREK_ROLES.filter((r) => !PE_ONLY_ROLES.includes(r)) },
        { path: '/prek/pe', labelKey: 'nav.pe', roles: PREK_ROLES },
      ],
    },
    {
      path: '/k',
      labelKey: 'nav.k',
      icon: <BookOpen className="size-5" />,
      roles: K_ROLES,
      children: [
        { path: '/k/virtue', labelKey: 'nav.virtue', roles: K_ROLES.filter((r) => !PE_ONLY_ROLES.includes(r)) },
        { path: '/k/chinese', labelKey: 'nav.chinese', roles: K_ROLES.filter((r) => !PE_ONLY_ROLES.includes(r)) },
        { path: '/k/english', labelKey: 'nav.english', roles: K_ROLES.filter((r) => !PE_ONLY_ROLES.includes(r)) },
        { path: '/k/pe', labelKey: 'nav.pe', roles: K_ROLES },
      ],
    },
    {
      path: '/upload',
      labelKey: 'nav.upload',
      icon: <Upload className="size-5" />,
      roles: UPLOAD_ROLES,
    },
    {
      path: '/my-resources',
      labelKey: 'nav.myResources',
      icon: <FolderOpen className="size-5" />,
    },
    {
      path: '/review',
      labelKey: 'nav.review',
      icon: <ClipboardCheck className="size-5" />,
      roles: REVIEW_ROLES,
    },
    {
      path: '/admin',
      labelKey: 'nav.admin',
      icon: <Settings className="size-5" />,
      roles: ADMIN_ROLES,
      children: [
        { path: '/admin/teachers', labelKey: 'nav.admin.teachers' },
        { path: '/admin/permissions', labelKey: 'nav.admin.permissions' },
        { path: '/admin/audit', labelKey: 'nav.admin.audit' },
      ],
    },
  ];

  const visibleMenuItems = filterMenuByRoles(menuItems);

  const renderMenuItem = (item: MenuItem, depth = 0): React.ReactNode => {
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expanded[item.path.replace('/', '')] ?? false;

    if (hasChildren) {
      return (
        <div key={item.path} className="mb-1">
          <button
            onClick={() => toggleExpanded(item.path.replace('/', ''))}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-white/90 transition-colors hover:bg-white/10 hover:text-white"
          >
            <span className="flex items-center gap-3">
              {item.icon}
              {t(item.labelKey as Parameters<typeof t>[0])}
            </span>
            {isExpanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
          {isExpanded && (
            <div className="mt-1 space-y-1 pl-8">
              {item.children!.map((child: MenuItem) => (
                <NavLink
                  key={child.path}
                  to={child.path}
                  onClick={() => {
                    if (isMobile) setSidebarOpen(false);
                  }}
                  className={({ isActive }) =>
                    `block rounded-lg px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-white/20 font-medium text-white'
                        : 'text-white/75 hover:bg-white/10 hover:text-white'
                    }`
                  }
                >
                  {t(child.labelKey as Parameters<typeof t>[0])}
                </NavLink>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <NavLink
        key={item.path}
        to={item.path}
        end={item.path === '/'}
        onClick={() => {
          if (isMobile) setSidebarOpen(false);
        }}
        className={({ isActive }) =>
          `mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
            isActive
              ? 'bg-white/20 font-medium text-white'
              : 'text-white/90 hover:bg-white/10 hover:text-white'
          }`
        }
      >
        {item.icon}
        {t(item.labelKey as Parameters<typeof t>[0])}
      </NavLink>
    );
  };

  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(true);
    }
  }, [isMobile]);

  return (
    <div className="flex min-h-screen bg-background">
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`sidebar-gradient fixed inset-y-0 left-0 z-50 w-60 transform flex-col border-r border-sidebar-border text-white transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } ${isMobile ? '' : 'relative translate-x-0'}`}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-white/20 text-white">
              <BookOpen className="size-5" />
            </div>
            <span className="text-base font-semibold">TsinglanKindergarten</span>
          </div>
          {isMobile && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="size-5" />
            </Button>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
          {visibleMenuItems.map((item: MenuItem) => renderMenuItem(item))}
        </nav>

        <div className="p-3 text-xs text-white/60">
          <p>&copy; 2024 TsinglanKindergarten</p>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header
          className={`sticky z-30 flex h-16 items-center justify-between border-b border-border bg-white/80 px-4 backdrop-blur sm:px-6`}
        >
          <div className="flex items-center gap-3">
            {isMobile && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu className="size-5" />
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <LanguageToggle />

            <div ref={userMenuRef} className="relative">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 hover:bg-accent"
                  >
                    <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="size-4" />
                    </div>
                    <span className="hidden text-sm font-medium text-foreground sm:inline">
                      {displayName}
                    </span>
                    <ChevronDown className="hidden size-4 text-muted-foreground sm:inline" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">
                        {displayName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {roleLabels.join(' / ')}
                      </span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleChangePassword}>
                    <KeyRound className="mr-2 size-4" />
                    <span>{t('nav.changePassword')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleLogout}
                    className="text-red-600 focus:text-red-600"
                  >
                    <LogOut className="mr-2 size-4" />
                    <span>{t('btn.logout')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;
