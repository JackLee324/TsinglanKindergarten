import 'reflect-metadata'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { static as expressStatic } from 'express'
import { AppModule } from './app.module'
import { buildValidationPipe } from './common/validation'
import { loadConfig } from './config'

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap')
  const config = loadConfig()
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true })

  app.useGlobalPipes(buildValidationPipe())
  // Express 适配器的实例方法（Nest 自己的 INestApplication 类型上没有）
  const express = app.getHttpAdapter().getInstance()
  express.disable('x-powered-by')
  // 内部工具：前端与 API 同源部署，因此不需要放开跨域。
  app.enableCors({ origin: false })

  // ── 前端静态资源 ─────────────────────────────────────────────────────────
  // 前后端**同源**：cookie 是 HttpOnly + SameSite=Lax，CSRF 是双提交 cookie，
  // 同源时浏览器行为与生产完全一致。分成两个端口就得再引入代理与 cookie 域问题，
  // 那样浏览器测试验证的是一套与生产不同的东西。
  const clientDir = join(__dirname, '..', 'client')
  const indexHtml = join(clientDir, 'index.html')
  if (existsSync(indexHtml)) {
    // ⚠️ 顺序很重要：这两条必须**早于** `app.init()`。
    //
    // Nest 在 init() 期间会注册自己的"未匹配路由"处理器，而它是**直接回响应**、
    // 不再 next() 的。所以任何在 init() 之后追加的中间件都永远收不到请求 ——
    // 实测就是 `/` 与 `/directory/xxx` 返回 Nest 的 404 JSON。
    // 放在 init() 之前，它们就排在 Nest 的路由之前；而下面的守卫保证
    // 只有"非 /api 的 GET"会被 SPA 回退接手，接口一个都不受影响。
    express.use(expressStatic(clientDir, { index: false }))
    express.use(
      (
        req: { method: string; path: string },
        res: { sendFile: (p: string) => void },
        next: () => void,
      ) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/')) {
          next()
          return
        }
        res.sendFile(indexHtml)
      },
    )
    logger.log(`serving SPA from ${clientDir}`)
  } else {
    logger.warn(`没有找到前端产物（${indexHtml}）—— 只提供 API。先跑 npm run build:client。`)
  }

  await app.listen(config.port)
  logger.log(`V2 backend listening on http://127.0.0.1:${config.port}`)
  logger.log(`environment: NODE_ENV=${process.env.NODE_ENV ?? 'development'}`)
  logger.log(`storage provider: ${config.storage.provider}`)
}

void bootstrap()
