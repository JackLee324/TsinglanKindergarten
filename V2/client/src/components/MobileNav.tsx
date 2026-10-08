import { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { SidebarBrand, SidebarNav } from './Sidebar'

/**
 * 移动端导航（业主 Stage 11 §2 / §4）。
 *
 * 为什么是"hamburger + 抽屉"而不是底部 Tab：
 *   全站的导航**只有一份真相** —— 目录树（`GET /api/directories/tree`）加服务端给的
 *   `capabilities`。再加一套底部导航，就等于把同一件事画第三遍，
 *   而 V1 的教训正是"同一件事有好几份真相"（写死的科目数组 + 目录表）。
 *   所以这里只补一个**入口**，抽屉里装的是**同一个** `SidebarNav`。
 *
 * 桌面（≥1024px）与移动（<1024px）由 JS 二选一渲染（见 `useIsDesktop`），
 * 所以任何时刻页面上都只有一套导航节点 —— 不只是"看不见"，
 * 而是根本不渲染第二份。这一点对按 `[data-nav=...]` 定位的自动化同样重要。
 */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const location = useLocation()

  /** 换页面就关上（抽屉里点完一项，不该还挡着内容）。 */
  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  /** 打开时锁住背后的滚动；Esc 关闭。 */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-label="打开导航"
        aria-expanded={open}
        aria-controls="mobile-drawer"
        onClick={() => setOpen(true)}
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary"
        data-testid="nav-open"
      >
        <Menu className="size-5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex"
          data-testid="mobile-drawer-overlay"
          onMouseDown={(e) => {
            // 点遮罩关闭；点抽屉内部不关。
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div
            id="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="导航"
            className="sidebar-gradient flex h-full w-60 max-w-[80vw] flex-col border-r border-sidebar-border text-white shadow-xl"
            data-testid="mobile-drawer"
          >
            <div className="relative shrink-0">
              <SidebarBrand />
              <button
                type="button"
                aria-label="关闭导航"
                onClick={() => setOpen(false)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10"
                data-testid="nav-close"
              >
                <X className="size-5" />
              </button>
            </div>
            {/* 抽屉自己滚动（不与 body 抢滚动条） */}
            <SidebarNav onNavigate={() => setOpen(false)} />
          </div>
          <div className="flex-1 bg-black/30" aria-hidden="true" />
        </div>
      )}
    </>
  )
}
