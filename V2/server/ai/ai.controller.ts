/**
 * server/ai/ai.controller.ts —— AI 助手的 HTTP 面
 * ============================================================================
 * 权限口径（业主 Stage 15 §六）：
 *   · 全部接口都要**登录**（`@AuthenticatedOnly`），但**不额外要求资源权限** ——
 *     "问平台怎么用"对任何账号都该可用；而"能问到哪些资料"由检索层按
 *     AuthorizationService 的目录权限决定。多一道权限门只会让 0 授权的账号
 *     连使用说明都问不到，那不是安全，是功能缺失。
 *   · 会话接口一律按 user_id 过滤：别人的会话返回 404（不暴露存在性）。
 *   · 取消：客户端断开连接时中止模型请求（AbortController），不留下继续烧钱的调用。
 */
import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AiChatDto, CreateConversationDto } from './ai.dto'
import { AiChatService } from './ai-chat.service'
import { AuthenticatedOnly, CurrentUser } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'

@Controller('api/ai')
export class AiController {
  constructor(private readonly chat: AiChatService) {}

  /** 状态：能不能用、为什么不能用、索引进度、建议问题。不含任何密钥信息。 */
  @Get('status')
  @AuthenticatedOnly()
  async status() {
    return await this.chat.status()
  }

  @Get('conversations')
  @AuthenticatedOnly()
  async conversations(@CurrentUser() user: AuthUser) {
    return { items: await this.chat.listConversations(user) }
  }

  @Post('conversations')
  @AuthenticatedOnly()
  async createConversation(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return await this.chat.createConversation(user, dto.title)
  }

  @Get('conversations/:id/messages')
  @AuthenticatedOnly()
  async messages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return { items: await this.chat.messages(user, id) }
  }

  @Delete('conversations/:id')
  @AuthenticatedOnly()
  async removeConversation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return await this.chat.deleteConversation(user, id)
  }

  /**
   * 提问。一次性返回（不流式）—— 前端用"加载中 + 取消 + 重试"覆盖体验；
   * 流式留给下一轮（需要 SSE/分块传输，本轮的取舍写在报告里）。
   */
  @Post('chat')
  @AuthenticatedOnly()
  async ask(@CurrentUser() user: AuthUser, @Body() dto: AiChatDto, @Req() req: Request) {
    const controller = new AbortController()
    // 客户端断开（用户点了取消、或关掉抽屉）→ 中止上游请求
    req.on('close', () => controller.abort())
    return await this.chat.chat(user, { question: dto.question, conversationId: dto.conversationId }, { signal: controller.signal })
  }
}
