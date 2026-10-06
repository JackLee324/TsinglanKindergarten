/**
 * scripts/verify-storage-upload-flow.mjs —— **真实上传 → 登记 → 签名下载**全链路（§4/§23）。
 *
 *   S3RVER_MODULE=/path/to/node_modules/s3rver \
 *   SERVER_PORT=3200 S3_ENDPOINT=http://127.0.0.1:9200 S3_BUCKET=qls-test-bucket \
 *   S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
 *   node scripts/verify-storage-upload-flow.mjs
 *
 * 它与 verify-storage-s3.mjs 的分工：
 *   · 那个脚本验证**签名与传输**本身（直接调 presign，起本地 S3）；
 *   · 这个脚本验证**产品链路**：登录 → 建资源 → 申请直传地址 → PUT 真字节
 *     → 登记（走服务端校验）→ 用签名 URL 下载 → 逐字节比对。
 *
 * 它必须跑在一个**配置了 S3 后端**的服务端上 —— 未配置时服务端会（正确地）503，
 * 那样这一步就变成"验证了它拒绝"，所以脚本会明确检查配置并跳过而不是假通过。
 */
import { folderIdFor } from '../tests/helpers/directory-fixture.mjs';
import { purgeProbeResources } from '../tests/helpers/probe-cleanup.mjs';
const BASE = process.env.MFA_BASE || `http://127.0.0.1:${process.env.SERVER_PORT || 3200}`;
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;
const PW = process.env.SEQ_PROBE_PASSWORD || 'SeqProbe!2026x';

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  console.log('  ' + (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + '  ' +
    label.padEnd(62) + ' -> ' + JSON.stringify(actual) + (ok ? '' : '   expected ' + JSON.stringify(expected)));
  if (ok) pass++; else { fail++; failures.push(`${label}: got ${JSON.stringify(actual)}`); }
}
function skip(label, reason) { console.log('  \x1b[33mSKIP\x1b[0m  ' + label.padEnd(62) + ' -> ' + reason); skipped++; }

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    // `redirect: 'manual'` 是必须的：下载接口用 302 把调用方送到签名直链，
    // 而 fetch 默认会**自动跟随**重定向 —— 于是断言看到的会是 s3rver 的 200、
    // Location 是 null（我第一版就是这样，把"重定向正确"误报成"没重定向"）。
    const r = await fetch(BASE + p, {
      method: m, headers: h,
      body: b === undefined ? undefined : JSON.stringify(b),
      redirect: 'manual',
    });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空 */ }
    return { s: r.status, d, location: r.headers.get('location') };
  }
  /** 带会话 cookie 的裸 GET（不走 req 的 JSON 解析），用于跟随重定向。 */
  async function rawGet(url) {
    const h = {};
    if (Object.keys(jar).length) h.cookie = cookie();
    return fetch(url, { headers: h, redirect: 'manual' });
  }
  return { req, rawGet };
}

console.log(`\n真实上传 → 登记 → 签名下载 @ ${BASE}\n${'='.repeat(78)}\n`);

const c = makeClient();
await c.req('GET', '/');
const login = await c.req('POST', '/api/auth/login', { username: 'seq_principal', password: PW });
if (login.s !== 201 && login.s !== 200) { console.error(`登录失败 ${login.s}`); process.exit(2); }

let resourceId = null;
const PAYLOAD = Buffer.from(
  '%PDF-1.7\n' + '真实上传链路验证：这是一段真实字节，用来证明字节确实经过了对象存储。\n'.repeat(30),
  'utf8',
);

try {
  console.log('1) 建资源并申请直传地址');
  // §8：必须带 directoryId；§7：legacy folderType 由服务端按目录推导。
  const storageProbeDir = await folderIdFor(c, { program: 'prek', subject: 'virtue' });
  const created = await c.req('POST', '/api/resources', {
    title: `上传链路探针 ${Date.now().toString().slice(-6)}`,
    program: 'prek', subject: 'virtue', directoryId: storageProbeDir,
  });
  check('创建资源 → 201', created.s, 201);
  resourceId = created.d?.id ?? null;
  if (!resourceId) {
    // 把服务端的真实原因打出来。只说"没有 id"会让人以为服务端没返回，
    // 而实际上它返回了 400 与原因。
    throw new Error('创建响应没有 id：' + JSON.stringify(created.d));
  }

  const urlRes = await c.req('POST', `/api/resources/${resourceId}/upload-url`, { fileName: '周次教案 第1周 (v2).pdf' });
  if (urlRes.s === 503) {
    skip('申请直传地址', '服务端未配置 S3 后端（返回 503）—— 这本身是正确行为，但本脚本需要在配好 S3 的服务端上跑');
  } else {
    check('申请直传地址 → 201', urlRes.s, 201);
    const { uploadUrl, bucketId, filePath } = urlRes.d ?? {};
    check('  → 返回预签名上传地址', typeof uploadUrl === 'string' && uploadUrl.includes('X-Amz-Signature'), true);
    check('  → 对象键由服务端生成（含资源 id）', typeof filePath === 'string' && filePath.includes(resourceId), true);
    check('  → 键里带原名（清洗后）', /周次教案|_pdf|\.pdf/.test(String(filePath)), true);
    // S3_BUCKET 是**服务端**的配置；脚本自己不一定有（我第一版就是这么比的，
    // 拿到 undefined 而误报失败）。有就比对，没有就只断言非空。
    check('  → 返回 bucketId' + (process.env.S3_BUCKET ? '（与服务端配置一致）' : '（非空）'),
      process.env.S3_BUCKET ? bucketId : (typeof bucketId === 'string' && bucketId.length > 0),
      process.env.S3_BUCKET ?? true);

    console.log('\n2) 用预签名地址真的 PUT 字节');
    const put = await fetch(uploadUrl, { method: 'PUT', body: PAYLOAD });
    check('PUT 被对象存储接受', put.status, 200);

    console.log('\n3) 登记（服务端校验文件名/类型/大小/魔数）');
    const head = PAYLOAD.subarray(0, 16).toString('base64');
    const reg = await c.req('POST', `/api/resources/${resourceId}/file`, {
      fileName: '周次教案 第1周 (v2).pdf',
      mimeType: 'application/pdf',
      sizeBytes: PAYLOAD.length,
      head,
      fileBucketId: bucketId,
      filePath,
    });
    check('登记 → 201', reg.s, 201);
    check('  → 行里标记为有文件', reg.d?.hasFile, true);

    console.log('\n4) 签名下载并逐字节比对');
    // 下载是**两跳**：
    //   GET /api/resources/:id/download      → 302 /api/files/download?token=…（应用自己的短期令牌）
    //   GET /api/files/download?token=…      → 302 对象存储签名直链
    // 第一跳是相对路径，必须相对 BASE 解析 —— 我第一版直接 fetch(location)，拿到的是
    // 相对路径，undici 直接报 Invalid URL。
    const dl = await c.req('GET', `/api/resources/${resourceId}/download`);
    check('第一跳：换取下载令牌 → 302', dl.s, 302);
    check('  → Location 里没有 bucket= / path= 泄露', /bucket=|path=/.test(String(dl.location)), false);
    check('  → Location 指向应用自己的令牌端点',
      String(dl.location).startsWith('/api/files/download?token='), true);

    // 必须带上会话 cookie：令牌端点会把令牌**绑定到调用方账号**，
    // 不带会话就是一个 401（我第一版用裸 fetch，于是把"令牌绑定正确"误报成"第二跳失败"）。
    const hop2 = await c.rawGet(new URL(String(dl.location), BASE));
    check('第二跳：令牌端点 → 302 签名直链', hop2.status, 302);
    const signedUrl = hop2.headers.get('location');
    check('  → 第二跳是对象存储的签名地址',
      /X-Amz-Signature=/.test(String(signedUrl)), true);

    const got = await fetch(signedUrl);
    check('从签名直链取回字节 → 200', got.status, 200);
    const bytes = Buffer.from(await got.arrayBuffer());
    check('  → 与上传的字节**逐字节一致**', bytes.equals(PAYLOAD), true);
    check('  → 长度一致', `${bytes.length}/${PAYLOAD.length}`, `${PAYLOAD.length}/${PAYLOAD.length}`);

    console.log('\n5) 版本历史（§15 与上传的联动）');
    const versions = await c.req('GET', `/api/resources/${resourceId}/versions`);
    check('版本历史 → 200', versions.s, 200);
    check('  → 至少 2 个版本（创建 + 附加文件）', (versions.d ?? []).length >= 2, true);
    check('  → 最新一版是 file_attached', versions.d?.[0]?.changeKind, 'file_attached');
  }
} finally {
  if (resourceId) {
    // ⚠️ `DELETE` 是软删除（进回收站）。本套件以前只做它，于是每跑一次就往回收站
    // 留一行 `上传链路探针 <ts>` —— 实测积了 57 行。现在真正删掉并**核实**。
    const purged = await purgeProbeResources({
      req: (m, p, b) => c.req(m, p, b),
      ids: [resourceId],
      dbUrl: DB_URL,
      label: '上传链路探针',
    });
    console.log(
      `\n清理：探针 ${resourceId} → 接口 purge ${purged.purgedViaApi} 条 / SQL 硬删 ${purged.purgedViaSql} 条` +
        (purged.remaining.length ? `；**仍残留 ${purged.remaining.length} 条**` : '；残留 0'),
    );
    for (const id of purged.remaining) { bad('探针清理', `仍残留 ${id}`); }
  }
}

console.log('\n' + '='.repeat(78));
console.log(`上传链路验证：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过   pass=${pass} fail=${fail} skipped=${skipped}`);
if (skipped > 0) console.log('  ⚠️  有 ' + skipped + ' 项被显式跳过（它们**不算通过**）。');
if (fail > 0) { console.log('\n失败明细：'); for (const f of failures) console.log('  * ' + f); process.exit(1); }
