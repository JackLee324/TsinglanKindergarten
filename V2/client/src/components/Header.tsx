import { LogOut, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { MobileNav } from './MobileNav'
import { useIsDesktop } from './useMediaQuery'

/**
 * 顶栏。右侧只显示"我是谁"与退出 —— 不展示角色、权限、范围这些内部概念
 * （业主明确要求教师界面不出现 RBAC / scope / grant / deny / override）。
 */
export function Header() {
  const { user, capabilities, logout } = useAuth()
  const navigate = useNavigate()
  /*
    窄屏（<1024px）在左侧给一个导航入口 —— 桌面侧边栏在那种宽度下**根本不渲染**
    （见 Layout 与 Sidebar），所以这里是唯一的入口，不是"多一个按钮"。
    宽屏不渲染它：同一时刻只存在一套导航。
  */
  const isDesktop = useIsDesktop()

  const onLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header
      className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b border-border bg-card px-4 sm:px-6"
      data-testid="header"
    >
      <div className="flex min-w-0 items-center gap-2">
        {!isDesktop && user !== null && <MobileNav />}
        <p
          className="truncate text-sm font-medium text-muted-foreground"
          data-testid="header-title"
        >
          教师资源平台
        </p>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        {user !== null && (
          <>
            <span className="flex items-center gap-2 text-sm text-foreground" data-testid="header-user">
              <UserRound className="size-4 shrink-0 text-muted-foreground" />
              {/* 窄屏上名字可能很长：允许省略，别把退出按钮挤出屏幕 */}
              <span className="max-w-[7rem] truncate sm:max-w-none" data-testid="header-user-name">
                {user.name}
              </span>
            </span>
            {/* 「管理员」这个标签来自服务端的能力位，前端不比较角色。 */}
            {capabilities?.isAdmin === true && (
              <Badge variant="secondary" data-testid="header-role-badge">
                管理员
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onLogout()}
              data-testid="logout-button"
            >
              <LogOut className="size-4" />
              退出
            </Button>
          </>
        )}
      </div>
    </header>
  )
}
