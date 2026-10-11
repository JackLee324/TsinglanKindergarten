import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { useIsDesktop } from './useMediaQuery'
import { AiAssistantProvider } from './ai/AiAssistantContext'
import { AiPanel } from './ai/AiPanel'

/**
 * 应用外壳：左侧 240px 固定导航 + 顶栏 + 主内容区（`p-6`，最大宽度 1280px 居中）。
 * 版式取自 V1，不做改动。
 */
export function Layout() {
  /*
    导航按视口二选一渲染 —— **不是**用 CSS 藏起来。
    窄屏下侧边栏的 DOM 根本不存在，于是"页面上同时有两套 data-nav"这件事
    在结构上就不可能发生（自动化按 [data-nav] 定位时也不会撞上隐藏的那份）。
    窄屏的入口在 Header 里的 hamburger（MobileNav → 抽屉），抽屉里装的是
    同一个 SidebarNav。
  */
  const isDesktop = useIsDesktop()

  return (
    /*
      AI 助手面板挂在**外壳**上（不是挂在某一页里）：
      它是"随时能问一句"的工具，切页面不该把它关掉。
      Provider 只提供开关状态，入口在侧边栏与顶栏 —— 两处都调同一个 open()。
    */
    <AiAssistantProvider>
      <div className="min-h-screen bg-background" data-testid="app-layout">
        {isDesktop && <Sidebar />}
        <div className="lg:pl-60">
          <Header />
          <main className="mx-auto max-w-[1280px] p-4 sm:p-6" data-testid="main">
            <Outlet />
          </main>
        </div>
        <AiPanel />
      </div>
    </AiAssistantProvider>
  )
}
