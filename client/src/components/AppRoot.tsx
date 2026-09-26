import React, { useState } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';

/**
 * The application root.
 * =====================
 *
 * WHAT THIS REPLACES
 * ------------------
 * `index.tsx` used to render `AppContainer` from `@lark-apaas/client-toolkit`. That
 * component wrapped the whole app in, in this order:
 *
 *   SafetyErrorBoundary > Watermark        (a "妙搭生成" badge, bottom-right)
 *   QueryProvider                          (react-query; used by nothing else here)
 *   ConfigProvider                         (antd theme derived from our CSS tokens)
 *   AuthProvider                           (the platform's auth SDK; `enableAuth`
 *                                           was never passed, so it was inert)
 *   App                                    (page-view telemetry + Inspector in dev)
 *   PageHoc                                (dev-only screenshot bridge; production
 *                                           returns children unchanged)
 *   Toaster                                (skipped: package.json sets
 *                                           `flags.customToaster`, and the app
 *                                           renders its own sonner Toaster)
 *
 * Of those, exactly ONE has a visible effect in this application and is reproduced
 * here: the antd `ConfigProvider`. Four pages (`MyResources`, `TeacherAdmin`,
 * `Review`, `AuditLog`) render antd's `Table`, and the provider is what makes that
 * table use this product's palette instead of antd's default blue, and what makes
 * its pagination read "条/页" instead of English. Dropping it would have been a real
 * UI change, invisible in any test that only fetches HTTP.
 *
 * The rest is dropped for stated reasons:
 *   * Watermark — a floating 妙搭 badge plus an <img> from `lf3-static.bytednsdoc.com`
 *     (verified in the rendered DOM before this migration). It is platform branding
 *     and a third-party runtime dependency; removing it is the single deliberate
 *     visual change of this migration and is reported as such.
 *   * QueryProvider — `@tanstack/react-query` is used only by the dead
 *     `components/business-ui` tree, which is deleted.
 *   * AuthProvider / Inspector / IframeBridge / PageHoc / Toaster — inert
 *     (`enableAuth` unset), development-only, or superseded by the app's own.
 *   * ErrorRender + its ErrorBoundary — superseded by the app's own
 *     `AppErrorBoundary`, which app.tsx mounts inside the router (it needs
 *     `useNavigate`, so it has to be inside `BrowserRouter`; a second boundary
 *     here would be a fallback the user can never reach).
 *
 * THE TOKENS ARE READ FROM CSS, NOT HARD-CODED
 * --------------------------------------------
 * Same mechanism as the platform's, verified against its source: read the design
 * tokens off `document.documentElement` once at mount and hand them to antd. That
 * keeps the table in step with `client/src/tailwind-theme.css` — one palette, two
 * consumers — instead of duplicating hex values here where they would drift.
 *
 * `colorSuccess: primary` and `colorWarning: destructive` look wrong and are kept
 * exactly as they were: they are the shipped mapping, and "fixing" them would
 * change the colour of every antd success/warning affordance.
 */

interface CssVarColors {
  background?: string;
  destructive?: string;
  primary?: string;
  foreground?: string;
  warning?: string;
  success?: string;
  muted?: string;
  mutedForeground?: string;
  border?: string;
  popover?: string;
  accent?: string;
}

function readAllCssVarColors(): CssVarColors {
  try {
    if (typeof document === 'undefined') return {};
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string): string | undefined =>
      styles.getPropertyValue(name).trim() || undefined;
    return {
      background: read('--background'),
      destructive: read('--destructive'),
      primary: read('--primary'),
      foreground: read('--foreground'),
      warning: read('--warning'),
      success: read('--success'),
      muted: read('--muted'),
      mutedForeground: read('--muted-foreground'),
      border: read('--border'),
      popover: read('--popover'),
      accent: read('--accent'),
    };
  } catch {
    // An unreadable stylesheet must not stop the app from rendering; antd then
    // falls back to its own defaults, which is the pre-platform behaviour.
    return {};
  }
}

interface AppRootProps {
  children: React.ReactNode;
}

export const AppRoot: React.FC<AppRootProps> = ({ children }) => {
  // Read once, at mount — the same point in the lifecycle the platform read them.
  const [cssColors] = useState(readAllCssVarColors);

  const antdThemeToken = {
    colorBgBase: cssColors.background,
    colorError: cssColors.destructive,
    colorInfo: cssColors.primary,
    colorLink: cssColors.primary,
    colorPrimary: cssColors.primary,
    colorSuccess: cssColors.primary,
    colorTextBase: cssColors.foreground,
    colorWarning: cssColors.destructive,
  };

  const antdTableToken = {
    bodySortBg: cssColors.muted,
    borderColor: cssColors.border,
    expandIconBg: cssColors.background,
    filterDropdownBg: cssColors.popover,
    filterDropdownMenuBg: cssColors.popover,
    fixedHeaderSortActiveBg: cssColors.muted,
    footerBg: cssColors.muted,
    footerColor: cssColors.mutedForeground,
    headerBg: cssColors.muted,
    headerColor: cssColors.mutedForeground,
    headerFilterHoverBg: cssColors.muted,
    headerSortActiveBg: cssColors.muted,
    headerSortHoverBg: cssColors.muted,
    headerSplitColor: cssColors.border,
    rowExpandedBg: cssColors.background,
    rowHoverBg: cssColors.muted,
    rowSelectedBg: cssColors.accent,
    rowSelectedHoverBg: cssColors.accent,
    stickyScrollBarBg: cssColors.muted,
  };

  const antdPaginationToken = {
    itemActiveBg: cssColors.background,
    itemActiveBgDisabled: cssColors.muted,
    itemActiveColor: cssColors.primary,
    itemActiveColorDisabled: cssColors.muted,
    itemActiveColorHover: cssColors.muted,
    itemBg: cssColors.background,
    itemInputBg: cssColors.background,
    itemLinkBg: cssColors.background,
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: antdThemeToken,
        components: {
          Table: antdTableToken,
          Pagination: antdPaginationToken,
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
};
