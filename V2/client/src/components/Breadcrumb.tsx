import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { DirectoryNode } from '../api/types'
import { DIRECTORY_BASE, directoryUrl } from '../directory/path'

/**
 * 面包屑。祖先链来自**目录树本身**（`parentId` 关系），
 * 不用 slug 前缀推断 —— V1 曾经因此漏掉中间层。
 */
export function Breadcrumb({ chain }: { readonly chain: readonly DirectoryNode[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm" data-testid="breadcrumb">
      <Link
        to={DIRECTORY_BASE}
        className="text-muted-foreground transition-colors hover:text-primary"
        data-testid="breadcrumb-root"
      >
        课程目录
      </Link>
      {chain.map((node, index) => {
        const isLast = index === chain.length - 1
        return (
          <span key={node.id} className="flex items-center gap-1">
            <ChevronRight className="size-4 text-muted-foreground/60" />
            {isLast ? (
              <span
                className="font-medium text-foreground"
                data-testid="breadcrumb-current"
                data-directory-id={node.id}
                data-directory-slug={node.slug}
              >
                {node.name}
              </span>
            ) : (
              <Link
                to={directoryUrl(node.path)}
                className="text-muted-foreground transition-colors hover:text-primary"
                data-testid="breadcrumb-item"
                data-directory-slug={node.slug}
              >
                {node.name}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
