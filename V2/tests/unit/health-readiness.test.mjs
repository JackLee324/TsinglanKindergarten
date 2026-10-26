/**
 * 就绪检查必须是 **503**，不能是 200 + body 说 degraded。
 *
 * 这条测试存在的理由（真实缺陷）：
 * 旧的 `ready()` 在数据库查询失败时 `return { status:'degraded', database:'unreachable' }`
 * —— HTTP 状态码仍是 200。而 Render 健康检查 / K8s readinessProbe / 负载均衡
 * **只看状态码不解析 body**，于是数据库挂了实例照样被判"就绪"，流量被送进查不了库的进程。
 * 之前的隔离 E2E 用 `st in (500,503) or b'"ok"' not in b` 断言，把 200 也判成 PASS，
 * 属于测试侧的假绿，代码与测试两边都要修。
 *
 * 断言的是"探针视角"：状态码 + database 字段，二者缺一不可。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { healthController } from '../helpers/modules.mjs'
const { HealthController } = healthController

/** 假的 Response：只记录被设置的状态码（passthrough 模式下控制器自己设 503）。 */
function fakeRes() {
  const res = { code: 200 }
  res.status = (c) => {
    res.code = c
    return res
  }
  return res
}

/** 假的 sql 模板函数：ok=true 时正常返回，否则抛出连接错误。 */
function fakeSql(ok) {
  return async () => {
    if (!ok) throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    return [{ ok: 1 }]
  }
}

describe('health/ready 就绪语义', () => {
  test('数据库可用 → 200 + status=ready + database=ok', async () => {
    const res = fakeRes()
    const c = new HealthController(fakeSql(true), { health: async () => ({}) })
    const body = await c.ready(res)
    assert.equal(res.code, 200, '可用时必须是不设状态码（默认 200）')
    assert.equal(body.status, 'ready')
    assert.equal(body.database, 'ok')
  })

  test('数据库不可用 → 503 + status=unavailable + database=unreachable', async () => {
    const res = fakeRes()
    const c = new HealthController(fakeSql(false), { health: async () => ({}) })
    const body = await c.ready(res)
    assert.equal(res.code, 503, '探针只看状态码：DB 挂掉必须 503，不能 200')
    assert.equal(body.status, 'unavailable')
    assert.equal(body.database, 'unreachable')
    assert.ok(typeof body.detail === 'string' && body.detail.length > 0, '非生产应带 detail')
  })

  test('生产环境不泄露 detail（避免 SQL 片段/主机名外泄）', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = fakeRes()
      const c = new HealthController(fakeSql(false), { health: async () => ({}) })
      const body = await c.ready(res)
      assert.equal(res.code, 503)
      assert.equal(body.detail, undefined)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})
