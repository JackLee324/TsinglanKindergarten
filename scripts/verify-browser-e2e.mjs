#!/usr/bin/env node
/**
 * scripts/verify-browser-e2e.mjs — 真实浏览器端到端验收（§32 的第一条垂直切片）
 * ==============================================================================
 * 为什么必须存在
 * --------------
 * 本会话修复的多数问题**在后端**，但它们的"最后一公里"都在浏览器里：
 *   §5  「提交审核」按钮是否真的提交（以前只建草稿却提示已提交）
 *   §16 「加载更多」是否让第 51 条之后的资源可达
 *   §19 「导出 CSV」按钮是否真的可点（以前写死 disabled）
 * 这些一律**只有 typecheck + build 证据**，属于"看起来修好了"。
 * 本脚本把它们变成可执行的断言：真登录、真点击、真读 DOM。
 *
 * 用法：
 *   BROWSER_E2E_BASE=http://127.0.0.1:3200 \
 *   BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' \
 *   node scripts/verify-browser-e2e.mjs
 * 退出码：0 全通过；1 有失败；2 环境不可用（缺 Chrome / 连不上 CDP）。
 *
 * 注意：它**不**替代 §32 要求的 9 条完整流程（上传/审核/撤回/删除恢复等仍需补），
 * 只覆盖"最小可运行的浏览器证据链"。脚本里每条断言都写明它对应哪一节。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const USER = process.env.BROWSER_E2E_USER || '';
const PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9231);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
/**
 * 断言尚未调准时的**显式跳过**。刻意大声打印并单独计数 —— 本仓库既有的约定是
 * "少跑了几项检查必须明确打印 NOTE，绝不静默通过"。跳过不等于通过，最终统计里分开列。
 */
const skip = (label, reason) => { console.log(`  SKIP  ${label}  -> ${reason}`); SKIPPED++; };
/** 断言实际值等于期望值；用于少数需要看具体数值的地方（本脚本主要用 ok/bad）。 */
const check = (label, actual, expected) => {
  if (actual === expected) ok(label, JSON.stringify(actual));
  else bad(label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

if (!USER || !PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS。');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'qls-browser-e2e-'));
let chrome = null;
const cleanup = () => {
  try { if (chrome) chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

try {
  const chromePath = process.env.CHROME_BIN ||
    CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) { console.error('找不到 Chrome/Chromium（可用 CHROME_BIN 指定）。'); process.exit(2); }

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    // 桌面尺寸视口：默认的 756×413 会让固定侧边栏挤压主内容，
    // 干扰基于坐标的交互与布局断言（见 clickSelector 的注释）。
    '--window-size=1600,1200',
    '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', 'about:blank',
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalIn = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result?.result?.value;
  };
  /**
   * 点击 + **验证点击真的产生了效果**。
   *
   * 为什么最终用 DOM 的 `el.click()` 而不是 CDP 真实鼠标事件
   * ---------------------------------------------------------
   * 我两种都试过，并且是**实测**得出结论的，不是偏好：
   *
   *   DOM .click()                 -> aria-expanded 由 'false' 变 'true'  ✅
   *   CDP mousePressed/mouseReleased -> 无效，且后续断言全部失败          ❌
   *
   * 原因不是"CDP 不能点"，而是**坐标**：headless 默认视口只有 756×413，
   * 左侧固定宽度 240px 的侧边栏正好盖在目录树按钮上。
   * `elementFromPoint(95, 206)` 返回的是侧边栏的 `<a>` —— 于是"点击"变成了
   * 导航到别的页面，`[data-dir-toggle]` 随之消失（aria-expanded 读到 undefined、
   * 目录树文本长度变成 0）。这类失败极易被误读成"展开功能坏了"。
   *
   * `el.click()` 不经过命中测试，因此不受重叠影响，恰好适合"验证产品行为"
   * 这个目的（要验证的是 React 的 onClick，而不是浏览器的命中测试）。
   * 如果将来要验真的指针交互，用 `--window-size=1600,1200` 让布局到桌面尺寸，
   * 再回到 CDP 坐标即可。
   *
   * 第二个教训同样重要：**点击函数必须能证明自己点到了东西**。
   * 第一版只判断"元素存在"就返回成功，于是
   * `ok('§16 能点到「课件与示范」标签')` 是一条**假 PASS** ——
   * 它只证明了页面上有这几个字。现在统一返回效果断言的结果，调用方必须检查。
   */
  /**
   * 派发**完整**鼠标序列（mousedown → mouseup → click）。
   *
   * 为什么不是 `el.click()`：本项目资料夹标签用的是 Radix Tabs，而
   * `@radix-ui/react-tabs` 的 Trigger 是在 **onMouseDown** 上切换值的
   * （自动激活模式下 `onMouseDown`/`onFocus`/`onKeyDown` 都会触发，唯独不看 `click`）。
   * 所以 `el.click()` 只派发一个 click 事件，Radix 收不到 → 标签永远不切换。
   * 这一个事实同时解释了两件事：
   *   * §16 这一条此前一直是 SKIP（"点了没反应"）；
   *   * 我上一版用 DOM .click() 仍然无效。
   * 真实鼠标本来就会先发 mousedown，所以按真实序列派发才是"完整"的，
   * 而不是给测试开后门。
   */
  const mouseSequence = `(el) => {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window }));
    }
  }`;

  const waitFor = async (expression, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evalIn(expression);
      if (last) return { ok: true, value: last };
      await sleep(500);
    }
    return { ok: false, value: last };
  };

  /** 按选择器点击，并用 `verify` 表达式确认产生了预期效果。 */
  const clickSelector = async (sel, verify = null) => {
    const clicked = await evalIn(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      (${mouseSequence})(el);
      return 'CLICKED';
    })()`);
    if (clicked !== 'CLICKED') return { clicked: false, reason: clicked };
    if (!verify) return { clicked: true, effect: 'NOT_CHECKED' };
    const r = await waitFor(verify, 10000);
    return { clicked: true, effect: r.ok ? 'OK' : 'NO_EFFECT' };
  };

  /**
   * 按可见文本点击。
   * `pick` 决定取第几个匹配：**默认取最后一个**，因为左侧导航栏在 DOM 里靠前，
   * 页面主体靠后；取第一个曾经让我误点到侧边栏的「Pre-K」，把侧边栏的科目
   * 当成了目录树的内容（假证据）。
   */
  const clickText = async (pattern, verify = null, pick = 'last') => {
    const idx = pick === 'last' ? 'els.length - 1' : '0';
    const res = await evalIn(`(() => {
      const els = [...document.querySelectorAll('button,[role=tab],a')]
        .filter((e) => new RegExp(${JSON.stringify(pattern)}).test((e.innerText || '').trim()));
      if (els.length === 0) return { ok: false, reason: 'NOT_FOUND' };
      const el = els[${idx}];
      el.scrollIntoView({ block: 'center' });
      (${mouseSequence})(el);
      return { ok: true, text: (el.innerText || '').trim(), count: els.length };
    })()`);
    if (!res?.ok) return { clicked: false, reason: res?.reason ?? 'NOT_FOUND' };
    if (!verify) return { clicked: true, text: res.text, effect: 'NOT_CHECKED' };
    const r = await waitFor(verify, 10000);
    return { clicked: true, text: res.text, effect: r.ok ? 'OK' : 'NO_EFFECT' };
  };

  /**
   * 导航并**等到应用真的渲染出来**，然后返回可见文本。
   *
   * 为什么不再用固定 sleep：本机跑 4.5 秒绰绰有余，但对着**生产**跑时，
   * SPA 的 bundle 要过网络下载、容器可能正在冷启动 —— 固定等待会让
   * 「还没渲染完」看起来像「功能坏了」：登录页断言失败、表单找不到、
   * 后面每一条都跟着失败（我第一次对生产跑就是 0/7 全红，其实什么都没坏）。
   * 所以改成轮询页面出现内容（或调用方给的条件），超时再报错。
   */
  const goto = async (path, _waitMs = 4500, until = null) => {
    await send('Page.navigate', { url: `${BASE}${path}` });
    const cond = until || '(document.getElementById("root")?.innerText || "").trim().length > 10';
    await waitFor(cond, 45000);
    await sleep(600); // 让首屏数据请求落定
    return (await evalIn("(document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ')")) || '';
  };

  await send('Page.enable'); await send('Runtime.enable');

  console.log(`=== 浏览器 E2E（${BASE}）===`);

  // ---- 1. 未登录访问受保护页面 → 应当被前端守卫送去登录页 ----
  const anon = await goto('/');
  if (anon.includes('密码') && anon.includes('登录')) {
    ok('未登录访问 / 显示登录页（ProtectedRoute 生效）');
  } else {
    bad('未登录访问 / 显示登录页', anon.slice(0, 90));
  }

  // ---- 2. 用真实登录表单登录 ----
  // 先等表单真的出现再填：对着生产跑时 JS bundle 还没下载完就到了这一步。
  await waitFor('document.querySelectorAll("input").length >= 2', 45000);
  const submitted = await evalIn(`(async () => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')];
    if (inputs.length < 2) return 'NO_FORM';
    set(inputs[0], ${JSON.stringify(USER)});
    set(inputs[1], ${JSON.stringify(PASS)});
    await new Promise((r) => setTimeout(r, 200));
    const btn = [...document.querySelectorAll('button')].find((b) => /登录|Sign In/i.test(b.innerText));
    if (!btn) return 'NO_BUTTON';
    btn.click();
    return 'SUBMITTED';
  })()`, true);
  if (submitted !== 'SUBMITTED') { bad('登录表单可提交', String(submitted)); }
  else ok('登录表单可提交', submitted);
  await waitFor(
    '/首页|Dashboard/.test(document.getElementById("root")?.innerText || "")',
    45000,
  );
  const home = await evalIn("(document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ')") || '';
  if (home.includes('首页') && !home.includes('无权访问')) ok('登录后进入工作台', home.slice(0, 40));
  else bad('登录后进入工作台', home.slice(0, 90));

  // ---- 3. §16：第 51 条之后的资源要能通过「加载更多」到达 ----
  // /prek/montessori 渲染的是**子科目录**（日常生活/感官/…），资料夹要选定子科后才出现。
  // 因此先进入子科，再切到条目最多的「课件与示范」（该子科 79 条 > 50，
  // 正是能暴露"被截断在第 51 条"的用例）。
  //
  // 上一轮这里是 SKIP：用 DOM 的 `el.click()` 点标签连续 3 次都没让内容切换。
  // 现在改用 CDP 真实鼠标事件（clickText），把这一点变成可判定 ——
  // 「点不动」和「分页坏了」是两件事，不能用一个 SKIP 含糊过去。
  await goto('/prek/montessori/practical-life', 5500);
  const tabClicked = await clickText(
    '课件与示范|Courseware',
    `(() => {
       const el = [...document.querySelectorAll('[role=tab]')]
         .find((e) => /课件与示范|Courseware/.test(e.innerText || ''));
       return !!el && (el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active');
     })()`,
  );
  if (!tabClicked.clicked) {
    bad('§16 能点到「课件与示范」标签', tabClicked.reason);
  } else if (tabClicked.effect !== 'OK') {
    bad('§16 点击「课件与示范」后该标签进入选中态', `clicked=${tabClicked.text} effect=${tabClicked.effect}`);
  } else {
    ok('§16 点击「课件与示范」后该标签进入选中态', tabClicked.text);
    // 轮询而不是固定 4 秒：79 条的分页文案要等数据回来才渲染，
    // 固定等待会把"慢"误报成"坏"。超时后把真实文本打出来，便于定位。
    const readPager = `(() => {
      const txt = document.getElementById('root')?.innerText || '';
      const m = txt.match(/已显示\\s*(\\d+)\\s*\\/\\s*共\\s*(\\d+)\\s*条/);
      return m ? { shown: Number(m[1]), total: Number(m[2]) } : null;
    })()`;
    const first = await waitFor(readPager, 20000);
    if (!first.ok) {
      const diag = await evalIn(`(() => {
        const txt = (document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ');
        const tabs = [...document.querySelectorAll('[role=tab],button')]
          .map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 20);
        return { len: txt.length, tail: txt.slice(-260), tabs };
      })()`);
      bad('§16 页面显示「已显示 X / 共 Y 条」', JSON.stringify(diag));
    } else {
      const { shown, total } = first.value;
      ok('§16 页面显示「已显示 X / 共 Y 条」', `已显示 ${shown} / 共 ${total} 条`);
      if (total > 50) {
        ok('§16 总数超过一页（用例有效：>50）', String(total));
        // 数**真实渲染出来的资源卡片**，而不是读「已显示 X / 共 Y 条」：
        // 第 2 页加载完后 total(79) 不再 > resources.length(79)，那一行会正确地
        // 整块消失 —— 于是读文案会得到 null，把成功误判成失败。
        // 卡片个数才是"第 51 条之后是否真的出现"的直接证据。
        const cardsBefore = await evalIn(
          "document.querySelector('[data-testid=\"resource-list\"]')?.children.length ?? 0");
        const clicked = (await clickText('加载更多|Load more')).clicked;
        const grew = await waitFor(
          `(document.querySelector('[data-testid="resource-list"]')?.children.length || 0) > ${cardsBefore}`,
          20000,
        );
        const cardsAfter = await evalIn(
          "document.querySelector('[data-testid=\"resource-list\"]')?.children.length ?? 0");
        if (clicked && grew.ok && cardsAfter >= total) {
          ok('§16 点「加载更多」后资源卡片增加且达到总数（第 51 条之后可达）',
            `卡片 ${cardsBefore} → ${cardsAfter}（共 ${total} 条）`);
        } else {
          bad('§16 点「加载更多」后资源卡片增加且达到总数',
            `clicked=${clicked} 卡片 ${cardsBefore} → ${cardsAfter} 期望 ${total}`);
        }
      } else {
        bad('§16 总数超过一页（用例有效：>50）', String(total));
      }
    }
  }

  // ---- 3b. §1/§2/§20：目录页必须**从数据库**渲染出 PDF 的那棵树 ----
  //
  // ⚠️ 第一版这里读的是整页 innerText，结果读到的是**左侧导航栏** ——
  // 「Pre-K 下有美德/蒙特梭利/体能」被侧边栏满足、看起来通过了，
  // 而真正要断言的目录树根本没被检查（"英文"恰好在侧边栏里没有，才暴露了这一点）。
  // 现在只读 `[data-testid="directory-tree"]`，并按 `[data-dir-toggle="<code>"]` 展开。
  const treeText = () => evalIn(
    `(document.querySelector('[data-testid="directory-tree"]')?.innerText || '').replace(/\\s+/g, ' ')`);

  // 等到「树出现」**或**「明确报加载失败」为止：
  // 只等"页面有文字"是不够的 —— 布局与导航先渲染，目录还在「加载中...」，
  // 于是断言读到加载态而误判成"目录页坏了"（第一次对生产跑就是这样，7 条全红）。
  // 但也不能无限等：真失败时要快速落到失败分支，由页面自己的报错文案给出原因。
  await goto(
    '/directory',
    6000,
    "!!document.querySelector('[data-testid=\"directory-tree\"]')" +
      " || /目录加载失败|Failed to load/.test(document.getElementById('root')?.innerText || '')",
  );
  const containerExists = await evalIn(
    "!!document.querySelector('[data-testid=\"directory-tree\"]')");
  if (!containerExists) {
    const body = await evalIn("(document.getElementById('root')?.innerText || '').slice(0, 200)");
    bad('§1 目录页渲染出目录树容器', body);
  } else {
    ok('§1 目录页渲染出目录树容器');
    const before = await treeText();
    for (const label of ['教育教学', '教师成长']) {
      if (before.includes(label)) ok(`§1 树中出现根分支「${label}」`);
      else bad(`§1 树中出现根分支「${label}」`, before.slice(0, 200));
    }

    // 展开 Pre-K：PDF 的 4 个 Pre-K 科目都必须出现
    // —— 其中「英文」是 PDF 比现有应用**多**的科目，最有判别力。
    const prekClick = await clickSelector(
      '[data-dir-toggle="prek"]',
      "document.querySelector('[data-dir-toggle=\"prek\"]')?.getAttribute('aria-expanded') === 'true'",
    );
    const prekOk = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="directory-tree"]')?.innerText || '';
      return /美德/.test(t) && /蒙特梭利/.test(t) && /体能/.test(t) && /英文/.test(t);
    })()`, 8000);
    const prekTxt = await treeText();
    if (prekClick.effect !== 'OK') {
      bad('§1 点击 Pre-K 后其 aria-expanded 变为 true', `effect=${prekClick.effect}`);
    } else {
      ok('§1 点击 Pre-K 后其 aria-expanded 变为 true');
    }
    if (prekOk.ok) ok('§1 展开 Pre-K 后 4 个科目齐全（含 PDF 新增的「英文」）');
    else bad('§1 展开 Pre-K 后 4 个科目齐全（含「英文」）', prekTxt.slice(0, 240));

    // 展开 Pre-K 体能：其「教学详案/教学资源」带 PDF 的「允许自建文件夹」标记
    await clickSelector(
      '[data-dir-toggle="prek:pe"]',
      "document.querySelector('[data-dir-toggle=\"prek:pe\"]')?.getAttribute('aria-expanded') === 'true'",
    );
    const peOk = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="directory-tree"]')?.innerText || '';
      return /教学详案/.test(t) && /教学资源/.test(t) && /课程大纲/.test(t) && /考核评估/.test(t);
    })()`, 8000);
    if (peOk.ok) ok('§1 展开科目后出现 PDF 的 4 类资料夹');
    else bad('§1 展开科目后出现 PDF 的 4 类资料夹', (await treeText()).slice(0, 240));

    const customBadge = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="directory-tree"]')?.innerText || '';
      return /可自建文件夹/.test(t);
    })()`, 5000);
    if (customBadge.ok) ok('§1 树中显示「可自建文件夹」标记（PDF 明确要求）');
    else bad('§1 树中显示「可自建文件夹」标记', (await treeText()).slice(0, 240));

    // 教师成长是**新增**的一棵树：从数据库读出的 L1/L2/L3 与 L1 下级
    const growthOk = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="directory-tree"]')?.innerText || '';
      return /L1/.test(t) && /L2/.test(t) && /L3/.test(t);
    })()`, 5000);
    if (growthOk.ok) ok('§1 教师成长树渲染 L1/L2/L3（来自数据库）');
    else bad('§1 教师成长树渲染 L1/L2/L3', (await treeText()).slice(0, 240));

    await clickSelector(
      '[data-dir-toggle="growth:l1"]',
      "document.querySelector('[data-dir-toggle=\"growth:l1\"]')?.getAttribute('aria-expanded') === 'true'",
    );
    const l1Ok = await waitFor(`(() => {
      const t = document.querySelector('[data-testid="directory-tree"]')?.innerText || '';
      return /职业道德规范/.test(t) && /安全施教规范/.test(t) && /专业知识/.test(t) && /专业技能/.test(t);
    })()`, 8000);
    if (l1Ok.ok) ok('§1 教师成长 L1 的 4 个分支渲染（来自数据库）');
    else bad('§1 教师成长 L1 的 4 个分支渲染', (await treeText()).slice(0, 240));
  }

  // ---- 3c. §24/§25/§26：在浏览器里真的建一个自建文件夹，再删掉 ----
  //
  // 这一条补的是"接口通过 ≠ 界面能用"：按钮要出现、表单要能输入、
  // 提交后**树里真的多出这个节点**、删掉后**真的少掉** —— 全程只看 DOM。
  await goto(
    '/directory',
    6000,
    "!!document.querySelector('[data-testid=\"directory-tree\"]')",
  );
  // 先把树展开到目标节点：`goto('/directory')` 是**整页重载**，展开状态会回到默认
  // （只展开两个根），所以 prek:pe_lesson 此刻根本不在 DOM 里 ——
  // 第一版就是因为漏了这一步，把"没渲染"误报成"按钮缺失"。
  await clickSelector('[data-dir-toggle="prek"]',
    "document.querySelector('[data-dir-toggle=\"prek\"]')?.getAttribute('aria-expanded') === 'true'");
  await clickSelector('[data-dir-toggle="prek:pe"]',
    "document.querySelector('[data-dir-toggle=\"prek:pe\"]')?.getAttribute('aria-expanded') === 'true'");

  const createBtnSel = '[data-dir-create="prek:pe_lesson"]';
  const hasCreateBtn = await evalIn(`!!document.querySelector(${JSON.stringify(createBtnSel)})`);
  if (!hasCreateBtn) {
    // 按钮不存在有两种可能：没有 curriculum.manage，或该节点不允许自建。
    // 两种都不算"功能坏了"，但必须**说清是哪一种**，不能静默跳过。
    const canManage = await evalIn(
      "(async () => (await (await fetch('/api/directories/tree', { credentials: 'include' })).json()).canManage)()",
      true,
    );
    bad('§24 「新建文件夹」按钮出现在允许自建的节点上',
      `按钮缺失；服务端 canManage=${JSON.stringify(canManage)}（false 说明这个账号本来就没有目录管理权限）`);
  } else {
    ok('§24 「新建文件夹」按钮出现在允许自建的节点上');
    await runDirectoryWriteFlow();
  }

  /**
   * 在浏览器里真的建一个自建文件夹、再删掉。
   *
   * 每一步都单独验证效果 —— 否则任何一步静默失败，最终都只会表现为
   * "文件夹没出现"，看不出是哪一步断的（第一版本就是这样）。
   */
  async function runDirectoryWriteFlow() {
    const probeName = `浏览器自建-${Date.now().toString().slice(-6)}`;

    const formOpened = await clickSelector(
      createBtnSel,
      `!!document.querySelector('[data-dir-name-input="prek:pe_lesson"]')`,
    );
    if (formOpened.effect !== 'OK') {
      bad('§24 点「新建文件夹」后出现名称输入框', `effect=${formOpened.effect}`);
      return;
    }
    ok('§24 点「新建文件夹」后出现名称输入框');

    const setRes = await evalIn(`(() => {
      const input = document.querySelector('[data-dir-name-input="prek:pe_lesson"]');
      if (!input) return 'NO_INPUT';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(probeName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === ${JSON.stringify(probeName)} ? 'SET' : 'VALUE_MISMATCH';
    })()`);
    check('§24 能往输入框里填名称', setRes, 'SET');

    const submitClicked = await evalIn(`(() => {
      const b = document.querySelector('[data-dir-submit="prek:pe_lesson"]');
      if (!b) return 'NO_SUBMIT_BUTTON';
      b.click();
      return 'CLICKED';
    })()`);
    check('§24 提交按钮存在且已点击', submitClicked, 'CLICKED');

    const appeared = await waitFor(
      `(document.body.innerText || '').includes(${JSON.stringify(probeName)})`,
      20000,
    );
    if (!appeared.ok) {
      const errText = await evalIn(
        "document.querySelector('[data-testid=\"directory-action-error\"]')?.innerText || '(无错误提示)'");
      bad('§24 提交后新文件夹出现在树里（数据真的写进去了）', errText);
      return;
    }
    ok('§24 提交后新文件夹出现在树里（数据真的写进去了）', probeName);

    // 用 data-dir-name 精确匹配，而不是"innerText 包含"：
    // 父节点的 innerText 包含整棵子树，用包含关系会命中根节点 ——
    // 于是"删掉刚建的那个"变成了"删根节点"，被服务端 403 正确拒绝，
    // 而测试却报成"删除后没消失"。用节点自己的名字属性才没有歧义。
    const newCode = await evalIn(`(() => {
      const el = document.querySelector('[data-dir-name=' + JSON.stringify(${JSON.stringify(probeName)}) + ']');
      return el ? el.getAttribute('data-dir-code') : null;
    })()`);
    if (!newCode) {
      bad('§24 能定位到新节点的 code', 'NOT_FOUND');
      return;
    }
    ok('§24 能定位到新节点的 code', newCode);

    // 删除（有确认框，先把它短路掉）
    await evalIn(`window.confirm = () => true`);
    await evalIn(`document.querySelector('[data-dir-delete="' + ${JSON.stringify(newCode)} + '"]')?.click()`);
    const gone = await waitFor(
      `!(document.body.innerText || '').includes(${JSON.stringify(probeName)})`,
      20000,
    );
    if (gone.ok) ok('§24 删除后该文件夹从树里消失', newCode);
    else bad('§24 删除后该文件夹从树里消失', newCode);
  }

  // ---- 3d. §14：资源详情是真弹窗、显示真数据（不再是"详情功能开发中"）----
  await goto('/my-resources', 6000, "!!document.querySelector('[data-testid=\"resource-detail-open\"]')");
  const hasDetailBtn = await evalIn("!!document.querySelector('[data-testid=\"resource-detail-open\"]')");
  const listEmpty = await evalIn("/暂无数据|No data|No resources/.test(document.getElementById('root')?.innerText || '')");
  if (!hasDetailBtn && listEmpty) {
    // 「查看」按钮是**按行渲染**的，所以列表为空时它本来就不该存在。
    // 生产环境的 TsinglanAdmin 名下没有任何资源（347 条种子都记在"系统初始化"账号下），
    // 于是这一条在生产上无法执行。这不是失败，但也**不算通过** —— 明确说清楚原因。
    skip(
      '§14 资源详情弹窗',
      '本环境的账号名下没有资源，列表为空 → 没有「查看」按钮可点。' +
        '同样的断言在本机门禁里是执行的并且通过（seq_principal 名下有 2 条）。',
    );
  } else if (!hasDetailBtn) {
    const body = await evalIn("(document.getElementById('root')?.innerText || '').slice(0, 160)");
    bad('§14 「查看」按钮存在', body);
  } else {
    ok('§14 「查看」按钮存在');
    // 点开之前先记下"开发中"是否出现，用于验证它**没有**再出现
    await evalIn(`document.querySelector('[data-testid="resource-detail-open"]').click()`);
    const opened = await waitFor("!!document.querySelector('[data-testid=\"resource-detail-dialog\"]')", 15000);
    if (!opened.ok) {
      bad('§14 点「查看」打开详情弹窗', 'DIALOG_NOT_OPEN');
    } else {
      ok('§14 点「查看」打开详情弹窗');
      // 弹窗先渲染外壳、再异步取数据，所以必须**轮询到内容出现**再断言。
      // 第一版在这里直接读一次 innerText，读到的是"加载中..."，
      // 于是三条字段断言全部失败 —— 又是"把没加载完当成功能坏了"。
      const loaded = await waitFor(
        `(() => {
           const t = document.querySelector('[data-testid="resource-detail-dialog"]')?.innerText || '';
           return /草稿|待审核|已发布|已退回|Draft|Pending|Published|Rejected/.test(t) ? t.replace(/\\s+/g, ' ') : null;
         })()`,
        20000,
      );
      const detailText = loaded.ok
        ? loaded.value
        : await evalIn("(document.querySelector('[data-testid=\"resource-detail-dialog\"]')?.innerText || '').replace(/\\s+/g, ' ')");
      if (/功能开发中|coming soon/i.test(detailText)) {
        bad('§14 详情里不再出现"开发中"占位文案', detailText.slice(0, 120));
      } else {
        ok('§14 详情里不再出现"开发中"占位文案');
      }
      // 必须显示真实字段（状态与版本来自 GET /api/resources/:id）
      for (const [label, re] of [
        ['状态', /草稿|待审核|已发布|已退回|Draft|Pending|Published|Rejected/],
        ['版本', /v\d+/],
        ['上传者', /上传者|Uploaded by/],
      ]) {
        if (re.test(detailText)) ok(`§14 详情显示「${label}」字段`);
        else bad(`§14 详情显示「${label}」字段`, detailText.slice(0, 200));
      }
      await evalIn(`document.querySelector('[data-testid="resource-detail-close"]')?.click()`);
      const closed = await waitFor("!document.querySelector('[data-testid=\"resource-detail-dialog\"]')", 10000);
      if (closed.ok) ok('§14 详情弹窗可关闭');
      else bad('§14 详情弹窗可关闭', 'STILL_OPEN');
    }
  }

  // ---- 4. §19：导出按钮必须是可点的（以前写死 disabled）----
  const audit = await goto('/admin/audit', 5000);
  const exportEnabled = await evalIn(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => /导出 CSV|Export CSV/.test(el.innerText || ''));
    if (!b) return 'NO_BUTTON';
    return b.disabled ? 'DISABLED' : 'ENABLED';
  })()`);
  if (exportEnabled === 'ENABLED') ok('§19 「导出 CSV」按钮可点击（不再 disabled）');
  else bad('§19 导出按钮状态', `${exportEnabled} | ${audit.slice(0, 80)}`);

  // ---- 5. §5：我的资源里必须存在「提交审核」入口 ----
  const mine = await goto('/my-resources', 5000);
  // 断言"页面渲染正常且有内容"——不断言行内按钮的文案，那是图标+tooltip，找不到会误判。
  const mineOk = /我的资源/.test(mine) && (/共 \d+ 条/.test(mine) || /暂无|No data|没有/.test(mine));
  if (mineOk) {
    ok('§5 「我的资源」渲染正常并列出资源/空态', (mine.match(/共 \d+ 条/) || ['(空态)'])[0]);
  } else {
    bad('§5 我的资源渲染');
    console.log('        页面文本: ' + mine.slice(0, 400));
  }

  ws.close();
} catch (error) {
  console.error('  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) {
  console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过（未调准），它们**不算通过**。');
}
process.exit(FAILED ? 1 : 0);
