import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import { DirectoryProvider } from './directory/DirectoryProvider'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { HomePage } from './pages/HomePage'
import { DirectoryBrowsePage } from './pages/DirectoryBrowsePage'
import { DirectoryManagePage } from './pages/DirectoryManagePage'
import { ResourceDetailPage } from './pages/ResourceDetailPage'
import { MyResourcesPage } from './pages/MyResourcesPage'
import { ReviewQueuePage } from './pages/ReviewQueuePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Spinner } from './components/ui/Spinner'
import { EmptyState } from './components/ui/EmptyState'

/**
 * 应用装配。
 *
 * 路由表里**没有任何目录名**：`/directory/*` 把通配段交给目录树解析。
 * 所以"管理员新增一级栏目「活动」"这件事在前端是**零改动**的。
 *
 * 权限判定只有一处：`RequireAuth`（是否登录）。至于"能不能看目录管理"，
 * 用的是服务端给的 `capabilities.canManageDirectories` —— 前端不判断角色。
 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DirectoryProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<HomePage />} />
              <Route path="my-resources" element={<MyResourcesPage />} />
              {/*
                审核工作台。权限同样来自服务端的 capabilities ——
                前端不判断角色（页面内部还有一层提示，但真正的边界在接口上）。
              */}
              <Route path="review" element={<ReviewQueuePage />} />
              {/*
                资源详情用 **id** 做地址（`/resources/:id`），不用标题 ——
                标题可改、可重复。目录仍然用 slug 路径，两者不混。
              */}
              <Route path="resources/:id" element={<ResourceDetailPage />} />
              <Route path="directory" element={<DirectoryBrowsePage />} />
              {/* 目录管理要放在通配之前，否则会被 `/directory/*` 吃掉 */}
              <Route path="directory/manage" element={<RequireDirectoryManage><DirectoryManagePage /></RequireDirectoryManage>} />
              <Route path="directory/*" element={<DirectoryBrowsePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </DirectoryProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

/** 未登录 → 登录页。**在 `ready` 之前不跳转**，否则首帧会闪一下登录页。 */
function RequireAuth({ children }: { readonly children: ReactNode }) {
  const { user, ready } = useAuth()
  const location = useLocation()

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="正在加载…" />
      </div>
    )
  }
  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

/**
 * 目录管理只对**服务端说可以的人**开放。
 *
 * 这里不是安全边界（接口自己会拒），但界面不该把一个必然失败的操作摆在教师面前。
 */
function RequireDirectoryManage({ children }: { readonly children: ReactNode }) {
  const { capabilities } = useAuth()
  if (capabilities?.canManageDirectories !== true) {
    return (
      <EmptyState
        title="你没有目录管理权限"
        description="如果这是需要的，请联系管理员。"
        testId="manage-forbidden"
      />
    )
  }
  return <>{children}</>
}
