import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight, ClipboardCheck, FolderTree, Home, Layers, Settings } from 'lucide-react'
import { useDirectory } from '../directory/DirectoryProvider'
import { directoryUrl, isWithinPath } from '../directory/path'
import { useAuth } from '../auth/useAuth'
import type { DirectoryNode } from '../api/types'
import { cn } from './ui/cn'

/**
 * 侧边栏。**完全由目录数据生成** —— 这里没有一处写死的栏目名。
 *
 * 一级栏目 = `GET /api/directories/tree` 返回的 roots。
 * 管理员在数据库里新增「活动」，它就自动出现在这里，不需要改 React。
 *
 * 视觉取自 V1：240px 固定宽、紫色渐变、白字、当前项 `bg-white/15`。
 */
export function Sidebar() {
  const { roots, loading, ready } = useDirectory()
  const { capabilities } = useAuth()
  const location = useLocation()
  const currentPath = location.pathname.startsWith('/directory/')
    ? location.pathname.slice('/directory/'.length)
    : ''

  return (
    <aside
      className="sidebar-gradient fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-sidebar-border text-white lg:flex"
      data-testid="sidebar"
    >
      <div className="flex h-16 items-center gap-3 border-b border-white/15 px-5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-white/20">
          <FolderTree className="size-5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">教师平台</p>
          <p className="text-xs text-white/70">清澜山幼儿园</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" data-testid="sidebar-nav">
        <NavItem to="/" label="首页" icon={<Home className="size-5" />} testId="nav-home" />
        {/* 「我的资源」是**固定条目**，不是目录节点 —— 它由后端按 uploader 过滤，
            与目录树无关。除此之外侧边栏里的一切都来自目录数据。 */}
        <NavItem
          to="/my-resources"
          label="我的资源"
          icon={<Layers className="size-5" />}
          testId="nav-my-resources"
        />
        {/* 审核工作台只对有审核权限的人显示（能力位来自服务端，前端不判断角色）。 */}
        {capabilities?.canReview === true && (
          <NavItem
            to="/review"
            label="审核工作台"
            icon={<ClipboardCheck className="size-5" />}
            testId="nav-review"
          />
        )}

        {/*
          目录区：一级栏目全部来自数据库。
          `data-nav` 用 URL、`data-directory-slug` 用 slug —— 浏览器测试据此定位，
          不依赖中文文案（文案是可改的，slug 不是）。
        */}
        <div className="mt-2 space-y-0.5" data-testid="sidebar-directories">
          {!ready && loading && <p className="px-3 py-2 text-xs text-white/70">加载中…</p>}
          {ready && roots.length === 0 && (
            <p className="px-3 py-2 text-xs text-white/70" data-testid="sidebar-empty">
              还没有可访问的目录
            </p>
          )}
          {roots.map((root) => (
            <SidebarNode
              key={root.id}
              node={root}
              currentPath={currentPath}
              depth={0}
            />
          ))}
        </div>

        {capabilities?.canManageDirectories === true && (
          <div className="mt-3 border-t border-white/15 pt-3">
            <NavItem
              to="/directory/manage"
              label="目录管理"
              icon={<Settings className="size-5" />}
              testId="nav-directory-manage"
            />
          </div>
        )}
      </nav>
    </aside>
  )
}

function NavItem({
  to,
  label,
  icon,
  testId,
  dataNav,
  dataSlug,
}: {
  readonly to: string
  readonly label: string
  readonly icon?: React.ReactNode
  readonly testId: string
  readonly dataNav?: string
  readonly dataSlug?: string
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      data-testid={testId}
      data-nav={dataNav ?? to}
      data-directory-slug={dataSlug}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'bg-white/20 font-medium text-white' : 'text-white/90 hover:bg-white/10',
        )
      }
    >
      {icon}
      <span data-testid={`${testId}-label`}>{label}</span>
    </NavLink>
  )
}

/**
 * 一个目录节点。
 *
 * 默认**收起**（与 V1 一致），避免 69 个节点一上来全展开。
 * 展开状态由用户的当前路径驱动：进入深层节点时，祖先链自动展开。
 */
function SidebarNode({
  node,
  currentPath,
  depth,
}: {
  readonly node: DirectoryNode
  readonly currentPath: string
  readonly depth: number
}) {
  const active = isWithinPath(currentPath, node.path)
  const hasChildren = node.children.length > 0
  const [open, setOpen] = useState(depth === 0 ? active : false)
  const url = directoryUrl(node.path)

  // 进入深层节点时把它所在的祖先链展开（首次渲染后由用户交互改变）。
  const shouldBeOpen = open || (depth === 0 && active)

  return (
    <>
      <div className="flex items-center" data-nav-row={url}>
        {hasChildren && (
          <button
            type="button"
            aria-label={shouldBeOpen ? '收起' : '展开'}
            aria-expanded={shouldBeOpen}
            data-testid="sidebar-toggle"
            data-nav-toggle={url}
            onClick={() => setOpen((v) => !v)}
            className="ml-1 rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
          >
            {shouldBeOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        )}
        <NavLink
          to={url}
          data-testid="sidebar-node"
          data-nav={url}
          data-directory-id={node.id}
          data-directory-slug={node.slug}
          data-directory-enabled={String(node.enabled)}
          className={({ isActive }) =>
            cn(
              'flex-1 truncate rounded-lg px-3 py-2 text-sm transition-colors',
              hasChildren ? '' : 'ml-6',
              isActive
                ? 'bg-white/20 font-medium text-white'
                : 'text-white/90 hover:bg-white/10',
            )
          }
        >
          <span data-testid="sidebar-node-label">{node.name}</span>
        </NavLink>
      </div>

      {hasChildren && shouldBeOpen && (
        <div className="mt-0.5 space-y-0.5 border-l border-white/15 pl-1" data-nav-children={url}>
          {node.children.map((child) => (
            <SidebarNode
              key={child.id}
              node={child}
              currentPath={currentPath}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </>
  )
}
