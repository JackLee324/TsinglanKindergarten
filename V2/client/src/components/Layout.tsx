import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

/**
 * 应用外壳：左侧 240px 固定导航 + 顶栏 + 主内容区（`p-6`，最大宽度 1280px 居中）。
 * 版式取自 V1，不做改动。
 */
export function Layout() {
  return (
    <div className="min-h-screen bg-background" data-testid="app-layout">
      <Sidebar />
      <div className="lg:pl-60">
        <Header />
        <main className="mx-auto max-w-[1280px] p-4 sm:p-6" data-testid="main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
