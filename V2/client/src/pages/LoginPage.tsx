import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { Input, Label } from '../components/ui/Input'

/**
 * 登录页。
 *
 * 只用账号 + 密码。**没有**验证码、恢复码、challenge 这些步骤 ——
 * 业主明确要求教师与管理员都用最简单的登录方式。
 * 安全是后台实现（scrypt、HttpOnly cookie、CSRF、限流），不是用户的操作步骤。
 */
export function LoginPage() {
  const { user, ready, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (ready && user !== null) {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      // 显示服务端给出的可读原因（"用户名或密码不正确" / "账号已停用…"），
      // 不要把 401 说成"网络错误"。
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" data-testid="login-page">
      <Card className="w-full max-w-sm">
        <CardContent>
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold text-foreground">教师资源平台</h1>
            <p className="mt-1 text-sm text-muted-foreground">清澜山幼儿园</p>
          </div>

          <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
            <div>
              <Label htmlFor="username" required>
                用户名
              </Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="login-username"
                required
              />
            </div>
            <div>
              <Label htmlFor="password" required>
                密码
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="login-password"
                required
              />
            </div>

            {error !== null && (
              <p
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="login-error"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={busy} data-testid="login-submit">
              {busy ? '登录中…' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
