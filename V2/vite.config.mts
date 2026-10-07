/**
 * V2 前端构建配置。
 *
 * 三条与 V1 保持一致的决定（它们是"部署后静态资源找不到"那类问题的解药）：
 *
 *   · `root` 是仓库根目录，入口文档是 `client/index.html`；
 *   · `publicDir = client/public`；
 *   · `outDir = dist/client` —— 与 NestJS 的产物 `dist/server` 并列，
 *     由服务端在同一个进程里提供静态资源。
 *
 * 为什么不单起一个 Vite dev server 给端到端测试用：
 * 浏览器测试要的是**同源**（cookie 是 HttpOnly + SameSite=Lax，CSRF 是双提交 cookie）。
 * 前后端同源时，cookie、CSRF、相对路径全部与生产一致；跨端口就得再引入代理与
 * cookie 域的问题，那会让测试验证的是一套与生产不同的东西。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  // root 指向 client/，产物才会直接落在 dist/client/（而不是 dist/client/client/）。
  root: path.resolve(import.meta.dirname, 'client'),
  publicDir: path.resolve(import.meta.dirname, 'client/public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@client': path.resolve(import.meta.dirname, 'client/src'),
      '@shared': path.resolve(import.meta.dirname, 'shared'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'client/index.html'),
    },
  },
  server: {
    port: 3400,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3300', changeOrigin: false },
    },
  },
})
