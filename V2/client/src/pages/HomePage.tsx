import { Link } from 'react-router-dom'
import { useDirectory } from '../directory/DirectoryProvider'
import { directoryUrl } from '../directory/path'
import { Card, CardContent } from '../components/ui/Card'
import { EmptyState } from '../components/ui/EmptyState'
import { Spinner } from '../components/ui/Spinner'
import { Badge } from '../components/ui/Badge'

/**
 * 首页：只做一件事 —— 把一级栏目列出来。
 *
 * 刻意**不做仪表盘**（业主明确要求"不要大型 Dashboard"）。
 * 首页的价值是"一眼看到我现在能去哪儿"。
 */
export function HomePage() {
  const { roots, loading, ready } = useDirectory()

  return (
    <div data-testid="home-page">
      <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
        教师平台
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        选择一个栏目开始。目录由管理员维护，随时可以增删改。
      </p>

      {!ready && loading && <Spinner label="正在加载目录…" />}

      {ready && roots.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="你还没有被分配到任何目录"
            description="请联系管理员在「管理 → 教师」里为你开放目录范围。"
            testId="home-empty"
          />
        </div>
      )}

      {roots.length > 0 && (
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="home-roots">
          {roots.map((root) => (
            <Link key={root.id} to={directoryUrl(root.path)} className="block">
              <Card
                data-testid="home-root-card"
                data-directory-id={root.id}
                data-directory-slug={root.slug}
                className="h-full transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
              >
                <CardContent>
                  <h2 className="text-lg font-semibold text-foreground" data-testid="home-root-name">
                    {root.name}
                  </h2>
                  {root.nameEn !== null && (
                    <p className="mt-0.5 text-sm text-muted-foreground">{root.nameEn}</p>
                  )}
                  <Badge variant="secondary" className="mt-4">
                    {root.children.length} 个子目录
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
