import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { PERMISSIONS, PERMISSION_CODES, type PermissionCode } from '@shared/permissions'
import { useDirectory } from '../../directory/DirectoryProvider'
import type { DirectoryNode, PermissionGrant } from '../../api/types'
import { cn } from '../ui/cn'

/**
 * 权限编辑器（业主 Stage 8 §3 / §24 / §25）。
 *
 * 界面上**只有中文**：
 *   · 权限 = 「查看资源」「上传资源」……
 *   · 范围 = 「开放目录」
 *
 * 绝不出现 `permission code` / `scope kind` / `grant` / `deny` / `override` /
 * `effective` —— 业主的原话是"管理员应该感觉自己在管理老师和目录，
 * 而不是在配置一个复杂的 RBAC 系统"。
 *
 * ── 两种模式，默认是最简单的那种 ──────────────────────────────────────────
 *
 * **统一开放目录**（默认）：勾选权限 + 勾选目录 = 每个权限都在这些目录上生效。
 * 这是园里 99% 的场景（"王老师在 Pre-K/美德 能查看和上传"）。
 *
 * **分别设置**：某个权限的目录与别的不一样时才用。
 *
 * ⚠️ 为什么必须有两种：数据模型是 `(permission, directoryId)` 的组合，
 * 只给"统一"模式的话，打开一个**已经分别设置过**的老师再保存，
 * 会把他那些不一样的授权**悄悄抹平成一个笛卡尔积**。
 * 所以这里先检测：配置不是笛卡尔积就自动进入"分别设置"并说明原因。
 * 宁可多一个模式，也不要静默改掉别人的权限。
 */
export interface PermissionDraft {
  /** 统一模式：这些权限 × 这些目录。 */
  readonly permissions: readonly PermissionCode[]
  readonly directories: readonly string[]
}

export function PermissionEditor({
  value,
  onChange,
  resetKey,
  onModeChange,
}: {
  readonly value: PermissionGrant[]
  readonly onChange: (grants: PermissionGrant[], mode: 'uniform' | 'per-permission') => void
  /**
   * 编辑器**当前用哪种方式**，回传给父组件（父组件底部那行"当前方式：…"要用）。
   *
   * 为什么必须有这个回调：方式是由编辑器自己决定的 —— 一份"按权限分别设置"
   * 的授权会自动落到「分别设置」（见下面 resetKey 的说明）。父组件只能猜，
   * 而它猜的初值是「统一开放目录」，于是画面上会同时出现
   * "「分别设置」高亮着"和"当前方式：统一开放目录"两句话互相打架。
   * 这是 Stage 8 的浏览器用例（⑦）抓出来的，不是理论问题。
   */
  readonly onModeChange?: (mode: 'uniform' | 'per-permission') => void
  /**
   * 何时**重新初始化**编辑器（换一个老师、或者弹窗重新打开）。
   *
   * ⚠️ 这个参数是必需的，不是可选的方便参数。原因很具体：
   *
   * 「统一开放目录」模式下，"勾了权限但还没勾目录"是一个**中间状态**，
   * 它产生不了任何授权（笛卡尔积是空的）。如果编辑器跟着 `value` 走，
   * 父组件把这份空授权回传回来时，编辑器会以为"什么都没有"，把刚勾上的
   * 权限又清掉 —— 表现就是"勾选框点不动"。
   *
   * 所以：编辑器自己持有这套中间状态，只在 resetKey 变化时才从 value 重建。
   * （这个缺陷是 Stage 8 的浏览器用例抓出来的：界面上勾了 4 个权限，
   *   保存下去数据库里是 0 条。）
   */
  readonly resetKey: string
}) {
  const { roots } = useDirectory()

  const uniform = useMemo(() => uniformDirectoriesOf(value), [value])
  const [mode, setMode] = useState<'uniform' | 'per-permission'>(
    uniform === null ? 'per-permission' : 'uniform',
  )
  const [checkedPermissions, setCheckedPermissions] = useState<PermissionCode[]>(() => [
    ...new Set(value.map((g) => g.permission as PermissionCode)),
  ])
  const [checkedDirectories, setCheckedDirectories] = useState<string[]>(() => uniform ?? [])
  const [perPermission, setPerPermission] = useState<Record<string, string[]>>(() => byPermission(value))

  /** 只有**换了对象**才从 value 重建（见 resetKey 的说明）。 */
  const lastResetKey = useRef(resetKey)
  useEffect(() => {
    if (lastResetKey.current === resetKey) return
    lastResetKey.current = resetKey
    const nextUniform = uniformDirectoriesOf(value)
    setMode(nextUniform === null ? 'per-permission' : 'uniform')
    setCheckedPermissions([...new Set(value.map((g) => g.permission as PermissionCode))])
    setCheckedDirectories(nextUniform ?? [])
    setPerPermission(byPermission(value))
    // value 故意不进依赖：进了就回到"父组件回传空授权 → 清空勾选"的老问题上。
    // eslint 在本项目里没有装 react-hooks 插件，所以这里不写 disable 注释。
  }, [resetKey])

  /*
    把"现在用的是哪种方式"告诉父组件（含首次挂载与换人之后的重建），
    父组件底部那行"当前方式：…"才不会和编辑器里高亮的方式互相打架。

    回调用 ref 拿，避免父组件每渲染一次传一个新函数就把 effect 又跑一遍。
    setMode 收到同样的值时 React 会直接跳过重渲染，所以这里不存在循环。
  */
  const modeChangeRef = useRef(onModeChange)
  modeChangeRef.current = onModeChange
  useEffect(() => {
    modeChangeRef.current?.(mode)
  }, [mode])

  const emitUniform = (permissions: PermissionCode[], directories: string[]) => {
    const grants: PermissionGrant[] = []
    for (const permission of permissions) {
      for (const directoryId of directories) grants.push({ permission, directoryId })
    }
    onChange(grants, 'uniform')
  }

  const emitPerPermission = (draft: Record<string, string[]>) => {
    const grants: PermissionGrant[] = []
    for (const [permission, directories] of Object.entries(draft)) {
      for (const directoryId of directories) grants.push({ permission: permission as PermissionCode, directoryId })
    }
    onChange(grants, 'per-permission')
  }

  /** 全局权限（用户管理 / 审计）不带目录范围 —— 界面上单独一栏，免得被误当成"还要选目录"。 */
  const directoryPermissions = PERMISSION_CODES.filter((p) => PERMISSIONS[p].scope === 'directory')
  const globalPermissions = PERMISSION_CODES.filter((p) => PERMISSIONS[p].scope === 'global')

  return (
    <div className="space-y-4" data-testid="permission-editor">
      {mode === 'per-permission' && (
        <p
          className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground"
          data-testid="permission-mode-notice"
        >
          这位老师的权限是按权限分别设置的（不同权限开放了不同目录）。
          为了不悄悄改掉它，下面用的是「分别设置」。想改成统一开放目录，可以点上面的按钮。
        </p>
      )}

      <div className="flex gap-2 text-xs" data-testid="permission-mode-switch">
        <button
          type="button"
          onClick={() => {
            setMode('uniform')
            emitUniform(checkedPermissions, checkedDirectories)
          }}
          className={cn(
            'rounded-full px-3 py-1',
            mode === 'uniform' ? 'bg-primary text-primary-foreground' : 'bg-secondary',
          )}
          data-testid="permission-mode-uniform"
          data-active={String(mode === 'uniform')}
        >
          统一开放目录
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('per-permission')
            emitPerPermission(perPermission)
          }}
          className={cn(
            'rounded-full px-3 py-1',
            mode === 'per-permission' ? 'bg-primary text-primary-foreground' : 'bg-secondary',
          )}
          data-testid="permission-mode-per"
          data-active={String(mode === 'per-permission')}
        >
          分别设置
        </button>
      </div>

      {/* ── 权限 ─────────────────────────────────────────────────────────── */}
      <div>
        <p className="mb-2 text-sm font-medium text-foreground">权限</p>
        <div className="grid gap-2 sm:grid-cols-2" data-testid="permission-list">
          {directoryPermissions.map((code) => (
            <label
              key={code}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2"
              data-testid="permission-option"
              data-permission={code}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checkedPermissions.includes(code)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...checkedPermissions, code]
                    : checkedPermissions.filter((p) => p !== code)
                  setCheckedPermissions(next)
                  if (mode === 'uniform') {
                    emitUniform(next, checkedDirectories)
                  } else {
                    const draft = { ...perPermission }
                    if (e.target.checked) draft[code] = draft[code] ?? [...checkedDirectories]
                    else delete draft[code]
                    setPerPermission(draft)
                    emitPerPermission(draft)
                  }
                }}
                data-testid={`permission-${code}`}
              />
              <span className="min-w-0">
                {/* 只显示中文标签 —— 权限码出现在界面上就是"配置 RBAC 系统"的感觉 */}
                <span className="block text-sm text-foreground">{PERMISSIONS[code].label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {PERMISSIONS[code].description}
                </span>
              </span>
            </label>
          ))}
        </div>

        {globalPermissions.length > 0 && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="global-permission-list">
            {globalPermissions.map((code) => (
              <label
                key={code}
                className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2"
                data-testid="global-permission-option"
                data-permission={code}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checkedPermissions.includes(code)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...checkedPermissions, code]
                      : checkedPermissions.filter((p) => p !== code)
                    setCheckedPermissions(next)
                    if (mode === 'uniform') {
                      // 全局权限不带目录范围 —— 单独处理，不参与笛卡尔积。
                      emitUniform(next, checkedDirectories)
                    } else {
                      const draft = { ...perPermission }
                      if (e.target.checked) draft[code] = []
                      else delete draft[code]
                      setPerPermission(draft)
                      emitPerPermission(draft)
                    }
                  }}
                  data-testid={`permission-${code}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{PERMISSIONS[code].label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {PERMISSIONS[code].description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── 开放目录 ─────────────────────────────────────────────────────── */}
      <div>
        <p className="mb-2 text-sm font-medium text-foreground">开放目录</p>
        {mode === 'uniform' ? (
          <DirectoryTree
            roots={roots}
            selected={checkedDirectories}
            onToggle={(ids) => {
              setCheckedDirectories(ids)
              emitUniform(checkedPermissions, ids)
            }}
            testIdPrefix="directory-option"
          />
        ) : (
          <div className="space-y-3">
            {checkedPermissions
              .filter((code) => PERMISSIONS[code].scope === 'directory')
              .map((code) => (
                <details key={code} className="rounded-lg border border-border px-3 py-2" open>
                  <summary
                    className="cursor-pointer text-sm text-foreground"
                    data-testid="per-permission-row"
                    data-permission={code}
                  >
                    {PERMISSIONS[code].label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      已开放 {(perPermission[code] ?? []).length} 个目录
                    </span>
                  </summary>
                  <div className="mt-2">
                    <DirectoryTree
                      roots={roots}
                      selected={perPermission[code] ?? []}
                      onToggle={(ids) => {
                        const draft = { ...perPermission, [code]: ids }
                        setPerPermission(draft)
                        emitPerPermission(draft)
                      }}
                      testIdPrefix={`directory-option-${code}`}
                    />
                  </div>
                </details>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 目录树多选。层级与目录浏览用的是**同一棵树**（DirectoryProvider）。 */
function DirectoryTree({
  roots,
  selected,
  onToggle,
  testIdPrefix,
}: {
  readonly roots: readonly DirectoryNode[]
  readonly selected: readonly string[]
  readonly onToggle: (ids: string[]) => void
  readonly testIdPrefix: string
}) {
  const [expanded, setExpanded] = useState<string[]>(() => roots.map((r) => r.id))

  return (
    <ul className="rounded-lg border border-border p-2" data-testid="directory-tree">
      {roots.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          selected={selected}
          expanded={expanded}
          onToggleExpand={(id) =>
            setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
          }
          onToggleSelect={(ids) => onToggle(ids)}
          testIdPrefix={testIdPrefix}
        />
      ))}
    </ul>
  )
}

function TreeRow({
  node,
  depth,
  selected,
  expanded,
  onToggleExpand,
  onToggleSelect,
  testIdPrefix,
}: {
  readonly node: DirectoryNode
  readonly depth: number
  readonly selected: readonly string[]
  readonly expanded: readonly string[]
  readonly onToggleExpand: (id: string) => void
  readonly onToggleSelect: (ids: string[]) => void
  readonly testIdPrefix: string
}) {
  const isOpen = expanded.includes(node.id)
  const hasChildren = node.children.length > 0
  const isSelected = selected.includes(node.id)

  const toggle = () => {
    onToggleSelect(
      isSelected ? selected.filter((x) => x !== node.id) : [...selected, node.id],
    )
  }

  return (
    <li>
      <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: `${depth * 16}px` }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.id)}
            className="text-muted-foreground"
            aria-label={isOpen ? '收起' : '展开'}
            data-testid={`${testIdPrefix}-toggle-${node.slug}`}
          >
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="inline-block size-3.5" />
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={toggle}
            data-testid={`${testIdPrefix}-${node.slug}`}
            data-directory-id={node.id}
          />
          <span className={cn('text-foreground', !node.enabled && 'text-muted-foreground line-through')}>
            {node.name}
          </span>
          {isSelected && <Check className="size-3.5 text-primary" />}
        </label>
      </div>
      {hasChildren && isOpen && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onToggleSelect={onToggleSelect}
              testIdPrefix={testIdPrefix}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** permission → 目录集合。全局权限（无目录）用空数组表示。 */
function byPermission(grants: readonly PermissionGrant[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const g of grants) {
    const list = out[g.permission] ?? []
    if (g.directoryId !== null) list.push(g.directoryId)
    out[g.permission] = list
  }
  return out
}

/**
 * 如果这份授权是"所有权限 × 同一组目录"的笛卡尔积，返回那组目录；否则返回 null。
 *
 * 返回 null 就是"这位老师是分别设置的"，界面据此自动进入分别模式。
 */
export function uniformDirectoriesOf(grants: readonly PermissionGrant[]): string[] | null {
  const perPermission = new Map<string, Set<string>>()
  for (const g of grants) {
    if (g.directoryId === null) continue // 全局权限不参与
    const set = perPermission.get(g.permission) ?? new Set<string>()
    set.add(g.directoryId)
    perPermission.set(g.permission, set)
  }
  if (perPermission.size === 0) return []
  const sets = [...perPermission.values()]
  const first = [...sets[0]].sort().join(',')
  for (const set of sets) {
    if ([...set].sort().join(',') !== first) return null
  }
  return [...sets[0]]
}
