import { Global, Module } from '@nestjs/common'
import { StorageController } from './storage.controller'
import { LocalStorageProvider } from './local.provider'
import { S3StorageProvider } from './s3.provider'
import { StorageService } from './storage.service'

/**
 * 存储模块。
 *
 * 两个驱动都注册成 provider（本地数据面控制器要用 LocalStorageProvider 直接验令牌），
 * 但**业务代码只注入 StorageService** —— 由它按配置选定驱动。
 * 这样"换个存储平台"是改配置，不是改调用方。
 */
@Global()
@Module({
  controllers: [StorageController],
  providers: [LocalStorageProvider, S3StorageProvider, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
