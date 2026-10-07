/**
 * scripts/check-dist.mjs —— 构建产物的完整性检查（服务端）
 * ============================================================================
 * 它补的是 `nest build` **不会**替我们保证的那件事：
 *
 * `nest build` 编译成功时一切正常；编译**失败**时它自己就会以非 0 退出
 * （实测：SWC 报 `Failed to compile` 时 nest 退出码 = 1，所以链式 `&&`
 *  会在那里停下，这一点不需要这个脚本来兜）。
 *
 * 真正危险的是**它成功、但 dist 里是旧东西**：
 *   · 少了一个产物 → 服务启动时报 `Cannot find module './x.service'`
 *     （这个还算响）；
 *   · 产物比源文件旧 → 服务照常启动、接口照常返回、测试照常全绿，
 *     但跑的是**上一次编译的代码**。这是"假绿"，是最贵的一类故障：
 *     所有门禁都过了，验收的却是旧实现。
 *
 * 所以这里逐文件核对：每个 `server/**\/*.ts`、`shared/**\/*.ts`
 * 都要有对应的 `dist/**\/*.js`，且不早于源文件的修改时间。
 *
 * 目录映射与 `nest-cli.json` 的 `stripLeadingPaths: false` 一致：
 * `server/a/b.ts` → `dist/server/a/b.js`；`shared/c.ts` → `dist/shared/c.js`。
 */
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const problems = []
const sources = [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'shared'))]

for (const source of sources) {
  const rel = relative(ROOT, source)
  const target = join(ROOT, 'dist', rel.replace(/\.ts$/, '.js'))
  let stat
  try {
    stat = statSync(target)
  } catch {
    problems.push(`${rel} 没有编译产物（缺少 dist/${rel.replace(/\.ts$/, '.js')}）`)
    continue
  }
  if (stat.mtimeMs < statSync(source).mtimeMs) {
    problems.push(`${rel} 的产物比源文件旧 —— dist 里留的是上一次编译的结果`)
  }
}

if (problems.length > 0) {
  console.error('\n✖ 服务端构建产物不完整或不新鲜：')
  for (const p of problems) console.error(`  · ${p}`)
  console.error(
    '\n  最坏的情况是"产物比源文件旧"：服务照常启动、测试照常全绿，但跑的是旧代码。\n' +
      '  遇到这里失败，先重新执行 `npm run build`；如果仍然失败，说明有文件没被编译。',
  )
  process.exit(1)
}

console.log(`✔ 服务端构建产物完整且新鲜（核对 ${sources.length} 个源文件）`)
