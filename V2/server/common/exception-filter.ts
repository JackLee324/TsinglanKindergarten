import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'

/**
 * 统一错误响应形状：`{ statusCode, code, message }`。
 * 5xx 只记录日志、不把内部错误原文发给客户端（可能含 SQL 片段/路径）。
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception')

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>
        res.status(status).json({
          statusCode: status,
          code: typeof b.code === 'string' ? b.code : defaultCode(status),
          message: typeof b.message === 'string' ? b.message : exception.message,
        })
        return
      }
      res.status(status).json({ statusCode: status, code: defaultCode(status), message: String(body) })
      return
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception))
    const payload =
      this.constructorError(exception)
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: payload,
    })
  }

  private constructorError(exception: unknown): string {
    // 非生产环境把真实错误带出来，方便定位；生产只给一句话。
    if (process.env.NODE_ENV === 'production') return '服务器内部错误'
    return exception instanceof Error ? exception.message : String(exception)
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED'
    case 401:
      return 'UNAUTHENTICATED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 409:
      return 'CONFLICT'
    default:
      return 'ERROR'
  }
}
