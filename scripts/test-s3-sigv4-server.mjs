/**
 * scripts/test-s3-sigv4-server.mjs —— 一个**真正校验 AWS SigV4 签名**的 S3 兼容测试后端。
 *
 *   S3_SIGV4_PORT=9300 S3_SIGV4_BUCKET=… S3_SIGV4_ACCESS_KEY=… S3_SIGV4_SECRET=… \
 *     node scripts/test-s3-sigv4-server.mjs
 *
 * 为什么不能继续用 s3rver
 * ----------------------
 * `s3rver` **不校验 V4 签名**（它自己的文档写明 "V4 signatures have incomplete
 * support"）。于是"PUT 被接受"这件事**完全不能证明签名是对的** —— 一个把
 * canonical request 拼错、签名算错的实现，在 s3rver 上照样 200 通过。
 * 这对本项目是致命的：客户端直传完全依赖预签名 URL，签名错了要么传不上去，
 * 要么（更糟）在真实 bucket 上表现为无法解释的 403。
 *
 * 这个后端按 AWS 文档**从零重算**签名，并在每一层独立拒绝：
 *   1. `X-Amz-Algorithm` 必须是 AWS4-HMAC-SHA256；
 *   2. `X-Amz-Credential` 里的 AccessKeyId 必须匹配 —— 否则 InvalidAccessKeyId；
 *   3. credential scope 必须自洽（date 与 X-Amz-Date 同日、region/service 匹配）；
 *   4. **必须未过期**（X-Amz-Date + X-Amz-Expires >= now）；
 *   5. 重算 canonical request → stringToSign → 签名，与实际值**定长比较**。
 *
 * 因此任何一处被改动（对象键、过期时间、bucket、密钥）都会在签名这一层暴露，
 * 而不是被"宽容地"接受。
 *
 * 它只用于验证，**不是生产代码**：数据在内存里、没有鉴权以外的任何功能。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.S3_SIGV4_PORT || 9300);
const BUCKET = process.env.S3_SIGV4_BUCKET || 'qls-sigv4-bucket';
const ACCESS_KEY_ID = process.env.S3_SIGV4_ACCESS_KEY || 'SIGV4TESTKEY';
const SECRET_ACCESS_KEY = process.env.S3_SIGV4_SECRET || 'sigv4-test-secret';
const REGION = process.env.S3_SIGV4_REGION || 'us-east-1';
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (d) => createHash('sha256').update(d, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/** S3 的 URI 编码：保留 -_.~，空格必须是 %20。 */
const s3Encode = (v) =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 内存对象存储：`${bucket}/${key}` → Buffer。 */
const objects = new Map();

function xmlError(code, message, status) {
  return {
    status,
    body:
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code>` +
      `<Message>${message}</Message></Error>`,
  };
}

/**
 * 校验一个请求的 SigV4 签名。返回 `{ ok: true }` 或 `{ ok: false, ...xmlError }`。
 *
 * 每一步失败都返回**不同的 S3 错误码**，测试因此可以断言"因为哪个原因被拒"，
 * 而不是只断言"403 了"——后者无法区分"签名算错"和"过期"。
 */
function verifySignature(method, rawPath, query, host, nowSeconds) {
  if (query.get('X-Amz-Algorithm') !== ALGORITHM) {
    return xmlError('InvalidRequest', 'unsupported X-Amz-Algorithm', 400);
  }

  const credential = query.get('X-Amz-Credential') ?? '';
  const amzDate = query.get('X-Amz-Date') ?? '';
  const expiresRaw = query.get('X-Amz-Expires') ?? '';
  const signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
  const providedSignature = query.get('X-Amz-Signature') ?? '';

  if (!credential || !amzDate || !expiresRaw || !providedSignature) {
    return xmlError('AuthorizationQueryParametersError', 'missing required X-Amz-* parameter', 400);
  }

  // 2) 凭据：AccessKeyId 必须匹配。
  //
  // `X-Amz-Credential` 形如 `<key>/<date>/<region>/<service>/aws4_request`。
  // 必须**按全部段**拆开 —— 第一版写成 `const [key, scope] = credential.split('/')`，
  // 于是 scope 只拿到了日期那一段，region/service 全是 undefined，
  // 每个请求都被判成 "invalid credential scope"，连正确的 PUT 都过不去。
  const credParts = credential.split('/');
  const providedKey = credParts[0];
  const scopeDate = credParts[1];
  const scopeRegion = credParts[2];
  const scopeService = credParts[3];
  const scopeTerminator = credParts[4];
  const scope = credParts.slice(1).join('/');
  if (providedKey !== ACCESS_KEY_ID) {
    return xmlError('InvalidAccessKeyId', 'the access key id you provided does not exist', 403);
  }
  // 3) credential scope 必须自洽。
  if (scopeTerminator !== 'aws4_request' || scopeService !== SERVICE) {
    return xmlError('AuthorizationQueryParametersError', 'invalid credential scope', 400);
  }
  if (scopeRegion !== REGION) {
    return xmlError('AuthorizationQueryParametersError', `wrong region in scope: ${scopeRegion}`, 400);
  }
  if (amzDate.slice(0, 8) !== scopeDate) {
    return xmlError('AuthorizationQueryParametersError', 'scope date does not match X-Amz-Date', 400);
  }

  // 4) 过期：签名**有效**但超时也必须拒绝 —— 这正是"过期签名"用例要证明的。
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires <= 0) {
    return xmlError('AuthorizationQueryParametersError', 'invalid X-Amz-Expires', 400);
  }
  const signedAt = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  ) / 1000;
  if (!Number.isFinite(signedAt)) {
    return xmlError('AuthorizationQueryParametersError', 'unparseable X-Amz-Date', 400);
  }
  if (signedAt + expires < nowSeconds) {
    return xmlError('AccessDenied', 'Request has expired', 403);
  }

  // 5) 重算签名。
  const canonicalUri = rawPath;
  const canonicalQuery = [...query.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [s3Encode(k), s3Encode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${SECRET_ACCESS_KEY}`, scopeDate);
  const kRegion = hmac(kDate, scopeRegion);
  const kService = hmac(kRegion, scopeService);
  const kSigning = hmac(kService, 'aws4_request');
  const expected = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const a = Buffer.from(providedSignature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // 诊断信息留在服务端日志里（含 canonicalRequest 的哈希，便于对照），
    // 但**不回给客户端** —— 真实 S3 也不会泄漏这些。
    return xmlError('SignatureDoesNotMatch', 'the request signature we calculated does not match', 403);
  }

  return { ok: true };
}

/**
 * 最小权限 CORS —— 只允许**一个**来源，只开放实际用到的方法与请求头。
 *
 * 为什么测试后端也必须有 CORS：浏览器直传是**跨域** PUT，没有 CORS 时
 * 浏览器会在预检阶段就拦掉，页面只看到 `Failed to fetch`，而服务端一行日志都没有。
 * 实测就是如此（upload-web 在该模式下 4 条断言失败）。
 * 这也正是 §5 要求生产 bucket 必须配的策略 —— 这里按同样的最小权限写，
 * 而不是图省事写 `*`（`S3_SIGV4_ALLOWED_ORIGIN` 可覆盖，默认就是应用来源）。
 */
const ALLOWED_ORIGIN = process.env.S3_SIGV4_ALLOWED_ORIGIN || 'http://127.0.0.1:3200';
const ALLOWED_METHODS = 'GET, PUT, HEAD';

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
  res.setHeader('Access-Control-Max-Age', '3000');
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawPath = url.pathname;
  const nowSeconds = Math.floor(Date.now() / 1000);

  applyCors(req, res);

  // 预检**不携带签名**（浏览器不可能签），所以必须在验签之前应答 ——
  // 真实 S3 同样如此。顺序写反的话，预检会被判成"缺 X-Amz-* 参数"而 400。
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const verdict = verifySignature(req.method, rawPath, url.searchParams, req.headers.host, nowSeconds);
  if (!verdict.ok) {
    res.writeHead(verdict.status, { 'content-type': 'application/xml' });
    res.end(verdict.body);
    return;
  }

  // 路径式寻址：/{bucket}/{key...}
  const segments = rawPath.replace(/^\/+/, '').split('/');
  const bucket = decodeURIComponent(segments.shift() ?? '');
  const key = segments.map(decodeURIComponent).join('/');

  if (bucket !== BUCKET) {
    // 注意：bucket 也在 canonical URI 里，改 bucket 通常**先**在签名那一层就失败。
    // 能走到这里说明签名与请求一致、但桶名不是本服务承载的那个。
    res.writeHead(404, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code></Error>');
    return;
  }

  const storeKey = `${bucket}/${key}`;

  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      objects.set(storeKey, Buffer.concat(chunks));
      res.writeHead(200, { etag: `"${sha256Hex(storeKey).slice(0, 32)}"` });
      res.end();
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const body = objects.get(storeKey);
    if (!body) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `sigv4-verifying S3 test backend on http://127.0.0.1:${PORT} ` +
      `bucket=${BUCKET} region=${REGION} key=${ACCESS_KEY_ID}（**真的重算签名并校验过期**）`,
  );
});
