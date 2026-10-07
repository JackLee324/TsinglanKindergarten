import { Global, Module } from '@nestjs/common'
import { AuthorizationService } from './authorization.service'

/**
 * 授权模块是**全局**的：任何模块都可能需要问"这个人能不能对这个目录做这件事"，
 * 而全局注册也保证全仓库只有一个 AuthorizationService 实例（一份判定逻辑）。
 */
@Global()
@Module({ providers: [AuthorizationService], exports: [AuthorizationService] })
export class AuthorizationModule {}
