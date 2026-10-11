/**
 * server/ai/ai.module.ts —— AI 模块装配
 * ============================================================================
 * 供应商客户端是**可空**的：没配 `AI_API_KEY` 时 `AI_PROVIDER` 为 null，
 * 索引 worker 仍然会跑（文本/Office 文件的解析不需要模型），
 * 图片 OCR 会被如实记为 `OCR_DISABLED` —— 而不是假装索引成功。
 */
import { Module } from '@nestjs/common'
import { AuthorizationModule } from '../authz/authorization.module'
import { StorageModule } from '../storage/storage.module'
import { resolveAiConfig } from './ai.config'
import { AI_PROVIDER } from './ai.provider.token'
import { createAiProvider } from './provider'
import { AiIndexService } from './index.service'
import { AiIndexWorker } from './index.worker'
import { AiRetrievalService } from './retrieval.service'
import { AiChatService } from './ai-chat.service'
import { AiController } from './ai.controller'

@Module({
  imports: [AuthorizationModule, StorageModule],
  providers: [
    { provide: 'AI_CONFIG', useFactory: () => resolveAiConfig() },
    {
      provide: AI_PROVIDER,
      useFactory: () => createAiProvider(resolveAiConfig()),
    },
    AiIndexService,
    AiIndexWorker,
    AiRetrievalService,
    AiChatService,
  ],
  controllers: [AiController],
  exports: [AiIndexService, AiRetrievalService, AiChatService, AI_PROVIDER, 'AI_CONFIG'],
})
export class AiModule {}
