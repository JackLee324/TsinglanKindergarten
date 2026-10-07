import { LogOut, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'

/**
 * 顶栏。右侧只显示"我是谁"与退出 —— 不展示角色、权限、范围这些内部概念
 * （业主明确要求教师界面不出现 RBAC / scope / grant / deny / override）。
 */
export function Header() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const onLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header
      className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-card px-6"
      data-testid="header"
    >
      <p className="text-sm font-medium text-muted-foreground" data-testid="header-title">
        教师资源平台
      </p>
      <div className="flex items-center gap-3">
        {user !== null && (
          <>
            <span className="flex items-center gap-2 text-sm text-foreground" data-testid="header-user">
              <UserRound className="size-4 text-muted-foreground" />
              <span data-testid="header-user-name">{user.name}</span>
            </span>
            {user.role === 'ADMIN' && (
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
