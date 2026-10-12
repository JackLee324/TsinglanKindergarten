/**
 * tests/integration/cors-drift-check.integration.test.mjs
 *   —— check-storage.mjs 的**真实退出码**
 * ============================================================================
 * 上一份 tests/unit/cors-drift.test.mjs 测的是纯判断逻辑；这一份测的是
 * **脚本真的会不会以非零退出码结束** —— 因为 CI / 部署门禁认的是退出码，
 * 不是输出里有没有某句提示。
 *
 * 用一个**真实**的 S3 后端（SeaweedFS，支持 PutBucketCors）跑，
 * 每个场景把不同的 CORS 策略写到桶上，再真跑一次脚本。
 * 全程在隔离环境：不连生产桶、不用生产凭据、不碰生产数据库。
 *
 * ⚠️ 为什么放在 integration 而不是 unit：
 *   `startS3Backend` 用的是**固定端口**（18444 等），而 `npm run test:unit`
 *   是并行跑文件的 —— 两个用后端的文件同时跑就会撞端口（实测报
 *   `S3 测试后端要用的端口被占用：master(19433)`）。
 *   `test:integration` 用 `--test-concurrency=1` 串行执行，正好合适。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetBucketCorsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, s3TestClient, startS3Backend } from '../helpers/s3-backend.mjs'
import { REQUIRED_ALLOWED_HEADERS, REQUIRED_METHODS } from '../../scripts/lib/cors-drift.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const CHECK_SCRIPT = join(ROOT, 'scripts', 'check-storage.mjs')

const NEW_ORIGIN = 'https://tsinglanteachers.zeabur.app'
const OLD_ORIGIN = 'https://tsinglan.zeabur.app'

/** 退出码契约：0 通过 · 1 检查未通过 · 2 BLOCKED（缺输入）。 */
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_BLOCKED = 2

let backend

before(async () => {
  backend = await startS3Backend({ bucket: `v2cors-${randomUUID().slice(0, 8)}` })
})

after(async () => {
  await backend?.stop()
})

/** 真跑一次脚本，拿真实退出码。 */
function runCheck(args) {
  const res = spawnSync(process.execPath, [CHECK_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      V2_ALLOW_DEV_SECRETS: '1',
      STORAGE_PROVIDER: 's3',
      STORAGE_ENDPOINT: backend.endpoint,
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: backend.bucket,
      STORAGE_ACCESS_KEY: S3_TEST_ACCESS_KEY,
      STORAGE_SECRET_KEY: S3_TEST_SECRET_KEY,
      STORAGE_FORCE_PATH_STYLE: '1',
    },
  })
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** 把一份 CORS 策略写到测试桶上。 */
async function setCors(overrides = {}) {
  const policy = {
    CORSRules: [
      {
        AllowedOrigins: [NEW_ORIGIN],
        AllowedMethods: [...REQUIRED_METHODS],
        AllowedHeaders: [...REQUIRED_ALLOWED_HEADERS],
        ExposeHeaders: ['ETag', 'x-amz-checksum-sha256'],
        MaxAgeSeconds: 3600,
        ...overrides,
      },
    ],
  }
  await s3TestClient().send(new PutBucketCorsCommand({ Bucket: backend.bucket, CORSConfiguration: policy }))
  return policy
}

/** 读回桶上生效的策略（用来验证"检查没有改配置"）。 */
async function readCors() {
  try {
    return await s3TestClient().send(new GetBucketCorsCommand({ Bucket: backend.bucket }))
  } catch (error) {
    if (error.name === 'NoSuchCORSConfiguration') return null
    throw error
  }
}

describe('check-storage.mjs 的退出码（真桶 + 真子进程）', () => {
  test('① 期望的新域名在 AllowedOrigins 里 → 退出码 0', async () => {
    await setCors()
    const ok = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(ok.status, EXIT_OK, ok.output)
    const viaBase = runCheck(['--base', `${NEW_ORIGIN}/login`])
    assert.equal(viaBase.status, EXIT_OK, '--base 给部署地址（带路径）也要能取出 Origin')
  })

  test('② 桶里只有旧域名、期望新域名 → 退出码 1（本次故障的形状）', async () => {
    await setCors({ AllowedOrigins: [OLD_ORIGIN] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
    assert.match(res.output, /不在允许列表里/)
    assert.match(res.output, new RegExp(NEW_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('③ 只有通配符 → 退出码 1', async () => {
    await setCors({ AllowedOrigins: ['*'] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
    assert.match(res.output, /通配符/)
  })

  test('④ 协议不同 → 退出码 1', async () => {
    await setCors({ AllowedOrigins: ['http://tsinglanteachers.zeabur.app'] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
  })

  test('⑤ 主机不同 → 退出码 1', async () => {
    await setCors({ AllowedOrigins: [OLD_ORIGIN] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
  })

  test('⑥ 端口不同 → 退出码 1', async () => {
    await setCors({ AllowedOrigins: [`${NEW_ORIGIN}:8443`] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
  })

  test('⑦ 不给期望 Origin → 退出码 2（BLOCKED，不得静默通过）', async () => {
    await setCors()
    const res = runCheck([])
    assert.equal(res.status, EXIT_BLOCKED, res.output)
    assert.match(res.output, /BLOCKED/)
    // 与"检查失败"区分开：这里是**没条件判**，不是判过、也不是判错。
    assert.notEqual(res.status, EXIT_OK)
  })

  test('⑦b 非法期望值（通配符 / 非 http）→ 非零，且不能当成通过', async () => {
    await setCors()
    for (const bad of ['*', 'not-an-origin', 'ftp://a.com']) {
      const res = runCheck(['--expected-origin', bad])
      assert.notEqual(res.status, EXIT_OK, `${bad} 不该判过：${res.output}`)
    }
  })

  test('⑧ PUT 不在 AllowedMethods 里 → 退出码 1', async () => {
    await setCors({ AllowedMethods: ['GET', 'HEAD'] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
    assert.match(res.output, /PUT/)
  })

  test('⑧b 允许头缺失 → 退出码 1', async () => {
    await setCors({ AllowedHeaders: ['content-type'] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)
    assert.match(res.output, /authorization/)
  })

  test('⑨ 多个合法 Origin，期望的那个被允许 → 退出码 0（其余只提示不判失败）', async () => {
    await setCors({ AllowedOrigins: [NEW_ORIGIN, 'https://staging.example.com'] })
    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_OK, res.output)
    assert.match(res.output, /还有这些来源/)
    assert.match(res.output, /staging\.example\.com/, '应当把额外来源报出来供核实')
  })

  test('⑩ 检查是只读的：失败的检查不会改配置、也不会动对象', async () => {
    // 先摆一个"会失败"的策略，并在桶里放一个对象。
    const before = await setCors({ AllowedOrigins: [OLD_ORIGIN] })
    const key = `cors-readonly-probe/${randomUUID()}.txt`
    await s3TestClient().send(
      new PutObjectCommand({ Bucket: backend.bucket, Key: key, Body: Buffer.from('probe') }),
    )
    const objectsBefore = await listKeys()

    const res = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(res.status, EXIT_FAILED, res.output)

    const after = await readCors()
    assert.deepEqual(
      after?.CORSRules,
      before.CORSRules,
      '检查过程改了桶的 CORS —— 它必须是只读的',
    )
    assert.deepEqual(await listKeys(), objectsBefore, '检查过程动了桶里的对象')

    await s3TestClient().send(new DeleteObjectCommand({ Bucket: backend.bucket, Key: key }))
  })

  test('文档化陷阱：期望值给旧域名时"通过"**不能**证明新域名可用', async () => {
    // 桶上只有旧域名 —— 这正是故障发生时生产桶的真实状态。
    await setCors({ AllowedOrigins: [OLD_ORIGIN] })

    // 如果操作者把期望值也写成旧域名，检查会**通过**……
    const withOld = runCheck(['--expected-origin', OLD_ORIGIN])
    assert.equal(withOld.status, EXIT_OK, '期望值与桶一致时必然通过 —— 这正是陷阱所在')

    // ……但真正在用的新域名其实**没有**被授权。
    const withNew = runCheck(['--expected-origin', NEW_ORIGIN])
    assert.equal(withNew.status, EXIT_FAILED, '真实的部署域名必须由操作者给出，检查才有意义')

    // 结论：检查的有效性完全取决于"期望 Origin 来自哪里"。
    // 所以 check-storage.mjs 不接受从桶里反推，也不拿 V2_PUBLIC_ORIGIN 当期望值。
  })
})

async function listKeys() {
  const res = await s3TestClient().send(new ListObjectsV2Command({ Bucket: backend.bucket }))
  return (res.Contents ?? []).map((o) => o.Key).sort()
}
