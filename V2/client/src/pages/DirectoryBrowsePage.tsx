import { useParams } from 'react-router-dom'
import { useDirectory } from '../directory/DirectoryProvider'
import { DirectoryBrowser } from '../directory/DirectoryBrowser'
import { Breadcrumb } from '../components/Breadcrumb'
import { Spinner } from '../components/ui/Spinner'
import { EmptyState } from '../components/ui/EmptyState'

/**
 * 目录浏览页。
 *
 * 路由是 `/directory/*`，把通配段交给目录树解析 —— **路由里没有任何目录名**。
 * 因此管理员新增一级栏目时，这里一行都不用改。
 *
 * 解析不到时显示"已回到最近可解析的祖先"，而不是 404：
 * 目录被改名/停用/移动之后，老链接仍然要能落到一个有意义的位置。
 */
export function DirectoryBrowsePage() {
  const params = useParams()
  const segments = (params['*'] ?? '').split('/').filter((s) => s.length > 0)
  const { roots, ready, loading, resolve } = useDirectory()

  if (!ready && loading) return <Spinner label="正在加载目录…" />

  const target = resolve(segments)
  const unresolved = segments.slice(target.resolvedCount).join('/')

  if (target.node === null && segments.length > 0) {
    return (
      <div data-testid="directory-page">
        <div className="mb-5">
          <Breadcrumb chain={[]} />
        </div>
        <EmptyState
          title="找不到这个目录"
          description={`地址里的「${segments.join(' / ')}」已不存在或已被停用。请从左侧导航重新进入。`}
          testId="directory-not-found"
        />
      </div>
    )
  }

  const notice =
    unresolved.length > 0
      ? `地址中的「${unresolved}」已不存在或已被停用，已回到「${target.node?.name ?? '课程目录'}」。`
      : null

  return (
    <div data-testid="directory-page" data-directory-path={target.node?.path ?? ''}>
      <div className="mb-5">
        <Breadcrumb chain={target.chain} />
      </div>

      {target.node !== null && (
        <div className="mb-5">
          <h1
            className="text-2xl font-semibold text-foreground"
            data-testid="directory-title"
            data-directory-id={target.node.id}
            data-directory-slug={target.node.slug}
          >
            {target.node.name}
          </h1>
          {target.node.description !== null && target.node.description !== '' ? (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="directory-description">
              {target.node.description}
            </p>
          ) : (
            target.node.nameEn !== null && (
              <p className="mt-1 text-sm text-muted-foreground">{target.node.nameEn}</p>
            )
          )}
        </div>
      )}

      {target.node !== null && target.node.enabled === false && (
        <div
          className="mb-5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
          data-testid="directory-disabled-notice"
        >
          这个目录已停用，普通教师看不到它。你是因为有管理权限才看得到。
        </div>
      )}

      <DirectoryBrowser node={target.node} roots={roots} notice={notice} />
    </div>
  )
}
