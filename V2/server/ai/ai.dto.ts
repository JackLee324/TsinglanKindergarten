/**
 * server/ai/ai.dto.ts —— AI 接口的入参（白名单校验，与项目其它模块同一套）
 * ============================================================================
 * 上限刻意收紧：问题最长 500 字（够问清楚一件事），标题 80 字。
 * 全局 ValidationPipe 会拒绝多余字段（未知字段 → 400），所以前端多传东西不会静默生效。
 */
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator'

export class AiChatDto {
  @IsString()
  @MinLength(1, { message: '问题不能为空' })
  @MaxLength(500, { message: '问题最长 500 字，请拆分后再问' })
  question!: string

  @IsOptional()
  @IsUUID('4')
  conversationId?: string
}

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string
}
