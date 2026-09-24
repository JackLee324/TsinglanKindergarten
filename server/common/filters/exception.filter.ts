import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import { HTTP_STATUS_TO_RESPONSE_CODE_MAP, ResponseCode } from '../constants/api_response_code';
import { ApiErrorResponse } from '../interfaces/api_response.interface';

// 全局异常过滤器，用于捕获所有未处理的异常
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    // 如果响应头已发送，则不处理
    if (response.headersSent) {
      return;
    }

    // Correlation id. `res.locals.requestId` is authoritative: the platform's
    // RequestContextMiddleware overwrites `req.requestId` later in the pipeline,
    // which made the id in the response body differ from the one in the
    // `x-request-id` header. Preferring res.locals keeps the value the user sees
    // identical to the value in the logs.
    // The response header is the AUTHORITATIVE value: it is what the client
    // actually received, so quoting it in the body guarantees the user can match
    // the id they were shown against the server log.
    // (The platform registers its own request-id middleware which runs later than
    // ours and overwrites both `req.requestId` and the header, so reading either
    // of those first produced a body id that did not match the header.)
    const requestId =
      (response as Response & { locals?: { requestId?: string } }).locals?.requestId ??
      request?.requestId;

    // Force the header to the SAME value that is written into the body and into
    // the server log below. Verified behaviour of the installed platform: its
    // interceptors set `x-request-id` after this filter has read it, so simply
    // reading the header produced a body id that did not match what the client
    // finally received (observed: header 6bb10dc0…, body 074616a4…). Since an
    // exception filter owns the final response, it is the right place to make the
    // two agree.
    if (requestId) {
      response.setHeader('x-request-id', requestId);
    }

    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;

    if (exception instanceof BusinessException) {
      // 业务异常
      httpStatus = exception.httpStatus;
      errorResponse = {
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          fieldErrors: exception.fieldErrors,
          requestId,
          timestamp: Date.now(),
        },
      };
    } else if (exception instanceof HttpException) {
      // HTTP异常
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();

      errorResponse = {
        error: {
          code: HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus],
          message: typeof exceptionResponse === 'string' ? exceptionResponse : exception.message,
          details: typeof exceptionResponse === 'object' ? JSON.stringify(exceptionResponse) : undefined,
          requestId,
          timestamp: Date.now(),
        },
      };
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { code?: unknown }).code === '22P02'
    ) {
      // Postgres invalid_text_representation：路径/查询参数与列类型不匹配（最常见是非法 UUID）
      // 与「合法 UUID 但记录不存在」走同一条 not-found 语义，避免 500 噪声
      httpStatus = HttpStatus.NOT_FOUND;
      errorResponse = {
        error: {
          code: ResponseCode.NOT_FOUND,
          message: '资源不存在',
          requestId,
          timestamp: Date.now(),
        },
      };
    } else {
      // Unknown / unexpected exception.
      //
      // SECURITY (audit finding G-11): this branch used to return
      // `stack` and `cause` to the CLIENT. Those contain absolute file paths,
      // dependency internals, SQL fragments and sometimes credentials embedded in
      // a connection string — all of which help an attacker map the system. On a
      // public deployment the client must receive only a generic message plus the
      // request id needed to correlate with the server log.
      //
      // The full detail is still logged server-side, which is where an operator
      // needs it; it is simply no longer part of the HTTP response.
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

      const err = exception as Error;
      const requestId = (request as { requestId?: string })?.requestId;
      this.logger.error(
        `Unhandled exception [requestId=${requestId ?? 'n/a'}] ` +
          `${err?.name ?? 'Error'}: ${err?.message ?? String(exception)}`,
        err?.stack,
      );

      errorResponse = {
        error: {
          code: ResponseCode.INTERNAL_ERROR,
          message: '服务器内部错误',
          requestId,
          timestamp: Date.now(),
          // Only in development: never on a public deployment.
          ...(process.env.NODE_ENV !== 'production'
            ? { stack: err?.stack, cause: err?.cause as string }
            : {}),
        },
      };
    }

    response.status(httpStatus).json(errorResponse);
  }
}
