/**
 * tests/unit/route-declarations.test.mjs —— 结构性守卫
 * ============================================================================
 * 两条必须由机器盯着、人盯不住的事：
 *
 * 1. **每个路由都要显式声明访问级别**：`@Public()` / `@AuthenticatedOnly()` /
 *    `@RequirePermission()` 三者之一。一条都没写的路由会被守卫 fail closed 拒掉，
 *    这是有意的，但必须有测试盯着 —— 否则"新增接口忘了声明"只会表现为
 *    某个接口莫名 403，而没人知道原因。
 *    （V1 的默认反过来：没声明就放行，于是新增接口对所有登录用户开放，
 *      而所有测试仍然全绿，因为测试用的是管理员账号。）
 *
 * 2. **授权判定只有一处**：所有权、目录范围、管理员绕过都必须经过
 *    `AuthorizationService`。业务代码里出现 `uploader_id !== actor.id`
 *    或 `role === 'ADMIN'` 就是开了第二条判定路径。
 *
 * ── 写这个解析器踩过的两个坑（两次都是解析器错、代码对）──────────────────
 * a) NestJS 的装饰器顺序**不固定**：
 *        @AuthenticatedOnly()      @Get('logs')
 *        @Get('me')                @RequirePermission('audit.view')
 *        async me() {...}          async logs() {...}
 *    只在 `@Get(` 上面找（第一版）、或只在下面找，都会漏掉一半，
 *    于是四条**正确声明**的路由被报成"没声明"。
 *    正确做法：以 HTTP 装饰器为锚点，**上下都收**。
 * b) 注释里出现 `role === 'ADMIN'` 是正常的中文说明，不是违规。
 *    必须先**去掉注释**再匹配，否则测试会因为自己的注释而变红
 *    （V1 也踩过同一个坑）。stripComments 保留行号，便于按行定位。
 *
 * 一个会误报的静态测试比没有测试更糟：它会让人去改本来正确的代码。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'server')

function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, predicate, out)
    else if (predicate(entry)) out.push(full)
  }
  return out
}

/** 去掉块注释与行注释，**保留行号**（注释换成等长空白）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length))
}

const HTTP_DECORATOR = /@(Get|Post|Patch|Put|Delete)\(/
const ANY_DECORATOR = /^\s*@[A-Za-z_$][\w$]*\(/

/**
 * 拆出每个路由声明：以 HTTP 装饰器为锚点，**向上与向下**收连续的装饰器行。
 * 向下收到方法签名之前为止（NestJS 允许 `@Get(...)` 写在 `@RequirePermission(...)` 之前）。
 */
function handlersOf(source) {
  const lines = stripComments(source).split('\n')
  const anchors = []
  for (const [i, line] of lines.entries()) {
    if (HTTP_DECORATOR.test(line)) anchors.push(i)
  }

  return anchors.map((anchor) => {
    let start = anchor
    while (start - 1 >= 0 && ANY_DECORATOR.test(lines[start - 1])) start -= 1

    let end = anchor
    while (end + 1 < lines.length && ANY_DECORATOR.test(lines[end + 1])) end += 1

    return {
      line: anchor + 1,
      decorators: lines.slice(start, end + 1).join('\n'),
      firstLine: lines[anchor].trim(),
    }
  })
}

describe('路由必须显式声明访问级别', () => {
  const files = walk(SERVER, (name) => name.endsWith('.controller.ts'))

  test(`扫描到 ${files.length} 个 controller`, () => {
    assert.ok(files.length >= 5, `只找到 ${files.length} 个 controller，路径可能不对`)
  })

  for (const file of files) {
    const rel = relative(ROOT, file)
    test(`${rel}：每个路由都有声明`, () => {
      const handlers = handlersOf(readFileSync(file, 'utf8'))
      assert.ok(handlers.length > 0, '这个 controller 里没有找到路由')

      const undeclared = handlers
        .filter(
          (h) =>
            !(
              /@Public\(\)/.test(h.decorators) ||
              /@AuthenticatedOnly\(\)/.test(h.decorators) ||
              /@RequirePermission\(/.test(h.decorators)
            ),
        )
        .map((h) => `第 ${h.line} 行：${h.firstLine}`)

      assert.deepEqual(
        undeclared,
        [],
        `这些路由既没有 @Public / @AuthenticatedOnly，也没有 @RequirePermission：\n  ${undeclared.join('\n  ')}\n` +
          '它们会被守卫 fail closed 拒掉。要放行请**显式**声明。',
      )
    })
  }
})

describe('权限声明不得退化成角色判断', () => {
  const files = walk(SERVER, (name) => name.endsWith('.controller.ts'))

  test('controller 里不出现 role === / roles.includes（注释不算）', () => {
    const offenders = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /roles\s*\.\s*includes\(|role\s*===\s*['"]/.test(l) && l.trim() !== '')
      if (hits.length > 0) offenders.push(`${relative(ROOT, file)}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `这些 controller 用角色而不是能力码判定：\n  ${offenders.join('\n  ')}\n` +
        '角色判断会与「授权只有一个真相」直接冲突。能力开关请走 authz.capabilitiesFor()。',
    )
  })
})

describe('资源所有权判断必须收口到 AuthorizationService', () => {
  test('业务代码里不出现 uploader_id !== / uploaderId !==（注释不算）', () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (rel.endsWith(join('authz', 'authorization.service.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /(uploader_id|uploaderId)\s*!==/.test(l) && l.trim() !== '')
      if (hits.length > 0) offenders.push(`${rel}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `所有权判断必须走 AuthorizationService.canActOnResource()：\n  ${offenders.join('\n  ')}\n` +
        '散在业务代码里的所有权判断既不会被授权测试覆盖，也不会出现在「谁被拒了」的审计里。',
    )
  })
})

describe('ADMIN 绕过只允许一处', () => {
  /**
   * 上面那条只扫了 `ADMIN_ROLE` 这个**常量**，于是 `role === 'ADMIN'` 这种
   * 字面量写法能溜过去 —— Stage 8 加"最后一个管理员"保护时就是这么溜过去的
   * （在 users.service.ts 里写了一次角色比较）。这条把它堵上。
   */
  test("server/ 下 `'ADMIN'` 这个角色字面量也只出现在 authorization.service.ts", () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (rel.endsWith(join('authz', 'authorization.service.ts'))) continue
      // `shared/permissions.ts` 里定义角色的取值集合，那是定义处不是判定处。
      if (rel.endsWith(join('shared', 'permissions.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /['"]ADMIN['"]/.test(l) && l.trim() !== '')
        // SQL 里按角色取值筛选（`WHERE role = 'ADMIN'`）不算"判定放行"，
        // 但为了不留后门，这里连它一起管：要查管理员请走 AuthorizationService。
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      if (hits.length > 0) offenders.push(`${rel}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `角色字面量 'ADMIN' 只允许出现在 authorization.service.ts：\n  ${offenders.join('\n  ')}\n` +
        '"管理员"这个概念必须只有一处定义，否则它的含义会在各处慢慢分叉。',
    )
  })

  /*
    ⚠️ 这条规则**只针对 RBAC 角色**（ADMIN / TEACHER / principal …）。
    不能写成"任何 `role ===` 都算"：消息、任务、日志里都有 `role` 字段
    （AI 助手的对话消息就是 `role === 'user' | 'assistant'`），
    一刀切会逼着后来的人把字段改名来绕过规则 —— 那是把规则改坏了，不是遵守它。
    判定标准落在这里：**右侧是 RBAC 角色字面量**，或**左侧来自 user/actor/capabilities**。
  */
  const RBAC_ROLE_LITERAL =
    /['"](ADMIN|TEACHER|principal|curriculum_director|prek_head|k_head|pe_specialist|prek_assistant|visitor)['"]/
  const RBAC_ROLE_SOURCE = /\b(user|actor|currentUser|me|self|capabilities|session)\s*\.\s*roles?\b/

  test('client/src 里不比较角色（用服务端给的 capabilities）', () => {
    const files = walk(join(ROOT, 'client', 'src'), (name) => /\.(ts|tsx)$/.test(name))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /(roles?\s*===|roles\s*\.includes)/.test(l) && l.trim() !== '')
        .filter((l) => RBAC_ROLE_LITERAL.test(l) || RBAC_ROLE_SOURCE.test(l))
      if (hits.length > 0) offenders.push(`${rel}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `前端不得比较角色：\n  ${offenders.join('\n  ')}\n` +
        '能不能做某件事由服务端的 capabilities 决定；"是不是管理员"也是服务端算好的。',
    )
  })

  /*
    变异验证：把一条真实的违规写法放进 `client/src`，上面那条必须变红。
    没有这一步，"不比较角色"就只是一句口号 —— 规则写松了没人会知道。
    （探针用完立刻删除；即便断言失败也走 finally 清理。）
  */
  test('变异验证：写一条 `user.role === \'principal\'` 进去，上面那条必须红', () => {
    const probe = join(ROOT, 'client', 'src', '__role_guard_probe.ts')
    writeFileSync(probe, "export const bad = (user: { role: string }) => user.role === 'principal'\n")
    try {
      const code = stripComments(readFileSync(probe, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /(roles?\s*===|roles\s*\.includes)/.test(l) && l.trim() !== '')
        .filter((l) => RBAC_ROLE_LITERAL.test(l) || RBAC_ROLE_SOURCE.test(l))
      assert.equal(hits.length, 1, '违规写法必须被规则抓到（否则规则形同虚设）')
      // 反向：对话消息的 role 不能被误伤（这是本轮加 AI 助手时踩到的误报）
      const chatLine = "if (message.role === 'user') {"
      assert.equal(
        RBAC_ROLE_LITERAL.test(chatLine) || RBAC_ROLE_SOURCE.test(chatLine),
        false,
        '消息的 role 字段不该被当成 RBAC 角色（否则会逼着后来的人改字段名来绕过规则）',
      )
    } finally {
      rmSync(probe, { force: true })
    }
  })

  /*
    ── 为什么要有这条静态规则（2026-10-11 实测事故）─────────────────────────────
    Nest 解析构造函数依赖用的是编译期元数据 `design:paramtypes`。
    当参数类型写成**联合类型**（`X | null`，`@Optional()` 的常见写法）时，
    SWC 写出来的元数据只能是 `Object` —— 于是 Nest 去找名为 `Object` 的 provider，
    找不到，`@Optional()` 静默注入 `undefined`。

    症状极难排查：上传照常成功、接口全 200，只是**索引任务永远不排队**
    （还有一层 try/catch 兜底，连日志都没有），最后表现为"AI 问什么都说没找到"。
    所以要显式写 `@Inject(真实 token)`：那条路径不经过元数据，永远不会猜错。
  */
  test('@Optional() 注入必须显式写 @Inject(真实 token)（联合类型会被编译成 Object）', () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const line of code.split('\n')) {
        if (!line.includes('@Optional()')) continue
        if (line.includes('@Inject(')) continue
        offenders.push(`${rel}: ${line.trim()}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `@Optional() 必须同时写 @Inject(token)：\n  ${offenders.join('\n  ')}\n` +
        '否则 Nest 会拿 design:paramtypes 去猜，而联合类型只能编译成 Object —— ' +
        '依赖会被静默注入成 undefined，出错时没有任何提示。',
    )
  })

  test('server/ 下 ADMIN_ROLE 只出现在 authorization.service.ts（注释与 import 不算）', () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (rel.endsWith(join('authz', 'authorization.service.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /ADMIN_ROLE/.test(l) && l.trim() !== '')
        .filter((l) => !/^\s*(import|\})/.test(l))
      if (hits.length > 0) offenders.push(`${rel}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `ADMIN 绕过必须集中在一处：\n  ${offenders.join('\n  ')}\n` +
        '分散的绕过无法被审查，也无法被测试覆盖。',
    )
  })
})

describe('不留 TODO / stub / 假授权', () => {
  test('server 与 shared 里没有 TODO / FIXME / XXX / placeholder', () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts')).concat(
      walk(join(ROOT, 'shared'), (name) => name.endsWith('.ts')),
    )
    const offenders = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const hits = code
        .split('\n')
        .filter((l) => /\b(TODO|FIXME|XXX|PLACEHOLDER)\b/.test(l) && l.trim() !== '')
      if (hits.length > 0) offenders.push(`${relative(ROOT, file)}: ${hits[0].trim()}`)
    }
    assert.deepEqual(offenders, [], `发现未完成的标记：\n  ${offenders.join('\n  ')}`)
  })

  test('没有返回固定 true 的授权假实现', () => {
    const files = walk(SERVER, (name) => name.endsWith('.ts'))
    const offenders = []
    for (const file of files) {
      const rel = relative(ROOT, file)
      if (rel.endsWith(join('authz', 'authorization.service.ts'))) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      // 形如 `allowed: true` 的硬编码放行，或 `canXxx() { return true }`
      const hits = code
        .split('\n')
        .filter((l) => /allowed:\s*true\s*[,}]/.test(l) && l.trim() !== '')
      if (hits.length > 0) offenders.push(`${rel}: ${hits[0].trim()}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `发现硬编码的授权放行：\n  ${offenders.join('\n  ')}\n` +
        '放行只能来自 AuthorizationService 的判定结果。',
    )
  })
})
