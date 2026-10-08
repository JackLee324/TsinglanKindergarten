/**
 * tests/unit/mobile-nav.test.mjs —— 移动端导航的**结构**约束（阶段 11）
 * ============================================================================
 * 业主 Stage 11 的要求里有一条是"结构性的"，不是"功能性的"：
 *
 *   > 不要复制第二套导航数据。导航仍然使用同一个 Directory / capabilities 数据源。
 *   > 禁止 MobileMenu 自己硬编码 Pre-K / K / 美德 / 活动 等目录。
 *   > 不要同时显示两个。
 *
 * 这类要求靠点击测试是**测不牢的**：今天抽屉里恰好点得到，明天有人为了快
 * 在抽屉里写死一个「活动」也能通过点击测试。所以这里直接读源码来钉：
 * 导航条目只有一处定义、移动端不许出现目录名、两种布局互斥、断点只有一处。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = join(ROOT, 'client', 'src')

function read(rel) {
  return readFileSync(join(CLIENT, rel), 'utf8')
}

/** 去掉注释再断言：注释里出现"美德"是在解释设计，不是硬编码。 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('移动端导航只有一份真相（业主 Stage 11 §2）', () => {
  test('导航条目只有一处定义：SidebarNav', () => {
    // 导航条目的定义标志：`testId="nav-xxx"`。抽屉里若有人再写一遍，这里就会多出一个文件。
    const definingFiles = walk(CLIENT).filter((f) =>
      /testId="nav-(?:home|my-resources|review)"/.test(code(readFileSync(f, 'utf8'))),
    )
    assert.deepEqual(
      definingFiles.map((f) => relative(CLIENT, f)),
      ['components/Sidebar.tsx'],
      '「首页 / 我的资源 / 审核 / 目录 / 管理」这些条目只允许在 Sidebar.tsx 里定义一次',
    )
    // 固定条目 + 目录根 + 管理分组都在 SidebarNav 里（少一个就说明有人搬走了导航）
    const sidebar = code(read('components/Sidebar.tsx'))
    for (const id of [
      'nav-home',
      'nav-my-resources',
      'nav-review',
      'nav-directory-manage',
      'nav-admin-users',
      'nav-admin-audit',
    ]) {
      assert.ok(sidebar.includes(`testId="${id}"`), `Sidebar.tsx 里应当有 ${id}`)
    }
  })

  test('移动端组件复用 SidebarNav，而不是自己写一套', () => {
    const mobile = read('components/MobileNav.tsx')
    assert.match(mobile, /import \{[^}]*SidebarNav[^}]*\} from '\.\/Sidebar'/, '抽屉必须用同一个 SidebarNav')
    assert.match(mobile, /<SidebarNav/, '抽屉里要真的渲染它')
  })

  test('移动端组件里不许出现目录名（禁止硬编码导航数据）', () => {
    const mobile = code(read('components/MobileNav.tsx'))
    for (const banned of ['Pre-K', '美德', '蒙特梭利', '教师成长', '教育教学', '活动', 'K 中文']) {
      assert.equal(
        mobile.includes(banned),
        false,
        `MobileNav 里出现了「${banned}」—— 导航数据只能来自目录接口，不许写死`,
      )
    }
    // 也不能自己写死路径
    assert.equal(
      /\/directory\//.test(mobile),
      false,
      'MobileNav 里不该出现写死的 /directory/... 路径',
    )
  })

  test('桌面与移动互斥渲染（不同时显示两套）', () => {
    const layout = read('components/Layout.tsx')
    const header = read('components/Header.tsx')
    assert.match(layout, /isDesktop\s*&&\s*<Sidebar\s*\/>/, '桌面侧边栏要按 isDesktop 条件渲染')
    assert.match(header, /!isDesktop\s*&&\s*user !== null\s*&&\s*<MobileNav/, 'hamburger 只在窄屏渲染')
    assert.equal(
      (layout + header).includes('hidden lg:flex'),
      false,
      '不能靠 CSS 把侧边栏藏起来 —— 那样它的 DOM 还在，页面上就会有两份导航节点',
    )
  })

  test('断点只有一处定义（1024px），没有第二个 matchMedia', () => {
    const hook = read('components/useMediaQuery.ts')
    assert.match(hook, /DESKTOP_QUERY = '\(min-width: 1024px\)'/, '断点值只有这一处')
    const users = walk(CLIENT).filter((f) => code(readFileSync(f, 'utf8')).includes('matchMedia'))
    assert.deepEqual(
      users.map((f) => relative(CLIENT, f)),
      ['components/useMediaQuery.ts'],
      'matchMedia 只允许出现在这个 hook 里，否则断点会各写各的',
    )
  })

  test('抽屉关闭的三条路径都在（点导航项 / Esc / 按钮）', () => {
    const mobile = read('components/MobileNav.tsx')
    assert.match(mobile, /onNavigate=\{\(\) => setOpen\(false\)\}/, '点导航项要关')
    assert.match(mobile, /Escape/, 'Esc 要关')
    assert.match(mobile, /data-testid="nav-close"/, '要有显式关闭按钮')
    assert.match(mobile, /useEffect\(\(\) => \{\s*setOpen\(false\)/, '换路由要自动关')
  })

  test('打开抽屉时锁住背景滚动（避免双滚动条）', () => {
    const mobile = read('components/MobileNav.tsx')
    assert.match(mobile, /document\.body\.style\.overflow = 'hidden'/, '抽屉打开时要锁背景滚动')
    assert.match(mobile, /document\.body\.style\.overflow = previous/, '关闭后要恢复')
  })
})
