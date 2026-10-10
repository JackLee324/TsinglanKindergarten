/**
 * tests/unit/build-tooling-preflight.test.mjs —— 构建工具缺失时必须是**人话**
 * ============================================================================
 * 2026-10-10 的真实事故（线上构建失败，日志只有一行）：
 *
 *     ERROR 🔴 build failed err=build image: ... process "/bin/sh -c npm run build"
 *     did not complete successfully: exit code 127
 *
 * 127 = command not found。原因是平台把服务变量 `NODE_ENV=production` 带进了
 * Docker 构建，`npm ci` 据此**跳过 devDependencies**，于是 `nest` / `vite`
 * 两个二进制根本不存在，而它们正是 `npm run build` 要调的。
 * 本机复现：`NODE_ENV=production npm ci` → 166 个包、没有 `.bin/nest`。
 *
 * 这份测试盯两件事，缺一件这个坑就会再来一次：
 *   ① **行为**：`scripts/prepare-build.mjs` 在工具缺失时以非 0 退出，并且
 *      把"缺了什么、为什么、怎么修"写清楚（不再只留一个 127）；
 *   ② **配置**：`Dockerfile` 里每一条 `npm ci` 都必须**显式**写明
 *      `--include=dev` 或 `--omit=dev` —— 不许把装不装 devDeps 交给环境变量决定。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'prepare-build.mjs'), 'utf8')

/** 在临时目录里复制一份 prepare-build.mjs —— 它按**自己所在的路径**推导 ROOT，
 *  所以复制到临时目录后，它操作的是临时目录，绝不会碰到仓库里的 dist/。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'qls-build-preflight-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'prepare-build.mjs'), SCRIPT)
  return dir
}

function runPreflight(dir) {
  const res = spawnSync(process.execPath, [join(dir, 'scripts', 'prepare-build.mjs')], {
    encoding: 'utf8',
    cwd: dir,
  })
  return { status: res.status, out: `${res.stdout}${res.stderr}` }
}

describe('① 构建工具缺失时，报错必须是可诊断的（不是裸的 exit 127）', () => {
  let sandbox

  before(() => {
    sandbox = makeSandbox()
  })
  after(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  test('没有 node_modules/.bin/nest 与 vite → 退出码非 0，且说清缺什么、为什么、怎么修', () => {
    const { status, out } = runPreflight(sandbox)
    assert.notEqual(status, 0, '工具缺失时必须失败，不能继续构建')
    assert.match(out, /构建工具缺失/, '要有一句人话的结论')
    assert.match(out, /nest/, '要点名缺的是哪个工具')
    assert.match(out, /vite/, '要点名缺的是哪个工具')
    assert.match(out, /NODE_ENV=production/, '要点明最常见的原因，否则看日志的人只能猜')
    assert.match(out, /npm ci --include=dev/, '要给出可以直接照做的修法')
  })

  test('两个工具都在（占位文件即可）→ 退出码 0，不误报', () => {
    const okSandbox = makeSandbox()
    try {
      const bin = join(okSandbox, 'node_modules', '.bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'nest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(bin, 'vite'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const { status, out } = runPreflight(okSandbox)
      assert.equal(status, 0, `有工具时不该挡：${out}`)
      assert.doesNotMatch(out, /构建工具缺失/, '不该误报')
    } finally {
      rmSync(okSandbox, { recursive: true, force: true })
    }
  })
})

describe('② Dockerfile 里装不装 devDeps 必须写明，不许交给环境变量决定', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const npmCiLines = dockerfile
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((l) => /^RUN\s+npm ci\b/.test(l.line))

  test('每条 npm ci 都显式写了 --include=dev 或 --omit=dev', () => {
    assert.ok(npmCiLines.length >= 2, `至少要找到 deps 与 prod-deps 两条 npm ci，实际 ${npmCiLines.length}`)
    for (const { line, no } of npmCiLines) {
      assert.match(
        line,
        /--include=dev|--omit=dev/,
        `Dockerfile:${no} 的 npm ci 没有写明装不装 devDeps：NODE_ENV=production 会让它静默跳过 devDeps，构建就以 127 失败`,
      )
    }
  })

  test('构建用的那一层一定带上了 devDeps（否则 nest / vite 不存在）', () => {
    assert.ok(
      npmCiLines.some((l) => /--include=dev/.test(l.line)),
      '必须有一层明确 --include=dev：nest / vite / typescript 都只在 devDependencies 里',
    )
  })

  test('运行阶段仍然是 NODE_ENV=production（别为了修构建把这条删了）', () => {
    assert.match(dockerfile, /ENV NODE_ENV=production/, '运行镜像必须是生产模式')
    assert.match(dockerfile, /EXPOSE 3300/, '运行镜像暴露的端口必须与 SERVER_PORT 一致')
  })
})
