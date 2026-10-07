/**
 * tests/helpers/modules.mjs —— 单元测试与集成测试**共用**的模块加载方式
 * ============================================================================
 * 一律从 `dist/` 加载：测试跑的必须是**将要部署的那份产物**。
 * 直接从 `shared/*.ts` 导入会让测试跑在另一份源码视图上，
 * 而且 Node 会因为 package.json 没有 type 字段而反复警告模块类型。
 *
 * 编译产物是 CommonJS，所以用 createRequire 而不是 ESM 具名导入。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

export const permissions = require(join(ROOT, 'dist/shared/permissions.js'))
export const resourceStatus = require(join(ROOT, 'dist/shared/resource-status.js'))
export const directoryRules = require(join(ROOT, 'dist/shared/directory.js'))
export const auditActions = require(join(ROOT, 'dist/shared/audit-actions.js'))
export const resourceQuery = require(join(ROOT, 'dist/shared/resource-query.js'))
export const filePolicy = require(join(ROOT, 'dist/shared/file-policy.js'))
export const storageRules = require(join(ROOT, 'dist/server/storage/local.provider.js'))
export const s3ProviderRules = require(join(ROOT, 'dist/server/storage/s3.provider.js'))
export const storageContract = require(join(ROOT, 'dist/server/storage/storage.provider.js'))
export const password = require(join(ROOT, 'dist/server/auth/password.js'))
export const auditService = require(join(ROOT, 'dist/server/audit/audit.service.js'))

/**
 * 迁移脚本（阶段 9）。
 *
 * 脚本是 ESM，所以用 import 而不是 require。它的 CLI 部分被 `isMain` 守着，
 * 所以 import 它没有副作用 —— 映射表因此可以像普通模块一样被单测直接检查。
 */
export const v1Migration = await import(join(ROOT, 'scripts/import-v1.mjs'))
export const v1Snapshot = await import(join(ROOT, 'scripts/v1-snapshot.mjs'))
