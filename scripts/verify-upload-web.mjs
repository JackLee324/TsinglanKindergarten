/**
 * scripts/verify-upload-web.mjs —— **浏览器里**的真实上传闭环（§4/§23 客户端侧）。
 *
 *   BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' \
 *   EXPECT_STORAGE=on|off node scripts/verify-upload-web.mjs
 *
 * 为什么必须单独有这一个脚本
 * -------------------------
 * `scripts/verify-storage-upload-flow.mjs` 证明的是**服务端三步接口**可用
 * （申请直传地址 → PUT 字节 → 登记）。它对客户端代码一行都没有覆盖：
 * 老师在页面上点的是「保存草稿」按钮，而"按钮点下去之后客户端有没有真的把
 * 字节送上去、失败时有没有如实说清楚"只有真实 DOM 能回答。
 *
 * 本脚本覆盖的三条分支，正好对应 UploadPage 里四种 `fileOutcome` 中的三种：
 *
 *   阶段 1  EXPECT_STORAGE=on  合法 PDF → 期望 `uploaded`
 *           └ 断言成功提示、`hasFile=true`、以及**从签名直链取回的字节与
 *             浏览器上传的字节逐字节一致**（这才叫"文件真的在平台上"）。
 *   阶段 1  EXPECT_STORAGE=off 同一个合法 PDF，但服务端没接对象存储 → 期望
 *           `not_configured`：必须出现"文件没有上传"的**警告**，而且
 *           `hasFile=false`、下载被拒。**绝不能出现绿色成功提示。**
 *   阶段 2  （仅 on）扩展名不在白名单的探针文件 → 期望 `failed`：
 *           提示里必须同时说清"资源已保存"和"文件上传失败"，并带上服务端原因。
 *
 * 刻意不碰的东西
 * --------------
 * 不用 `/upload` 的**新建**表单（那要驱动 5 个 Radix Select，脆且与本轮改动无关）；
 * 走 `/upload?id=<资源id>` 编辑模式：表单由真实接口预填，本脚本只做
 * "选文件 → 提交"这两个真正的用户动作。新建分支与编辑分支调用的是**同一个**
 * uploadSelectedFile，服务端接口也已被 verify-storage-upload-flow.mjs 覆盖。
 */
import { folderIdFor } from '../tests/helpers/directory-fixture.mjs';
import { purgeProbeResources } from '../tests/helpers/probe-cleanup.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9273);
const EXPECT_STORAGE = (process.env.EXPECT_STORAGE || 'on').toLowerCase();
/**
 * 数据库连接串，仅用于**清理探针**的 SQL 兜底。
 * `DELETE /api/resources/:id` 是软删除，只走它会在回收站里积行（实测积了 94 行）。
 * 没设也能跑：那时清理只走 purge 接口，残留会被清清楚楚报出来。
 */
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}
if (EXPECT_STORAGE !== 'on' && EXPECT_STORAGE !== 'off') {
  console.error('EXPECT_STORAGE 只能是 on 或 off。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  SKIP  ${label}  -> ${reason}`); SKIPPED++; };

/**
 * 一份**真的**最小 PDF：字节 0 起是 `%PDF-`，服务端的魔数嗅探只认这个。
 * 内容不重要，重要的是它不是靠改扩展名骗过校验的假 PDF。
 */
const PDF_TEXT = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');
const PDF_BYTES = [...Buffer.from(PDF_TEXT, 'utf8')];

/** HTTP 客户端（带 cookie jar）——浏览器之外的动作（建资源、取字节、清理）走这里。 */
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
    const r = await fetch(BASE + p, {
      method: m, headers: h,
      body: b === undefined ? undefined : JSON.stringify(b),
      redirect: 'manual',
    });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空/重定向 */ }
    return { s: r.status, d, location: r.headers.get('location') };
  }
  /** 只取响应头（不跟随重定向），用于两跳下载。 */
  async function rawGet(url) {
    return fetch(url, { headers: { cookie: cookie() }, redirect: 'manual' });
  }
  return { req, rawGet };
}

const profile = mkdtempSync(join(tmpdir(), 'qls-upload-web-'));
let chrome = null;
/**
 * 探针资源 id 列表。
 *
 * 每个阶段必须用**独立**一条资源：曾经两个阶段共用一条，于是阶段 2"上传被拒后
 * hasFile 仍为 false"这条断言在阶段 1 已经成功挂上文件的情况下必然失败 ——
 * 而失败的原因是测试自己写错了，不是产品错了。共用状态会让断言互相污染。
 */
const createdResourceIds = [];

async function main() {
  const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const chromePath = process.env.CHROME_BIN || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) { console.error('找不到 Chrome/Chromium（可用 CHROME_BIN 指定）。'); process.exit(2); }

  // ---- 会话 + 预置一条草稿资源 ----
  const c = makeClient();
  await c.req('GET', '/');
  const login = await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
  if (login.s !== 201 && login.s !== 200) {
    console.error(`登录失败：HTTP ${login.s} ${JSON.stringify(login.d)}`);
    process.exit(2);
  }

  const stamp = Date.now().toString().slice(-6);
  /** 探针标题的唯一来源 —— wait 表达式也用它，避免两处拼接不一致导致假失败。 */
  const probeTitle = (suffix) => `上传闭环探针 ${suffix} ${stamp}`;
  /** 建一条草稿探针资源；返回 id（失败即退出，因为后续全部依赖它）。 */
  const createProbeResource = async (suffix) => {
    // §8：新建资源必须带 directoryId；§7：legacy folderType 由服务端按目录推导。
    // 目标取「教学详案」，与原 folderType 'weekly_plans' 是同一类（weekly_plans → 教学详案）。
    const probeDir = await folderIdFor(c, { program: 'prek', subject: 'virtue', suffix: 'lesson' });
    const created = await c.req('POST', '/api/resources', {
      title: probeTitle(suffix),
      program: 'prek',
      subject: 'virtue',
      directoryId: probeDir,
      semester: 'S1',
      weekNumber: 3,
      status: 'draft',
    });
    if (created.s !== 201 && created.s !== 200) {
      console.error(`建探针资源失败：HTTP ${created.s} ${JSON.stringify(created.d)}`);
      process.exit(2);
    }
    const id = created.d?.id ?? created.d?.resource?.id ?? null;
    if (!id) {
      console.error(`建资源响应里没有 id：${JSON.stringify(created.d)}`);
      process.exit(2);
    }
    createdResourceIds.push(id);
    return id;
  };

  // 阶段 1 与阶段 2 **各自**一条资源，避免前一个阶段的文件污染后一个阶段的断言。
  const createdResourceId = await createProbeResource('主');
  let phase2ResourceId = null;

  // ---- 起浏览器 ----
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--window-size=1600,1200',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page') || null;
    } catch { /* 还没起来 */ }
    if (!target) await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) { console.error('CDP 未就绪。'); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalIn = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) { last = await evalIn(expression); if (last) return { ok: true, value: last }; await sleep(400); }
    return { ok: false, value: last };
  };
  const goto = async (path, until = null) => {
    await send('Page.navigate', { url: `${BASE}${path}` });
    await waitFor(until || '(document.getElementById("root")?.innerText || "").trim().length > 10', 45000);
    await sleep(500);
    return evalIn("(document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ')");
  };
  const fill = async (sel, value) => evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
  })()`);
  const clickSel = async (sel) => evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({ block: 'center' });
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
    return 'CLICKED';
  })()`);
  /** 按可见文字点按钮（页面没有 data-testid，只能按文案定位）。 */
  const clickByText = async (text) => evalIn(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes(${JSON.stringify(text)}));
    if (!b) return 'NOT_FOUND';
    b.scrollIntoView({ block: 'center' });
    for (const t of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
    return 'CLICKED';
  })()`);

  // ===========================================================================
  // 真实鼠标点击（CDP Input 域），用于驱动 Radix Select。
  //
  // 为什么**不能**用 DOM 合成事件：Radix 的 SelectItem 在 pointer 处理器里用
  // `document.elementFromPoint(clientX, clientY)` 判断"指针是否落在内容区上"，
  // 而 `new MouseEvent('click')` 的 clientX/clientY 默认是 **0,0** ——
  // 于是 elementFromPoint(0,0) 拿到的是页面左上角的元素，判定"不在内容区"，
  // 选择被丢弃：**下拉会正常关闭，但值不会被设置**。
  //
  // 实测症状（本轮踩到）：合成事件下点 "Pre-K" 后 combobox 文案仍为空、
  // 科目下拉仍是 disabled，看起来像"点了没反应"；换成真实鼠标事件后
  // 四个下拉全部一次选中。这类"看着像产品 bug、其实是测试手法不对"的坑，
  // 只有把整条输入管线走真才能排除。
  // ===========================================================================
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0, pointerType: 'mouse' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  };
  /** 元素视口中心坐标（先滚到视口中间，否则坐标会落在视口外）。 */
  const centerOf = async (expr) => {
    const raw = await evalIn(`(() => {
      const el = ${expr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    return raw ? JSON.parse(raw) : null;
  };
  /**
   * 取某个下拉选项"可见部分"的中心坐标。
   *
   * 先 `scrollIntoView({block:'nearest'})` 把它带进可视范围（会滚动 Radix 的
   * viewport，而不是整个页面），再把它自己的矩形与 viewport 矩形求交集，
   * 取交集中心。目标项完全不可见时返回 null —— 宁可报 NO_OPTION，
   * 也不要盲目点一个坐标然后选中别的东西。
   */
  const evalInOptionCenter = async (option) => {
    const raw = await evalIn(`(() => {
      const opt = [...document.querySelectorAll('[role=option]')]
        .find((x) => (x.innerText || '').trim() === ${JSON.stringify(option)});
      if (!opt) return null;
      opt.scrollIntoView({ block: 'nearest' });
      const vp = opt.closest('[data-radix-select-viewport]');
      const r = opt.getBoundingClientRect();
      const v = vp ? vp.getBoundingClientRect()
                   : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      const top = Math.max(r.top, v.top);
      const bottom = Math.min(r.bottom, v.bottom);
      const left = Math.max(r.left, v.left);
      const right = Math.min(r.right, v.right);
      if (bottom <= top || right <= left) return null;
      return JSON.stringify({ x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) });
    })()`);
    return raw ? JSON.parse(raw) : null;
  };

  /** 按 FormItem 的 label 文案定位控件（页面没有 data-testid，只能按文案走）。 */
  const controlExpr = (selector, label) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((c) => {
    let n = c;
    for (let i = 0; i < 6 && n; i += 1) {
      n = n.parentElement;
      if (n && n.querySelector('label')) return ((n.querySelector('label').innerText || '').includes(${JSON.stringify(label)}));
    }
    return false;
  })`;
  /** 用真实鼠标点开 Radix Select 并选中一项。 */
  const pickSelect = async (label, option) => {
    const trigger = await centerOf(controlExpr('[role=combobox]', label));
    if (!trigger) return `NO_COMBO:${label}`;
    await clickAt(trigger.x, trigger.y);
    await sleep(700);
    // 目标项的坐标必须取"它自己的矩形"与"下拉可视区"的**交集中心**。
    //
    // 只取 getBoundingClientRect 的中心是不够的：下拉列表本身可滚动
    // （`[data-radix-select-viewport]`），长列表里目标项的矩形可能落在可视区之外，
    // 按那个坐标点下去会命中**另一个**选项。本轮实测：点 "Pre-K / 美德"
    // 实际选中了 "Pre-K / 蒙特梭利 / 教学详案"。
    const item = await evalInOptionCenter(option);
    if (!item) {
      const seen = await evalIn(`JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      return `NO_OPTION:${option} seen=${seen}`;
    }
    await clickAt(item.x, item.y);
    await sleep(700);
    // **必须复核到底选中了什么。**
    //
    // 目录下拉有 69 个候选，列表本身可滚动；只按坐标点一下**不足以**说明
    // 点中的就是那一项。本轮实测就踩到了：点 "Pre-K / 美德" 实际选中的是
    // `prek:montessori_lesson`，随后服务端正确地以 400
    // 「资源与所选目录不属于同一科目」拒绝 —— 看起来像产品缺陷，其实是
    // 测试点错了，而且如果不断言"选中了什么"，它会静默地一直错下去。
    const landed = await evalIn(`(() => {
      const c = ${controlExpr('[role=combobox]', label)};
      return c ? (c.innerText || '').replace(/\\s+/g, ' ').trim() : null;
    })()`);
    if (landed !== option) {
      return `WRONG_PICK:${option} -> ${landed}`;
    }
    return 'PICKED';
  };
  /**
   * 按 label 填文本框 / 数字框 / 多行框。
   *
   * ⚠️ 选择器**不能**写 `input[type=text]`：shadcn 的 `<Input>` 渲染出来
   * **没有 type 属性**（`el.type` 求值是 'text'，但属性选择器匹配的是 attribute）。
   * 实测就是这么踩的：周次框（显式 `type="number"`）能填，标题框报 NOT_FOUND，
   * 于是提交被"必填项"校验拦下 —— 看起来像产品缺陷，其实是选择器写错了。
   */
  const fillByLabel = async (label, value) => evalIn(`(() => {
    const el = ${controlExpr('input:not([type=file]),textarea', label)};
    if (!el) return 'NOT_FOUND';
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
  })()`);

  /**
   * 监听 sonner 的 toast。
   *
   * 必须**先装监听再操作**：toast 默认几秒后自动消失，事后去 DOM 里找会
   * 随机抓不到（"没抓到"和"没提示"长得一模一样，正是最容易自欺的一类假失败）。
   */
  const installToastRecorder = () => evalIn(`(() => {
    window.__toasts = [];
    const scan = () => {
      for (const el of document.querySelectorAll('[data-sonner-toast]')) {
        const t = (el.innerText || '').trim();
        if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
      }
    };
    scan();
    window.__toastObserver?.disconnect();
    window.__toastObserver = new MutationObserver(scan);
    window.__toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    return 'WATCHING';
  })()`);

  /** 把一组真实字节挂到隐藏的 file input 上（DataTransfer 是浏览器提供的真实文件通道）。 */
  const attachFile = async (name, bytes, mime) => evalIn(`(() => {
    const input = document.querySelector('input[type=file]');
    if (!input) return 'NO_INPUT';
    const f = new File([new Uint8Array(${JSON.stringify(bytes)})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length + ':' + (input.files[0]?.name || '');
  })()`);

  await send('Page.enable'); await send('Runtime.enable');

  const storageLabel = EXPECT_STORAGE === 'on' ? '已配置对象存储' : '未配置对象存储';
  console.log(`\n=== 浏览器真实上传闭环（${BASE}；服务端${storageLabel}）===\n`);

  // ---- 浏览器登录 ----
  console.log('1) 浏览器登录');
  await goto('/login', 'document.querySelectorAll("input").length >= 2');
  await fill('input[autocomplete="username"]', USER);
  await fill('input[autocomplete="current-password"]', PASS);
  await clickSel('[data-testid="login-submit"]');
  const home = await waitFor("location.pathname === '/'", 30000);
  if (home.ok) ok('浏览器登录进入工作台', await evalIn('location.pathname'));
  else {
    bad('浏览器登录进入工作台', await evalIn("(document.getElementById('root')?.innerText||'').replace(/\\s+/g,' ').slice(0,200)"));
  }

  // ---- 阶段 1：合法 PDF ----
  console.log(`\n2) 编辑页选文件并保存（期望结论：${EXPECT_STORAGE === 'on' ? 'uploaded' : 'not_configured'}）`);
  let phase1Ok = false;
  if (FAILED === 0) {
    const title = probeTitle('主');
    await goto(
      `/upload?id=${createdResourceId}`,
      `[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(title)})`,
    );
    const prefilled = await evalIn(`[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(title)})`);
    if (prefilled) ok('编辑页由真实接口预填（表单已就绪）');
    else bad('编辑页由真实接口预填（表单已就绪）', await evalIn("(document.getElementById('root')?.innerText||'').replace(/\\s+/g,' ').slice(-260)"));

    await installToastRecorder();

    const fileName = `周次教案-探针-${stamp}.pdf`;
    const attached = await attachFile(fileName, PDF_BYTES, 'application/pdf');
    if (String(attached).startsWith('1:')) ok('选中文件（真实字节，非仅文件名）', String(attached));
    else bad('选中文件（真实字节，非仅文件名）', String(attached));

    const shown = await waitFor(`(document.getElementById('root')?.innerText||'').includes(${JSON.stringify(fileName)})`, 10000);
    if (shown.ok) ok('页面回显已选文件名');
    else bad('页面回显已选文件名');

    const submitted = await clickByText('保存草稿');
    if (submitted === 'CLICKED') ok('点「保存草稿」提交');
    else bad('点「保存草稿」提交', String(submitted));

    const gotToast = await waitFor('(window.__toasts || []).length > 0', 30000);
    const toasts = (await evalIn('window.__toasts || []')) || [];
    if (gotToast.ok) ok('产生了提示', toasts.join(' | ').slice(0, 160));
    else bad('产生了提示', '点提交后没有任何 toast —— 交互没有真正生效');

    if (gotToast.ok) {
      const joined = toasts.join('\n');
      if (EXPECT_STORAGE === 'on') {
        if (/资源与文件均已保存/.test(joined)) ok('成功提示明确说明"文件也保存了"');
        else bad('成功提示明确说明"文件也保存了"', joined.slice(0, 200));
        if (/文件没有上传|上传失败/.test(joined)) bad('成功路径上不应出现失败字样', joined.slice(0, 200));
        else ok('成功路径上没有混淆的失败字样');
      } else {
        // 关键断言：没接存储时**绝不能**出现绿色成功提示。
        if (/资源与文件均已保存/.test(joined)) bad('未接存储时不应出现"文件已保存"的成功提示', joined.slice(0, 200));
        else ok('未接存储时没有出现"文件已保存"的成功提示');
        if (/没有上传|未接|未配置|存储/.test(joined)) ok('明确告知文件没有上传（警告而非成功）', joined.slice(0, 200));
        else bad('明确告知文件没有上传（警告而非成功）', joined.slice(0, 200));
      }
      phase1Ok = true;
    }
  } else {
    skip('编辑页选文件并保存', '浏览器登录未通过');
  }

  // ---- 阶段 1 的服务端侧核对（浏览器说得再好也要有库里的证据） ----
  console.log('\n3) 服务端侧核对');
  if (phase1Ok) {
    const row = await c.req('GET', `/api/resources/${createdResourceId}`);
    if (row.s === 200) {
      const r = row.d?.resource ?? row.d ?? {};
      if (EXPECT_STORAGE === 'on') {
        if (r.hasFile === true) ok('库里该资源标记为有文件', 'hasFile=true');
        else bad('库里该资源标记为有文件', `hasFile=${JSON.stringify(r.hasFile)}`);
        if (Number(r.fileSize) === PDF_BYTES.length) ok('库里文件大小与所选字节一致', `${r.fileSize}/${PDF_BYTES.length}`);
        else bad('库里文件大小与所选字节一致', `${r.fileSize}/${PDF_BYTES.length}`);
        if (String(r.fileName || '').includes(stamp)) ok('库里文件名与所选文件一致', String(r.fileName));
        else bad('库里文件名与所选文件一致', String(r.fileName));

        // 两跳下载 + 逐字节比对：唯一能证明"浏览器上传的字节真的取回来"的断言。
        const dl = await c.req('GET', `/api/resources/${createdResourceId}/download`);
        if (dl.s === 302) ok('第一跳换取下载令牌 → 302');
        else bad('第一跳换取下载令牌 → 302', String(dl.s));
        if (dl.s === 302) {
          const hop2 = await c.rawGet(new URL(String(dl.location), BASE));
          if (hop2.status === 302) ok('第二跳 → 302 签名直链');
          else bad('第二跳 → 302 签名直链', String(hop2.status));
          const signedUrl = hop2.headers.get('location');
          const got = await fetch(signedUrl);
          if (got.status === 200) ok('从签名直链取回字节 → 200');
          else bad('从签名直链取回字节 → 200', String(got.status));
          const bytes = Buffer.from(await got.arrayBuffer());
          if (bytes.equals(Buffer.from(PDF_BYTES))) ok('取回字节与浏览器上传的字节**逐字节一致**', `${bytes.length}B`);
          else bad('取回字节与浏览器上传的字节**逐字节一致**', `${bytes.length}B vs ${PDF_BYTES.length}B`);
        }
      } else {
        if (r.hasFile === false) ok('库里该资源仍标记为无文件', 'hasFile=false');
        else bad('库里该资源仍标记为无文件', `hasFile=${JSON.stringify(r.hasFile)}`);
        // 没接存储时，客户端以前会**伪造** bucket/path；现在必须为空。
        const fabricated = [r.filePath, r.bucketId, r.fileUrl].some((v) => typeof v === 'string' && v.length > 0);
        if (!fabricated) ok('没有伪造 bucket / path / fileUrl');
        else bad('没有伪造 bucket / path / fileUrl', JSON.stringify({ p: r.filePath, b: r.bucketId, u: r.fileUrl }));

        // 断言"被拒绝"这个事实，不猜具体码：404 = 这条资源没有文件，
        // 503 = 有文件但存储未配置/不可用。两者都是诚实拒绝；
        // 要守住的底线是**不是 200、且不给任何指向对象存储的 Location**。
        const dl = await c.req('GET', `/api/resources/${createdResourceId}/download`);
        if (dl.s === 404 || dl.s === 503) ok('无文件时下载被拒（404 无文件 / 503 存储未配置）', String(dl.s));
        else bad('无文件时下载被拒（404 无文件 / 503 存储未配置）', String(dl.s));
        if (!dl.location || !/X-Amz-Signature=/.test(String(dl.location))) ok('拒绝时不返回任何签名直链');
        else bad('拒绝时不返回任何签名直链', String(dl.location).slice(0, 120));
        const code = String(dl.d?.error?.code ?? dl.d?.code ?? '');
        if (/NOT_FOUND|NO_FILE|STORAGE_NOT_CONFIGURED|UNAVAILABLE/.test(code)) ok('拒绝里带机器可读的错误码', code);
        else bad('拒绝里带机器可读的错误码', code || JSON.stringify(dl.d).slice(0, 160));
      }
    } else {
      bad('读取资源详情 → 200', `HTTP ${row.s}`);
    }
  } else {
    skip('服务端侧核对', '阶段 1 未通过');
  }

  // ---- 阶段 2：服务端拒绝的文件必须如实报"上传失败" ----
  console.log('\n4) 服务端会拒绝的文件（期望结论：failed）');
  if (EXPECT_STORAGE === 'on' && FAILED === 0) {
    // 用一条**全新**资源：它从"没有文件"开始，所以"被拒后仍然没有文件"才有意义。
    phase2ResourceId = await createProbeResource('拒绝');
    await goto(
      `/upload?id=${phase2ResourceId}`,
      `[...document.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(probeTitle('拒绝'))})`,
    );
    await installToastRecorder();
    const badName = `probe-${stamp}.exe`;
    const attached = await attachFile(badName, [...Buffer.from('MZ\x90\x00', 'binary')], 'application/octet-stream');
    if (String(attached).startsWith('1:')) ok('选中一个不在白名单里的文件', String(attached));
    else bad('选中一个不在白名单里的文件', String(attached));

    await clickByText('保存草稿');
    const gotToast = await waitFor('(window.__toasts || []).length > 0', 30000);
    const toasts = (await evalIn('window.__toasts || []')) || [];
    if (gotToast.ok) {
      const joined = toasts.join('\n');
      if (/上传失败/.test(joined)) ok('提示里说明文件上传失败', joined.slice(0, 200));
      else bad('提示里说明文件上传失败', joined.slice(0, 200));
      if (/资源与文件均已保存/.test(joined)) bad('被服务端拒绝时不得出现成功提示', joined.slice(0, 200));
      else ok('被服务端拒绝时没有出现成功提示');
    } else {
      bad('被服务端拒绝时产生了提示', '没有任何 toast');
    }

    const row = await c.req('GET', `/api/resources/${phase2ResourceId}`);
    const r = row.d?.resource ?? row.d ?? {};
    if (r.hasFile === false) ok('被拒绝后库里仍标记为无文件（不谎报有文件）', 'hasFile=false');
    else bad('被拒绝后库里仍标记为无文件（不谎报有文件）', `hasFile=${JSON.stringify(r.hasFile)}`);
    const dl2 = await c.req('GET', `/api/resources/${phase2ResourceId}/download`);
    if (dl2.s === 404 || dl2.s === 503) ok('文件被拒后下载仍被拒（404 无文件 / 503 存储未配置）', String(dl2.s));
    else bad('文件被拒后下载仍被拒（404 无文件 / 503 存储未配置）', String(dl2.s));
    if (!dl2.location || !/X-Amz-Signature=/.test(String(dl2.location))) ok('被拒后不返回任何签名直链');
    else bad('被拒后不返回任何签名直链', String(dl2.location).slice(0, 120));
  } else if (EXPECT_STORAGE !== 'on') {
    skip('服务端拒绝文件的用例', '服务端未接对象存储，本轮只验证 not_configured 分支');
  } else {
    skip('服务端拒绝文件的用例', '阶段 1 未通过，后置步骤不再执行');
  }

  // ---- 阶段 3：**新建**资源（老师最常用的那条路）必须也真的走通 ----
  //
  // 阶段 1/2 走的是 `/upload?id=<id>` 编辑模式 —— 表单由接口预填，只验证了
  // "选文件 → 提交"这两个动作。但老师平时点的是 `/upload` **新建**：
  // 要自己选班型/科目/资料夹/学期、自己填标题。这条路上的表单交互
  // （Radix Select 的联动重置）本轮刚刚修过一个致命缺陷，因此必须真的走一遍。
  console.log('\n5) 新建资源（老师最常用的那条路）');
  if (EXPECT_STORAGE === 'on' && FAILED === 0) {
    const newTitle = probeTitle('新建');
    await goto('/upload', 'document.querySelectorAll("[role=combobox]").length >= 4');
    // 等 structures 异步加载到位，否则下拉是空的。
    await waitFor(`document.querySelectorAll('[role=combobox]').length >= 4 && !document.querySelectorAll('[role=combobox]')[0].disabled`, 20000);

    const filled = await fillByLabel('资源标题', newTitle);
    if (filled === 'SET') ok('填标题', newTitle);
    else bad('填标题', String(filled));

    const week = await fillByLabel('周次', '7');
    if (week === 'SET') ok('填周次');
    else bad('填周次', String(week));

    // 四个下拉依次选。顺序与真实用户一致：班型 → 科目 → 资料夹 → 学期。
    // §7：这里**不再有「资料夹」下拉** —— 老师只选「所属目录」，
    // legacy folder_type 由服务端按目录推导。断言跟着契约走。
    const picks = [
      ['班型', 'Pre-K'],
      ['科目', '美德'],
      ['学期', '第一学期'],
    ];
    let allPicked = true;
    for (const [label, option] of picks) {
      const r = await pickSelect(label, option);
      if (r === 'PICKED') ok(`选${label} = ${option}`);
      else { bad(`选${label} = ${option}`, r); allPicked = false; }
    }
    // 关键回归断言：选完"科目"之后它**必须还在**。
    // 本轮修掉的缺陷就是"选完班型把科目清空"，症状是校验失败 + 完全不提示。
    const shown = await evalIn(`JSON.stringify([...document.querySelectorAll('[role=combobox]')].map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim()))`);
    const labels = JSON.parse(shown || '[]');
    if (allPicked && labels[0].includes('Pre-K') && labels[1].includes('美德')) {
      ok('已选下拉的值都**保留住了**（选班型没有把科目清掉）', labels.join(' / '));
    } else {
      bad('已选下拉的值都**保留住了**（选班型没有把科目清掉）', labels.join(' / '));
    }

    // §8：新建时**必须**选一个目录，并断言它**落库**了。
    // 这是"资源上传时可以真正归属到目录"这条要求的浏览器级证据。
    //
    // 选项文案是"从根到资料夹"的完整路径（教育教学 / Pre-K / 美德 / 教学详案…），
    // 所以这里取第一个含「美德」的资料夹选项 —— 由下面的落库断言兜底：
    // 选错目录的话，服务端会因为跨科目而 400。
    const dirOptions = await evalIn(
      `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`,
    );
    void dirOptions;
    const dirPick = await pickSelect('所属目录', '教育教学 / Pre-K / 美德 / 教学详案');
    if (dirPick === 'PICKED') ok('选所属目录 = 教育教学 / Pre-K / 美德 / 教学详案');
    else {
      const seen = await evalIn(
        `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()).slice(0, 12))`,
      );
      bad('选所属目录', `${dirPick} seen=${String(seen).slice(0, 300)}`);
    }

    const fileName = `新建探针-${stamp}.pdf`;
    const attached = await attachFile(fileName, PDF_BYTES, 'application/pdf');
    if (String(attached).startsWith('1:')) ok('选中文件', String(attached));
    else bad('选中文件', String(attached));

    await installToastRecorder();
    const submitted = await clickByText('提交审核');
    if (submitted === 'CLICKED') ok('点「提交审核」');
    else bad('点「提交审核」', String(submitted));

    const gotToast = await waitFor('(window.__toasts || []).length > 0', 30000);
    const toasts = (await evalIn('window.__toasts || []')) || [];
    if (gotToast.ok) {
      const joined = toasts.join('\n');
      if (/资源与文件均已保存/.test(joined)) ok('新建后提示"资源与文件均已保存"', joined.slice(0, 120));
      else bad('新建后提示"资源与文件均已保存"', joined.slice(0, 200));
    } else {
      bad('新建后产生了提示', '没有任何 toast —— 交互没有真正生效');
    }

    // 服务端侧核对：这条资源必须真的存在、真的提交了审核、真的有文件。
    const mine = await c.req('GET', '/api/resources/mine');
    const items = mine.d?.items ?? mine.d ?? [];
    const createdRow = Array.isArray(items) ? items.find((r) => r?.title === newTitle) : null;
    if (createdRow) {
      ok('新建的资源在「我的资源」里查得到', createdRow.id);
      createdResourceIds.push(createdRow.id);
      if (createdRow.status === 'pending_review') ok('状态真的是 pending_review（提交审核生效）', createdRow.status);
      else bad('状态真的是 pending_review（提交审核生效）', String(createdRow.status));
      if (createdRow.hasFile === true) ok('库里标记为有文件', 'hasFile=true');
      else bad('库里标记为有文件', `hasFile=${JSON.stringify(createdRow.hasFile)}`);

      // §8：目录归属必须真的落库，而且必须落在**具体资料夹**上
      // （不再是科目节点 —— 新契约要求 requireLeafFolder）。
      const virtue = await c.req('GET', '/api/directories/tree');
      const flat = [];
      const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n.children); } };
      walk((virtue.d ?? {}).roots ?? []);
      const expected = flat.find((n) => n.code === 'prek:virtue_lesson');
      if (expected && createdRow.directoryId === expected.id) {
        ok('目录归属已落库且指向资料夹', createdRow.directoryId);
      } else {
        bad('目录归属已落库且指向资料夹', `got=${createdRow.directoryId} want=${expected?.id}`);
      }
      // §7：legacy folder_type 由服务端按目录推导 —— 资料夹是「教学详案」，
      // 所以它必须被推导成 weekly_plans，而不是被留空或被猜成别的。
      const derived = createdRow.folderType ?? createdRow.folder_type;
      if (derived === 'weekly_plans') ok('legacy folder_type 由服务端按目录推导', String(derived));
      else bad('legacy folder_type 由服务端按目录推导', `got=${String(derived)} want=weekly_plans`);

      // 反向：用目录过滤能查回这条资源（"目录页面能查到属于该目录的资源"）。
      const byDir = await c.req('GET', '/api/resources?directory=prek%3Avirtue_lesson&pageSize=100');
      const inDir = ((byDir.d ?? {}).items ?? []).some((r) => r.id === createdRow.id);
      if (inDir) ok('按目录查询能查到这条新资源（?directory=prek:virtue_lesson）');
      else bad('按目录查询能查到这条新资源（?directory=prek:virtue_lesson）', `HTTP ${byDir.s}`);

      const dl = await c.req('GET', `/api/resources/${createdRow.id}/download`);
      if (dl.s === 302) {
        const hop2 = await c.rawGet(new URL(String(dl.location), BASE));
        const signedUrl = hop2.headers.get('location');
        const got = await fetch(signedUrl);
        const bytes = got.status === 200 ? Buffer.from(await got.arrayBuffer()) : Buffer.alloc(0);
        if (bytes.equals(Buffer.from(PDF_BYTES))) ok('新建流程上传的字节也能逐字节取回', `${bytes.length}B`);
        else bad('新建流程上传的字节也能逐字节取回', `HTTP ${got.status} / ${bytes.length}B`);
      } else {
        bad('新建流程后下载第一跳 → 302', String(dl.s));
      }
    } else {
      bad('新建的资源在「我的资源」里查得到', `共 ${Array.isArray(items) ? items.length : '?'} 条，未找到「${newTitle}」`);
    }
  } else if (EXPECT_STORAGE !== 'on') {
    skip('新建资源流程', '服务端未接对象存储，新建后必然失败，本轮用编辑模式验证 not_configured 分支');
  } else {
    skip('新建资源流程', '前置阶段未通过，后置步骤不再执行');
  }
}

try {
  await main();
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
} finally {
  if (chrome) chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  // 清理探针资源（可能不止一条）。
  //
  // ⚠️ 这里以前只做 `DELETE` —— 而它是**软删除**。于是每跑一次门禁就往回收站
  // 留 3 行（主 / 新建 / 拒绝），实测积了 94 行，是本库最大的一处残留来源。
  // 现在走共用的 purgeProbeResources()：先走真实 purge 接口（顺带把
  // `resource.purge` 权限与审计一起验到），再用 SQL 兜底，最后**核实**行真的没了。
  if (createdResourceIds.length > 0) {
    try {
      const c = makeClient();
      await c.req('GET', '/');
      await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
      const purged = await purgeProbeResources({
        req: (m, p, b) => c.req(m, p, b),
        ids: createdResourceIds,
        dbUrl: DB_URL,
        label: '上传闭环探针',
      });
      console.log(
        `\n清理：${createdResourceIds.length} 条探针 → 接口 purge ${purged.purgedViaApi} 条 / ` +
          `SQL 硬删 ${purged.purgedViaSql} 条` +
          (purged.remaining.length ? `；**仍残留 ${purged.remaining.length} 条**` : '；残留 0'),
      );
      for (const id of purged.remaining) { bad('探针清理', `仍残留 ${id}`); }
    } catch (e) {
      console.error(`\n清理探针资源失败：${e?.message}`);
      bad('探针清理', String(e?.message));
    }
  }
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
