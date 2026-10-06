/**
 * scripts/verify-directory-web.mjs —— §1 目录模型的**浏览器级**三项硬要求。
 *
 *   BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' node scripts/verify-directory-web.mjs
 *
 * 用户对 §1 提了三条明确、可判定、且**此前没有任何测试覆盖**的要求：
 *
 *   1. 目录修改后**刷新浏览器仍然存在**（不是内存里的假象）；
 *   2. 新增目录**无需修改代码**即可在网页出现（目录来自数据库，不是硬编码数组）；
 *   3. **目录页面能够查询到属于该目录的资源**。
 *
 * `verify-browser-e2e.mjs` 的 §24 建过文件夹，但它建完就删，**从不刷新页面** ——
 * 于是第 1 条完全没被验过：一个"只活在 React state 里、刷新就没"的实现也能通过。
 * 这个脚本专门补上"刷新"这一步。
 *
 * 断言策略：每一步都问"**发生了什么**"，而不是"我点了什么按钮"。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9295);

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  SKIP  ${label}  -> ${reason}`); SKIPPED++; };

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
      method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b),
    });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空 */ }
    return { s: r.status, d };
  }
  return { req };
}

const profile = mkdtempSync(join(tmpdir(), 'qls-dirweb-'));
let chrome = null;
let createdFolderCode = null;
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

  const c = makeClient();
  await c.req('GET', '/');
  const login = await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
  if (login.s !== 201 && login.s !== 200) {
    console.error(`登录失败：HTTP ${login.s}`);
    process.exit(2);
  }

  // 选一个 allowCustomFolders=true 的叶节点作为父目录（不写死具体 code：
  // 哪些节点允许自建是数据决定的，写死会在数据变化时变成一条脆弱断言）。
  const tree = await c.req('GET', '/api/directories/tree');
  const flat = [];
  const walk = (ns) => { for (const n of ns ?? []) { flat.push(n); walk(n.children); } };
  walk((tree.d ?? {}).roots ?? []);
  const parent = flat.find((n) => n.allowCustomFolders === true);
  if (!parent) {
    console.error('找不到任何 allowCustomFolders=true 的节点，无法验证自建文件夹。');
    process.exit(2);
  }
  const stamp = Date.now().toString().slice(-6);
  const folderName = `刷新探针-${stamp}`;

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
  /** 整页重新加载（不是 SPA 路由跳转）—— 这才是"刷新"。 */
  const hardReload = async (until, timeoutMs = 45000) => {
    await send('Page.reload', { ignoreCache: true });
    await waitFor(until, timeoutMs);
    await sleep(400);
  };
  const fill = async (sel, value) => evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
  })()`);
  /**
   * 把目录树逐层展开，直到目标选择器出现。
   *
   * 目录页是**可折叠**的树：`prek:english_lesson` 这种深层节点在祖先收起时
   * 根本不进 DOM，直接 `querySelector` 会得到 NOT_FOUND —— 那不是"按钮不见了"，
   * 是"还没渲染出来"。第一版就是这么误报的（4 条 FAIL 全是这一个原因）。
   */
  const expandUntil = async (selector, maxRounds = 12) => {
    for (let i = 0; i < maxRounds; i += 1) {
      if (await evalIn(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      const clicked = await evalIn(`(() => {
        const toggles = [...document.querySelectorAll('[data-dir-toggle]')];
        let n = 0;
        for (const t of toggles) {
          // 只点"还没展开"的那些；已展开的再点会把它合上，来回打架。
          if (t.getAttribute('aria-expanded') === 'true') continue;
          for (const e of ['mousedown', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
          }
          n += 1;
        }
        return n;
      })()`);
      await sleep(600);
      if (!clicked) break;
    }
    return evalIn(`!!document.querySelector(${JSON.stringify(selector)})`);
  };

  const clickSel = async (sel) => evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({ block: 'center' });
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
    return 'CLICKED';
  })()`);

  await send('Page.enable'); await send('Runtime.enable');

  console.log(`\n=== §1 目录模型浏览器验证（${BASE}）===\n`);

  // ---- 浏览器登录 ----
  console.log('1) 浏览器登录');
  await openPath('/login', 'document.querySelectorAll("input").length >= 2');
  await fill('input[autocomplete="username"]', USER);
  await fill('input[autocomplete="current-password"]', PASS);
  await clickSel('[data-testid="login-submit"]');
  const home = await waitFor("location.pathname === '/'", 30000);
  if (home.ok) ok('浏览器登录进入工作台');
  else bad('浏览器登录进入工作台', await evalIn('location.pathname'));

  // ---- 2. 在界面上新建一个目录 ----
  console.log('\n2) 在界面上新建目录');
  if (FAILED === 0) {
    await openPath('/directory', '!!document.querySelector("[data-dir-code]")');
    const hasTree = await evalIn('!!document.querySelector("[data-dir-code]")');
    if (hasTree) ok('目录页渲染出目录树');
    else bad('目录页渲染出目录树');

    const revealed = await expandUntil(`[data-dir-create="${parent.code}"]`);
    if (revealed) ok(`展开目录树后找到父节点 ${parent.code} 的「新建子目录」按钮`);
    else bad(`展开目录树后找到父节点 ${parent.code} 的「新建子目录」按钮`, 'NOT_FOUND');

    const createBtn = await clickSel(`[data-dir-create="${parent.code}"]`);
    if (createBtn === 'CLICKED') ok(`点「新建子目录」（父节点 ${parent.code}）`);
    else bad(`点「新建子目录」（父节点 ${parent.code}）`, String(createBtn));

    const inputShown = await waitFor(`!!document.querySelector('[data-dir-name-input="${parent.code}"]')`, 15000);
    if (inputShown.ok) ok('出现名称输入框');
    else bad('出现名称输入框');

    await fill(`[data-dir-name-input="${parent.code}"]`, folderName);
    await clickSel(`[data-dir-submit="${parent.code}"]`);

    const appeared = await waitFor(
      `!!document.querySelector('[data-dir-name=' + JSON.stringify(${JSON.stringify(folderName)}) + ']')`,
      25000,
    );
    if (appeared.ok) ok('提交后新目录出现在树里', folderName);
    else bad('提交后新目录出现在树里', folderName);

    createdFolderCode = await evalIn(`(() => {
      const el = document.querySelector('[data-dir-name=' + JSON.stringify(${JSON.stringify(folderName)}) + ']');
      return el ? el.getAttribute('data-dir-code') : null;
    })()`);
    if (createdFolderCode) ok('拿到新目录的 code', createdFolderCode);
    else bad('拿到新目录的 code', 'NOT_FOUND');
  } else {
    skip('在界面上新建目录', '登录未通过');
  }

  // ---- 3. **硬刷新**后仍然存在（用户要求第 1 条）----
  console.log('\n3) 刷新浏览器后目录仍然存在（硬要求 1）');
  if (createdFolderCode) {
    await hardReload('!!document.querySelector("[data-dir-code]")');
    // 刷新后树回到收起状态，同样要重新展开才能看到深层节点。
    await expandUntil(`[data-dir-name=' + JSON.stringify(${JSON.stringify(folderName)}) + ']`);
    const stillThere = await evalIn(
      `!!document.querySelector('[data-dir-name=' + JSON.stringify(${JSON.stringify(folderName)}) + ']')`,
    );
    if (stillThere) ok('F5 硬刷新后新目录仍在（不是内存里的假象）', folderName);
    else bad('F5 硬刷新后新目录仍在（不是内存里的假象）', folderName);

    // 服务端也确认一遍：刷新看到的不可能是前端凭空的。
    const serverTree = await c.req('GET', '/api/directories/tree');
    const flat2 = [];
    const walk2 = (ns) => { for (const n of ns ?? []) { flat2.push(n); walk2(n.children); } };
    walk2((serverTree.d ?? {}).roots ?? []);
    if (flat2.some((n) => n.code === createdFolderCode)) ok('服务端目录树里也确实存在该节点', createdFolderCode);
    else bad('服务端目录树里也确实存在该节点', createdFolderCode);
  } else {
    skip('刷新后仍然存在', '未成功创建目录');
  }

  // ---- 4. 无需改代码即可出现在上传页（用户要求第 2 条）----
  console.log('\n4) 新目录无需改代码即可在上传页出现（硬要求 2）');
  if (createdFolderCode) {
    await openPath('/upload', 'document.querySelectorAll("[role=combobox]").length >= 4');

    // 「目录归属」下拉在**未选班型时是禁用的**（有意的设计：候选要按班型过滤）。
    // 不先选班型就点它，等于点一个禁用控件 —— 第一版就是这么误报成"新目录没出现"的。
    await evalIn(`(() => {
      const combo = [...document.querySelectorAll('[role=combobox]')].find((c) => {
        let n = c;
        for (let i = 0; i < 6 && n; i += 1) {
          n = n.parentElement;
          if (n && n.querySelector('label')) return (n.querySelector('label').innerText || '').includes('班型');
        }
        return false;
      });
      if (!combo) return 'NO_COMBO';
      const mk = (t) => t.startsWith('pointer')
        ? new PointerEvent(t, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window })
        : new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window });
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) combo.dispatchEvent(mk(t));
      return 'OPENED';
    })()`);
    await sleep(700);
    // 真实鼠标点 "Pre-K"（合成事件点不中 Radix 的选项，见 upload-web 里的同类教训）
    const rect = await evalIn(`(() => {
      const opt = [...document.querySelectorAll('[role=option]')].find((o) => (o.innerText || '').trim() === 'Pre-K');
      if (!opt) return null;
      opt.scrollIntoView({ block: 'nearest' });
      const r = opt.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (rect) {
      const { x, y } = JSON.parse(rect);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0, pointerType: 'mouse' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await sleep(700);
    }
    const picked = await evalIn(`(() => {
      const combo = [...document.querySelectorAll('[role=combobox]')].find((c) => {
        let n = c;
        for (let i = 0; i < 6 && n; i += 1) {
          n = n.parentElement;
          if (n && n.querySelector('label')) return (n.querySelector('label').innerText || '').includes('班型');
        }
        return false;
      });
      return combo ? (combo.innerText || '').trim() : null;
    })()`);
    if (picked === 'Pre-K') ok('先选班型 = Pre-K（目录下拉此时才可用）');
    else bad('先选班型 = Pre-K（目录下拉此时才可用）', String(picked));

    // 触发一次下拉打开，把候选项渲染出来再检查。
    const opened = await evalIn(`(() => {
      const combos = [...document.querySelectorAll('[role=combobox]')].find((c) => {
        let n = c;
        for (let i = 0; i < 6 && n; i += 1) {
          n = n.parentElement;
          if (n && n.querySelector('label')) return (n.querySelector('label').innerText || '').includes('目录归属');
        }
        return false;
      });
      if (!combos) return 'NO_COMBO';
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        combos.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window }));
      }
      return 'OPENED';
    })()`);
    if (opened !== 'OPENED') {
      bad('上传页能打开「目录归属」下拉', String(opened));
    } else {
      const listed = await waitFor(
        `[...document.querySelectorAll('[role=option]')].some((o) => (o.innerText || '').includes(${JSON.stringify(folderName)}))`,
        15000,
      );
      if (listed.ok) ok('新目录出现在上传页的「目录归属」候选里（没有改过任何代码）', folderName);
      else bad('新目录出现在上传页的「目录归属」候选里（没有改过任何代码）', folderName);
    }
  } else {
    skip('上传页出现新目录', '未成功创建目录');
  }

  // ---- 5. 目录页面能查到属于该目录的资源（用户要求第 3 条）----
  console.log('\n5) 目录页面能查到属于该目录的资源（硬要求 3）');
  if (createdFolderCode) {
    const created = await c.req('POST', '/api/resources', {
      title: `目录归属探针 ${stamp}`,
      program: 'prek',
      subject: 'virtue',
      folderType: 'weekly_plans',
      status: 'published',
    });
    const rid = created.d?.id ?? created.d?.resource?.id ?? null;
    if (!rid) {
      bad('建一条探针资源', `HTTP ${created.s}`);
    } else {
      // 记进数组：这个 rid 在下面会被 ridB "盖掉"，
      // 只用一个变量的写法每跑一次就会在库里漏一行（实测漏了 4 行）。
      createdResourceIds.push(rid);
      // 归属到刚建的自建目录（自建目录在 k:chinese:arts_lesson 下，所以 program/subject 要对上）
      // **必须重新拉一次目录树**再取 id。
      //
      // 之前用的是脚本开头那份 `flat`，而那个快照是在**新建目录之前**取的 ——
      // 于是 `find(...)` 返回 undefined、`.id` 得到 undefined，资源被建成"未归属"，
      // 查询自然是 0。这是本轮第三个"读了自己过期的数据"造成的假失败。
      const freshTree = await c.req('GET', '/api/directories/tree');
      const flatFresh = [];
      const walkFresh = (ns) => { for (const n of ns ?? []) { flatFresh.push(n); walkFresh(n.children); } };
      walkFresh((freshTree.d ?? {}).roots ?? []);
      const freshNode = flatFresh.find((n) => n.code === createdFolderCode);
      if (!freshNode) {
        bad('重新拉取目录树后能找到新目录', createdFolderCode);
      } else {
        // 探针目录建在 `prek:english_lesson` 下，所以资源必须与之一致
        // （program=prek、subject=english）。写错 subject 会得到一个**正确**的 400
        // 「未知的子科目」——第一版就是这么把自己的笔误报成"功能坏了"的。
        const relink = await c.req('POST', '/api/resources', {
          title: `目录归属探针B ${stamp}`,
          program: 'prek',
          subject: 'english',
          folderType: 'weekly_plans',
          directoryId: freshNode.id,
          status: 'published',
        });
        const ridB = relink.d?.id ?? relink.d?.resource?.id ?? null;
        if (ridB) createdResourceIds.push(ridB);

        if (relink.s === 201 && ridB) {
          const byDir = await c.req('GET', `/api/resources?directory=${encodeURIComponent(createdFolderCode)}&pageSize=100`);
          const inDir = ((byDir.d ?? {}).items ?? []).some((r) => r.id === ridB);
          if (inDir) ok('按该目录查询能查到归属其中的资源', createdFolderCode);
          else bad('按该目录查询能查到归属其中的资源', `HTTP ${byDir.s} total=${byDir.d?.total}`);

          // 再看一眼归属确实写在行上（而不是查询凑巧命中）。
          const detail = await c.req('GET', `/api/resources/${ridB}`);
          const row = detail.d?.resource ?? detail.d ?? {};
          if (row.directoryId === freshNode.id) ok('资源行上的 directoryId 正是该目录', row.directoryId);
          else bad('资源行上的 directoryId 正是该目录', `got=${row.directoryId} want=${freshNode.id}`);
        } else {
          bad('把资源归属到该目录', `HTTP ${relink.s} ${String(relink.d?.error?.message ?? '')}`);
        }

        // ---------------------------------------------------------------
        // 6) 界面上真的能点进去看到该目录的资源
        // ---------------------------------------------------------------
        // 上一节证明的是**接口**能按目录查。接口能查 ≠ 用户在目录页点得到 ——
        // 而 §1 的原话是"目录页能查到该目录下资源"。缺了这一段，
        // "目录页" 就只剩一棵树 + 数字，没有任何下钻入口。
        console.log('\n6) 界面上点开目录名 → 看到该目录下的资源');
        if (!ridB) {
          skip('界面上点开目录名看到资源', '未成功把资源归属到新目录');
        } else {
          await openPath('/directory', `!!document.querySelector('[data-testid="directory-tree"]')`);
          const hint = await evalIn(`!!document.querySelector('[data-testid="directory-browse-hint"]')`);
          if (hint) ok('目录页说明了"点目录名可查看资源"');
          else bad('目录页说明了"点目录名可查看资源"', '没有 directory-browse-hint');

          // 探针目录是**新建的深层节点**，默认折叠，必须先展开到它出现。
          // 直接 querySelector 一定拿不到 —— 折叠的节点不在 DOM 里。
          const revealSelector = `[data-testid="directory-browse"][data-dir-browse="${createdFolderCode}"]`;
          const revealed = await expandUntil(revealSelector, 12);
          if (revealed) ok('展开后目录名成为可点按钮', createdFolderCode);
          else bad('展开后目录名成为可点按钮', `DOM 里找不到 ${revealSelector}`);

          const clicked = revealed ? await clickSel(revealSelector) : 'SKIPPED';
          const opened = await waitFor(`!!document.querySelector('[data-testid="directory-resources"]')`, 15000);
          if (opened.ok) ok('点击后资源面板出现', clicked);
          else bad('点击后资源面板出现', clicked);

          const panelCode = await evalIn(`document.querySelector('[data-testid="directory-resources"]')?.getAttribute('data-dir-resources')`);
          if (panelCode === createdFolderCode) ok('面板对应的是被点的那个目录', panelCode);
          else bad('面板对应的是被点的那个目录', `got=${panelCode} want=${createdFolderCode}`);

          // 面板内容是**异步**拉的。只等"面板出现"是不够的 ——
          // 上一版就是这么读到了"加载中..."，然后把它报成"面板里没有这条资源"。
          // 等"加载完成"的三种终态之一（有内容 / 空态 / 错误态）再断言。
          await waitFor(`(() => {
            const p = document.querySelector('[data-testid="directory-resources"]');
            if (!p) return false;
            if (p.querySelector('[data-testid="directory-resources-empty"]')) return true;
            if (p.querySelector('[data-testid="directory-resources-error"]')) return true;
            return (p.innerText || '').includes(${JSON.stringify(`目录归属探针B ${stamp}`)});
          })()`, 20000);

          const panelText = await evalIn(`(document.querySelector('[data-testid="directory-resources"]')?.innerText || '')`);
          if (panelText.includes(`目录归属探针B ${stamp}`)) ok('面板里列出了归属该目录的探针资源');
          else bad('面板里列出了归属该目录的探针资源', panelText.replace(/\s+/g, ' ').slice(0, 160));

          const errBlock = await evalIn(`!!document.querySelector('[data-testid="directory-resources-error"]')`);
          if (!errBlock) ok('面板没有把失败渲染成错误块');
          else bad('面板没有把失败渲染成错误块', '出现了 directory-resources-error');

          const closed = await clickSel('[data-testid="directory-resources-close"]');
          await sleep(600);
          const gone = !(await evalIn(`!!document.querySelector('[data-testid="directory-resources"]')`));
          if (closed === 'CLICKED' && gone) ok('关闭按钮能收起面板');
          else bad('关闭按钮能收起面板', `${closed} gone=${gone}`);
        }
      }
    }
  } else {
    skip('目录页查到该目录资源', '未成功创建目录');
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
    await c.req('GET', '/');
    await c.req('POST', '/api/auth/login', { username: USER, password: PASS });

    // 先把探针资源**彻底**删掉，再删目录。
    //
    // 为什么不能只调 DELETE /api/resources/:id：那是**软删除**（回收站），
    // 行还在、`directory_id` 也还在，于是外键 ON DELETE RESTRICT 仍然拦着目录 ——
    // 实测就是这样留下了一个删不掉的探针目录，而且当时服务端还回 500。
    // 所以这里走 SQL 硬删，与 mfa-web / directories 的清理方式一致。
    if (createdResourceIds.length > 0 || createdFolderCode) {
      const dbUrl = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB;
      if (dbUrl) {
        const postgres = (await import('postgres')).default;
        const sql = postgres(dbUrl, { max: 1 });
        for (const rid of createdResourceIds) {
          const n = await sql`DELETE FROM resources WHERE id = ${rid}`;
          console.log(`清理：硬删除探针资源 ${rid} → ${n.count} 行`);
        }
        if (createdFolderCode) {
          // 兜底：把任何仍指向该目录的行解除归属，避免残留挡住目录删除。
          const u = await sql`UPDATE resources SET directory_id = NULL WHERE directory_id = (SELECT id FROM directories WHERE code = ${createdFolderCode})`;
          if (u.count > 0) console.log(`      解除 ${u.count} 行对探针目录的归属`);
        }
        await sql.end();
      } else {
        console.error('\n未设置 DATABASE_URL / AUTHZ_TEST_DB，无法硬删探针数据');
      }
    }

    if (createdFolderCode) {
      const del = await c.req('DELETE', `/api/directories/node/${encodeURIComponent(createdFolderCode)}`);
      console.log(`清理：删除探针目录 ${createdFolderCode} → HTTP ${del.s}`);
      if (del.s >= 400) {
        console.error(`  ⚠️  目录未删除，请手动清理：${createdFolderCode}`);
      }
    }
  } catch (e) {
    console.error(`\n清理失败：${e?.message}`);
  }
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
