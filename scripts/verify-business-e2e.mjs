/**
 * scripts/verify-business-e2e.mjs —— 真实浏览器里的**业务全链路**（§9）。
 *
 *   BROWSER_E2E_USER=… BROWSER_E2E_PASS=… node scripts/verify-business-e2e.mjs
 *
 * 覆盖用户点名的整条链路：
 *   新建 → 选班型 → 选科目 → 选目录 → 上传真实文件 → 保存草稿 → 我的资源 →
 *   查看详情 → 提交审核 → 审核 → 发布 → 目录中出现 → 下载 → 字节一致
 * 外加四组：
 *   编辑→保存→刷新→数据仍在；删除→回收站→恢复→再出现；
 *   权限授权→重新登录→生效；权限撤销→旧 Session→权限失效。
 *
 * 与既有套件的分工
 * ----------------
 * `upload-web` 证明"上传那一步是真的"；`directory-web` 证明目录三项硬要求。
 * 本套件证明**把这些步骤连起来走一遍**不会在中途断掉 —— 单点都对、
 * 串起来不对，是这类系统最常见也最难发现的一类缺陷。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9297);

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  \x1b[33mSKIP\x1b[0m  ${label}  -> ${reason}`); SKIPPED++; };

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

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
  const login = async (u, p) => {
    await req('GET', '/');
    return req('POST', '/api/auth/login', { username: u, password: p });
  };
  return { req, rawGet, login };
}

const profile = mkdtempSync(join(tmpdir(), 'qls-biz-'));
let chrome = null;
const createdResourceIds = [];
/** 本次运行的标记。**必须在模块作用域**：finally 里的兜底清理要用它，
 *  而 main() 内的局部变量在 finally 里是不可见的（第一版就因此没生效）。 */
let runStamp = null;
let probeTeacherId = null;
let probeTeacherUsername = null;
const overridesToClear = [];

async function main() {
  const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const chromePath = process.env.CHROME_BIN || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) { console.error('找不到 Chrome/Chromium。'); process.exit(2); }

  const c = makeClient();
  const adminLogin = await c.login(USER, PASS);
  if (adminLogin.s !== 201 && adminLogin.s !== 200) {
    console.error(`登录失败：HTTP ${adminLogin.s}`);
    process.exit(2);
  }

  const stamp = Date.now().toString().slice(-6);
  runStamp = stamp;

  // 全链路里"上传真实文件"和"下载字节一致"都**必须**有对象存储后端。
  // 没有后端时服务端会（正确地）503，整条链会在第 2 步就断掉。
  // 那种情况下**大声说明并跳过**，而不是把环境缺失报成一堆产品缺陷 ——
  // 这是本仓库既有约定（storage-upload / files-http 同一套做法）。
  const probeRes = await c.req('POST', '/api/resources', {
    title: `链路前置探测 ${stamp}`,
    program: 'prek',
    subject: 'virtue',
    folderType: 'weekly_plans',
    status: 'draft',
  });
  const probeId = probeRes.d?.id ?? probeRes.d?.resource?.id ?? null;
  let storageConfigured = false;
  if (probeId) {
    const urlProbe = await c.req('POST', `/api/resources/${probeId}/upload-url`, { fileName: 'probe.pdf' });
    storageConfigured = urlProbe.s !== 503;
    await c.req('DELETE', `/api/resources/${probeId}`);
  }
  if (!storageConfigured) {
    console.log('='.repeat(78));
    console.log('⚠️  本进程**没有配置对象存储**（upload-url 返回 503）。');
    console.log('    这条全链路包含"上传真实文件"与"下载字节一致"，缺存储时无法成立。');
    console.log('    请把应用指向一个配置好的后端后重跑；未配置模式下等价行为由');
    console.log('      upload-web（EXPECT_STORAGE=off）与 files-http 覆盖。');
    console.log('    **切勿为了让它变绿而伪造存储。**');
    console.log('='.repeat(78));
    for (const label of [
      '新建→上传→保存草稿', '编辑→保存→刷新', '我的资源→详情', '提交审核',
      '审核→发布', '目录中出现', '下载→字节一致', '删除→回收站→恢复',
      '授权/撤销',
    ]) {
      skip(label, '服务端未配置对象存储');
    }
    return;
  }
  console.log('（对象存储已配置，跑完整链路）');

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
  const openPath = async (path, until, timeoutMs = 45000) => {
    await send('Page.navigate', { url: `${BASE}${path}` });
    await waitFor(until, timeoutMs);
    await sleep(400);
  };
  const hardReload = async (until, timeoutMs = 45000) => {
    await send('Page.reload', { ignoreCache: true });
    await waitFor(until, timeoutMs);
    await sleep(400);
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0, pointerType: 'mouse' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  };
  const centerOf = async (expr) => {
    const raw = await evalIn(`(() => {
      const el = ${expr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    return raw ? JSON.parse(raw) : null;
  };
  /** 用真实鼠标点一个元素（CDP 坐标）——Radix 的组件对合成事件不买账。 */
  const mouseClick = async (expr) => {
    const p = await centerOf(expr);
    if (!p) return 'NOT_FOUND';
    await clickAt(p.x, p.y);
    await sleep(500);
    return 'CLICKED';
  };
  const fillByLabel = async (label, value) => evalIn(`(() => {
    const el = [...document.querySelectorAll('input:not([type=file]),textarea')].find((c) => {
      let n = c;
      for (let i = 0; i < 6 && n; i += 1) {
        n = n.parentElement;
        if (n && n.querySelector('label')) return ((n.querySelector('label').innerText || '').includes(${JSON.stringify(label)}));
      }
      return false;
    });
    if (!el) return 'NOT_FOUND';
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
  })()`);
  const controlExpr = (selector, label) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((c) => {
    let n = c;
    for (let i = 0; i < 6 && n; i += 1) {
      n = n.parentElement;
      if (n && n.querySelector('label')) return ((n.querySelector('label').innerText || '').includes(${JSON.stringify(label)}));
    }
    return false;
  })`;
  /** 开下拉并选项：坐标取"目标项矩形 ∩ 下拉可视区"的交集中心，点完**复核**选中值。 */
  const pickSelect = async (label, option) => {
    const trigger = await centerOf(controlExpr('[role=combobox]', label));
    if (!trigger) return `NO_COMBO:${label}`;
    await clickAt(trigger.x, trigger.y);
    await sleep(700);
    const item = await evalIn(`(() => {
      const opt = [...document.querySelectorAll('[role=option]')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(option)});
      if (!opt) return null;
      opt.scrollIntoView({ block: 'nearest' });
      const vp = opt.closest('[data-radix-select-viewport]');
      const r = opt.getBoundingClientRect();
      const v = vp ? vp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      const top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.bottom);
      const left = Math.max(r.left, v.left), right = Math.min(r.right, v.right);
      if (bottom <= top || right <= left) return null;
      return JSON.stringify({ x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) });
    })()`);
    if (!item) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      return `NO_OPTION:${option}`;
    }
    const { x, y } = JSON.parse(item);
    await clickAt(x, y);
    await sleep(700);
    const landed = await evalIn(`(() => { const c = ${controlExpr('[role=combobox]', label)}; return c ? (c.innerText || '').replace(/\\s+/g, ' ').trim() : null; })()`);
    return landed === option ? 'PICKED' : `WRONG_PICK:${option} -> ${landed}`;
  };
  const attachFile = async (name, bytes, mime) => evalIn(`(() => {
    const input = document.querySelector('input[type=file]');
    if (!input) return 'NO_INPUT';
    const f = new File([new Uint8Array(${JSON.stringify([...bytes])})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length + ':' + (input.files[0]?.name || '');
  })()`);
  const installToastRecorder = () => evalIn(`(() => {
    window.__toasts = [];
    const scan = () => { for (const el of document.querySelectorAll('[data-sonner-toast]')) { const t = (el.innerText || '').trim(); if (t && !window.__toasts.includes(t)) window.__toasts.push(t); } };
    scan();
    window.__toastObserver?.disconnect();
    window.__toastObserver = new MutationObserver(scan);
    window.__toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    return 'WATCHING';
  })()`);
  const toasts = () => evalIn('window.__toasts || []');
  /** 展开可折叠的目录树直到目标出现。 */
  const expandUntil = async (selector, maxRounds = 12) => {
    for (let i = 0; i < maxRounds; i += 1) {
      if (await evalIn(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      const clicked = await evalIn(`(() => {
        let n = 0;
        for (const t of document.querySelectorAll('[data-dir-toggle]')) {
          if (t.getAttribute('aria-expanded') === 'true') continue;
          for (const e of ['mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
          n += 1;
        }
        return n;
      })()`);
      await sleep(600);
      if (!clicked) break;
    }
    return evalIn(`!!document.querySelector(${JSON.stringify(selector)})`);
  };
  /** 在「我的资源」里针对**我们自己那一行**点按钮（按行文案定位，避免点到别人的行）。 */
  const clickInRow = async (testId, rowText) => evalIn(`(() => {
    const btn = [...document.querySelectorAll('[data-testid=' + ${JSON.stringify(testId)} + ']')].find((b) => {
      let n = b;
      for (let i = 0; i < 8 && n; i += 1) {
        n = n.parentElement;
        if (n && n.tagName === 'TR') return (n.innerText || '').includes(${JSON.stringify(rowText)});
      }
      return false;
    });
    if (!btn) return 'NOT_FOUND';
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`).then(async (raw) => {
    if (!raw || raw === 'NOT_FOUND') return 'NOT_FOUND';
    const { x, y } = JSON.parse(raw);
    await clickAt(x, y);
    await sleep(600);
    return 'CLICKED';
  });

  await send('Page.enable'); await send('Runtime.enable');

  const title = `全链路探针 ${stamp}`;
  const titleEdited = `全链路探针（已编辑） ${stamp}`;
  let resourceId = null;
  /** 编辑成功后标题会变 —— 之后所有按标题定位的地方都必须用**当前**标题。 */
  let currentTitle = title;
  console.log(`\n=== 业务全链路 E2E（${BASE}）===  探针标题：${title}\n`);

  // ---- 浏览器登录 --------------------------------------------------------
  console.log('1) 浏览器登录');
  await openPath('/login', 'document.querySelectorAll("input").length >= 2');
  await evalIn(`(() => {
    const set = (sel, v) => { const e = document.querySelector(sel); const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; st.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('input[autocomplete="username"]', ${JSON.stringify(USER)});
    set('input[autocomplete="current-password"]', ${JSON.stringify(PASS)});
    return 1;
  })()`);
  await mouseClick(`document.querySelector('[data-testid="login-submit"]')`);
  const home = await waitFor("location.pathname === '/'", 30000);
  if (home.ok) ok('浏览器登录进入工作台');
  else { bad('浏览器登录进入工作台', await evalIn('location.pathname')); }

  // ---- 2) 新建 → 选班型/科目/目录 → 上传 → 保存草稿 ----------------------
  console.log('\n2) 新建 → 选班型 → 选科目 → 选目录 → 上传真实文件 → 保存草稿');
  if (FAILED === 0) {
    await openPath('/upload', 'document.querySelectorAll("[role=combobox]").length >= 4');
    await waitFor(`(() => { const c = document.querySelectorAll('[role=combobox]')[0]; return c && !c.disabled; })()`, 20000);

    const t1 = await fillByLabel('资源标题', title);
    if (t1 === 'SET') ok('填标题');
    else bad('填标题', String(t1));

    for (const [label, opt] of [['班型', 'Pre-K'], ['科目', '美德'], ['资料夹', '周次教案'], ['学期', '第一学期'], ['目录归属', 'Pre-K / 美德']]) {
      const r = await pickSelect(label, opt);
      if (r === 'PICKED') ok(`选${label} = ${opt}`);
      else bad(`选${label} = ${opt}`, r);
    }

    const fileName = `全链路-${stamp}.pdf`;
    const attached = await attachFile(fileName, PDF, 'application/pdf');
    if (String(attached).startsWith('1:')) ok('选中真实文件（真实字节）', String(attached));
    else bad('选中真实文件', String(attached));

    await installToastRecorder();
    await mouseClick(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('保存草稿'))`);
    const gotToast = await waitFor('(window.__toasts || []).length > 0', 30000);
    const toastList = (await toasts()) || [];
    if (gotToast.ok && /资源与文件均已保存/.test(toastList.join('\n'))) ok('保存草稿 → 提示"资源与文件均已保存"');
    else bad('保存草稿 → 提示"资源与文件均已保存"', toastList.join(' | ').slice(0, 160));

    // 先把 id 取出来：下面的编辑阶段要用 `/upload?id=<id>` 打开编辑页。
    // 第一版把这段放在编辑**之后**，于是编辑阶段永远拿不到 id、被静默 SKIP 掉。
    const mine = await c.req('GET', '/api/resources/mine?pageSize=100');
    const row = ((mine.d ?? {}).items ?? []).find((r) => r.title === title);
    resourceId = row?.id ?? null;
    if (resourceId) { createdResourceIds.push(resourceId); ok('新建后拿到资源 id', resourceId); }
    else bad('新建后拿到资源 id');
  } else {
    skip('新建→上传→保存草稿', '登录未通过');
  }

  // ---- 3) 编辑 → 保存 → 刷新 → 数据仍在（**必须在草稿阶段做**）---------
  //
  // 为什么强调「草稿阶段」：界面上对**已发布**资源的「编辑」按钮是 disabled 的
  // （`disabled={!canEdit(record.status)}`）—— 也就是说「编辑已发布资源」本来就
  // 不是产品支持的路径。第一版把这段放在发布之后，保存被服务端正确拒绝，
  // 却看起来像「编辑坏了」：测试做了 UI 不允许做的事。

  console.log('\n3) 编辑 → 保存 → F5 刷新 → 数据仍在（草稿阶段）');
  if (resourceId) {
    await openPath(`/upload?id=${resourceId}`, `[...document.querySelectorAll('input')].some((i) => i.value === ${JSON.stringify(currentTitle)})`);
    const prefilled = await evalIn(`[...document.querySelectorAll('input')].some((i) => i.value === ${JSON.stringify(currentTitle)})`);
    if (prefilled) ok('编辑页由接口预填了原标题');
    else bad('编辑页由接口预填了原标题');

    const t2 = await fillByLabel('资源标题', titleEdited);
    if (t2 === 'SET') ok('改标题');
    else bad('改标题', String(t2));

    await installToastRecorder();
    await mouseClick(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('保存草稿'))`);
    await waitFor('(window.__toasts || []).length > 0', 25000);

    // 先回列表页再硬刷新：上传页是表单，标题在 <input> 的 **value** 里、不在
    // innerText 里；直接刷新上传页去 innerText 里找标题，是在测一件不可能成立的事。
    await openPath('/my-resources', "!!document.querySelector('[data-testid=\"resource-detail-open\"]')");
    await hardReload(`(document.body.innerText || '').includes(${JSON.stringify(titleEdited)})`);
    const persisted = await evalIn(`(document.body.innerText || '').includes(${JSON.stringify(titleEdited)})`);
    if (persisted) ok('刷新后新标题仍在（编辑真的落库了）', titleEdited);
    else bad('刷新后新标题仍在（编辑真的落库了）', titleEdited);

    const apiCheck = await c.req('GET', `/api/resources/${resourceId}`);
    const nowTitle = (apiCheck.d?.resource ?? apiCheck.d ?? {}).title;
    if (nowTitle === titleEdited) ok('接口也确认标题已改', nowTitle);
    else bad('接口也确认标题已改', String(nowTitle));
    currentTitle = titleEdited;
  } else {
    skip('编辑 → 刷新', '未拿到资源 id');
  }

  // ---- 3) 我的资源 → 详情 ------------------------------------------------
  console.log('\n4) 我的资源 → 查看详情');
  if (FAILED === 0) {
    await openPath('/my-resources', `(document.body.innerText || '').includes(${JSON.stringify(currentTitle)})`);
    const listed = await evalIn(`(document.body.innerText || '').includes(${JSON.stringify(currentTitle)})`);
    if (listed) ok('新资源出现在「我的资源」列表里');
    else bad('新资源出现在「我的资源」列表里');


    const opened = await clickInRow('resource-detail-open', currentTitle);
    if (opened === 'CLICKED') {
      const dialog = await waitFor(
        `(() => { const d = document.querySelector('[data-testid="resource-detail-dialog"]'); if (!d) return null; const t = d.innerText || ''; return t.includes(${JSON.stringify(currentTitle)}) ? t.replace(/\\s+/g, ' ').slice(0, 60) : null; })()`,
        20000,
      );
      if (dialog.ok) {
        ok('详情弹窗打开并显示该资源', dialog.value);
      } else {
        const dump = await evalIn(`(() => {
          const d = document.querySelector('[data-testid="resource-detail-dialog"]');
          if (!d) return '(弹窗节点不存在)';
          return (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 160);
        })()`);
        bad('详情弹窗打开并显示该资源', `弹窗内容=${dump}；期望包含=${currentTitle}`);
      }
      await evalIn(`document.querySelector('[data-testid="resource-detail-dialog"]')?.closest('[role=dialog]')?.querySelector('button')?.click()`);
      await sleep(500);
    } else {
      bad('点该行的「查看」', String(opened));
    }
  } else {
    skip('我的资源 / 详情', '前置步骤未通过');
  }

  // ---- 4) 提交审核 -------------------------------------------------------
  console.log('\n5) 提交审核');
  if (resourceId) {
    await openPath('/my-resources', `(document.body.innerText || '').includes(${JSON.stringify(currentTitle)})`);
    const clicked = await clickInRow('resource-submit-review', currentTitle);
    const confirmed = clicked === 'CLICKED' ? await mouseClick(`document.querySelector('[data-testid="confirm-submit-review"]')`) : 'SKIPPED';
    await sleep(1500);
    const after = await c.req('GET', `/api/resources/${resourceId}`);
    const status = (after.d?.resource ?? after.d ?? {}).status;
    if (status === 'pending_review') ok('提交审核后状态 = pending_review', `${clicked}/${confirmed}`);
    else bad('提交审核后状态 = pending_review', `status=${status} click=${clicked} confirm=${confirmed}`);
  } else {
    skip('提交审核', '未拿到资源 id');
  }

  // ---- 5) 审核 → 发布 ----------------------------------------------------
  console.log('\n6) 审核工作台 → 通过审核（→ published）');
  if (resourceId) {
    await openPath('/review', `(document.body.innerText || '').includes(${JSON.stringify(currentTitle)}`);
    const inReview = await waitFor(`(document.body.innerText || '').includes(${JSON.stringify(currentTitle)})`, 25000);
    if (inReview.ok) ok('资源出现在审核工作台');
    else bad('资源出现在审核工作台');

    const approveClicked = await clickInRow('review-approve', currentTitle);
    const approved = approveClicked === 'CLICKED' ? await mouseClick(`document.querySelector('[data-testid="confirm-approve"]')`) : 'SKIPPED';
    await sleep(2000);
    const after = await c.req('GET', `/api/resources/${resourceId}`);
    const status = (after.d?.resource ?? after.d ?? {}).status;
    if (status === 'published') ok('审核通过后状态 = published', `${approveClicked}/${approved}`);
    else bad('审核通过后状态 = published', `status=${status}`);
  } else {
    skip('审核 → 发布', '未拿到资源 id');
  }

  // ---- 6) 目录中出现 -----------------------------------------------------
  console.log('\n7) 目录页面：该目录下能看到这条资源');
  if (resourceId) {
    const byDir = await c.req('GET', '/api/resources?directory=prek%3Avirtue&pageSize=100');
    const inDir = ((byDir.d ?? {}).items ?? []).some((r) => r.id === resourceId);
    if (inDir) ok('按目录查询能查到这条资源（已发布）');
    else bad('按目录查询能查到这条资源（已发布）', `total=${byDir.d?.total}`);

    // 徽标的数字只统计 published（见 directories.service 的口径），
    // 所以对比时也必须加 status=published —— 否则会拿"11（已发布）"
    // 去比"13（全部状态）"，看起来像对不上，其实是两个口径。
    const publishedOnly = await c.req('GET', '/api/resources?directory=prek%3Avirtue&status=published&pageSize=100');

    await openPath('/directory', '!!document.querySelector("[data-dir-code]")');
    await expandUntil(`[data-dir-code="prek:virtue"]`);
    const badge = await evalIn(`(() => {
      const el = document.querySelector('[data-dir-code="prek:virtue"]');
      if (!el) return null;
      const t = el.innerText || '';
      return t.replace(/\\s+/g, ' ').trim().slice(0, 80);
    })()`);
    const want = String(publishedOnly.d?.total ?? '');
    if (badge && /\d/.test(badge)) ok('目录页该节点显示了资源数徽标', `${badge}`);
    else bad('目录页该节点显示了资源数徽标', String(badge));
    console.log(`        （接口给出该目录已发布资源数 total=${want}）`);
  } else {
    skip('目录中出现', '未拿到资源 id');
  }

  // ---- 7) 下载 → 字节一致 ------------------------------------------------
  console.log('\n8) 下载 → 字节一致');
  if (resourceId) {
    const dl = await c.req('GET', `/api/resources/${resourceId}/download`);
    if (dl.s !== 302) {
      bad('第一跳换取下载令牌', `HTTP ${dl.s}（存储未配置时 503 是预期内的，见 SKIP 说明）`);
      if (dl.s === 503) skip('下载字节比对', '服务端未配置对象存储，无法取回字节');
    } else {
      const hop2 = await c.rawGet(new URL(String(dl.location), BASE));
      const signed = hop2.headers.get('location');
      const got = signed ? await fetch(signed) : null;
      if (got && got.status === 200) {
        const bytes = Buffer.from(await got.arrayBuffer());
        if (bytes.equals(PDF)) ok('下载回来的字节与上传的逐字节一致', `${bytes.length}B`);
        else bad('下载回来的字节与上传的逐字节一致', `${bytes.length}B vs ${PDF.length}B`);
      } else {
        bad('从签名直链取回字节', `HTTP ${got?.status}`);
      }
    }
  } else {
    skip('下载 → 字节一致', '未拿到资源 id');
  }

  // ---- 9) 删除 → 回收站 → 恢复 -------------------------------------------
  console.log('\n9) 删除 → 回收站 → 恢复 → 再出现');
  if (resourceId) {
    await openPath('/my-resources', `(document.body.innerText || '').includes(${JSON.stringify(titleEdited)})`);
    const delClicked = await clickInRow('resource-delete', currentTitle);
    const delConfirmed = delClicked === 'CLICKED' ? await mouseClick(`document.querySelector('[data-testid="confirm-delete"]')`) : 'SKIPPED';
    await sleep(1500);

    const list = await c.req('GET', '/api/resources?pageSize=100&keyword=' + encodeURIComponent(currentTitle));
    const stillListed = ((list.d ?? {}).items ?? []).some((r) => r.id === resourceId);
    if (!stillListed) ok('删除后从正常列表消失', `${delClicked}/${delConfirmed}`);
    else bad('删除后从正常列表消失', '仍在列表里');

    const bin = await c.req('GET', '/api/resources/recycle-bin?pageSize=100');
    const inBin = ((bin.d ?? {}).items ?? []).some((r) => r.id === resourceId);
    if (inBin) ok('资源进入回收站（recycle-bin 查得到）');
    else bad('资源进入回收站（recycle-bin 查得到）', `HTTP ${bin.s}`);

    // 用户要求的"删除→回收站→恢复"必须是**界面上走得到**的一条路。
    // 上一版这里是一条 SKIP（当时前端确实没有回收站页面）；现在补了页面，
    // 断言就要落在真实点击上 —— 接口能通不等于用户点得到。
    const groupExpanded = await evalIn(`(() => {
      const btn = document.querySelector('[data-testid="nav-group-toggle"][data-nav="/admin"]');
      if (!btn) return 'NO_GROUP';
      if (btn.getAttribute('aria-expanded') !== 'true') {
        for (const e of ['mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
      }
      return 'EXPANDED';
    })()`);
    await sleep(600);
    const navLink = await evalIn(`(() => {
      const a = document.querySelector('[data-testid="nav-link"][data-nav="/admin/recycle-bin"]');
      return a ? (a.innerText || '').trim() : null;
    })()`);
    if (navLink) ok('侧边栏出现「回收站」入口', `${groupExpanded} / label=${navLink}`);
    else bad('侧边栏出现「回收站」入口', `group=${groupExpanded}，未渲染 [data-nav="/admin/recycle-bin"]`);

    const navClicked = navLink ? await mouseClick(`document.querySelector('[data-testid="nav-link"][data-nav="/admin/recycle-bin"]')`) : 'SKIPPED';
    const onBin = await waitFor(`location.pathname === '/admin/recycle-bin' && !!document.querySelector('[data-testid="recycle-restore"]')`);
    if (onBin.ok) ok('点击导航进入回收站页面', `${navClicked} -> ${await evalIn('location.pathname')}`);
    else bad('点击导航进入回收站页面', `${navClicked} -> ${await evalIn('location.pathname')}`);

    const binRow = await evalIn(`(() => {
      const rows = [...document.querySelectorAll('tbody tr.ant-table-row')];
      return rows.some((r) => (r.innerText || '').includes(${JSON.stringify(currentTitle)})) ? rows.length : 0;
    })()`);
    if (binRow > 0) ok('回收站列表里出现刚删除的资源', `共 ${binRow} 行`);
    else bad('回收站列表里出现刚删除的资源', `表格里找不到「${currentTitle}」`);

    const restoreClicked = await clickInRow('recycle-restore', currentTitle);
    const restoreConfirmed = restoreClicked === 'CLICKED'
      ? await mouseClick(`document.querySelector('[data-testid="confirm-restore"]')`)
      : 'SKIPPED';
    await sleep(1800);

    const restored = await c.req('POST', `/api/resources/${resourceId}/restore`);
    if (restored.s === 404) ok('界面上已恢复（接口二次恢复按预期 404「不在回收站中」拒绝）', `${restoreClicked}/${restoreConfirmed}`);
    else if (restored.s === 200 || restored.s === 201) bad('恢复走的应是界面路径', `界面点击 ${restoreClicked}/${restoreConfirmed} 后接口仍允许二次恢复 HTTP ${restored.s}`);
    else bad('恢复走的应是界面路径', `界面 ${restoreClicked}/${restoreConfirmed}，二次恢复 HTTP ${restored.s}`);

    const binAfter = await c.req('GET', '/api/resources/recycle-bin?pageSize=100');
    const stillInBin = ((binAfter.d ?? {}).items ?? []).some((r) => r.id === resourceId);
    if (!stillInBin) ok('恢复后从回收站移除');
    else bad('恢复后从回收站移除', '仍在回收站里');

    const back = await c.req('GET', `/api/resources/${resourceId}`);
    const backStatus = (back.d?.resource ?? back.d ?? {}).status;
    const backDeleted = (back.d?.resource ?? back.d ?? {}).deletedAt;
    if (back.s === 200 && !backDeleted) ok('恢复后资源重新可见（deletedAt 为空）', String(backStatus));
    else bad('恢复后资源重新可见', `HTTP ${back.s} deletedAt=${backDeleted}`);
  } else {
    skip('删除 → 回收站 → 恢复', '未拿到资源 id');
  }

  // ---- 10) 授权 → 重新登录 → 生效 / 撤销 → 旧 Session → 失效 --------------
  console.log('\n10) 权限授权→重登生效；撤销→旧 Session 失效');
  // 这一组只依赖"能建账号"，与上面的资源链路无关 ——
  // 第一版用 `FAILED === 0` 把它一起挡掉了，等于让一条无关的失败替它做决定。
  if (true) {
    probeTeacherUsername = `biz_probe_${stamp}`;
    const created = await c.req('POST', '/api/teachers', {
      username: probeTeacherUsername,
      name: `全链路探针账号 ${stamp}`,
      roles: ['visitor'],
      status: 'active',
    });
    probeTeacherId = created.d?.id ?? created.d?.teacher?.id ?? null;
    const tempPw = created.d?.temporaryPassword ?? created.d?.tempPassword ?? null;
    if (!probeTeacherId || !tempPw) {
      bad('建探针账号', `HTTP ${created.s} ${JSON.stringify(created.d).slice(0, 120)}`);
    } else {
      ok('建探针账号（visitor）', probeTeacherUsername);
      const probe = makeClient();
      await probe.login(probeTeacherUsername, tempPw);
      const newPw = `Biz!${stamp}aA9x`;
      const changed = await probe.req('POST', '/api/auth/change-password', { currentPassword: tempPw, newPassword: newPw });
      if (changed.s === 200 || changed.s === 201) ok('探针账号改密成功（脱离强制改密态）');
      else bad('探针账号改密成功', `HTTP ${changed.s}`);

      const probe2 = makeClient();
      await probe2.login(probeTeacherUsername, newPw);
      const before = await probe2.req('GET', '/api/resources?pageSize=1');
      // visitor 默认没有 resource.view，所以这里**应当**被拒。
      // 第一版把它当成"环境没准备好"而跳过 —— 其实它是一条有意义的行为断言。
      if (before.s === 403 || before.s === 401) {
        ok('授权前：visitor 读资源列表被拒（未授权的正确基线）', `HTTP ${before.s}`);
      } else {
        bad('授权前：visitor 读资源列表被拒', `HTTP ${before.s}`);
      }

      // 授权：给该账号追加 resource.delete（visitor 默认没有）
      const grant = await c.req('POST', `/api/teachers/${probeTeacherId}/permission-overrides/grant`, { permission: 'resource.delete' });
      if (grant.s === 200 || grant.s === 201) {
        ok('授予 resource.delete（追加授权）');
        overridesToClear.push({ teacherId: probeTeacherId, permission: 'resource.delete' });
      } else {
        bad('授予 resource.delete', `HTTP ${grant.s} ${JSON.stringify(grant.d).slice(0, 120)}`);
      }

      // "授权 → 重新登录 → 生效"：新会话里该权限必须体现出来
      const relogin = makeClient();
      await relogin.login(probeTeacherUsername, newPw);
      const perms = await relogin.req('GET', '/api/auth/me/permissions');
      const list = Array.isArray(perms.d) ? perms.d : (perms.d?.permissions ?? []);
      if (list.includes('resource.delete')) ok('重新登录后 /api/auth/me/permissions 含 resource.delete');
      else bad('重新登录后含 resource.delete', JSON.stringify(list).slice(0, 140));

      // "撤销 → 旧 Session → 权限失效"：撤销后**同一个会话**必须立刻失效
      const revoke = await c.req('DELETE', `/api/teachers/${probeTeacherId}/permission-overrides/resource.delete`);
      if (revoke.s === 200 || revoke.s === 204) ok('撤销 resource.delete');
      else bad('撤销 resource.delete', `HTTP ${revoke.s}`);

      const after = await relogin.req('GET', '/api/auth/me/permissions');
      const list2 = Array.isArray(after.d) ? after.d : (after.d?.permissions ?? []);
      if (!list2.includes('resource.delete')) {
        ok('撤销后**旧 Session** 立刻不再拥有该权限（permissionsVersion 生效）', `HTTP ${after.s}`);
      } else {
        bad('撤销后旧 Session 立刻不再拥有该权限', JSON.stringify(list2).slice(0, 140));
      }
    }
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

  const c = makeClient();
  try {
    await c.login(USER, PASS);
    for (const { teacherId, permission } of overridesToClear) {
      await c.req('DELETE', `/api/teachers/${teacherId}/permission-overrides/${permission}`);
    }
    // 探针资源**硬删**：软删除的行仍会被目录外键拦住，清理不干净会留残留。
    const dbUrl = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB;
    if (dbUrl) {
      const postgres = (await import('postgres')).default;
      const sql = postgres(dbUrl, { max: 1 });
      for (const id of createdResourceIds) {
        const n = await sql`DELETE FROM resources WHERE id = ${id}`;
        if (n.count > 0) console.log(`\n清理：硬删除探针资源 ${id} → ${n.count} 行`);
      }
      // 兜底：按本次运行的 stamp 再扫一遍。
      // 只按 id 删是不够的 —— 如果脚本在"资源已建好、但 id 还没查出来"时失败，
      // createdResourceIds 里什么都没有，那一行就永久留在库里（实测积了 4 行）。
      if (runStamp) {
        const stray = await sql`DELETE FROM resources WHERE title LIKE ${'全链路探针%' + runStamp + '%'}`;
        if (stray.count > 0) console.log(`清理：按 stamp 兜底删除探针资源 → ${stray.count} 行`);
        const strayT = await sql`DELETE FROM teachers WHERE username = ${'biz_probe_' + runStamp}`;
        if (strayT.count > 0) console.log(`清理：按 stamp 兜底删除探针账号 → ${strayT.count} 行`);
      }
      if (probeTeacherUsername) {
        const t = await sql`DELETE FROM teachers WHERE username = ${probeTeacherUsername}`;
        const left = await sql`SELECT count(*)::int AS n FROM teachers WHERE username = ${probeTeacherUsername}`;
        if (left[0]?.n === 0) console.log(`清理：硬删除探针账号 ${probeTeacherUsername} → ${t.count} 行，复查残留 0`);
        else console.error(`  ⚠️  探针账号未清理干净：${probeTeacherUsername}`);
      }
      await sql.end();
    }
  } catch (e) {
    console.error(`\n清理失败：${e?.message}`);
  }
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
