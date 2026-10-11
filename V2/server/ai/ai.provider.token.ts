/**
 * server/ai/ai.provider.token.ts —— 供应商客户端的注入令牌
 * ============================================================================
 * 为什么单开一个文件：`AiProvider` 是**可空**依赖（没配密钥时是 null），
 * 而 Nest 的 `@Inject()` 需要令牌 + 类型。把令牌放在这里，
 * 服务与模块都不用互相 import，避免循环依赖。
 */
export const AI_PROVIDER = 'AI_PROVIDER'

export type { AiProvider } from './provider'
