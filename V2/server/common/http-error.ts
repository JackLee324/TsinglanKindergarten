import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common'

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
}
