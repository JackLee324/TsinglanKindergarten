import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { AppModule } from './app.module'
import { buildValidationPipe } from './common/validation'
import { loadConfig } from './config'

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = await NestFactory.create(AppModule, { bodyParser: true })

  app.useGlobalPipes(buildValidationPipe())
  // Express 适配器的实例方法（Nest 自己的 INestApplication 类型上没有）
  app.getHttpAdapter().getInstance().disable('x-powered-by')
  // 内部工具：前端与 API 同源部署，因此不需要放开跨域。
  app.enableCors({ origin: false })

  await app.listen(config.port)
  const logger = new Logger('Bootstrap')
  logger.log(`V2 backend listening on http://127.0.0.1:${config.port}`)
  logger.log(`environment: NODE_ENV=${process.env.NODE_ENV ?? 'development'}`)
  logger.log(`storage driver: ${config.storageDriver}`)
}

void bootstrap()
