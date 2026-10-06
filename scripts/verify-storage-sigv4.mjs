/**
 * scripts/verify-storage-sigv4.mjs —— 用**真正校验 AWS SigV4** 的后端验收预签名 URL（§4）。
 *
 *   起后端：node scripts/test-s3-sigv4-server.mjs        （自带重算签名 + 过期校验）
 *   跑本套件：node scripts/verify-storage-sigv4.mjs
 *
 * 为什么必须有这一套
 * ------------------
 * 之前用的是 `s3rver`，而它**不校验 V4 签名**（其源码自述）。
 * 于是"PUT 返回 200"这件事**完全不能证明签名是对的** —— canonical request 拼错、
 * 签名算错的实现，在 s3rver 上照样通过。
 *
 * 本套件覆盖用户点名的 8 个用例，只有**真实签名校验通过**才标 PASS：
 *   1. 正确 PUT presigned URL
 *   2. 正确 GET / download
 *   3. 错误签名
 *   4. 过期签名
 *   5. 篡改 object key
 *   6. 篡改 expiry
 *   7. 错误 bucket
 *   8. 错误 credentials
 *
 * 另外做两件"防止自己骗自己"的事
 * ------------------------------
 *   A. **独立实现交叉验证**：用第三方库 `aws4` 对同一个请求独立算一遍签名，
 *      与后端算出来的比对。如果两边一致，说明 canonicalization 没有"我和我自己
 *      达成一致"的偏差。（`aws4` 只在安装了的环境里可用，缺失时**大声跳过**。）
 *   B. **走应用的真实链路**：不是只造 URL 手工试，而是让应用自己
 *      `POST /api/resources/:id/upload-url` 签发、用它 PUT、再通过应用的两跳
 *      签名下载取回，逐字节比对。这才是"应用签出来的 URL 真的能被严格后端接受"。
 */
import { createHash, createHmac } from 'node:crypto';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const S3 = process.env.S3_SIGV4_ENDPOINT || 'http://127.0.0.1:9300';
const BUCKET = process.env.S3_SIGV4_BUCKET || 'qls-sigv4-bucket';
const ACCESS_KEY_ID = process.env.S3_SIGV4_ACCESS_KEY || 'SIGV4TESTKEY';
const SECRET = process.env.S3_SIGV4_SECRET || 'sigv4-test-secret';
const REGION = process.env.S3_SIGV4_REGION || 'us-east-1';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${label}  -> ${reason}`); SKIPPED++; };

// ---- 本地签名器（用于造"签名有效但内容不对"的 URL）-----------------------
// 它只服务于**反向用例**：要证明后端拒绝"过期/篡改"，必须先造出一个
// **签名本身算对、但某处被改过**的 URL，否则测的就只是"签名错了"这一件事。
const ALGORITHM = 'AWS4-HMAC-SHA256';
const s3Encode = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256Hex = (d) => createHash('sha256').update(d, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

function presign({ method, bucket, key, secret = SECRET, accessKeyId = ACCESS_KEY_ID, at = new Date(), ttl = 900 }) {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const host = new URL(S3).host;
  const canonicalUri = `/${s3Encode(bucket)}/${key.split('/').map(s3Encode).join('/')}`;
  const query = new Map([
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttl)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [s3Encode(k), s3Encode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), REGION), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    url: `${S3}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** 取 S3 风格的错误码（后端返回 XML）。 */
async function errCodeOf(res) {
  const text = await res.text().catch(() => '');
  const m = /<Code>([^<]+)<\/Code>/.exec(text);
  return m ? m[1] : `(无 Code) ${text.slice(0, 80)}`;
}

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b), redirect: 'manual' });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空 */ }
    return { s: r.status, d, location: r.headers.get('location') };
  }
  const rawGet = (u) => fetch(u, { headers: { cookie: cookie() }, redirect: 'manual' });
  return { req, rawGet };
}

async function main() {
  const payload = Buffer.from(`SigV4 校验载荷 ${Date.now()}\n`, 'utf8');
  const probeKey = `sigv4-probe/${Date.now()}.pdf`;

  console.log(`\n=== SigV4 预签名验收（后端 ${S3}；应用 ${BASE}）===`);
  console.log('（该后端**从零重算签名**并独立校验过期；不是 s3rver 那种"只看形状"的实现）\n');

  // ---- 后端可用性 ----
  const alive = await fetch(`${S3}/${BUCKET}/health-probe`).then(() => true).catch(() => false);
  if (!alive) {
    console.error(`后端不可达：${S3}。请先起 node scripts/test-s3-sigv4-server.mjs`);
    process.exit(2);
  }

  // ---- A. 独立实现交叉验证 ------------------------------------------------
  console.log('A) 独立实现交叉验证（第三方 aws4）');
  // 指向包**入口文件**（main=aws4.js）而不是目录：ESM 的 import() 不接受目录路径，
  // 第一版就是因为这个把"库其实装了"误报成"找不到第三方实现"。
  const aws4Module =
    process.env.AWS4_MODULE || '/tmp/qls-s3server/node_modules/aws4/aws4.js';
  let aws4 = null;
  try {
    const mod = await import(aws4Module);
    aws4 = mod.default ?? mod;
  } catch (e) {
    aws4 = null;
    console.log(`      （导入 aws4 失败：${e?.message}）`);
  }
  if (!aws4) {
    skip('用 aws4 独立复算同一请求的签名', `未找到第三方实现（${aws4Module}），无法交叉验证`);
  } else {
    // 思路：让 **aws4 自己签**一个 PUT URL，再把它交给我们的校验后端。
    //
    // 为什么不逐字节比签名：aws4 的 `signQuery` 是自己取当前时间生成 X-Amz-Date 的，
    // 要逐字比对就得锁时钟（很脆）。而"**第三方签出来的 URL 能被我们的后端接受**"
    // 才是我们真正需要的结论 —— 它证明两边的 canonicalization 一致，
    // 排除了"我的签名器和我的校验器共享同一个 bug、自己和自己达成一致"。
    //
    // 注意 `signQuery` 属于**请求对象**而不是第二个参数（第一次传错位置，
    // 于是 aws4 悄悄退回去签 Authorization 头，签名自然是 null）。
    const aws4Key = `sigv4-crosscheck/${Date.now()}.pdf`;
    const aws4Path = `/${BUCKET}/${aws4Key.split('/').map(s3Encode).join('/')}`;
    const signed = aws4.sign(
      {
        host: new URL(S3).host,
        path: aws4Path,
        method: 'PUT',
        service: 's3',
        region: REGION,
        signQuery: true,
      },
      { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
    );
    const aws4Url = `${S3}${signed.path}`;
    const aws4Sig = new URL(aws4Url).searchParams.get('X-Amz-Signature');
    if (!aws4Sig) {
      bad('aws4 以 signQuery 方式产出签名', String(signed.path).slice(0, 100));
    } else {
      ok('aws4（第三方实现）以 signQuery 方式产出签名', aws4Sig.slice(0, 16) + '…');
      const crossRes = await fetch(aws4Url, { method: 'PUT', body: payload });
      if (crossRes.status === 200) {
        ok('严格后端**接受 aws4 独立签出的 URL** —— 两边 canonicalization 一致', '200');
      } else {
        bad('严格后端接受 aws4 独立签出的 URL', `${crossRes.status} ${await errCodeOf(crossRes)}`);
      }
      const crossTampered = aws4Url.replace(/\.pdf/, 'tampered.pdf');
      const crossBad = await fetch(crossTampered, { method: 'PUT', body: payload });
      if (crossBad.status === 403 && (await errCodeOf(crossBad)) === 'SignatureDoesNotMatch') {
        ok('同一 URL 被篡改后立刻被拒（说明上一条不是"什么都接受"）', '403');
      } else {
        bad('同一 URL 被篡改后立刻被拒', `${crossBad.status} ${await errCodeOf(crossBad)}`);
      }
    }
  }

  // ---- 1/3/4/5/6/7/8：用本地签名器造各种"被改过"的 URL --------------------
  console.log('\n1) 正确签名的 PUT → 必须被接受');
  const good = presign({ method: 'PUT', bucket: BUCKET, key: probeKey });
  const putRes = await fetch(good.url, { method: 'PUT', body: payload });
  if (putRes.status === 200) ok('正确签名的 PUT 被接受', '200');
  else bad('正确签名的 PUT 被接受', `${putRes.status} ${await errCodeOf(putRes)}`);

  console.log('\n2) 正确签名的 GET → 必须返回原字节');
  const getGood = presign({ method: 'GET', bucket: BUCKET, key: probeKey });
  const getRes = await fetch(getGood.url);
  if (getRes.status === 200) {
    const got = Buffer.from(await getRes.arrayBuffer());
    if (got.equals(payload)) ok('GET 取回的字节与 PUT 的逐字节一致', `${got.length}B`);
    else bad('GET 取回的字节与 PUT 的逐字节一致', `${got.length}B vs ${payload.length}B`);
  } else {
    bad('正确签名的 GET 被接受', `${getRes.status} ${await errCodeOf(getRes)}`);
  }

  console.log('\n3) 错误签名 → 必须拒绝');
  const badSig = presign({ method: 'PUT', bucket: BUCKET, key: probeKey });
  const tampered = badSig.url.replace(/X-Amz-Signature=([0-9a-f]{8})/, (m, p) =>
    `X-Amz-Signature=${p.split('').reverse().join('')}`);
  const r3 = await fetch(tampered, { method: 'PUT', body: payload });
  if (r3.status === 403 && (await errCodeOf(r3)) === 'SignatureDoesNotMatch') {
    ok('错误签名被拒（SignatureDoesNotMatch）', '403');
  } else {
    bad('错误签名被拒（SignatureDoesNotMatch）', `${r3.status} ${await errCodeOf(r3)}`);
  }

  console.log('\n4) 过期签名（签名本身有效，只是超时）→ 必须拒绝');
  const expired = presign({ method: 'PUT', bucket: BUCKET, key: probeKey, at: new Date(Date.now() - 3 * 3600 * 1000), ttl: 60 });
  const r4 = await fetch(expired.url, { method: 'PUT', body: payload });
  const code4 = await errCodeOf(r4);
  if (r4.status === 403 && code4 === 'AccessDenied') {
    ok('过期签名被拒（AccessDenied: Request has expired）', '403');
  } else {
    bad('过期签名被拒（AccessDenied: Request has expired）', `${r4.status} ${code4}`);
  }

  console.log('\n5) 篡改 object key → 必须拒绝');
  const keySigned = presign({ method: 'PUT', bucket: BUCKET, key: probeKey });
  const keyTampered = keySigned.url.replace(probeKey.split('/').pop(), 'stolen.pdf');
  const r5 = await fetch(keyTampered, { method: 'PUT', body: payload });
  if (r5.status === 403 && (await errCodeOf(r5)) === 'SignatureDoesNotMatch') {
    ok('篡改对象键被拒（签名覆盖了 URI）', '403');
  } else {
    bad('篡改对象键被拒（签名覆盖了 URI）', `${r5.status} ${await errCodeOf(r5)}`);
  }

  console.log('\n6) 篡改 expiry → 必须拒绝');
  const ttlSigned = presign({ method: 'PUT', bucket: BUCKET, key: probeKey, ttl: 900 });
  const ttlTampered = ttlSigned.url.replace('X-Amz-Expires=900', 'X-Amz-Expires=86400');
  const r6 = await fetch(ttlTampered, { method: 'PUT', body: payload });
  if (r6.status === 403 && (await errCodeOf(r6)) === 'SignatureDoesNotMatch') {
    ok('篡改有效期被拒（签名覆盖了 query）', '403');
  } else {
    bad('篡改有效期被拒（签名覆盖了 query）', `${r6.status} ${await errCodeOf(r6)}`);
  }

  console.log('\n7) 错误 bucket → 必须拒绝');
  const bucketSigned = presign({ method: 'PUT', bucket: BUCKET, key: probeKey });
  const bucketTampered = bucketSigned.url.replace(`/${BUCKET}/`, '/someone-elses-bucket/');
  const r7 = await fetch(bucketTampered, { method: 'PUT', body: payload });
  const code7 = await errCodeOf(r7);
  if (r7.status === 403 && code7 === 'SignatureDoesNotMatch') {
    ok('换成别的 bucket 被拒（bucket 在签名覆盖的 URI 里）', '403');
  } else {
    bad('换成别的 bucket 被拒（bucket 在签名覆盖的 URI 里）', `${r7.status} ${code7}`);
  }

  console.log('\n8) 错误 credentials → 必须拒绝');
  const wrongKey = presign({ method: 'PUT', bucket: BUCKET, key: probeKey, secret: 'not-the-real-secret' });
  const r8 = await fetch(wrongKey.url, { method: 'PUT', body: payload });
  if (r8.status === 403 && (await errCodeOf(r8)) === 'SignatureDoesNotMatch') {
    ok('用错的 secret 签名被拒', '403');
  } else {
    bad('用错的 secret 签名被拒', `${r8.status} ${await errCodeOf(r8)}`);
  }
  const wrongAccessKey = presign({ method: 'PUT', bucket: BUCKET, key: probeKey, accessKeyId: 'SOMEONE_ELSE' });
  const r8b = await fetch(wrongAccessKey.url, { method: 'PUT', body: payload });
  if (r8b.status === 403 && (await errCodeOf(r8b)) === 'InvalidAccessKeyId') {
    ok('用错的 AccessKeyId 被拒（InvalidAccessKeyId）', '403');
  } else {
    bad('用错的 AccessKeyId 被拒（InvalidAccessKeyId）', `${r8b.status} ${await errCodeOf(r8b)}`);
  }

  // ---- B. 走应用的真实链路 ------------------------------------------------
  console.log('\nB) 应用自己签发的 URL（真实链路：upload-url → PUT → 登记 → 两跳下载）');
  const c = makeClient();
  await c.req('GET', '/');
  const login = await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
  if (login.s !== 201 && login.s !== 200) {
    bad('登录', `HTTP ${login.s}`);
  } else {
    const created = await c.req('POST', '/api/resources', {
      title: `SigV4 链路探针 ${Date.now()}`,
      program: 'prek',
      subject: 'virtue',
      folderType: 'weekly_plans',
      status: 'draft',
    });
    const rid = created.d?.id ?? created.d?.resource?.id ?? null;
    if (!rid) {
      bad('建探针资源', `HTTP ${created.s}`);
    } else {
      try {
        const body = Buffer.from('%PDF-1.4\n% sigv4 roundtrip\n%%EOF\n', 'utf8');
        const url = await c.req('POST', `/api/resources/${rid}/upload-url`, { fileName: 'sigv4.pdf' });
        if (url.s !== 201 || !url.d?.uploadUrl) {
          bad('应用签发直传地址', `HTTP ${url.s} ${JSON.stringify(url.d).slice(0, 120)}`);
        } else {
          const signedUrl = String(url.d.uploadUrl);
          if (!signedUrl.includes('X-Amz-Signature=')) {
            bad('签发的地址带 X-Amz-Signature', signedUrl.slice(0, 80));
          } else {
            ok('应用签发出带签名的直传地址');
            const put = await fetch(signedUrl, { method: 'PUT', body, headers: { 'content-type': 'application/pdf' } });
            if (put.status === 200) ok('严格后端**接受了应用签出的签名**（这一条才证明签名是对的）', '200');
            else bad('严格后端接受了应用签出的签名', `${put.status} ${await errCodeOf(put)}`);

            const reg = await c.req('POST', `/api/resources/${rid}/file`, {
              fileName: 'sigv4.pdf',
              mimeType: 'application/pdf',
              sizeBytes: body.length,
              head: body.subarray(0, 8).toString('base64'),
              fileBucketId: url.d.bucketId,
              filePath: url.d.filePath,
            });
            if (reg.s === 201) ok('登记成功', '201');
            else bad('登记成功', `HTTP ${reg.s} ${JSON.stringify(reg.d).slice(0, 160)}`);

            const dl = await c.req('GET', `/api/resources/${rid}/download`);
            if (dl.s !== 302) {
              bad('第一跳换取下载令牌', `HTTP ${dl.s}`);
            } else {
              const hop2 = await c.rawGet(new URL(String(dl.location), BASE));
              const signedDl = hop2.headers.get('location');
              if (hop2.status !== 302 || !signedDl) {
                bad('第二跳拿到签名直链', `HTTP ${hop2.status}`);
              } else {
                const got = await fetch(signedDl);
                if (got.status === 200) {
                  const bytes = Buffer.from(await got.arrayBuffer());
                  if (bytes.equals(body)) ok('严格后端签发的下载直链取回字节逐字节一致', `${bytes.length}B`);
                  else bad('逐字节一致', `${bytes.length}B vs ${body.length}B`);
                } else {
                  bad('下载直链可取回', `${got.status} ${await errCodeOf(got)}`);
                }
              }
            }
          }
        }
      } finally {
        await c.req('DELETE', `/api/resources/${rid}`);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
}

console.log('\n' + '='.repeat(78));
console.log(`SigV4 校验：${PASSED} 通过 / ${FAILED} 失败 / ${SKIPPED} 跳过   pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
