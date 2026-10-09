#!/usr/bin/env node
/**
 * scripts/check-client-assets.mjs —— 前端产物自检（**构建期闸门**）
 * ============================================================================
 * 它补的是 `vite build` **不会**替我们保证的那件事。
 *
 * 背景（真实故障，2026-10-08 演练镜像）：Tailwind v4 是通过
 * `postcss.config.mjs`（插件 `@tailwindcss/postcss`）接进 Vite 的；
 * `vite.config.mts` 里只有 `react()`，**没有** `@tailwindcss/vite`。
 * Dockerfile 的构建阶段当时漏拷 `postcss.config.mjs`，于是构建**成功**、
 * 静态资源**全部 200**、后端测试**全绿**，但产物 CSS 里：
 *   · `@theme` 原样留着（插件没跑）
 *   · 编译后的 `:root,:host{…}` 主题变量一个都没有
 *   · `.flex` / `.min-h-screen` / `.rounded-lg` 等工具类**一个都没有**
 * 结果就是登录页用裸 HTML 默认样式渲染，挤在左上角。
 *
 * 这类故障最贵的地方在于**所有自动化门禁都是绿的**。所以这里把它变成
 * **构建失败**：`npm run build` 的最后一步就跑它，Docker 构建也走同一条链，
 * 于是"没样式的镜像"根本发不出去。
 *
 * 只做三件确定性判断（不算"漂亮的启发式"）：
 *   1) `@theme` 必须已被展开干净 —— 残留说明 Tailwind 插件没运行；
 *   2) 编译出的主题变量必须存在（`:root,:host{`）；
 *   3) 应用**确实用到**的一组布局工具类必须存在；
 *   4) `dist/client/index.html` 引用的文件名必须真的存在（防引用错产物）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// `--client-dir` 只为一件事存在：**反向测试**。
// 没有它就没法证明"坏产物真的会被拦下"（否则只能对着好产物跑，永远是绿的）。
const argIdx = process.argv.indexOf('--client-dir')
const CLIENT = argIdx >= 0 && process.argv[argIdx + 1] ? resolve(process.argv[argIdx + 1]) : join(ROOT, 'dist', 'client')
const ASSETS = join(CLIENT, 'assets')

/** 这些类必须出现：都是登录页/首页真实使用、且"没有就一定是裸 HTML"的布局类。 */
const REQUIRED_UTILITIES = [
  '.min-h-screen{',
  '.flex{',
  '.items-center{',
  '.w-full{',
  '.rounded-lg{',
]

const problems = []
if (!existsSync(ASSETS)) {
  problems.push('没有 dist/client/assets —— 前端根本没构建出来')
} else if (!existsSync(join(CLIENT, 'index.html'))) {
  problems.push('没有 dist/client/index.html —— 前端入口缺失')
} else {
  const cssFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.css'))
  if (cssFiles.length === 0) {
    problems.push('dist/client/assets 里没有任何 .css —— 样式没有被构建出来')
  }
  for (const file of cssFiles) {
    const css = readFileSync(join(ASSETS, file), 'utf8')
    if (css.includes('@theme')) {
      problems.push(`${file} 里还留着未展开的 \`@theme\` —— Tailwind 插件没有运行（构建链缺 postcss 配置？）`)
    }
    if (!css.includes(':root,:host{')) {
      problems.push(`${file} 里没有编译出的主题变量（\`:root,:host{\`）—— 同上：Tailwind 没跑`)
    }
    const missing = REQUIRED_UTILITIES.filter((u) => !css.includes(u))
    if (missing.length > 0) {
      problems.push(`${file} 里缺少工具类：${missing.join('、')} —— 页面会以裸 HTML 样式渲染`)
    }
  }
}

// index.html 引用的资源必须真的存在（防"引用的是上一次的产物"）
if (existsSync(join(CLIENT, 'index.html'))) {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  if (refs.length === 0) problems.push('dist/client/index.html 没有引用任何 /assets/ 资源 —— 入口不完整')
  for (const ref of refs) {
    if (!existsSync(join(CLIENT, ref.replace(/^\/assets\//, 'assets/')))) {
      problems.push(`dist/client/index.html 引用了不存在的资源：${ref}`)
    }
  }
}

if (problems.length > 0) {
  console.error('\n✖ 前端产物自检失败（页面会没有样式/脚本）：')
  for (const p of problems) console.error(`  · ${p}`)
  console.error(
    '\n  最常见的原因：**构建链里 Tailwind 没跑**。检查两处 ——\n' +
      '    1) 根目录存在 `postcss.config.mjs`（内容是 `@tailwindcss/postcss` 插件）；\n' +
      '    2) Dockerfile 的 build 阶段把它 COPY 进去了（漏了它构建照样"成功"）。\n' +
      '  次常见：vite 配置里的入口路径不对，`client/src/styles.css` 没被引入。',
  )
  process.exit(1)
}

console.log('✔ 前端产物自检通过（主题变量已编译、工具类齐全、index.html 引用有效）')
