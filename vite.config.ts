import path from 'path';
import { defineConfig } from '@lark-apaas/coding-preset-vite-react';

// ---------------------------------------------------------------------------
// build.assetsDir —— 独立部署必需（Zeabur / Docker / VPS）
// ---------------------------------------------------------------------------
// 默认值是 `assets`。但平台的 publicAssetsMiddleware()
// （@lark-apaas/fullstack-nestjs-core，约 36656 行）会刻意 **跳过** 以下前缀：
//
//     api/  openapi/  __innerapi__/  __runtime__/  static/  dev/  assets/
//
// 注释写着 hashed 构建产物走 CDN。在妙搭平台上 index.html 的资源地址会被改写成
// CDN 地址，所以 `/assets/*` 由 CDN 提供，一切正常。
//
// 独立部署时没有 CDN：平台中间件跳过 assets/，服务端也没有其它静态服务，于是
// 浏览器的 /assets/index-*.js 请求落到 SPA 回退，拿回一份 text/html 的首页 ——
// 脚本永远加载不了，**页面白屏**，而健康检查、API、日志全部显示正常。
//
// 实测过三种在服务端抢夺 /assets 的做法（useStaticAssets 放在 configureApp 前后、
// 直接挂 express.static 到 httpAdapter 实例）全部无效：平台的中间件先接走了。
// 换个不在跳过列表里的目录名是唯一干净的做法 —— 既让平台自己的中间件愿意直出，
// 也不需要修改任何服务端代码。
export default defineConfig({
  build: {
    assetsDir: 'bundle',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
});
