// 错误统一响应
export interface ApiErrorResponse {
  /** 错误详情 */
  error: {
    /** 错误代码 */
    code: string;
    /** 错误消息 */
    message: string;
    /** 错误详情 */
    details?: string;
    /** 字段验证错误 */
    fieldErrors?: Record<string, string[]>;
    /**
     * Correlation id for this request (also returned in the `x-request-id`
     * response header). Present so a user reporting a failure can quote one value
     * that identifies the exact server log line.
     */
    requestId?: string;
    /**
     * 调用栈 — DEVELOPMENT ONLY.
     * Never populated when NODE_ENV=production: stacks leak absolute paths,
     * dependency internals and sometimes credentials (audit finding G-11).
     */
    stack?: string;
    /** 错误原因 — DEVELOPMENT ONLY, same reasoning as `stack`. */
    cause?: string;
    /** 错误发生时间 */
    timestamp?: number;
  };
}

