import { BadRequestException, ValidationPipe } from '@nestjs/common'

export function buildValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => {
      const message = errors
        .map((e) => Object.values(e.constraints ?? {}).join('；'))
        .filter(Boolean)
        .join('；')
      return new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: message || '请求参数不合法',
      })
    },
  })
}
