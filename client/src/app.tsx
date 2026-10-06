import React from 'react';
import { Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import HomePage from './pages/Home/HomePage';
import UploadPage from './pages/Upload/UploadPage';
import MyResourcesPage from './pages/MyResources/MyResourcesPage';
import ReviewPage from './pages/Review/ReviewPage';
import TeacherAdminPage from './pages/TeacherAdmin/TeacherAdminPage';
import PermissionAdminPage from './pages/PermissionAdmin/PermissionAdminPage';
import AuditLogPage from './pages/AuditLog/AuditLogPage';
import RecycleBinPage from './pages/RecycleBin/RecycleBinPage';
import LoginPage from './pages/Login/LoginPage';
import UnauthorizedPage from './pages/Unauthorized/UnauthorizedPage';
import ChangePasswordPage from './pages/ChangePassword/ChangePasswordPage';
import DirectoryPage from './pages/Directory/DirectoryPage';
import AccountSecurityPage from './pages/AccountSecurity/AccountSecurityPage';
import UnassignedResourcesPage from './pages/UnassignedResources/UnassignedResourcesPage';

import { LanguageProvider } from './i18n/i18n-context';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AuthProvider } from './auth/auth-context';
import { ProtectedRoute } from './auth/ProtectedRoute';
// 目录的**唯一前端数据源**：侧边栏、首页、科目页、上传页、面包屑都从这里读。
// 它必须挂在 AuthProvider 之内（要等权限就绪才能拿一份没被误剪的树）。
import { DirectoryProvider } from './directory/DirectoryProvider';
import {
  DirectoryBrowseRoute,
  GrowthBrowseRoute,
  LegacyDirectoryRedirect,
} from './directory/DirectoryRoutes';

/**
 * 路由守全部改成**能力码**，与服务端同一份。
 *
 * WHY（这是 §13「每个概念只能有一个来源」的一个真实违规）：
 * 这里原本有四张手写的角色数组（TEACHER_ROLES / UPLOAD_ROLES / REVIEW_ROLES /
 * ADMIN_ROLES）。它们是**第二份真相**：服务端已经用 `@RequirePermission('…')`
 * 声明了每个接口要什么能力，侧边栏也已经按同一批能力码显示菜单。
 * 三份表述一旦分叉，既不报错也不被测试发现 —— 而它们**已经**分叉了：
 *
 *   1. 四张数组**全部漏掉了 `super_admin`**。后果不是"少看到一项菜单"，
 *      而是超管登录后被<Layout> 这一层的角色守卫直接挡在门外 —— 整个应用进不去。
 *   2. `ADMIN_ROLES = ['principal']` 比侧边栏用的 `account.view` **更窄**：
 *      `curriculum_director` 持有 `account.view`，侧边栏会给他显示「管理后台」，
 *      但点进去被路由弹回 —— "菜单说能进、进去说没权限"。
 *
 * 换成能力码之后三个方向同时对齐：
 *   · `<Layout>`（整个应用的入口）→ `curriculum.view`
 *   · 上传 → `resource.create`（服务端 POST /api/resources 同一个码）
 *   · 审核 → `review.view`（服务端审核接口同一个码）
 *   · 管理后台各页 → 各自服务端的码（account.view / permission.view /
 *     audit.view / resource.restore / curriculum.manage）
 *
 * 顺带修掉 super_admin 的封门问题：他持有全部权限，因此全部路由都进得去 ——
 * 这才是 `superAdminHoldsAll`（shared/rbac.ts 的 RBAC 不变式）应有的效果。
 */

const RoutesComponent = () => {
  return (
    <LanguageProvider>
      <AuthProvider>
        <DirectoryProvider>
          <AppErrorBoundary>
            <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />

            {/* Protected routes with layout */}
            <Route
              element={
                <ProtectedRoute requiredPermission="curriculum.view">
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<HomePage />} />

              {/* ============================================================
                  §1/§3/§11 目录浏览：**一个渲染器，一份数据**。
                  ============================================================
                  下面这组旧 URL（`/prek`、`/k/virtue`、`/k/english/:theme`…）
                  在这里都**仍然可用**，但它们不再各自渲染一套写死的页面，
                  而是解析成目录 code 之后跳到规范地址 `/directory/...`。
                  解析规则见 DirectoryProvider.resolveLegacyTarget（纯机械规则 +
                  一张只登记"无法推导的跨班型旧入口"的兼容表）。

                  为什么不再保留 PreKHomePage / KHomePage / MontessoriPage /
                  ChinesePage / EnglishPage / PEPage / SubjectPage 这七个页面的
                  路由：它们各自持有一份科目表与资料夹表，是业主指出的
                  「目录页叫 A、首页叫 B、侧边栏叫 C」的机制来源。
                  其中**真实且仍然有用的业务能力**（学期/周次筛选、第 51 条之后的
                  分页、蒙氏子分类与英文 Theme 的筛选、资源卡片与详情跳转）
                  已全部并入 DirectoryBrowser / DirectoryResources，没有丢。
                  ============================================================ */}
              <Route path="prek" element={<LegacyDirectoryRedirect />} />
              <Route path="prek/*" element={<LegacyDirectoryRedirect />} />
              <Route path="k" element={<LegacyDirectoryRedirect />} />
              <Route path="k/*" element={<LegacyDirectoryRedirect />} />
              <Route path="virtue" element={<LegacyDirectoryRedirect />} />
              <Route path="montessori" element={<LegacyDirectoryRedirect />} />
              <Route path="montessori/*" element={<LegacyDirectoryRedirect />} />

              {/* Upload */}
              <Route
                path="upload"
                element={
                  <ProtectedRoute requiredPermission="resource.create">
                    <UploadPage />
                  </ProtectedRoute>
                }
              />
              <Route path="my-resources" element={<MyResourcesPage />} />

              {/* 课程目录（PDF《教师平台》权威目录树，来自数据库）。
                  · `/directory` 与 `/directory/*` = 浏览（所有教师）
                  · `/directory/manage`        = 管理树（curriculum.manage）
                  两者是**同一个渲染器 + 一个入口**的关系：管理员在浏览页上
                  会多看到一个「管理此目录」按钮，而不是被送进另一个世界。 */}
              <Route path="directory" element={<DirectoryBrowseRoute />} />
              <Route
                path="directory/manage"
                element={
                  <ProtectedRoute requiredPermission="curriculum.manage">
                    <DirectoryPage />
                  </ProtectedRoute>
                }
              />
              <Route path="directory/*" element={<DirectoryBrowseRoute />} />

              {/* 教师成长（§10）：一等导航入口。`/growth` 与 `/growth/l1` 走同一套解析。 */}
              <Route path="growth" element={<GrowthBrowseRoute />} />
              <Route path="growth/*" element={<GrowthBrowseRoute />} />

              {/* Review */}
              <Route
                path="review"
                element={
                  <ProtectedRoute requiredPermission="review.view">
                    <ReviewPage />
                  </ProtectedRoute>
                }
              />

              {/* Admin */}
              <Route
                path="admin/teachers"
                element={
                  <ProtectedRoute requiredPermission="account.view">
                    <TeacherAdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/permissions"
                element={
                  <ProtectedRoute requiredPermission="permission.view">
                    <PermissionAdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/recycle-bin"
                element={
                  // 用**服务端同一个权限码**守卫（该路由服务端要求 resource.restore）。
                  // 不再写角色数组：角色数组是第二份真相，与服务端分叉时不会报错。
                  <ProtectedRoute requiredPermission="resource.restore">
                    <RecycleBinPage />
                  </ProtectedRoute>
                }
              />
              {/* §8 待补齐目录归属。用与服务端**同一个权限码**守卫
                  （`curriculum.manage`），因此只有园长/超管能进 ——
                  它是一页"全园资源的归档债清单"，不该对所有人开放。 */}
              <Route
                path="admin/unassigned-resources"
                element={
                  <ProtectedRoute requiredPermission="curriculum.manage">
                    <UnassignedResourcesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/audit"
                element={
                  <ProtectedRoute requiredPermission="audit.view">
                    <AuditLogPage />
                  </ProtectedRoute>
                }
              />

              {/* 账号安全 / 两步验证（§12）。对所有教师开放：每个账号管理自己的第二因素。
                  注意它必须放在受保护路由组内 —— 未登录进不来，而 MFA 未启用的
                  super_admin 也能进来自救（服务端对 mfa/enroll 做了豁免）。 */}
              <Route path="account/security" element={<AccountSecurityPage />} />

              {/* Change password */}
              <Route path="change-password" element={<ChangePasswordPage />} />
            </Route>

            <Route path="*" element={<NotFound />} />
            </Routes>
          </AppErrorBoundary>
        </DirectoryProvider>
      </AuthProvider>
    </LanguageProvider>
  );
};

export default RoutesComponent;
