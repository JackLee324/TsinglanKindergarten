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
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const strays = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^(dist|server|shared) \d+$/.test(e.name))
  .map((e) => e.name)

for (const stray of strays) {
  remove(join(ROOT, stray))
  console.log(`  · 清掉干扰目录 ${stray}（不是构建产物，会让 SWC 崩在第 0 步）`)
}
if (existsSync(DIST)) remove(DIST)

/**
 * 删目录，带三层兜底。
 *
 * 为什么不能只写 `rmSync(..., {recursive:true})`：这台机器上偶发出现
 * 权限为 `drwx------` 的 `dist/server 2` 之类目录，Node 的 rimraf 在它上面会
 * `Unknown system error -11`（scandir EAGAIN）直接抛错，**整个 build 就停在第 0 步**。
 * 报错信息只有一句 errno，完全指不到"哪个目录坏了"。
 *
 * 所以：先试 Node，再试系统 `rm -rf`，最后把目录改名挪走 ——
 * 三种方式都失败才报错退出（那时说明真有问题，不该装作没事继续构建）。
 */
function remove(target) {
  try {
    rmSync(target, { recursive: true, force: true })
    return
  } catch (error) {
    console.log(`  · Node 删除失败（${error.code ?? error.message}），改用系统 rm`)
  }

  const res = spawnSync('rm', ['-rf', target], { stdio: 'ignore' })
  if (res.status === 0 && !existsSync(target)) return

  // 最后一招：改名。构建只要求这个路径**不存在**，不要求它被删掉。
  const parked = `${target}.stray-${Date.now()}`
  try {
    renameSync(target, parked)
    console.log(`  · 无法删除，已改名挪开：${parked}（可以稍后手工删掉）`)
  } catch (error) {
    console.error(`✖ 无法清理构建产物目录：${target}`)
    console.error(`  rmSync: ${error.message}`)
    process.exit(1)
  }
}
