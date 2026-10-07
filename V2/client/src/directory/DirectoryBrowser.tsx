import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, FolderTree, GraduationCap, Image, Layers, Palette, Sparkles, Users } from 'lucide-react'
import type { DirectoryNode } from '../api/types'
import { directoryUrl } from './path'
import { Card, CardContent } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'

/**
 * 目录浏览渲染器 —— **全站唯一的目录渲染器**。
 *
 * 视觉严格取自 V1 的目录卡片：白卡、`rounded-xl`、`p-6`、14×14 的浅色图标块、
 * `text-lg font-semibold` 标题、底部 Badge + 进入箭头，hover 轻轻上浮。
 *
 * 与 V1 的差别只有数据来源：V1 的卡片来自数据库 + 一份写死的图标映射表；
 * V2 用节点的 `slug`/`type` 做同样的映射（**只是图标外观，不影响任何行为**），
 * 一个目录都没有写死。
 */
export interface DirectoryBrowserProps {
  readonly node: DirectoryNode | null
  readonly roots: readonly DirectoryNode[]
  /**
   * 需要提示"路径没解析全、已回到某个祖先"时给出说明。
   * 不白屏、不 404 —— 老链接与改名后的链接都要落到一个有意义的位置。
   */
  readonly notice?: string | null
}

export function DirectoryBrowser({ node, roots, notice }: DirectoryBrowserProps) {
  const navigate = useNavigate()
  const children = node === null ? roots : node.children

  return (
    <div data-testid="directory-browser" data-directory-id={node?.id ?? 'roots'}>
      {notice !== null && notice !== undefined && (
        <div
          className="mb-5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground"
          data-testid="directory-notice"
        >
          {notice}
        </div>
      )}

      {children.length === 0 ? (
        <EmptyState
          title="这个目录下还没有子目录"
          description="管理员可以在这里新建子目录，或把资源直接放在这个目录下（下一阶段开放上传）。"
          testId="directory-empty"
        />
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="directory-card-list">
          {children.map((child) => (
            <DirectoryCard key={child.id} node={child} onOpen={() => navigate(directoryUrl(child.path))} />
          ))}
        </div>
      )}
    </div>
  )
}

function DirectoryCard({
  node,
  onOpen,
}: {
  readonly node: DirectoryNode
  readonly onOpen: () => void
}) {
  const spec = iconFor(node)
  return (
    <Card
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      data-testid="directory-card"
      data-directory-id={node.id}
      data-directory-slug={node.slug}
      className="group cursor-pointer border-border shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
    >
      <CardContent>
        <div className={`mb-4 flex size-14 items-center justify-center rounded-xl ${spec.bg}`}>
          {spec.icon}
        </div>
        <h3 className="text-lg font-semibold text-foreground" data-testid="directory-card-name">
          {node.name}
        </h3>
        {node.nameEn !== null && node.nameEn !== '' && (
          <p className="mt-0.5 text-sm text-muted-foreground">{node.nameEn}</p>
        )}
        {node.description !== null && node.description !== '' && (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{node.description}</p>
        )}
        <div className="mt-5 flex items-center justify-between">
          <Badge variant={node.enabled ? 'secondary' : 'muted'} data-testid="directory-card-count">
            {node.children.length > 0
              ? `${node.children.length} 个子目录`
              : node.allowFiles
                ? `${node.resourceCount} 条资源`
                : '空目录'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-transform group-hover:translate-x-0.5">
            <ArrowRight className="size-4" />
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 图标外观映射。**只影响长相，不影响任何行为** ——
 * 没有它的节点照样渲染（退到按 type 的默认图标）。
 *
 * 这里刻意用 `type` 与 `slug` 而不是"科目 code 前缀"：
 * 前者是通用树的一部分，后者是 V1 的课程专用结构。
 */
function iconFor(node: DirectoryNode): { icon: React.ReactNode; bg: string } {
  const bySlug: Record<string, { icon: React.ReactNode; bg: string }> = {
    virtue: { icon: <Sparkles className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    montessori: { icon: <Palette className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    pe: { icon: <Users className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    english: { icon: <BookOpen className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    chinese: { icon: <BookOpen className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    resources: { icon: <Image className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    lesson: { icon: <Layers className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
  }
  const byType: Record<DirectoryNode['type'], { icon: React.ReactNode; bg: string }> = {
    ROOT: { icon: <GraduationCap className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    CATEGORY: { icon: <GraduationCap className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    SECTION: { icon: <FolderTree className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
    FOLDER: { icon: <FolderTree className="size-6" />, bg: 'bg-[#FAF8FF] text-primary' },
  }
  return bySlug[node.slug] ?? byType[node.type]
}
