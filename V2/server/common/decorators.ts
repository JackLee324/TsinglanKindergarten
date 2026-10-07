import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { PermissionCode } from '../../shared/permissions'
import type { AuthUser } from './auth-user'

export const REQUIRE_PERMISSION = 'v2:require-permission'
export const PUBLIC_ROUTE = 'v2:public-route'
export const AUTHENTICATED_ONLY = 'v2:authenticated-only'

/**
 * 声明这个接口需要的权限。
 *
 * **所有接口都必须声明**（登录、健康检查用 `@Public()` 显式豁免）。
 * 没声明的接口会被 AuthzGuard **拒绝**（fail closed）——
 * V1 的默认是"没声明就放行"，后果是新增接口忘了加注解时所有测试仍然全绿。
 */
export const RequirePermission = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRE_PERMISSION, permissions)

/** 显式声明"这个接口不需要登录"。 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)

/**
 * 显式声明"登录即可，不需要额外权限"。
 *
 * WHY 需要第三种状态：有些接口的**数据本身就是按权限过滤**的
 * （例如目录树只返回当前用户能看到的节点；`/auth/me` 返回自己的身份）。
 * 对它们要求某个具体权限会得到荒谬的结果：一个还没被分配任何目录的新教师
 * 连侧边栏都加载不出来，界面看起来像坏了。
 *
 * 但它**必须显式声明**，不能靠"没写注解就默认放行" —— 那正是 V1 的缺陷来源。
 * 静态测试要求每个路由恰好属于三者之一：@Public / @AuthenticatedOnly / @RequirePermission。
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true)

/** 目录 id 从哪里取，供 AuthzGuard 解析"对哪个目录做这件事"。 */
export type DirectorySource =
  | { readonly kind: 'param'; readonly name: string }
  /**
   * `nullMeansGlobal`：这个字段为空时，把操作看作**平台级**（不属于任何目录），
   * 于是按"全平台授权"判定。新增**一级栏目**就是这种情况 ——
   * 它没有父目录，但它是合法操作，不能因为"解析不到目录"就被 fail closed 拒掉。
   */
  | { readonly kind: 'body'; readonly name: string; readonly nullMeansGlobal?: boolean }
  | { readonly kind: 'query'; readonly name: string }
  | { readonly kind: 'resource'; readonly param: string }
  | { readonly kind: 'none' }

export const DIRECTORY_SOURCE = 'v2:directory-source'

export const DirectoryScope = (source: DirectorySource) => SetMetadata(DIRECTORY_SOURCE, source)

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>()
  if (!req.user) throw new Error('CurrentUser 在没有通过 AuthzGuard 的路由上使用')
  return req.user
})
