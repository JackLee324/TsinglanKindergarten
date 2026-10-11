/**
 * client/src/api/ai.ts —— AI 助手的接口调用（前端只调自己的后端）
 * ============================================================================
 * 三条纪律（与 v1 的教训一致）：
 *   ① 前端**不直接调任何模型供应商**，也不持有密钥 —— 密钥只在服务端环境变量里；
 *   ② 模型名、是否可用、限流额度全部由 `GET /api/ai/status` 从服务端读，
 *      前端一行都不写死（换模型不需要改前端、不需要重新发版说明）；
 *   ③ 提问带 `AbortSignal`：用户点「取消」时要真的断开连接，
 *      服务端在 `req.on('close')` 里中止上游请求 —— 否则用户以为停了、账单还在涨。
 */
import { api } from './http'
import type { AiChatResult, AiConversationSummary, AiMessage, AiStatus } from './types'

export const aiApi = {
  /** 能不能用、用的哪个模型、索引进度、建议问题。**不含任何密钥信息。** */
  status: () => api.get<AiStatus>('/api/ai/status'),

  conversations: () =>
    api.get<{ items: AiConversationSummary[] }>('/api/ai/conversations').then((r) => r.items),

  createConversation: (title?: string) =>
    api.post<{ id: string }>('/api/ai/conversations', title === undefined ? {} : { title }),

  messages: (conversationId: string) =>
    api
      .get<{ items: AiMessage[] }>(`/api/ai/conversations/${conversationId}/messages`)
      .then((r) => r.items),

  deleteConversation: (conversationId: string) =>
    api.del<{ deleted: boolean }>(`/api/ai/conversations/${conversationId}`),

  ask: (input: { readonly question: string; readonly conversationId?: string }, signal?: AbortSignal) =>
    api.post<AiChatResult>('/api/ai/chat', input, signal === undefined ? undefined : { signal }),
}
