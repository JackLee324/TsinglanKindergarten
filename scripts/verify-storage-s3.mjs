/**
 * scripts/verify-storage-s3.mjs —— S3 兼容对象存储的**真实字节往返**验证（§4/§23）。
 *
 *   S3RVER_MODULE=/path/to/node_modules/s3rver node scripts/verify-storage-s3.mjs
 *
 * 为什么要有一个独立的 S3 实现来验
 * ---------------------------------
 * 手写的 SigV4 签名最容易出的错，是"我自己算、我自己验"时看不出来的：
 * URL 编码规则（S3 要求 `%20` 而不是 `+`，且 `!'()*` 必须编码）、
 * 规范查询串的排序、签名头集合。所以这里让**被测代码生成预签名 URL**，
 * 交给一个**别人写的 S3 实现**去校验：签名对了它才收字节。
 *
 * 为什么不装 @aws-sdk 或用 MinIO
 *   · 本机**不能**再跑 `npm install`（会按当前平台 lockfile 裁剪掉 darwin-arm64 二进制，
 *     这个项目的构建已经因此坏过一次）。所以 SDK 这条路是关着的。
 *   · Docker Hub 在本环境不可达（`pull access denied`），MinIO 容器起不来。
 *   · 因此用纯 JS 的 `s3rver`，并且**装在项目之外的目录**（/tmp），
 *     通过 S3RVER_MODULE 指过来 —— 项目的 node_modules 一个字节都不动。
 *
 * ⚠️ 诚实标注：这验证的是 **s3rver（本地模拟）**，不是生产 bucket。
 *    换成真实 bucket 时，把 S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY_ID/
 *    S3_SECRET_ACCESS_KEY 设成真值再跑同一个脚本即可（下面的往返部分同样适用）。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// loader 在 tests/helpers 下（脚本目录里没有），路径要写对。
register('../tests/helpers/ts-alias-loader.mjs', import.meta.url);

const rbacless = await import(new URL('../server/modules/files/s3-object-storage.ts', import.meta.url).href);
const { presignS3Url, readS3Config, S3ObjectStorage } = rbacless;

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + '  ' +
    label.padEnd(64) + ' -> ' + JSON.stringify(actual) + (ok ? '' : '   expected ' + JSON.stringify(expected)));
  if (ok) pass++; else { fail++; failures.push(`${label}: got ${JSON.stringify(actual)}`); }
}
function skip(label, reason) {
  console.log('  \x1b[33mSKIP\x1b[0m  ' + label.padEnd(64) + ' -> ' + reason);
  skipped++;
}

const CFG = {
  endpoint: 'http://127.0.0.1:9200',
  region: 'us-east-1',
  bucket: 'qls-test-bucket',
  accessKeyId: 'S3RVER',
  secretAccessKey: 'S3RVER_SECRET_KEY',
};

console.log('\nS3 对象存储验证\n' + '='.repeat(80) + '\n');

// ===========================================================================
// 一、结构性断言（不依赖任何服务，永远执行）
// ===========================================================================
console.log('1) 签名与 URL 的结构（确定性、编码、排序、边界）');

const fixedNow = new Date('2026-01-02T03:04:05.000Z');
const url1 = presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow });
const url2 = presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow });
check('相同输入 → 相同 URL（确定性）', url1 === url2, true);

const parsed = new URL(url1);
check('  → 算法正确', parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
check('  → 过期时间被写入', parsed.searchParams.get('X-Amz-Expires'), '300');
check('  → 凭据范围格式正确',
  parsed.searchParams.get('X-Amz-Credential'), `${CFG.accessKeyId}/20260102/us-east-1/s3/aws4_request`);
check('  → 带签名', (parsed.searchParams.get('X-Amz-Signature') ?? '').length, 64);

// S3 的编码规则：空格必须是 %20；`!` 必须被编码（encodeURIComponent 不会编码它）
check('  → 空格编码为 %20（不是 +）', /a%20b/.test(url1), true);
check('  → `+` 被编码为 %2B', /a%20b%2Bc/.test(url1), true);
check('  → `!` 被编码为 %21（encodeURIComponent 不会）', /%21/.test(url1), true);
check('  → 未编码的原始字符不出现在路径里', /uploads\/a b/.test(url1), false);

// 规范查询串必须按 key 排序
const qi = url1.indexOf('?');
const qs = url1.slice(qi + 1, url1.indexOf('&X-Amz-Signature='));
const keys = qs.split('&').map((kv) => kv.split('=')[0]);
check('  → 规范查询串按 key 升序', keys.join(',') === [...keys].sort().join(','), true);

// 任何一个被签名的要素变化，签名都必须变
const sig = (u) => new URL(u).searchParams.get('X-Amz-Signature');
check('  → 换对象键 → 签名不同',
  sig(presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'x.pdf', ttlSeconds: 300, now: fixedNow })) !== sig(url1), true);
check('  → 换方法（GET→PUT）→ 签名不同',
  sig(presignS3Url(CFG, { method: 'PUT', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow })) !== sig(url1), true);
check('  → 换 TTL → 签名不同',
  sig(presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 301, now: fixedNow })) !== sig(url1), true);
check('  → 换密钥 → 签名不同',
  sig(presignS3Url({ ...CFG, secretAccessKey: 'other' }, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow })) !== sig(url1), true);
check('  → 换区域 → 签名不同',
  sig(presignS3Url({ ...CFG, region: 'eu-west-1' }, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow })) !== sig(url1), true);

// TTL 边界：夹到 [1, 7 天]
check('  → TTL 下限夹到 1 秒',
  new URL(presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'x', ttlSeconds: 0 })).searchParams.get('X-Amz-Expires'), '1');
check('  → TTL 上限夹到 7 天',
  new URL(presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'x', ttlSeconds: 999999 })).searchParams.get('X-Amz-Expires'), String(7 * 24 * 3600));

// 会话令牌必须参与签名（否则用了 STS 临时凭据就会 403）
const withToken = presignS3Url({ ...CFG, sessionToken: 'TOKEN123' }, { method: 'GET', bucketId: CFG.bucket, filePath: 'uploads/a b+c!d.pdf', ttlSeconds: 300, now: fixedNow });
check('  → 带会话令牌时 URL 里包含 X-Amz-Security-Token',
  new URL(withToken).searchParams.get('X-Amz-Security-Token'), 'TOKEN123');
check('  → 会话令牌参与签名（签名与不带令牌时不同）', sig(withToken) !== sig(url1), true);

// 配置读取：缺项一律返回 null，不猜默认凭据
check('readS3Config 缺 bucket → null', readS3Config({ S3_ENDPOINT: 'http://x', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }), null);
check('readS3Config 齐全 → 有值',
  readS3Config({ S3_ENDPOINT: 'http://x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' })?.bucket, 'b');

// bucket 不匹配必须拒绝（否则就是拿 A 桶凭据给 B 桶签名）
const backend = new S3ObjectStorage(CFG);
let mismatch = null;
try {
  await backend.createSignedUrl({ bucketId: 'some-other-bucket', filePath: 'x', ttlSeconds: 60 });
} catch (e) {
  mismatch = e?.getResponse?.()?.code ?? e?.response?.code ?? 'threw';
}
check('bucket 不匹配 → 拒绝签名', mismatch, 'STORAGE_UNAVAILABLE');

// ===========================================================================
// 二、签名有效性的交叉校验 —— **未完成，如实记录**
//
// 我试过用独立实现（`aws4`，AWS SDK v2 内部那份）对同一组输入签名再比对，
// **没有成功**：`aws4` 的预签名入口始终用它自己的时钟与默认过期时间
// （实测它输出 `X-Amz-Date=2026…` 而我传的是 2026-03-04，`X-Amz-Expires` 也恒为 86400），
// 于是两边根本没在签同一个输入 —— 这是**我的比对脚手架的问题**，
// 不能据此说签名错了，也**不能**据此说签名对了。
//
// 因此签名正确性目前**没有**被我验证过。已知的证据只有：
//   · 结构断言（规范查询串排序、S3 的编码规则、HMAC 链的确定性，见第 1 节）；
//   · 真实字节往返（第 3 节）—— 但 s3rver 自己的源码写着
//     「Currently only S3 (V2) signatures are fully supported.
//      V4 signatures have incomplete support.」，
//     它**不校验 V4 签名**，所以"PUT 被接受"证明的是链路可用，不是签名正确。
//
// 要真正验证签名，需要一个**严格校验 V4 的** S3 端点（真实 bucket、MinIO、
// 或装了 AWS SDK 的环境）。这件事必须由部署环境提供凭据后才能做。
// ===========================================================================
console.log('\n2) 签名有效性的交叉校验');
skip(
  '与独立实现交叉比对签名',
  '比对脚手架未能对齐时间戳/过期时间（aws4 用自己的时钟），因此本次**未验证签名正确性**；' +
    '需要严格校验 V4 的 S3 端点才能验证',
);

// ===========================================================================
// 三、真实字节往返（需要 s3rver；没有就**大声跳过**，不假装通过）
// ===========================================================================
console.log('\n3) 真实字节往返（预签名 PUT 上传 → 预签名 GET 下载 → 逐字节比对）');

const modulePath = process.env.S3RVER_MODULE || '';
if (!modulePath) {
  skip('真实字节往返', '未设置 S3RVER_MODULE；本环境 Docker Hub 不可达，无法起 MinIO。' +
    '设成 s3rver 的路径即可执行（例如 S3RVER_MODULE=/tmp/qls-s3server/node_modules/s3rver）');
} else {
  // S3RVER_MODULE 可以指向包目录，也可以直接指向入口文件 ——
  // 目录形式的动态 import 在 ESM 下不被支持（ERR_UNSUPPORTED_DIR_IMPORT），
  // 所以这里用 createRequire 做一次正常解析，而不是让调用方去猜 lib/s3rver.js。
  const { createRequire } = await import('node:module');
  const { existsSync, statSync } = await import('node:fs');
  const entry = existsSync(modulePath) && statSync(modulePath).isDirectory()
    ? createRequire(`${modulePath}/`).resolve('s3rver')
    : modulePath;
  const s3rverMod = await import(pathToFileURL(entry).href);
  const S3rver = s3rverMod.default ?? s3rverMod.S3rver;
  const dataDir = `${process.env.TMPDIR || '/tmp'}/qls-s3rver-${Date.now()}`;
  // 端口不能写死：写完就撞上一次"上一轮留下的 s3rver 还占着 9200"，
  // 表现为 EADDRINUSE 的门禁失败 —— 那是环境问题，却长得像代码问题。
  // 依次尝试若干端口，第一个能起来的就用它，并让 CFG.endpoint 跟着走。
  let started = null;
  let lastErr = null;
  for (const port of [9200, 9201, 9202, 9203, 9204]) {
    const tryServer = new S3rver({
      port, address: '127.0.0.1', silent: true,
      directory: dataDir,
      configureBuckets: [{ name: CFG.bucket }],
    });
    try {
      await tryServer.run();
      started = tryServer;
      CFG.endpoint = `http://127.0.0.1:${port}`;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!started) {
    throw new Error(`无法在 9200-9204 起本地 S3 模拟服务：${lastErr?.message}`);
  }
  const server = started;
  console.log(`        （本地 s3rver 已起：${CFG.endpoint}，bucket=${CFG.bucket}；数据目录 ${dataDir}）`);

  try {
    // ---- 中文文件名 + 空格 + 特殊字符：真正会踩编码坑的用例 ----
    const key = 'uploads/2026/周次教案 第1周 (v2)!+.pdf';
    const payload = Buffer.from('%PDF-1.7\n' + '这是一份真实字节内容 —— 用于验证签名与传输\n'.repeat(40), 'utf8');

    const putUrl = presignS3Url(CFG, { method: 'PUT', bucketId: CFG.bucket, filePath: key, ttlSeconds: 300 });
    const putRes = await fetch(putUrl, { method: 'PUT', body: payload });
    check('预签名 PUT 被 S3 接受（链路可用；注意 s3rver 不校验 V4 签名）', putRes.status, 200);

    const getUrl = presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: key, ttlSeconds: 300 });
    const getRes = await fetch(getUrl);
    check('预签名 GET 被 S3 接受（同上）', getRes.status, 200);
    const got = Buffer.from(await getRes.arrayBuffer());
    check('  下载字节与上传字节**逐字节一致**', got.equals(payload), true);
    check('  长度一致', `${got.length}/${payload.length}`, `${payload.length}/${payload.length}`);

    // ---- 篡改签名 ----
    // 实测：s3rver **接受**被篡改的签名。这不是我的签名有问题，而是 s3rver 的
    // 已知限制（其源码注释：V4 支持不完整，实际不校验 V4 的 HMAC）。
    // 所以这一条**不能**当成通过，也不能当成失败 —— 它在本环境无法判定。
    const tampered = putUrl.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=deadbeef');
    const tamperRes = await fetch(tampered, { method: 'PUT', body: payload });
    skip(
      '篡改签名被拒（服务端确实校验签名）',
      `本环境用 s3rver，它不校验 V4 签名（实测篡改后仍返回 ${tamperRes.status}）；` +
        '需要一个严格校验 V4 的端点才能判定',
    );

    // ---- 过期时间真的生效 ----
    const expired = presignS3Url(CFG, {
      method: 'GET', bucketId: CFG.bucket, filePath: key, ttlSeconds: 1,
      now: new Date(Date.now() - 60_000),
    });
    const expRes = await fetch(expired);
    check('已过期的预签名 URL → 被拒绝', expRes.status !== 200, true);

    // ---- 不存在的对象 → 404（而不是 200 空内容）----
    const missing = await fetch(presignS3Url(CFG, { method: 'GET', bucketId: CFG.bucket, filePath: 'nope.pdf', ttlSeconds: 60 }));
    check('不存在的对象 → 404', missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log('\n' + '='.repeat(80));
console.log(`S3 存储验证：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过   pass=${pass} fail=${fail} skipped=${skipped}`);
if (skipped > 0) console.log('  ⚠️  有 ' + skipped + ' 项被显式跳过（它们**不算通过**）。');
if (fail > 0) { console.log('\n失败明细：'); for (const f of failures) console.log('  * ' + f); process.exit(1); }
