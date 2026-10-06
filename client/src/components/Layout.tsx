import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  User, FolderTree, ShieldCheck } from 'lucide-react';
import { logger } from '@client/src/lib/logger';

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
import type { ProgramCode } from '@shared/api.interface';
// 单一真相：班型/科目可见性直接问 shared/rbac.ts，页面不再维护角色数组。
import { programsVisibleForStructure, roleScopeCovers, roleSubjectScope } from '@shared/rbac';

/**
 * 导航项按**能力**声明可见性，而不是按角色字面量。
 *
 * 以前这里有 6 张手写的角色数组（UPLOAD_ROLES / REVIEW_ROLES / ADMIN_ROLES /
 * PREK_ROLES / K_ROLES / PE_ONLY_ROLES）。它们是**第二份真相**：服务端已经用
 * `@RequirePermission('…')` 声明了每个路由要什么能力，`shared/rbac.ts` 也已经
 * 定义了"哪个角色能看哪个班型/科目"。界面再抄一份，只会与它们悄悄分叉 ——
 * 而且这类分叉既不报错、也不被现有测试发现。
 *
 * 现在三种声明方式，全部指向单一真相：
 *   · `permission`  —— 服务端同一个权限码（capability）
 *   · `program`     —— 班型结构可见性（programsVisibleForStructure）
 *   · `subject`     —— 科目访问范围（roleSubjectScope / roleScopeCovers）
 */
interface MenuItem {
  path: string;
  labelKey: string;
  icon?: React.ReactNode;
  children?: MenuItem[];
  /** 服务端同一套权限码；例：`resource.create`、`review.view`、`account.view`。 */
  permission?: string;
  /** 只看"这个班型的结构"（不含科目数据权限）——与 shared/rbac 的判定一致。 */
  program?: ProgramCode;
  /** 需要对该班型下的这个科目有访问范围。 */
  subject?: { program: ProgramCode; subject: string };
}

const Layout: React.FC = () => {
  const { t } = useTranslation();
  const { user, logout, hasPermission } = useAuth();
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

  /**
   * 一个导航项是否可见 —— 全部问单一真相，页面不再持有角色字面量。
   */
  const isItemVisible = useCallback(
    (item: MenuItem): boolean => {
      const roles = user?.roles ?? [];
      // 能力：与服务端同权限码
      if (item.permission && !hasPermission(item.permission)) return false;
      // 班型结构可见性：与 shared/rbac 的 programsVisibleForStructure 一致
      if (item.program && !programsVisibleForStructure(roles).includes(item.program)) return false;
      // 科目访问范围：与 roleSubjectScope / roleScopeCovers 一致
      if (item.subject) {
        const scope = roleSubjectScope(roles);
        if (!roleScopeCovers(scope, item.subject.program, item.subject.subject)) return false;
      }
      return true;
    },
    [user, hasPermission],
  );

  const filterMenu = (items: MenuItem[]): MenuItem[] => {
    return items
      .filter(isItemVisible)
      .map((item: MenuItem) => {
        if (item.children && item.children.length > 0) {
          const filteredChildren = filterMenu(item.children);
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

  const roleLabels = user?.roles?.map((r) =>
    t(`role.${r}` as Parameters<typeof t>[0]),
  ) || [];

  const menuItems: MenuItem[] = [
    { path: '/', labelKey: 'nav.home', icon: <Home className="size-5" /> },
    {
      path: '/prek',
      labelKey: 'nav.prek',
      icon: <BookOpen className="size-5" />,
      program: 'prek',
      children: [
        { path: '/prek/virtue', labelKey: 'nav.virtue', subject: { program: 'prek', subject: 'virtue' } },
        { path: '/prek/montessori', labelKey: 'nav.montessori', subject: { program: 'prek', subject: 'montessori' } },
        { path: '/prek/pe', labelKey: 'nav.pe', subject: { program: 'prek', subject: 'physical_education' } },
      ],
    },
    {
      path: '/k',
      labelKey: 'nav.k',
      icon: <BookOpen className="size-5" />,
      program: 'k',
      children: [
        { path: '/k/virtue', labelKey: 'nav.virtue', subject: { program: 'k', subject: 'virtue' } },
        { path: '/k/chinese', labelKey: 'nav.chinese', subject: { program: 'k', subject: 'chinese' } },
        { path: '/k/english', labelKey: 'nav.english', subject: { program: 'k', subject: 'english' } },
        { path: '/k/pe', labelKey: 'nav.pe', subject: { program: 'k', subject: 'physical_education' } },
      ],
    },
    {
      path: '/upload',
      labelKey: 'nav.upload',
      icon: <Upload className="size-5" />,
      permission: 'resource.create',
    },
    {
      path: '/my-resources',
      labelKey: 'nav.myResources',
      icon: <FolderOpen className="size-5" />,
    },
    {
      // 目录页对**所有**教师角色开放：服务端按角色剪枝，
      // 用户只会看到自己范围内的分支（visitor 会被 curriculum.view 挡住）。
      path: '/directory',
      labelKey: 'nav.directory',
      icon: <FolderTree className="size-5" />,
    },
    {
      // 账号安全（§12）：每个账号管理自己的两步验证，不按角色区分。
      path: '/account/security',
      labelKey: 'nav.security',
      icon: <ShieldCheck className="size-5" />,
    },
    {
      path: '/review',
      labelKey: 'nav.review',
      icon: <ClipboardCheck className="size-5" />,
      permission: 'review.view',
    },
    {
      path: '/admin',
      labelKey: 'nav.admin',
      icon: <Settings className="size-5" />,
      permission: 'account.view',
      children: [
        { path: '/admin/teachers', labelKey: 'nav.admin.teachers', permission: 'account.view' },
        { path: '/admin/permissions', labelKey: 'nav.admin.permissions', permission: 'permission.view' },
        { path: '/admin/audit', labelKey: 'nav.admin.audit', permission: 'audit.view' },
        // §回收站：唯一入口，按服务端同一权限码 resource.restore 显示。
        { path: '/admin/recycle-bin', labelKey: 'nav.admin.recycleBin', permission: 'resource.restore' },
      ],
    },
  ];

  const visibleMenuItems = filterMenu(menuItems);

  const renderMenuItem = (item: MenuItem, depth = 0): React.ReactNode => {
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expanded[item.path.replace('/', '')] ?? false;

    if (hasChildren) {
      return (
        <div key={item.path} className="mb-1">
          <button
            onClick={() => toggleExpanded(item.path.replace('/', ''))}
            data-testid="nav-group-toggle"
            data-nav={item.path}
            aria-expanded={isExpanded}
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
                  data-testid="nav-link"
                  data-nav={child.path}
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
        data-testid="nav-link"
        data-nav={item.path}
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
