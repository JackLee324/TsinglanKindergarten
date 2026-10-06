#!/usr/bin/env node
/**
 * scripts/apply-bucket-cors.mjs —— 把 §5 的**最小权限 CORS 策略**应用到对象存储桶。
 *
 * 为什么需要这个脚本
 * ------------------
 * 生产实测（`scripts/verify-prod-browser-upload.mjs`）显示浏览器直传**失败**：
 *
 *     预检响应 status=403   CORS 响应头={}
 *     corsErrorStatus = PreflightMissingAllowOriginHeader
 *
 * 也就是"老师点保存草稿传不上去"。修它需要**桶管理权限**，而应用运行时的
 * S3 凭据**故意**没有这个权限（`GetBucketCors` → 403 AccessDenied）——
 * 这是正确的最小权限，不应该为了好修而放宽它。
 *
 * 所以把这一步做成一个独立脚本：由持桶管理凭据的运维执行。它做了三件
 * 让这一步不容易出错的事：
 *
 *   1. **默认 dry-run**：不加 `--apply` 只读取现状并打印将要应用的 XML，不改任何东西。
 *   2. **通配符 origin 一律拒绝**：`*` 在代码里就是硬失败，不是文档里的一句要求。
 *      预签名 URL 本身是有时效的凭据；把来源放开成 `*`，等于允许任意站点
 *      把拿到的直传地址用在自己的页面上。
 *   3. **应用后立刻回读校验**：打印服务端实际保存的策略，而不是"我以为写进去了"。
 *
 * 用法
 * ----
 *   # 1) 只看现状（只读，无需写权限）
 *   S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
 *   CORS_ALLOWED_ORIGIN=https://tsinglankindergarten.zeabur.app \
 *     node scripts/apply-bucket-cors.mjs
 *
 *   # 2) 真正应用（需要桶管理权限，且必须显式确认）
 *   … CONFIRM_APPLY_BUCKET_CORS=yes node scripts/apply-bucket-cors.mjs --apply
 *
 *   # 3) 回到生产验证直传是否真的通了（幂等）
 *   PROD_BASE_URL=… PROD_ADMIN_CREDENTIALS=… ALLOW_PROD_WRITE=1 \
 *     node scripts/verify-prod-browser-upload.mjs
 *
 * 这份策略与 `DEPLOYMENT_PRODUCTION.md` §2.5 是**同一份内容**：
 * 改一处必须改另一处，否则文档与代码会各说一套。
 */

import { createHash, createHmac } from 'node:crypto';

const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/$/, '');
const bucket = process.env.S3_BUCKET || '';
const accessKeyId = process.env.S3_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';
const region = process.env.S3_REGION || 'auto';
const sessionToken = process.env.S3_SESSION_TOKEN || '';
const origin = (process.env.CORS_ALLOWED_ORIGIN || '').trim();
const apply = process.argv.includes('--apply');

const problems = [];
if (!endpoint) problems.push('S3_ENDPOINT');
if (!bucket) problems.push('S3_BUCKET');
if (!accessKeyId) problems.push('S3_ACCESS_KEY_ID');
if (!secretAccessKey) problems.push('S3_SECRET_ACCESS_KEY');
if (!origin) problems.push('CORS_ALLOWED_ORIGIN');
if (problems.length > 0) {
  console.error(`缺少必要环境变量：${problems.join(', ')}`);
  process.exit(2);
}

// ── 通配符 origin 是硬失败，不是警告 ──────────────────────────────────────
// 这一段是 §5「禁止 wildcard origin」的**代码化**：写在这里就不可能被
// "临时放一下"绕过，因为脚本直接拒绝执行。
if (origin.includes('*')) {
  console.error(
    `拒绝执行：CORS_ALLOWED_ORIGIN="${origin}" 含通配符。\n` +
      '预签名 URL 是有时效的凭据；把来源放开成 * 等于允许任意站点复用直传地址。\n' +
      '请填**具体的站点 origin**，例如 https://tsinglankindergarten.zeabur.app',
  );
  process.exit(2);
}
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  console.error(
    `拒绝执行：CORS_ALLOWED_ORIGIN="${origin}" 不是裸 origin。\n` +
      'origin 形如 scheme://host[:port]，**不带路径**（带路径的 origin 在预检里永远匹配不上）。',
  );
  process.exit(2);
}
if (apply && process.env.CONFIRM_APPLY_BUCKET_CORS !== 'yes') {
  console.error(
    '要真正修改桶策略，必须显式设置 CONFIRM_APPLY_BUCKET_CORS=yes。\n' +
      '（默认 dry-run：只读取现状并打印将要应用的策略。）',
  );
  process.exit(2);
}

/**
 * 与 DEPLOYMENT_PRODUCTION.md §2.5 一致的最小权限策略。
 *   ALLOWED_METHODS：PUT 浏览器直传 / GET 跟随签名直链下载 / HEAD 探测
 *   ALLOWED_HEADERS：仅 content-type（`putFileBytes` 只会带这一个自定义头）
 *                   注意预签名 URL 只签 host，content-type 不参与签名，
 *                   所以放开它不会破坏签名校验。
 *   EXPOSE_HEADERS：ETag，便于前端做完整性/去重校验；不暴露其它响应头。
 */
const ALLOWED_METHODS = ['PUT', 'GET', 'HEAD'];
const ALLOWED_HEADERS = ['content-type'];
const EXPOSE_HEADERS = ['ETag'];
const MAX_AGE_SECONDS = 3000;

const corsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>${origin}</AllowedOrigin>
${ALLOWED_METHODS.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`).join('\n')}
${ALLOWED_HEADERS.map((h) => `    <AllowedHeader>${h}</AllowedHeader>`).join('\n')}
${EXPOSE_HEADERS.map((h) => `    <ExposeHeader>${h}</ExposeHeader>`).join('\n')}
    <MaxAgeSeconds>${MAX_AGE_SECONDS}</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
`;

// ── 自己的 SigV4 签名（控制面请求）────────────────────────────────────────
// 仓库里那份 `s3-object-storage.ts` 是**预签名 GET/PUT** 用的，签名对象是
// 对象路径；控制面请求（GET/PUT ?cors）要另签，且要带 body 哈希。
// 这里保持独立实现，不去改动生产代码路径。
const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

function sign(method, canonicalUri, canonicalQuery, payload) {
  const host = new URL(endpoint).host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(payload);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');
  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const uri = `/${bucket}`;

async function getCors() {
  const headers = sign('GET', uri, 'cors=', '');
  let r;
  try {
    r = await fetch(`${endpoint}${uri}?cors=`, { method: 'GET', headers });
  } catch (error) {
    // 网络/DNS 失败不是"策略有问题"。作为运维脚本，报错要能一眼区分
    // "凭据不对"与"根本连不上"，否则会把人引向错误的排查方向。
    throw new Error(
      `连不上 ${endpoint}：${error?.cause?.message ?? error?.message}。` +
        '请先确认 S3_ENDPOINT 可达、DNS 能解析、出网没被拦。',
    );
  }
  const body = await r.text();
  return { status: r.status, body };
}

console.log(`\n=== bucket CORS（${endpoint} / ${bucket}）===`);
console.log(`允许的来源：${origin}`);
console.log(`允许的方法：${ALLOWED_METHODS.join(', ')}`);
console.log(`允许的请求头：${ALLOWED_HEADERS.join(', ')}（仅这些；不用 *）`);
console.log(`暴露的响应头：${EXPOSE_HEADERS.join(', ')}`);
console.log(`模式：${apply ? '**APPLY（会修改桶策略）**' : 'dry-run（只读）'}\n`);

console.log('--- 当前策略 ---');
let current;
try {
  current = await getCors();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
if (current.status === 200) {
  console.log(current.body);
} else if (current.status === 403) {
  console.log(
    `GetBucketCors -> 403 AccessDenied\n` +
      '  说明这组凭据**没有桶管理权限** —— 如果它就是应用的运行时凭据，这是**正确的最小权限**，\n' +
      '  请换一组有桶配置权限的凭据来跑这个脚本（不要为了省事去放宽应用的凭据）。',
  );
} else if (current.status === 404 || /NoSuchCORSConfiguration/i.test(current.body)) {
  console.log('**当前桶上没有任何 CORS 配置**（NoSuchCORSConfiguration）—— 这正是浏览器直传失败的原因。');
} else {
  console.log(`HTTP ${current.status}：${current.body.slice(0, 300)}`);
}

console.log('\n--- 将要应用的策略 ---');
console.log(corsXml);

if (!apply) {
  console.log('（dry-run 结束，未做任何修改。要应用请加 --apply 并设 CONFIRM_APPLY_BUCKET_CORS=yes）');
  process.exit(0);
}

console.log('--- 应用 ---');
const putHeaders = sign('PUT', uri, 'cors=', corsXml);
let put;
try {
  put = await fetch(`${endpoint}${uri}?cors=`, {
    method: 'PUT',
    headers: { ...putHeaders, 'content-type': 'application/xml' },
    body: corsXml,
  });
} catch (error) {
  console.error(`PutBucketCors 请求失败：${error?.cause?.message ?? error?.message}`);
  process.exit(1);
}
const putBody = await put.text();
if (put.status === 200 || put.status === 204) {
  console.log(`PutBucketCors -> ${put.status} OK`);
} else {
  console.error(`PutBucketCors -> ${put.status} ${putBody.slice(0, 300)}`);
  process.exit(1);
}

// 回读校验：不信任"我以为写进去了"。
console.log('\n--- 回读校验（服务端实际保存的策略）---');
const after = await getCors();
if (after.status === 200 && after.body.includes(origin)) {
  console.log(after.body);
  console.log(`\n✅ 策略已生效，且包含来源 ${origin}。`);
  console.log('   下一步（幂等，会写生产但自带清理）：');
  console.log('     PROD_BASE_URL=… PROD_ADMIN_CREDENTIALS=… ALLOW_PROD_WRITE=1 \\');
  console.log('       node scripts/verify-prod-browser-upload.mjs');
} else {
  console.error(`回读失败：HTTP ${after.status}\n${after.body.slice(0, 300)}`);
  process.exit(1);
}
