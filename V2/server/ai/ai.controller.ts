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
import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
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
  async ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: AiChatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const controller = new AbortController()
    /*
      取消：客户端断开（用户点「取消」、或关掉面板）→ **中止上游模型请求**。
      只让界面停止转圈是不够的：连接还挂着，模型那边照样在算、账单照样在涨，
      而用户点取消的本意正是止损。

      ⚠️ 这里用 `res.on('close')` + `writableEnded`，**不要**换成 `req.on('close')`：
      实测（临时探针 + 假供应商）在 Express 5 + `express.json()` 之下，
      请求体解析完之后 `req` 的 'close' 在本进程里不再触发 ——
      而"不触发"不会报错，表现就是"用户以为取消了、模型还在算"，
      属于最难发现的一类问题。正常响应结束时 'close' 也会来，那时 writableEnded
      已经是 true，跳过即可。这条有测试压着：`browser.stage15-ai-panel.test.mjs` ③
      会点「取消」，并让假供应商确认连接**真的**被中断。
    */
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    return await this.chat.chat(user, { question: dto.question, conversationId: dto.conversationId }, { signal: controller.signal })
  }
}
