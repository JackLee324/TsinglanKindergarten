import { ApiError } from '../../api/http'

/**
 * 错误 → 给老师看的一句话（业主 §20）。
 *
 * 规则：**服务端的 message 优先**。它已经是中文、而且往往比前端猜得更准
 * （"已发布的资源不能直接增删文件，请先撤回再修改"这种话，前端造不出来）。
 *
 * 前端只负责兜住两类服务端说不清的情况：
 *   · 网络层失败（拿不到任何响应）；
 *   · 服务端返回了 5xx 但 body 不是我们的错误形状。
 *
 * 明确不允许出现的是把 `Request failed with status code 503` 这种东西摆到界面上。
 */
export function humanMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.message.trim() !== '') return error.message
    return `${fallback}（${error.code}）`
  }
  if (error instanceof TypeError) {
    // fetch 抛 TypeError 基本只有一个原因：网络不可达。
    return '网络连接失败，请检查网络后重试。'
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}
