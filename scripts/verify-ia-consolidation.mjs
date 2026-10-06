/**
 * scripts/verify-ia-consolidation.mjs —— §1/§2/§3/§5/§7/§8/§10/§11 的**浏览器级**验证。
 *
 *   BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' node scripts/verify-ia-consolidation.mjs
 *
 * 用户对"信息架构收口"提了一串**必须真的在浏览器里成立**的要求。它们的共同点是：
 * API 通过完全不能说明问题 —— 一个接口全绿、而界面上名字对不上、链接点不动、
 * 刷新就没了的实现，同样能让所有接口测试通过。这个脚本只做浏览器断言。
 *
 * 覆盖的链路（每条都按用户的原话）：
 *   A §11 侧边栏由数据库驱动（改名后侧边栏跟着变，不是第二份写死的菜单）
 *   B §3  /directory 是**浏览**视图：Pre-K → 美德 → 课程大纲 → 资源
 *   C §2/§5 把「美德」改名 → **刷新** → 四处同时变（侧边栏 / Pre-K 首页 /
 *           目录管理页 / 上传页），且 code 不变
 *   D §7  上传页**不再有**那 6 个 legacy 资料夹下拉
 *   E §8  上传时必须选目录；没选就交不上去
 *   F §10 教师成长是一等入口：教师成长 → L1 → 安全施教规范 → 应急预案 →
 *           传染病识别与防治
 *   G §8  待补齐目录归属页：两个原因分开计数，且数字来自服务端
 *   H §11 旧 URL（/prek/virtue、/prek/montessori/practical-life）仍然可用
 *
 * 断言策略：每一步都问"**页面上现在是什么**"，而不是"我点了什么"。
 * 改名的断言尤其如此 —— 只看"点击成功了"完全没有意义，必须读出文字。
 */
import { spawn } from 'node:child_process';
import { purgeProbeResources } from '../tests/helpers/probe-cleanup.mjs';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9296);

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}

let PASSED = 0;
let FAILED = 0;
let SKIPPED = 0;
const ok = (label, detail = '') => {
  console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`);
  PASSED += 1;
};
const bad = (label, detail = '') => {
  console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`);
  FAILED += 1;
};
const skip = (label, reason) => {
  console.log(`  SKIP  ${label}  -> ${reason}`);
  SKIPPED += 1;
};

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, {
      method: m,
      headers: h,
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    store(r);
    let d = null;
    try {
      d = await r.json();
    } catch {
      /* 204 / 空响应体 */
    }
    return { s: r.status, d };
  }
  return { req };
}

const profile = mkdtempSync(join(tmpdir(), 'qls-ia-'));
let chrome = null;
/** 改名探针：跑完必须还原，否则会把测试库的名字永久改掉。 */
let renamedFrom = null;
/** 本套件创建的资源与自建文件夹 —— 收尾**真正删除**（DELETE 只是软删除，会进回收站）。 */
const createdResourceIds = [];
const createdFolderCodes = [];

async function main() {
  const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const chromePath = process.env.CHROME_BIN || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) {
    console.error('找不到 Chrome/Chromium（可用 CHROME_BIN 指定）。');
    process.exit(2);
  }

  const c = makeClient();
  await c.req('GET', '/');
  const login = await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
  if (login.s !== 200 && login.s !== 201) {
    console.error(`登录失败：HTTP ${login.s}`);
    process.exit(2);
  }
  const me = await c.req('GET', '/api/auth/me');
  if (me.d?.roles?.includes('principal') !== true && me.d?.roles?.includes('super_admin') !== true) {
    console.error('这个套件需要 principal / super_admin（要能改名与查看管理页）。');
    process.exit(2);
  }

  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1600,1400',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page') || null;
    } catch {
      /* 还没起来 */
    }
    if (!target) await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) {
    console.error('CDP 未就绪。');
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalIn = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evalIn(expression);
      if (last) return { ok: true, value: last };
      await sleep(300);
    }
    return { ok: false, value: last };
  };
  const openPath = async (path, until, timeoutMs = 45000) => {
    await send('Page.navigate', { url: `${BASE}${path}` });
    await waitFor(until, timeoutMs);
    await sleep(400);
  };
  /** 整页重新加载 —— 这才是"刷新"。SPA 路由跳转不会重新拉目录树。 */
  const hardReload = async (until, timeoutMs = 45000) => {
    await send('Page.reload', { ignoreCache: true });
    await waitFor(until, timeoutMs);
    await sleep(500);
  };
  const text = async (sel) =>
    evalIn(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? (el.innerText || '').replace(/\\s+/g,' ').trim() : null; })()`,
    );
  const exists = async (sel) => evalIn(`!!document.querySelector(${JSON.stringify(sel)})`);
  const pathname = async () => evalIn('location.pathname');

  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', clickCount: 0, pointerType: 'mouse',
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse',
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse',
    });
  };
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
  const controlExpr = (selector, label) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((c) => {
    let n = c;
    for (let i = 0; i < 6 && n; i += 1) {
      n = n.parentElement;
      if (n && n.querySelector('label')) return ((n.querySelector('label').innerText || '').includes(${JSON.stringify(label)}));
    }
    return false;
  })`;
  const pickSelect = async (label, option) => {
    const trigger = await centerOf(controlExpr('[role=combobox]', label));
    if (!trigger) return `NO_COMBO:${label}`;
    await clickAt(trigger.x, trigger.y);
    await sleep(700);
    const item = await evalInOptionCenter(option);
    if (!item) {
      const seen = await evalIn(
        `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`,
      );
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      return `NO_OPTION:${option} seen=${seen}`;
    }
    await clickAt(item.x, item.y);
    await sleep(700);
    const landed = await evalIn(
      `(() => { const c = ${controlExpr('[role=combobox]', label)}; return c ? (c.innerText || '').replace(/\\s+/g,' ').trim() : null; })()`,
    );
    return landed === option ? 'PICKED' : `WRONG_PICK:${option} -> ${landed}`;
  };
  const fillInput = async (sel, value) =>
    evalIn(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOT_FOUND';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
    })()`);
  const clickSel = async (sel) =>
    evalIn(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
      return 'CLICKED';
    })()`);

  await send('Page.enable');
  await send('Runtime.enable');

  console.log(`\n=== §1/§2/§3/§5/§7/§8/§10/§11 信息架构收口：浏览器验证（${BASE}）===\n`);

  // ---------------------------------------------------------------- 登录
  console.log('0) 浏览器登录');
  await openPath('/login', 'document.querySelectorAll("input").length >= 2');
  await fillInput('input[autocomplete="username"]', USER);
  await fillInput('input[autocomplete="current-password"]', PASS);
  await clickSel('[data-testid="login-submit"]');
  const home = await waitFor("location.pathname === '/'", 30000);
  if (home.ok) ok('浏览器登录进入工作台');
  else {
    bad('浏览器登录进入工作台', await pathname());
    console.log('\n登录都没过，后面全部无法验证，直接结束。');
    return;
  }

  // ------------------------------------------- A §11 侧边栏由数据库驱动
  console.log('\nA §11 侧边栏（数据库驱动）');
  // 分组子项默认收起（与改造前一致：三个分组原本也都是 false）。
  // 所以断言"子项文字"之前必须先真的把分组展开 —— 直接 querySelector 得到 null
  // 只说明"还没渲染"，不代表菜单里没有。
  const expandGroup = async (path) => {
    const done = await evalIn(`(() => {
      const b = document.querySelector('[data-testid="nav-group-toggle"][data-nav=' + ${JSON.stringify(JSON.stringify(path))} + ']');
      if (!b) return 'NOT_FOUND';
      if (b.getAttribute('aria-expanded') === 'true') return 'ALREADY';
      for (const t of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
      return 'CLICKED';
    })()`);
    await sleep(700);
    return done;
  };

  const navPrek = await text('[data-nav="/directory/prek"]');
  if (navPrek === 'Pre-K') ok('侧边栏班型名来自数据库（Pre-K）', navPrek);
  else bad('侧边栏班型名来自数据库（Pre-K）', String(navPrek));

  await expandGroup('/directory/prek');
  const navVirtue = await text('[data-nav="/directory/prek/virtue"]');
  if (navVirtue === '美德') ok('侧边栏科目名来自数据库（美德）', navVirtue);
  else bad('侧边栏科目名来自数据库（美德）', String(navVirtue));

  const navGrowth = await text('[data-nav="/growth"]');
  if (navGrowth === '教师成长') ok('§10 侧边栏有「教师成长」一等入口', navGrowth);
  else bad('§10 侧边栏有「教师成长」一等入口', String(navGrowth));

  await expandGroup('/growth');
  const growthChild = await text('[data-nav="/growth/l1"]');
  if (growthChild === 'L1 基础规范') ok('§10 教师成长下有 L1 基础规范', growthChild);
  else bad('§10 教师成长下有 L1 基础规范', String(growthChild));

  // 侧边栏里**不该**再出现旧的写死地址
  const legacyNavLeft = await evalIn(
    `JSON.stringify([...document.querySelectorAll('[data-nav]')].map((n) => n.getAttribute('data-nav')).filter((p) => p === '/prek' || p === '/k' || p === '/virtue' || p === '/montessori'))`,
  );
  if (legacyNavLeft === '[]') ok('侧边栏没有残留的硬编码旧地址（/prek、/k、/virtue、/montessori）');
  else bad('侧边栏没有残留的硬编码旧地址', String(legacyNavLeft));

  // ------------------------------------- B §3 浏览链 Pre-K → 美德 → 资料夹 → 资源
  console.log('\nB §3 /directory 是浏览视图：Pre-K → 美德 → 课程大纲 → 资源');
  await openPath('/directory', '!!document.querySelector(\'[data-testid="directory-browser"]\')');
  const rootCards = await evalIn(`JSON.stringify([...document.querySelectorAll('[data-dir-card]')].map((e) => e.getAttribute('data-dir-card')))`);
  const roots = JSON.parse(rootCards ?? '[]');
  if (roots.includes('root:edu') && roots.includes('root:growth')) {
    ok('§3 /directory 渲染两个根（教育教学 + 教师成长）');
  } else {
    bad('§3 /directory 渲染两个根', String(rootCards));
  }
  // 浏览视图**不应**出现管理控件 —— 那是管理页的事，混在一起才叫"两个世界"。
  const manageControlsOnBrowse = await evalIn(
    `document.querySelectorAll('[data-dir-create]').length + document.querySelectorAll('[data-dir-toggle]').length`,
  );
  if (manageControlsOnBrowse === 0) ok('§3 浏览视图不含管理控件（新建/展开树）');
  else bad('§3 浏览视图不含管理控件', String(manageControlsOnBrowse));
  const manageEntry = await exists('[data-testid="directory-manage-entry"]');
  if (manageEntry) ok('§3 有权限者能看到「管理此目录」入口');
  else bad('§3 有权限者能看到「管理此目录」入口');

  await openPath('/directory/prek', '!!document.querySelector(\'[data-dir-card="prek:virtue"]\')');
  const prekCards = JSON.parse(
    (await evalIn(`JSON.stringify([...document.querySelectorAll('[data-dir-card]')].map((e) => e.getAttribute('data-dir-card')))`)) ?? '[]',
  );
  const expectPrek = ['prek:virtue', 'prek:montessori', 'prek:pe', 'prek:english'];
  const missingPrek = expectPrek.filter((x) => !prekCards.includes(x));
  if (missingPrek.length === 0) ok('§3 Pre-K 下四个科目卡片齐全（美德/蒙台梭利/体能/英文）', prekCards.join(','));
  else bad('§3 Pre-K 下四个科目卡片齐全', `缺 ${missingPrek.join(',')} 实际 ${prekCards.join(',')}`);

  // 面包屑也用同一份数据
  const crumb = await text('[data-testid="directory-crumb-current"]');
  if (crumb === 'Pre-K') ok('§2 面包屑当前节点名来自数据库', crumb);
  else bad('§2 面包屑当前节点名来自数据库', String(crumb));

  // 点进「美德」
  await clickSel('[data-dir-card="prek:virtue"]');
  const toVirtue = await waitFor("location.pathname === '/directory/prek/virtue'", 20000);
  if (toVirtue.ok) ok('§3 点卡片进入美德（URL 由目录 code 推导）', await pathname());
  else bad('§3 点卡片进入美德', await pathname());
  await waitFor('!!document.querySelector(\'[data-dir-card="prek:virtue_outline"]\')');
  const folders = JSON.parse(
    (await evalIn(`JSON.stringify([...document.querySelectorAll('[data-dir-card]')].map((e) => e.getAttribute('data-dir-card')))`)) ?? '[]',
  );
  const expectFolders = ['prek:virtue_outline', 'prek:virtue_lesson', 'prek:virtue_resource', 'prek:virtue_assessment'];
  const missingFolders = expectFolders.filter((x) => !folders.includes(x));
  if (missingFolders.length === 0) ok('§4 美德下四个 PDF 资料夹齐全', folders.join(','));
  else bad('§4 美德下四个 PDF 资料夹齐全', `缺 ${missingFolders.join(',')} 实际 ${folders.join(',')}`);

  // 非叶节点也必须列出资源（否则挂在科目上的 346 条在浏览里是黑洞）
  const subjectResources = await exists('[data-testid="directory-subtree-resources"]');
  if (subjectResources) ok('§3 科目页也列出子树资源（含挂在科目层的历史数据）');
  else bad('§3 科目页也列出子树资源');

  // 进入资料夹
  await clickSel('[data-dir-card="prek:virtue_outline"]');
  await waitFor("location.pathname === '/directory/prek/virtue_outline'", 20000);
  const inFolder = await waitFor(
    '!!document.querySelector(\'[data-testid="directory-browse-resources"]\') || !!document.querySelector(\'[data-testid="directory-browse-empty"]\')',
    20000,
  );
  if (inFolder.ok) {
    const empty = await exists('[data-testid="directory-browse-empty"]');
    ok('§3 进入资料夹后显示资源列表（同一套渲染器在这一层退化成列表）', empty ? '空列表（该资料夹确无资源）' : '有资源');
  } else {
    bad('§3 进入资料夹后显示资源列表');
  }

  // 面包屑必须给出**完整**祖先链（含中间的科目节点）。
  // 这一条是补上一个真实缺陷：路径以前靠 code 前缀回溯，而资料夹的 code 是
  // `prek:virtue_outline`（一段，不是两段），于是中间的「美德」被整个跳过 ——
  // 面包屑显示「Pre-K / 课程大纲」，上传页的目录下拉四组资料夹也长得一模一样。
  const crumbAll = await evalIn(
    `JSON.stringify([...document.querySelectorAll('[data-testid="directory-crumb-root"],[data-testid="directory-crumb"],[data-testid="directory-crumb-current"]')].map((e) => (e.innerText || '').trim()))`,
  );
  const crumbs = JSON.parse(crumbAll ?? '[]');
  // 完整链路包含两个根层级：教育教学 → Pre-K → 美德 → 课程大纲。
  const expectCrumbs = ['课程目录', '教育教学', 'Pre-K', '美德', '课程大纲'];
  if (JSON.stringify(crumbs) === JSON.stringify(expectCrumbs)) {
    ok('§2 面包屑是完整链路（含中间科目节点）', crumbs.join(' / '));
  } else {
    bad('§2 面包屑是完整链路', `期望 ${expectCrumbs.join(' / ')} 实际 ${crumbs.join(' / ')}`);
  }

  // 筛选器仍在（从旧 SubjectPage 搬过来，没丢）
  if (await exists('[data-testid="directory-filter-semester"]')) ok('§3 学期筛选仍在（旧科目页能力已并入，未删除）');
  else bad('§3 学期筛选仍在');

  // --------------------------------- C §2/§5 改名 → 刷新 → 四处同步
  console.log('\nC §2/§5 把「美德」改名 → 刷新 → 四处同步（code 不变）');
  const NEW_NAME = '美德课程';

  /**
   * ⚠️ 改名**必须走界面**，不能走 API。
   *
   * 上一轮这条断言是直接 `PATCH /api/directories/node/...` 的 —— 于是它全绿，
   * 而界面上**根本没有改名按钮**（`canRenameHere` 仍然写着 `!node.isSystem`）。
   * 一个"接口能做、界面做不到"的半成品就这样被自己的测试放过去了。
   * §5 要求的是"管理员**能**改"，所以证据必须在界面上。
   */
  await openPath('/directory/manage', '!!document.querySelector("[data-dir-code]")', 60000);
  const expandTo = async (sel) => {
    for (let i = 0; i < 12; i += 1) {
      if (await exists(sel)) return true;
      const clicked = await evalIn(`(() => {
        let n = 0;
        for (const t of document.querySelectorAll('[data-dir-toggle]')) {
          if (t.getAttribute('aria-expanded') === 'true') continue;
          for (const e of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
          n += 1;
        }
        return n;
      })()`);
      await sleep(700);
      if (!clicked) break;
    }
    return exists(sel);
  };

  const hasRenameBtn = await expandTo('[data-dir-rename="prek:virtue"]');
  if (hasRenameBtn) ok('§5 正式目录也有「重命名」按钮（此前界面上完全没有）');
  else bad('§5 正式目录也有「重命名」按钮', '找不到 [data-dir-rename="prek:virtue"]');

  if (hasRenameBtn) {
    await clickSel('[data-dir-rename="prek:virtue"]');
    await sleep(700);
    const hasNameInput = await exists('[data-dir-name-input="prek:virtue"]');
    if (hasNameInput) ok('§5 点「重命名」后出现名称输入框');
    else bad('§5 点「重命名」后出现名称输入框');

    if (hasNameInput) {
      await fillInput('[data-dir-name-input="prek:virtue"]', NEW_NAME);
      await clickSel('[data-dir-submit="prek:virtue"]');
      await sleep(2200);
      // 服务端复核：名字真的落库了，而且 code 一个字没变。
      const after = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
      const row = after.d?.node ?? after.d ?? {};
      if (row.name === NEW_NAME) ok('§5 界面改名已落库', String(row.name));
      else bad('§5 界面改名已落库', `got=${String(row.name)} want=${NEW_NAME}`);
      if (row.code === 'prek:virtue') ok('§5 改名后 code 不变（内部稳定标识受保护）', row.code);
      else bad('§5 改名后 code 不变', String(row.code));
      renamedFrom = '美德';
    }
  }

  if (renamedFrom !== null) {
    // ① 侧边栏：整页刷新后重新拉树
    await hardReload('!!document.querySelector(\'[data-nav="/directory/prek"]\')');
    await expandGroup('/directory/prek');
    const navAfter = await text('[data-nav="/directory/prek/virtue"]');
    if (navAfter === NEW_NAME) ok('① 刷新后侧边导航已同步', navAfter);
    else bad('① 刷新后侧边导航已同步', String(navAfter));

    // ② Pre-K 首页（= /directory/prek 卡片）
    await openPath('/directory/prek', '!!document.querySelector(\'[data-dir-card="prek:virtue"]\')');
    const cardAfter = await text('[data-dir-card="prek:virtue"] [data-testid="directory-card-name"]');
    if (cardAfter === NEW_NAME) ok('② Pre-K 首页卡片已同步', cardAfter);
    else bad('② Pre-K 首页卡片已同步', String(cardAfter));

    // ③ 目录管理页
    await openPath('/directory/manage', '!!document.querySelector("[data-dir-code]")', 60000);
    // 管理树是**可折叠**的：`prek:virtue` 在祖先收起时根本不进 DOM，
    // 直接 querySelector 得到 null 只说明"还没渲染"，不是"名字不对"。
    for (let i = 0; i < 10; i += 1) {
      if (await exists('[data-dir-code="prek:virtue"]')) break;
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
    const manageName = await evalIn(`(() => {
      const el = document.querySelector('[data-dir-code="prek:virtue"]');
      if (!el) return null;
      return (el.innerText || '').replace(/\\s+/g,' ').trim();
    })()`);
    if (typeof manageName === 'string' && manageName.includes(NEW_NAME)) ok('③ 目录管理页已同步', manageName.slice(0, 40));
    else bad('③ 目录管理页已同步', String(manageName));

    // ④ 上传页的目录下拉
    //
    // ⚠️ 必须**先选班型与科目**：目录下拉的 `disabled` 条件是
    // `!programValue || directoryOptions.length === 0`，班型没选时它是禁用的，
    // 点它不会有任何反应，`[role=option]` 自然是空数组 ——
    // 看起来像"目录没同步"，其实只是还没轮到它可用。第一版就是这么误报的。
    await openPath('/upload', 'document.querySelectorAll("[role=combobox]").length >= 2', 60000);
    const stepProgram = await pickSelect('班型', 'Pre-K');
    if (stepProgram !== 'PICKED') bad('④ 前置：选择班型', String(stepProgram));
    // 科目下拉的选项文案就是科目名本身（不带路径前缀）。
    const stepSubject = await pickSelect('科目', NEW_NAME);
    if (stepSubject === 'PICKED') {
      ok('④ 上传页「科目」下拉已同步改名', NEW_NAME);
    } else {
      const seenSubjects = await evalIn(
        `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`,
      );
      bad('④ 上传页「科目」下拉已同步改名', `${stepSubject} seen=${String(seenSubjects).slice(0, 200)}`);
    }
    // 目录下拉的文案是"从根到资料夹"的路径，因此只需断言**含新名**。
    const dirTrigger = await centerOf(controlExpr('[role=combobox]', '所属目录'));
    if (dirTrigger === null) {
      bad('④ 上传页目录下拉已同步', 'NO_COMBO:所属目录');
    } else {
      await clickAt(dirTrigger.x, dirTrigger.y);
      await sleep(800);
      const dirOptions = await evalIn(
        `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`,
      );
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      if (typeof dirOptions === 'string' && dirOptions.includes(NEW_NAME)) {
        ok('④ 上传页目录下拉已同步改名', `选项含 ${NEW_NAME}`);
      } else {
        bad('④ 上传页目录下拉已同步改名', String(dirOptions).slice(0, 300));
      }
    }

    // ⑤ 详情/面包屑（§2 要求改名同步到 breadcrumb 与详情）
    await openPath('/directory/prek/virtue', '!!document.querySelector(\'[data-testid="directory-crumb-current"]\')');
    const crumbAfter = await text('[data-testid="directory-crumb-current"]');
    if (crumbAfter === NEW_NAME) ok('⑤ 面包屑当前节点已同步', crumbAfter);
    else bad('⑤ 面包屑当前节点已同步', String(crumbAfter));

    // ⓕ §2「详情也要同步」—— 打开一条真实资源的**详情弹窗**，看它显示的目录名。
    //
    // WHY 单独一条：`ResourceDetailDialog` 以前**根本没有"所属目录"这一格** ——
    // 详情里只有 legacy 的 `folderType`（六个历史值之一）。于是管理员把
    // 「美德」改成「美德课程」，详情页看不出任何变化 —— 而 §2 明确把「详情」
    // 列进了必须同步的位置清单。
    {
      // 这条断言必须**跑起来**，不能 SKIP。
      //
      // 上一版借的是"目录过滤返回的第一条资源" —— 而 `/my-resources` 只列
      // **自己**的资源，那条恰好不是本账号的，于是永远找不到卡片，永远 SKIP。
      // 而 SKIP 在用户的口径里不算通过（这正是他反复强调"不要为了看起来完成"的点）。
      //
      // 所以这里自己造一条**属于本账号**的探针资源，落在 prek:virtue 子树里，
      // 再在浏览器上从「我的资源」点进详情弹窗，读那一格文字。
      const leaf = await c.req(
        'GET',
        `/api/directories/node?code=${encodeURIComponent('prek:virtue_outline')}`,
      );
      const leafId = leaf.d?.id ?? null;
      const probeTitle = `IA 详情目录探针 ${Date.now().toString().slice(-6)}`;
      if (leafId === null) {
        bad('§2 详情弹窗显示目录名', `取不到 prek:virtue_outline 节点：HTTP ${leaf.s}`);
      } else {
        const made = await c.req('POST', '/api/resources', {
          title: probeTitle,
          program: 'prek',
          subject: 'virtue',
          directoryId: leafId,
          semester: 'S1',
        });
        const probeId = made.d?.id ?? null;
        if (probeId === null) {
          bad(
            '§2 详情弹窗显示目录名',
            `建探针资源失败：HTTP ${made.s} ${JSON.stringify(made.d?.error?.message ?? made.d)}`,
          );
        } else {
          createdResourceIds.push(probeId);
          await openPath(
            '/my-resources',
            '!!document.querySelector(\'[data-testid="resource-list"]\')',
            45000,
          );
          // 在浏览器上真的点开它 —— 证明的是**界面**上能看到，不是接口里有这个字段。
          const opened = await evalIn(`(() => {
            const rows = [...document.querySelectorAll('tr')];
            const row = rows.find((tr) => (tr.innerText || '').includes(${JSON.stringify(probeTitle)}));
            if (!row) return 'NO_ROW';
            const btn = row.querySelector('[data-testid="resource-detail-open"]');
            if (!btn) return 'NO_BUTTON';
            for (const t of ['mousedown','mouseup','click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
            return 'CLICKED';
          })()`);
          if (opened !== 'CLICKED') {
            bad(
              '§2 详情弹窗显示目录名',
              `${String(opened)}（探针 ${probeTitle} / id=${probeId}）`,
            );
          } else {
            const shown = await waitFor(
              '!!document.querySelector(\'[data-testid="detail-directory"]\')',
              15000,
            );
            if (!shown.ok) {
              bad('§2 详情弹窗显示所属目录', '找不到 [data-testid="detail-directory"]');
            } else {
              const detailDir = await text('[data-testid="detail-directory"]');
              if (typeof detailDir === 'string' && detailDir.includes(NEW_NAME)) {
                ok('ⓕ §2 详情弹窗里的目录名已同步', detailDir.slice(0, 60));
              } else {
                bad('ⓕ §2 详情弹窗里的目录名已同步', `got=${String(detailDir)} want 含 ${NEW_NAME}`);
              }
            }
          }
        }
      }
    }

    // ⓔ §5/§16「目录说明可编辑」—— 在**界面上**真的改一次说明并核对落库。
    //
    // WHY 单独一条：数据库有 `description` 列、服务层也一直写它，但管理界面
    // 此前**没有这一格输入框** —— 一个"库里支持、界面上够不着"的字段。
    // 接口测试对这种情况全绿，只有真去看界面才发现改不了，所以必须浏览器级断言。
    {
      const descProbe = `§5 说明可编辑探针 ${Date.now().toString().slice(-6)}`;
      await openPath('/directory/manage', '!!document.querySelector("[data-dir-code]")', 60000);
      // 展开到目标节点（管理树是可折叠的）
      for (let i = 0; i < 10; i += 1) {
        if (await exists('[data-dir-rename="prek:virtue"]')) break;
        const clicked = await evalIn(`(() => {
          let n = 0;
          for (const t of document.querySelectorAll('[data-dir-toggle]')) {
            if (t.getAttribute('aria-expanded') === 'true') continue;
            for (const e of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
            n += 1;
          }
          return n;
        })()`);
        await sleep(600);
        if (!clicked) break;
      }
      await clickSel('[data-dir-rename="prek:virtue"]');
      await sleep(700);
      const hasDescInput = await exists('[data-dir-desc-input="prek:virtue"]');
      if (hasDescInput) ok('§5 管理界面有「说明」输入框');
      else bad('§5 管理界面有「说明」输入框', '找不到 [data-dir-desc-input]');
      if (hasDescInput) {
        await fillInput('[data-dir-desc-input="prek:virtue"]', descProbe);
        await clickSel('[data-dir-submit="prek:virtue"]');
        await sleep(2000);
        const nodeResp = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
        const saved = nodeResp.d?.node?.description ?? nodeResp.d?.description ?? null;
        if (saved === descProbe) ok('§5 说明已落库', String(saved).slice(0, 40));
        else bad('§5 说明已落库', `got=${String(saved)} want=${descProbe}`);
        // 清空说明：把输入框清掉再保存，必须变成 null（而不是留下旧值）
        await clickSel('[data-dir-rename="prek:virtue"]');
        await sleep(700);
        await fillInput('[data-dir-desc-input="prek:virtue"]', '');
        await clickSel('[data-dir-submit="prek:virtue"]');
        await sleep(2000);
        const cleared = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
        // ⚠️ 不能用 `?? 'MISSING'` 来"取值或兜底"：清空之后 description **就是 null**，
        // 而 `null ?? 'MISSING'` 会把它换成 MISSING —— 于是**正确的行为会被判成失败**。
        // 这个坑我踩了一次。改成分清"字段不存在"与"字段值是 null"两件事。
        const descNode = cleared.d?.node ?? cleared.d ?? {};
        const hasField = Object.prototype.hasOwnProperty.call(descNode, 'description');
        const after = hasField ? descNode.description : '__NO_FIELD__';
        if (hasField && after === null) {
          ok('§5 清空说明 → 落成 null（不是留旧值）', 'null');
        } else {
          bad('§5 清空说明 → 落成 null', `hasField=${hasField} value=${String(after)}`);
        }
      }
    }

    // ⓒ §5「官方目录的三个字段都能改」—— 需求 C 逐字列的是
    //     中文名 / 英文名 / 说明，缺一个就不算完成。
    //
    // WHY 单独一条：中文名与说明已有断言，**英文名一直没有**。而英文界面
    // （en-US）读的正是 `nameEn`（DirectoryPage 第 253 行），漏掉这一格就等于
    // "英文界面里管理员改的名字看不见" —— 一个只有切到英文才会暴露的缺口。
    {
      const before = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
      const beforeNode = before.d?.node ?? before.d ?? {};
      const originalNameEn = beforeNode.nameEn ?? '';
      const enProbe = `Virtue Probe ${Date.now().toString().slice(-6)}`;
      await openPath('/directory/manage', '!!document.querySelector("[data-dir-code]")', 60000);
      for (let i = 0; i < 10; i += 1) {
        if (await exists('[data-dir-rename="prek:virtue"]')) break;
        const clicked = await evalIn(`(() => {
          let n = 0;
          for (const t of document.querySelectorAll('[data-dir-toggle]')) {
            if (t.getAttribute('aria-expanded') === 'true') continue;
            for (const e of ['mousedown','mouseup','click']) t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, button: 0, view: window }));
            n += 1;
          }
          return n;
        })()`);
        await sleep(600);
        if (!clicked) break;
      }
      await clickSel('[data-dir-rename="prek:virtue"]');
      await sleep(700);
      const hasEnInput = await exists('[data-dir-name-en-input="prek:virtue"]');
      if (!hasEnInput) {
        bad('§5 管理界面有「英文名」输入框', '找不到 [data-dir-name-en-input]');
      } else {
        ok('§5 管理界面有「英文名」输入框');
        await fillInput('[data-dir-name-en-input="prek:virtue"]', enProbe);
        await clickSel('[data-dir-submit="prek:virtue"]');
        await sleep(2000);
        const afterResp = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
        const afterNode = afterResp.d?.node ?? afterResp.d ?? {};
        if (afterNode.nameEn === enProbe) ok('§5 英文名已落库', String(afterNode.nameEn));
        else bad('§5 英文名已落库', `got=${String(afterNode.nameEn)} want=${enProbe}`);
        // 需求 C 的后半句：改这三个字段时 `code` / `id` **必须不变**。
        if (afterNode.code === 'prek:virtue' && afterNode.id === beforeNode.id) {
          ok('§5 改英文名后 code 与 id 都不变（内部稳定标识受保护）', String(afterNode.code));
        } else {
          bad(
            '§5 改英文名后 code 与 id 都不变',
            `code=${String(afterNode.code)} id=${String(afterNode.id)} was=${String(beforeNode.id)}`,
          );
        }
        // 还原英文名，不留脏数据
        await clickSel('[data-dir-rename="prek:virtue"]');
        await sleep(700);
        await fillInput('[data-dir-name-en-input="prek:virtue"]', originalNameEn);
        await clickSel('[data-dir-submit="prek:virtue"]');
        await sleep(2000);
        const restored = await c.req('GET', '/api/directories/node?code=prek%3Avirtue');
        const restoredNode = restored.d?.node ?? restored.d ?? {};
        if ((restoredNode.nameEn ?? '') === originalNameEn) {
          ok('英文名已还原（不留脏数据）', String(restoredNode.nameEn));
        } else {
          bad(
            '英文名已还原',
            `got=${String(restoredNode.nameEn)} want=${String(originalNameEn)}`,
          );
        }
      }
    }

    // 复原
    const revert = await c.req('PATCH', '/api/directories/node/prek%3Avirtue', { name: renamedFrom });
    if (revert.s === 200 && revert.d?.name === renamedFrom) {
      ok('改名已还原（不留脏数据）', renamedFrom);
      renamedFrom = null;
    } else {
      bad('改名已还原', `HTTP ${revert.s} ${JSON.stringify(revert.d?.error?.message ?? revert.d)}`);
    }
    // 复原名之后，界面上也应回到「美德」
    await hardReload('!!document.querySelector(\'[data-nav="/directory/prek"]\')');
    await expandGroup('/directory/prek');
    const navReverted = await text('[data-nav="/directory/prek/virtue"]');
    if (navReverted === '美德') ok('还原后侧边导航回到「美德」', navReverted);
    else bad('还原后侧边导航回到「美德」', String(navReverted));
  }

  // ------------------------------------------- D §7 上传页没有 legacy 资料夹下拉
  console.log('\nD §7 上传页不再要求选 6 个 legacy 资料夹');
  await openPath('/upload', 'document.querySelectorAll("[role=combobox]").length >= 2', 60000);
  // 表单里不应再有「资料夹」这个 label（folderType）
  const folderLabelPresent = await evalIn(`(() => {
    const labels = [...document.querySelectorAll('label')].map((l) => (l.innerText || '').trim());
    return JSON.stringify(labels.filter((t) => t.includes('资料夹') && !t.includes('所属目录')));
  })()`);
  if (folderLabelPresent === '[]') ok('§7 上传页没有 legacy「资料夹」下拉', String(folderLabelPresent));
  else bad('§7 上传页没有 legacy「资料夹」下拉', String(folderLabelPresent));

  const legacyFolderOptions = await evalIn(`(() => {
    const labels = [...document.querySelectorAll('label')].map((l) => (l.innerText || '').trim());
    return labels.some((t) => t.startsWith('资料夹'));
  })()`);
  if (legacyFolderOptions === false) ok('§7 不再出现「资料夹*」必填标记');
  else bad('§7 不再出现「资料夹*」必填标记');

  const dirLabel = await evalIn(`(() => {
    const labels = [...document.querySelectorAll('label')].map((l) => (l.innerText || '').trim());
    return JSON.stringify(labels.filter((t) => t.includes('所属目录')));
  })()`);
  if (typeof dirLabel === 'string' && dirLabel.includes('所属目录')) ok('§8 上传页有必填的「所属目录」', dirLabel);
  else bad('§8 上传页有必填的「所属目录」', String(dirLabel));

  // --------------------------------- E §8 没选目录 → 交不上去（客户端拦截）
  console.log('\nE §8 未选目录时不允许提交');
  await fillInput('input#title, input[name="title"]', `IA 探针-${Date.now().toString().slice(-6)}`);
  const draftBtn = await evalIn(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('保存草稿'));
    return b ? 'FOUND' : 'NOT_FOUND';
  })()`);
  if (draftBtn === 'FOUND') {
    await evalIn(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('保存草稿'));
      if (b) for (const t of ['mousedown','mouseup','click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
      return 'CLICKED';
    })()`);
    await sleep(1200);
    // 关键：**必须留在上传页**，并且给出校验提示（而不是静默什么都不做）
    if ((await pathname()) === '/upload') ok('§8 未选目录 → 没有跳走（提交被拦）');
    else bad('§8 未选目录 → 没有跳走', await pathname());
    const errText = await evalIn(`(() => {
      const el = document.querySelector('[data-slot="form-message"]');
      return el ? (el.innerText || '').trim() : null;
    })()`);
    if (typeof errText === 'string' && errText.length > 0) ok('§8 给出了可读的校验提示（不是内部 key）', errText);
    else bad('§8 给出了可读的校验提示', String(errText));
    if (typeof errText === 'string' && !/^[a-z]+\.[a-zA-Z]+$/.test(errText)) ok('§8 校验提示已翻译（不是 upload.xxxRequired 这种内部串）', errText);
    else bad('§8 校验提示已翻译', String(errText));
  } else {
    skip('§8 未选目录时不允许提交', '找不到「保存草稿」按钮');
  }

  // ------------------------------------------- F §10 教师成长链路
  console.log('\nF §10 教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治');
  await openPath('/growth', '!!document.querySelector(\'[data-dir-card="growth:l1"]\')');
  const growthCards = JSON.parse(
    (await evalIn(`JSON.stringify([...document.querySelectorAll('[data-dir-card]')].map((e) => e.getAttribute('data-dir-card')))`)) ?? '[]',
  );
  if (growthCards.includes('growth:l1') && growthCards.includes('growth:l2') && growthCards.includes('growth:l3')) {
    ok('§4 教师成长下三级齐全（L1 / L2 / L3）', growthCards.join(','));
  } else {
    bad('§4 教师成长下三级齐全', growthCards.join(','));
  }
  const levelName = await text('[data-dir-card="growth:l1"] [data-testid="directory-card-name"]');
  if (levelName === 'L1 基础规范') ok('§4 L1 名称逐字匹配 PDF', levelName);
  else bad('§4 L1 名称逐字匹配 PDF', String(levelName));

  await clickSel('[data-dir-card="growth:l1"]');
  await waitFor('!!document.querySelector(\'[data-dir-card="growth:l1:safety"]\')', 20000);
  const l1Children = JSON.parse(
    (await evalIn(`JSON.stringify([...document.querySelectorAll('[data-dir-card]')].map((e) => e.getAttribute('data-dir-card')))`)) ?? '[]',
  );
  const expectL1 = ['growth:l1:ethics', 'growth:l1:safety', 'growth:l1:know', 'growth:l1:skill'];
  const missingL1 = expectL1.filter((x) => !l1Children.includes(x));
  if (missingL1.length === 0) ok('§4 L1 下四项齐全（职业道德规范/安全施教规范/专业知识/专业技能）', l1Children.join(','));
  else bad('§4 L1 下四项齐全', `缺 ${missingL1.join(',')}`);

  await clickSel('[data-dir-card="growth:l1:safety"]');
  await waitFor('!!document.querySelector(\'[data-dir-card="growth:l1:safety:plan"]\')', 20000);
  const planName = await text('[data-dir-card="growth:l1:safety:plan"] [data-testid="directory-card-name"]');
  if (planName === '应急预案') ok('§4 应急预案名称逐字匹配 PDF', planName);
  else bad('§4 应急预案名称逐字匹配 PDF', String(planName));

  await clickSel('[data-dir-card="growth:l1:safety:plan"]');
  await waitFor('!!document.querySelector(\'[data-dir-card="growth:l1:safety:plan:disease"]\')', 20000);
  const diseaseName = await text('[data-dir-card="growth:l1:safety:plan:disease"] [data-testid="directory-card-name"]');
  if (diseaseName === '传染病识别与防治') ok('§4 传染病识别与防治名称逐字匹配 PDF', diseaseName);
  else bad('§4 传染病识别与防治名称逐字匹配 PDF', String(diseaseName));

  await clickSel('[data-dir-card="growth:l1:safety:plan:disease"]');
  // §10：教师成长分支的地址在 `/growth` 下（不是 `/directory/growth`）——
  // 它是一等导航入口，所以有自己的前缀。
  const deepPath = await waitFor("location.pathname === '/growth/l1/safety/plan/disease'", 20000);
  if (deepPath.ok) ok('§10 深层教师成长节点的 URL 在 /growth 下且可直达', await pathname());
  else bad('§10 深层教师成长节点的 URL', await pathname());

  // 教师成长**没有**资源（不是资源容器），因此不应显示资源列表 —— 而是子项或空态
  await hardReload('!!document.querySelector(\'[data-testid="directory-browser"]\')');
  const diseaseAfterReload = await text('[data-testid="directory-crumb-current"]');
  if (diseaseAfterReload === '传染病识别与防治') ok('§10 刷新后仍在同一节点（树来自数据库）', diseaseAfterReload);
  else bad('§10 刷新后仍在同一节点', String(diseaseAfterReload));

  // ------------------------------------------- G §8 待补齐目录归属页
  console.log('\nG §8 待补齐目录归属（管理员）');
  await openPath('/admin/unassigned-resources', '!!document.querySelector(\'[data-testid="under-filed-page"]\')', 60000);
  const hasPage = await exists('[data-testid="under-filed-page"]');
  if (hasPage) ok('§8 /admin/unassigned-resources 存在且可访问');
  else bad('§8 /admin/unassigned-resources 存在且可访问');

  const apiCounts = await c.req('GET', '/api/resources/under-filed');
  const unassignedShown = await text('[data-testid="under-filed-count-unassigned"]');
  const subjectShown = await text('[data-testid="under-filed-count-subject"]');
  const apiUn = String(apiCounts.d?.counts?.unassigned ?? -1);
  const apiSub = String(apiCounts.d?.counts?.subjectLevel ?? -1);
  if (typeof unassignedShown === 'string' && unassignedShown.includes(apiUn)) {
    ok('§8 「完全没有归属」计数来自服务端', `界面含 ${apiUn}`);
  } else {
    bad('§8 「完全没有归属」计数来自服务端', `界面=${String(unassignedShown)} 服务端=${apiUn}`);
  }
  if (typeof subjectShown === 'string' && subjectShown.includes(apiSub)) {
    ok('§8 「只到科目层」计数来自服务端', `界面含 ${apiSub}`);
  } else {
    bad('§8 「只到科目层」计数来自服务端', `界面=${String(subjectShown)} 服务端=${apiSub}`);
  }
  // 两种原因必须**分开**呈现（否则管理员会以为全都无处安放）
  const reasonLabels = await evalIn(`(() => {
    const t = document.body.innerText || '';
    const hasA = t.includes('完全没有目录归属') || t.includes('No directory at all');
    const hasB = t.includes('只到科目') || t.includes('Subject / sub-subject level only');
    return JSON.stringify({ hasA, hasB });
  })()`);
  const reasons = JSON.parse(reasonLabels ?? '{}');
  if (reasons.hasA === true && reasons.hasB === true) ok('§8 两种原因分开说明（未归属 / 仅科目层）');
  else bad('§8 两种原因分开说明', String(reasonLabels));

  const tableRows = await evalIn('document.querySelectorAll(\'[data-testid="under-filed-row"]\').length');
  if (typeof tableRows === 'number' && tableRows > 0) ok('§8 列表渲染出待补齐资源', `${tableRows} 行`);
  else skip('§8 列表渲染出待补齐资源', '当前库里没有待补齐行（0 条是合法状态）');

  // ------------------------------------------- I §12 数据范围在**界面上**可查看可编辑
  //
  // WHY 单独一段、而且必须走界面：§12 要求"管理员需能看到……数据范围
  // （ALL / PROGRAM / SUBJECT / OWN），至少可查看与编辑"。
  // `AuthorizationService.setScopes()` 与 `account_scopes` 表早就存在，
  // 而**没有任何界面能调用它们** —— 这正是本轮补上的东西（接口 + 面板里的编辑区）。
  // 接口那一半已经有 27 条断言（`account-permissions` 5b 段）；
  // 这里补的是"界面上真的点得动"，因为本轮已经栽过两次"接口能做、界面做不到"：
  // 正式目录没有改名按钮、说明没有输入框。
  console.log('\nI §12 数据范围：界面上可查看、可编辑');
  {
    const dirList = await c.req('GET', '/api/teachers?pageSize=50');
    const all = dirList.d?.items ?? dirList.d ?? [];
    const target = Array.isArray(all) ? all.find((t) => (t.roles ?? []).includes('prek_head')) : null;
    if (target === undefined || target === null) {
      skip('§12 数据范围界面编辑', '找不到可用于验证的 prek_head 账号');
    } else {
      await openPath(
        `/admin/permissions?teacherId=${encodeURIComponent(target.id)}`,
        '!!document.querySelector(\'[data-testid="scope-section"]\')',
        60000,
      );
      const hasSection = await exists('[data-testid="scope-section"]');
      if (hasSection) ok('§12 权限面板里有「数据范围」区域');
      else bad('§12 权限面板里有「数据范围」区域');

      if (hasSection) {
        // 初始应为空（= 按角色默认），并且界面必须**说清楚**空数组的含义
        const emptyText = await text('[data-testid="scope-empty"]');
        if (typeof emptyText === 'string' && emptyText.length > 0) {
          ok('§12 空状态有解释（空 = 按角色默认，不是"没有权限"）', emptyText.slice(0, 40));
        } else {
          bad('§12 空状态有解释', String(emptyText));
        }

        // 进入编辑 → 加一条 → 选 kind → 保存
        await clickSel('[data-testid="scope-edit"]');
        await sleep(600);
        const adding = await clickSel('[data-testid="scope-add"]');
        if (adding === 'CLICKED') ok('§12 能新增一条范围绑定');
        else bad('§12 能新增一条范围绑定', String(adding));
        await sleep(400);
        // 把 kind 选成 PROGRAM。
        //
        // 用 `data-testid="scope-kind"` 定位，**不能**按 label 文案找：
        // 这一格没有 `<label>`（它是表格里的一列），按 label 找会得到 NO_COMBO ——
        // 第一版就是这么 SKIP 掉的。可跳过的断言等于没断言，所以这里改成按 testid
        // 取坐标，再走 Radix 需要的真实鼠标事件。
        {
          // ⚠️ `centerOf()` 收的是**表达式**（`const el = ${expr}`），不是选择器字符串。
          // 第一版传了 `'[data-testid="scope-kind"]'`，于是表达式变成
          // `const el = '[data-testid=…]'` —— 一个字符串。它 truthy，于是走进
          // `el.scrollIntoView` 抛错，整个赋值拿不到值，返回 null，被报成
          // `NO_TRIGGER`（"元素不存在"）。**是我用错了助手，不是产品缺陷。**
          const kindTrigger = await centerOf('document.querySelector(\'[data-testid="scope-kind"]\')');
          if (kindTrigger === null) {
            bad('§12 能把范围类型选成 PROGRAM', 'NO_TRIGGER');
          } else {
            await clickAt(kindTrigger.x, kindTrigger.y);
            await sleep(700);
            const optionCenter = await evalInOptionCenter('按班型（PROGRAM）');
            if (optionCenter === null) {
              const seen = await evalIn(
                `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()))`,
              );
              await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
              await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
              bad('§12 能把范围类型选成 PROGRAM', `NO_OPTION seen=${String(seen).slice(0, 200)}`);
            } else {
              await clickAt(optionCenter.x, optionCenter.y);
              await sleep(600);
              const landed = await text('[data-testid="scope-kind"]');
              if (typeof landed === 'string' && landed.includes('PROGRAM')) {
                ok('§12 能把范围类型选成 PROGRAM', landed);
              } else {
                bad('§12 能把范围类型选成 PROGRAM', `landed=${String(landed)}`);
              }
            }
          }
        }
        // PROGRAM 形态要求必须有 program 值（服务端与数据库约束都这么要求），
        // 所以这里把 prek 填进去 —— 不然保存会（正确地）被 400 拒绝。
        const progInput = await exists('[data-testid="scope-program"]');
        if (progInput) {
          // 输入框现在是**受控**的（onChange 直接写草稿），所以填完即生效，
          // 不需要再手工触发 blur —— 以前那版是非受控 + onBlur，
          // "填完直接点保存"会丢值（实测库里仍是空的）。
          await fillInput('[data-testid="scope-program"]', 'prek');
          await sleep(300);
          ok('§12 PROGRAM 形态出现 program 输入框并可填写');
        } else {
          bad('§12 PROGRAM 形态出现 program 输入框');
        }
        await clickSel('[data-testid="scope-save"]');
        await sleep(2200);
        const after = await c.req('GET', `/api/teachers/${target.id}/scopes`);
        const scopes = after.d?.scopes ?? [];
        if (scopes.some((x) => x.kind === 'PROGRAM' && x.program === 'prek')) {
          ok('§12 界面上保存的范围已落库', JSON.stringify(scopes).slice(0, 90));
        } else {
          bad('§12 界面上保存的范围已落库', JSON.stringify(after.d).slice(0, 140));
        }
        // 清空还原，不留脏数据
        await clickSel('[data-testid="scope-edit"]');
        await sleep(500);
        const removeBtns = await evalIn('document.querySelectorAll(\'[data-testid="scope-remove"]\').length');
        for (let i = 0; i < Number(removeBtns); i += 1) {
          await clickSel('[data-testid="scope-remove"]');
          await sleep(300);
        }
        await clickSel('[data-testid="scope-save"]');
        await sleep(2000);
        const cleared = await c.req('GET', `/api/teachers/${target.id}/scopes`);
        if ((cleared.d?.scopes ?? []).length === 0) ok('§12 清空后回到"按角色默认"（无脏数据）');
        else bad('§12 清空后回到"按角色默认"', JSON.stringify(cleared.d).slice(0, 120));
      }
    }
  }

  // ------------------------------------------- H §11 旧 URL 仍然可用
  console.log('\nH §11 旧 URL 兼容（由 directory code 解析，不 404）');
  const legacyCases = [
    ['/prek/virtue', '/directory/prek/virtue'],
    ['/k/chinese', '/directory/k/chinese'],
    ['/k/english', '/directory/k/english'],
    ['/prek/montessori', '/directory/prek/montessori'],
  ];
  for (const [from, to] of legacyCases) {
    await openPath(from, '!!document.querySelector(\'[data-testid="directory-browser"]\')', 45000);
    // 首次进入会等树加载；等路由稳定
    await waitFor(`location.pathname === ${JSON.stringify(to)}`, 15000);
    const now = await pathname();
    if (now === to) ok(`§11 ${from} → ${to}`);
    else bad(`§11 ${from} → ${to}`, String(now));
  }

  // 旧 URL 的第三层（蒙氏子分类）不在 PDF 目录树里，但**不能死**
  await openPath(
    '/prek/montessori/practical-life',
    '!!document.querySelector(\'[data-testid="directory-browser"]\')',
    45000,
  );
  await sleep(1500);
  const leftoverPath = await pathname();
  if (leftoverPath === '/directory/prek/montessori') {
    ok('§11 /prek/montessori/practical-life 退到最近的可解析祖先（不 404）', leftoverPath);
  } else {
    bad('§11 旧 URL 第三层不应 404', String(leftoverPath));
  }

  // 真正不存在的旧 URL 落到目录根，而不是白屏
  await openPath('/k/virtue', '!!document.querySelector(\'[data-testid="directory-browser"]\')', 45000);
  await sleep(1200);
  const notFoundPath = await pathname();
  if (notFoundPath === '/directory' || notFoundPath === '/directory/prek' || notFoundPath === '/directory/k') {
    ok('§11 无法解析的旧 URL 落到目录根（不白屏、不 404）', notFoundPath);
  } else {
    bad('§11 无法解析的旧 URL 落到目录根', String(notFoundPath));
  }

  // ------------------------------------------- J §15 自建文件夹 + 浏览器上传闭环
  //
  // §15 的第三条链路是：「新增自建文件夹 → 刷新 → 目录显示 → 进入 → **上传资源**
  // → 保存 → 资源出现在该目录」。
  //
  // 其中"新建文件夹 / 刷新后仍在 / 上传页候选里出现"由 `directory-web` 真浏览器覆盖，
  // 但**上传那一步此前只有接口级证据**（`directory-web` 用的是
  // `POST /api/resources`）。也就是说"老师在界面上把资源传进自建文件夹"这条路径
  // 从来没有人真的走过 —— 而它恰好是最长、最容易断的一条。
  // 这一段把它补成浏览器级：真的在界面上选文件夹、真的点保存。
  console.log('\nJ §15 自建文件夹 → 浏览器上传 → 资源出现在该目录');
  {
    // 挂在「体能 / 教学资源」下 —— 该叶节点在 PDF 里标了 allowCustomFolders=true，
    // 而且没有被其它浏览器套件占用。
    const PARENT = 'prek:pe_resource';
    const parentNode = await c.req('GET', `/api/directories/node?code=${encodeURIComponent(PARENT)}`);
    const parentId = parentNode.d?.node?.id ?? parentNode.d?.id ?? null;
    if (parentId === null) {
      bad('§15 取到可自建文件夹的父节点', JSON.stringify(parentNode.d).slice(0, 120));
    } else {
      const folderName = `IA自建 ${Date.now().toString().slice(-6)}`;
      const made = await c.req('POST', '/api/directories/folder', {
        parentCode: PARENT,
        name: folderName,
      });
      const folderCode = made.d?.code ?? null;
      const folderId = made.d?.id ?? null;
      if (folderId !== null) {
        createdFolderCodes.push(folderCode);
        ok('§15 通过接口建出自建文件夹（供上传链路使用）', folderCode ?? '');
      } else {
        bad('§15 建出自建文件夹', `HTTP ${made.s} ${JSON.stringify(made.d?.error?.message ?? made.d)}`);
      }

      if (folderId !== null && folderCode !== null) {
        // 刷新后必须还在（数据驱动，不是内存里的假象）
        await openPath('/directory/manage', '!!document.querySelector("[data-dir-code]")', 60000);
        // ⚠️ 管理树是**折叠**的，新文件夹在深层 —— 必须先展开再找，
        // 否则会把"还没渲染"误报成"刷新后不见了"。（这里刚踩过。）
        const foundAfterReload = await expandTo(`[data-dir-code="${folderCode}"]`);
        if (foundAfterReload) ok('§15 刷新后自建文件夹仍在目录管理页');
        else bad('§15 刷新后自建文件夹仍在目录管理页', folderCode);

        // 在**界面上**把资源传进这个文件夹
        await openPath('/upload', 'document.querySelectorAll("[role=combobox]").length >= 2', 60000);
        const pickProgram = await pickSelect('班型', 'Pre-K');
        if (pickProgram !== 'PICKED') bad('§15 前置：选班型', String(pickProgram));
        const pickSubject = await pickSelect('科目', '体能');
        if (pickSubject !== 'PICKED') bad('§15 前置：选科目', String(pickSubject));

        // 目录下拉的文案是"从根到资料夹"的完整路径，所以只要断言**含文件夹名**
        const dirTrigger = await centerOf(controlExpr('[role=combobox]', '所属目录'));
        let pickedCustom = false;
        if (dirTrigger === null) {
          bad('§15 上传页能打开「所属目录」下拉', 'NO_COMBO');
        } else {
          await clickAt(dirTrigger.x, dirTrigger.y);
          await sleep(800);
          const optCenter = await evalInOptionCenter(
            await evalIn(`(() => {
              const opt = [...document.querySelectorAll('[role=option]')]
                .find((x) => (x.innerText || '').includes(${JSON.stringify(folderName)}));
              return opt ? (opt.innerText || '').trim() : null;
            })()`),
          );
          const wantedLabel = await evalIn(`(() => {
            const opt = [...document.querySelectorAll('[role=option]')]
              .find((x) => (x.innerText || '').includes(${JSON.stringify(folderName)}));
            return opt ? (opt.innerText || '').trim() : null;
          })()`);
          if (wantedLabel === null) {
            const seen = await evalIn(
              `JSON.stringify([...document.querySelectorAll('[role=option]')].map((x) => (x.innerText || '').trim()).filter((t) => t.includes('体能')))`,
            );
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            bad('§15 自建文件夹出现在上传页候选里', `seen(体能) = ${String(seen).slice(0, 200)}`);
          } else if (optCenter === null) {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            bad('§15 自建文件夹选项可点击', wantedLabel);
          } else {
            ok('§15 自建文件夹出现在上传页候选里', wantedLabel.slice(0, 50));
            await clickAt(optCenter.x, optCenter.y);
            await sleep(700);
            const landed = await evalIn(
              `(() => { const c = ${controlExpr('[role=combobox]', '所属目录')}; return c ? (c.innerText || '').replace(/\\s+/g,' ').trim() : null; })()`,
            );
            pickedCustom = typeof landed === 'string' && landed.includes(folderName);
            if (pickedCustom) ok('§15 已在上传页选中该自建文件夹', String(landed).slice(0, 50));
            else bad('§15 已在上传页选中该自建文件夹', String(landed));
          }
        }

        if (pickedCustom) {
          const probeTitle = `IA 自建文件夹上传探针 ${Date.now().toString().slice(-6)}`;
          await fillInput('input#title, input[name="title"]', probeTitle);
          await sleep(300);
          const saved = await evalIn(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('保存草稿'));
            if (!b) return 'NOT_FOUND';
            for (const t of ['mousedown','mouseup','click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, view: window }));
            return 'CLICKED';
          })()`);
          if (saved !== 'CLICKED') {
            bad('§15 点「保存草稿」', String(saved));
          } else {
            await sleep(3000);
            const mine = await c.req('GET', '/api/resources/mine?pageSize=100');
            const items = mine.d?.items ?? mine.d ?? [];
            const row = Array.isArray(items) ? items.find((r) => r.title === probeTitle) : null;
            if (row === undefined || row === null) {
              bad('§15 浏览器保存的资源已落库', `找不到标题 ${probeTitle}`);
            } else {
              createdResourceIds.push(row.id);
              ok('§15 浏览器保存的资源已落库', row.id);
              if (row.directoryId === folderId) ok('§15 目录归属正是那个自建文件夹', row.directoryId);
              else bad('§15 目录归属正是那个自建文件夹', `got=${String(row.directoryId)} want=${folderId}`);
              // 进入该文件夹的浏览页，资源必须出现在那里
              // ⚠️ 少了一个 `/` 就会变成 `/directoryprek/...` —— 一个 404 页面。
              // 实测就是这么错的，而失败信息只写"没看到资源"，
              // 直到我给这条断言加上"把页面当时的样子打出来"的诊断才一眼看出。
              await openPath(
                `/directory/${folderCode.split(':').join('/')}`,
                '!!document.querySelector(\'[data-testid="directory-browser"]\')',
                45000,
              );
              const listed = await waitFor(
                `(document.getElementById('root')?.innerText || '').includes(${JSON.stringify(probeTitle)})`,
                20000,
              );
              if (listed.ok) {
                ok('§15 进入该自建文件夹能看到这条资源');
              } else {
                // 失败时必须自己说清"页面当时长什么样"，否则这条断言只会留下
                // "没看到"三个字，而原因可能是：树里没有这个节点（旧 URL 解析失败）、
                // 走了 notFound 分支、资源列表为空态、或只列了已发布没合并"我的"。
                // 这四种的修法完全不同。
                const diag = await evalIn(`(() => {
                  const txt = (document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ');
                  return JSON.stringify({
                    path: location.pathname,
                    browser: !!document.querySelector('[data-testid="directory-browser"]'),
                    notFound: !!document.querySelector('[data-testid="directory-browse-notfound"]'),
                    empty: !!document.querySelector('[data-testid="directory-browse-empty"]'),
                    mineNote: document.querySelector('[data-testid="directory-mine-note"]')?.innerText ?? null,
                    cards: document.querySelectorAll('[data-testid="resource-list"] > *').length,
                    tail: txt.slice(-200),
                  });
                })()`);
                bad('§15 进入该自建文件夹能看到这条资源', `想要 ${probeTitle}｜${String(diag).slice(0, 300)}`);
              }
            }
          }
        }
      }
    }
  }
}

async function cleanup() {
  // 改名的还原放在主流程里（每一步都能断言），这里只兜底一次。
  try {
    const c = makeClient();
    await c.req('GET', '/');
    await c.req('POST', '/api/auth/login', { username: USER, password: PASS });
    if (renamedFrom !== null) {
      const r = await c.req('PATCH', '/api/directories/node/prek%3Avirtue', { name: renamedFrom });
      console.log(`\n  (兜底还原「美德」：HTTP ${r.s})`);
    }
    // 探针资源必须**真正删除**：`DELETE` 只是软删除（进回收站），
    // 而门禁的 no-probe-residue 会逐行比对，软删留下的行会让它失败。
    if (createdResourceIds.length > 0) {
      const purged = await purgeProbeResources({
        req: (m, p, b) => c.req(m, p, b),
        ids: createdResourceIds,
        dbUrl: process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null,
        label: 'ia-consolidation',
      });
      console.log(
        `  (清理探针资源：接口 purge ${purged.purgedViaApi} / SQL 硬删 ${purged.purgedViaSql}` +
          (purged.remaining.length ? `；**仍残留 ${purged.remaining.length}**` : '；残留 0') +
          ')',
      );
    }
    // 自建文件夹：先解除资源归属（外键是 ON DELETE RESTRICT），再删。
    for (const code of createdFolderCodes.filter(Boolean)) {
      const del = await c.req('DELETE', `/api/directories/node/${encodeURIComponent(code)}`);
      console.log(`  (清理自建文件夹 ${code}：HTTP ${del.s})`);
    }
  } catch (e) {
    console.error('  (兜底还原失败：' + String(e) + ')');
  }
  try {
    if (chrome) chrome.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

try {
  await main();
} catch (e) {
  console.error('\n运行中抛出异常：' + (e?.stack || String(e)));
  FAILED += 1;
} finally {
  await cleanup();
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) {
  console.log(`  ⚠️  有 ${SKIPPED} 条断言被显式跳过，它们**不算通过**。`);
}
// pass=0 时即使 fail=0 也算失败：那意味着这个套件什么都没验。
process.exit(FAILED > 0 || PASSED === 0 ? 1 : 0);
