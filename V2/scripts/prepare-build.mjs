/**
 * scripts/prepare-build.mjs —— 构建前把产物目录清干净
 * ============================================================================
 * 为什么需要这一步（这是踩过两次的坑，不是洁癖）：
 *
 * 这台机器上会**偶发**出现 `dist/server 2` / `dist/server 3` 这类带空格后缀的
 * 目录（权限还是 `drwx------`），它们不是构建产物，但 SWC 会去扫 `dist/`，
 * 扫到这样的目录就直接 `Unknown system error -11` 崩掉，报错信息完全指不到原因。
 *
 * 产物的正确状态只有一个：「就是这次构建写出来的那些」。
 * 所以构建前无条件 `rm -rf dist` —— 顺带也杜绝了"上次的旧 .js 留在里面、
 * 测试跑在旧代码上还全绿"这种更危险的情况（check-dist.mjs 是第二道防线）。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const strays = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^dist \d+$/.test(e.name))
  .map((e) => e.name)

for (const stray of strays) {
  rmSync(join(ROOT, stray), { recursive: true, force: true })
  console.log(`  · 清掉干扰目录 ${stray}（不是构建产物，会让 SWC 崩在第 0 步）`)
}
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true })
