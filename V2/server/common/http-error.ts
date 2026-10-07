import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common'

/**
 * 业务错误都带一个**机器可读的 code**，前端据此决定显示什么，
 * 而不是去匹配中文文案（匹配文案改一个字就断）。
 */
export class AppError {
  static forbidden(message: string, code = 'FORBIDDEN') {
    return new ForbiddenException({ statusCode: 403, code, message })
  }
  static notFound(message: string, code = 'NOT_FOUND') {
    return new NotFoundException({ statusCode: 404, code, message })
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new ConflictException({ statusCode: 409, code, message })
  }
  static badRequest(message: string, code = 'VALIDATION_FAILED') {
    return new BadRequestException({ statusCode: 400, code, message })
  }
  static tooLarge(message: string, code = 'FILE_TOO_LARGE') {
    return new PayloadTooLargeException({ statusCode: 413, code, message })
  }
  /**
   * 依赖的外部服务不可用（存储没配好 / 暂时连不上）。
   *
   * ⚠️ 必须是 503，不能是 500：500 会让前端与运维都以为"服务端代码崩了"，
   * 而真实原因是配置或第三方不可达，处理方式完全不同（§20）。
   */
  static serviceUnavailable(message: string, code = 'STORAGE_UNAVAILABLE') {
    return new ServiceUnavailableException({ statusCode: 503, code, message })
  }
  /** 需要更细的控制时用（例如 409 之外的组合）。 */
  static http(status: number, code: string, message: string) {
    return new HttpException({ statusCode: status, code, message }, status)
  }
}
