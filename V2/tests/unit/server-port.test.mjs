/**
 * tests/unit/server-port.test.mjs —— 监听端口必须跟平台对齐（线上 502 的那一课）
 * ============================================================================
 * 2026-10-11 线上真实故障：Zeabur 把服务路由到 **8080**（服务配置 `ports:[{id:web,port:8080}]`），
 * 而应用只认 `SERVER_PORT=3300` —— **构建成功、容器起来了、站点一直 502**
 * （边缘连不上上游端口）。平台会注入 `PORT=${WEB_PORT}`，端口是平台说了算。
 *
 * 这份测试钉住解析规则，尤其是"生产跟随平台、本地/测试保持原样"这条分界线：
 *   ① 生产 + PORT → 用 PORT（这就是线上修复）；
 *   ② 非生产 + 两者都有 → **SERVER_PORT 优先**（本地开发/集成测试/演练栈完全没有 PORT，
 *      行为必须和以前一模一样 —— 615 条集成测试跑在这条上）；
 *   ③ 非法值（空、非数字、越界）一律跳过，绝不把 NaN 交给 listen()。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appConfig } from '../helpers/modules.mjs'

const { resolveServerPort } = appConfig

describe('① 生产环境跟随平台端口（这次 502 的根因）', () => {
  test('生产 + PORT=8080 + SERVER_PORT=3300 → 8080，来源 PORT', () => {
    assert.deepEqual(resolveServerPort({ PORT: '8080', SERVER_PORT: '3300' }, true), {
      port: 8080,
      source: 'PORT',
    })
  })

  test('生产没有 PORT → 退回 SERVER_PORT（自建 Docker 部署走这条）', () => {
    assert.deepEqual(resolveServerPort({ SERVER_PORT: '3300' }, true), {
      port: 3300,
      source: 'SERVER_PORT',
    })
  })

  test('生产 PORT 非法 → 不用它，退回 SERVER_PORT（不猜端口）', () => {
    for (const bad of ['', '   ', 'abc', '0', '70000', '-1', '8080.5']) {
      assert.deepEqual(
        resolveServerPort({ PORT: bad, SERVER_PORT: '3300' }, true),
        { port: 3300, source: 'SERVER_PORT' },
        `PORT=${JSON.stringify(bad)} 应当被忽略`,
      )
    }
  })
})

describe('② 非生产环境保持原样（本地开发 / 集成测试 / 演练栈）', () => {
  test('SERVER_PORT 优先，哪怕环境里恰好有 PORT', () => {
    assert.deepEqual(resolveServerPort({ PORT: '9999', SERVER_PORT: '3311' }, false), {
      port: 3311,
      source: 'SERVER_PORT',
    })
  })

  test('只有 PORT 时用它；两个都没有 → 3300 默认', () => {
    assert.deepEqual(resolveServerPort({ PORT: '9999' }, false), { port: 9999, source: 'PORT' })
    assert.deepEqual(resolveServerPort({}, false), { port: 3300, source: 'default' })
    assert.deepEqual(resolveServerPort({}, true), { port: 3300, source: 'default' })
  })
})

describe('③ 边界：端口号合法区间', () => {
  test('1 与 65535 合法；0 / 65536 / 非整数 非法', () => {
    assert.equal(resolveServerPort({ SERVER_PORT: '1' }, false).port, 1)
    assert.equal(resolveServerPort({ SERVER_PORT: '65535' }, false).port, 65535)
    for (const bad of ['0', '65536', '-80', '8 0', '80_80']) {
      assert.equal(
        resolveServerPort({ SERVER_PORT: bad }, false).source,
        'default',
        `${bad} 不该被当成端口`,
      )
    }
  })

  test('loadConfig 会带上端口来源（启动日志要靠它排障）', () => {
    const prev = { ...process.env }
    try {
      process.env.SERVER_PORT = '3399'
      process.env.NODE_ENV = 'test'
      // 非生产要显式允许开发默认密钥，否则 loadConfig 会因缺密钥抛错（那是刻意的）
      process.env.V2_ALLOW_DEV_SECRETS = '1'
      delete process.env.PORT
      const config = appConfig.loadConfig()
      assert.equal(config.port, 3399)
      assert.equal(config.portSource, 'SERVER_PORT')
    } finally {
      process.env = prev
    }
  })
})
