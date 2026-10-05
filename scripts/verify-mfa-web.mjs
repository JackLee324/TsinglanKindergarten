/**
 * scripts/verify-mfa-web.mjs —— 两步验证与首次登录强制改密的**浏览器**闭环（§12/§13）。
 *
 *   BROWSER_E2E_USER=seq_principal BROWSER_E2E_PASS='…' node scripts/verify-mfa-web.mjs
 *
 * 为什么单独一个脚本而不是并进 verify-browser-e2e.mjs：
 * 它会**切换登录账号**（要造一个临时账号、走完登记、再退出重登），
 * 混在只读为主的流程里会互相干扰；而且它必须能独立失败、独立定位。
 *
 * 覆盖的真实链路：
 *   建临时账号 → 用临时密码登录 → **被强制跳到改密页**（其他路由被挡住）
 *   → 改密成功 → 进入 /account/security → 启用两步验证（真 TOTP 码）
 *   → 拿到恢复码 → 退出 → 重新登录 → **出现第二步** → 输入新 TOTP 码 → 进入工作台
 *
 * 断言里没有任何"看代码就能确定"的东西：每一步都读真实 DOM 与真实 HTTP 状态。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const BASE = process.env.BROWSER_E2E_BASE || 'http://127.0.0.1:3200';
const ADMIN_USER = process.env.BROWSER_E2E_USER || '';
const ADMIN_PASS = process.env.BROWSER_E2E_PASS || '';
const PORT = Number(process.env.BROWSER_E2E_CDP_PORT || 9271);
const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('需要 BROWSER_E2E_USER / BROWSER_E2E_PASS（用于创建并清理临时账号）。');
  process.exit(2);
}

let PASSED = 0, FAILED = 0, SKIPPED = 0;
const ok = (label, detail = '') => { console.log(`  PASS  ${label}${detail ? '  -> ' + detail : ''}`); PASSED++; };
const bad = (label, detail = '') => { console.log(`  FAIL  ${label}${detail ? '  -> ' + detail : ''}`); FAILED++; };
const skip = (label, reason) => { console.log(`  SKIP  ${label}  -> ${reason}`); SKIPPED++; };

// TOTP 独立实现（与 scripts/verify-mfa.mjs 同一份），这样测试不会和被测代码共享同一个 bug。
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32d(s) { let bits = 0, v = 0; const out = []; for (const c of s.toUpperCase().replace(/=+$/, '')) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, t = Math.floor(Date.now() / 1000), period = 30, digits = 6) {
  const buf = Buffer.alloc(8); const c = Math.floor(t / period);
  buf.writeUInt32BE(Math.floor(c / 2 ** 32), 0); buf.writeUInt32BE(c >>> 0, 4);
  const d = crypto.createHmac('sha1', b32d(secret)).update(buf).digest();
  const o = d[d.length - 1] & 15;
  const n = ((d[o] & 127) << 24) | ((d[o + 1] & 255) << 16) | ((d[o + 2] & 255) << 8) | (d[o + 3] & 255);
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** 简单 HTTP 客户端（cookie jar），用于创建/清理临时账号这类非浏览器动作。 */
function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } };
  async function req(m, p, b) {
    const h = { 'content-type': 'application/json' };
    if (Object.keys(jar).length) h.cookie = cookie();
    if (jar['suda-csrf-token']) h['x-suda-csrf-token'] = jar['suda-csrf-token'];
    const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    store(r);
    let d = null; try { d = await r.json(); } catch { /* 204/空 */ }
    return { s: r.status, d };
  }
  return { req };
}

const profile = mkdtempSync(join(tmpdir(), 'qls-mfa-web-'));
let chrome = null;
let createdUsername = null;

function cleanupProfile() { try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }

async function main() {
  const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const chromePath = process.env.CHROME_BIN || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) { console.error('找不到 Chrome/Chromium（可用 CHROME_BIN 指定）。'); process.exit(2); }

  // ---- 造账号（管理员会话）----
  const admin = makeClient();
  await admin.req('GET', '/');
  const adminLogin = await admin.req('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (adminLogin.s !== 201 && adminLogin.s !== 200) {
    console.error(`管理员登录失败：HTTP ${adminLogin.s} ${JSON.stringify(adminLogin.d)}`);
    process.exit(2);
  }

  const stamp = Date.now().toString().slice(-6);
  createdUsername = `e2e_mfa_${stamp}`;
  const created = await admin.req('POST', '/api/teachers', {
    username: createdUsername,
    name: `MFA 闭环探针 ${stamp}`,
    roles: ['prek_head'],
    status: 'active',
  });
  if (created.s !== 201 && created.s !== 200) {
    console.error(`创建临时账号失败：HTTP ${created.s} ${JSON.stringify(created.d)}`);
    process.exit(2);
  }
  const teacherId = created.d?.id ?? created.d?.teacher?.id ?? null;
  const tempPassword = created.d?.temporaryPassword ?? created.d?.tempPassword ?? null;
  if (!teacherId || !tempPassword) {
    console.error(`创建响应里没有 id/临时密码：${JSON.stringify(created.d)}`);
    process.exit(2);
  }
  const NEW_PASSWORD = `E2eMfa!${stamp}aA9`;

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
  const path = () => evalIn('location.pathname');
  const fill = async (sel, value) => evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'SET' : 'MISMATCH';
  })()`);
  const clickSel = async (sel) => {
    const r = await evalIn(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NOT_FOUND'; el.scrollIntoView({block:'center'}); for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0,view:window})); return 'CLICKED'; })()`);
    return r;
  };

  await send('Page.enable'); await send('Runtime.enable');

  console.log(`\n=== MFA / 强制改密 浏览器闭环（${BASE}）===\n`);

  // =========================================================================
  // 1. 用临时密码登录 → 必须被强制改密拦住
  // =========================================================================
  console.log('1) 首次登录（临时密码）→ 强制改密');
  await goto('/');
  await waitFor('document.querySelectorAll("input").length >= 2', 45000);
  await fill('input[autocomplete="username"]', createdUsername);
  await fill('input[autocomplete="current-password"]', tempPassword);
  await clickSel('[data-testid="login-submit"]');

  const landed = await waitFor('/change-password/.test(location.pathname)', 30000);
  if (landed.ok) ok('临时密码登录后被强制跳到 /change-password', await path());
  else bad('临时密码登录后被强制跳到 /change-password', `停在 ${await path()}`);

  if (landed.ok) {
    // 关键：不是"提示了一句"，而是**别的路由进不去**
    await goto('/my-resources');
    const blocked = await path();
    if (blocked === '/change-password') ok('未改密前访问 /my-resources 仍被挡回改密页');
    else bad('未改密前访问 /my-resources 仍被挡回改密页', `到了 ${blocked}`);

    await goto('/directory');
    const blocked2 = await path();
    if (blocked2 === '/change-password') ok('未改密前访问 /directory 仍被挡回改密页');
    else bad('未改密前访问 /directory 仍被挡回改密页', `到了 ${blocked2}`);

    // **服务端**也必须拦。前端跳转是可以通过直接调接口绕过的，
    // 所以这一条才是"强制改密"到底真不真的分界线。
    await goto('/change-password');
    const apiProbe = await evalIn(`(async () => {
      const r = await fetch('/api/resources/mine', { credentials: 'include' });
      let body = null; try { body = await r.json(); } catch { /* 空 */ }
      return { status: r.status, code: body?.error?.code ?? body?.code ?? null,
               details: JSON.stringify(body?.error?.details ?? '') };
    })()`, true);
    if (apiProbe?.status === 403) ok('临时密码状态下受保护接口被服务端拒绝（403）', String(apiProbe.status));
    else bad('临时密码状态下受保护接口被服务端拒绝（403）', JSON.stringify(apiProbe));

    const codeSeen = /PASSWORD_CHANGE_REQUIRED/.test(String(apiProbe?.code ?? '') + String(apiProbe?.details ?? ''));
    if (codeSeen) ok('拒绝里带机器可读的 PASSWORD_CHANGE_REQUIRED');
    else bad('拒绝里带机器可读的 PASSWORD_CHANGE_REQUIRED', JSON.stringify(apiProbe));

    // 而改密接口本身必须放行，否则用户会被锁死
    const allowed = await evalIn(`(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      return r.status;
    })()`, true);
    if (allowed === 200) ok('改密期间 /api/auth/me 仍放行（否则用户会被锁死）', String(allowed));
    else bad('改密期间 /api/auth/me 仍放行', String(allowed));

    // 改密
    const inputs = await evalIn("[...document.querySelectorAll('input')].map(i => i.getAttribute('autocomplete') || i.type)");
    console.log('        （改密页输入框：' + JSON.stringify(inputs) + '）');
    await fill('input[autocomplete="current-password"]', tempPassword);
    const newPwSel = await evalIn(`(() => {
      const els = [...document.querySelectorAll('input[type=password]')];
      return els.length >= 2 ? (els[1].getAttribute('name') || 'index:1') : null;
    })()`);
    // 直接按顺序填：第 1 个当前密码、第 2 个新密码、第 3 个（若有）确认
    await evalIn(`(() => {
      const els = [...document.querySelectorAll('input[type=password]')];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const vals = [${JSON.stringify(tempPassword)}, ${JSON.stringify(NEW_PASSWORD)}, ${JSON.stringify(NEW_PASSWORD)}];
      els.forEach((el, i) => { if (vals[i] !== undefined) { setter.call(el, vals[i]); el.dispatchEvent(new Event('input', { bubbles: true })); } });
      return els.length;
    })()`);
    await sleep(300);
    await evalIn(`(() => { const b = [...document.querySelectorAll('button[type=submit]')][0]; if (b) b.click(); return !!b; })()`);

    const left = await waitFor("location.pathname === '/'", 30000);
    if (left.ok) ok('改密成功后离开改密页并进入工作台');
    else {
      const errText = await evalIn("(document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)");
      bad('改密成功后离开改密页', `停在 ${await path()}；页面：${errText}`);
    }
  }

  // =========================================================================
  // 2. 在浏览器里启用两步验证（真 TOTP）
  // =========================================================================
  console.log('\n2) 在 /account/security 启用两步验证');
  let secret = null;
  if (FAILED === 0) {
    await goto('/account/security', "!!document.querySelector('[data-testid=\"mfa-panel\"]')");
    const state = await evalIn("document.querySelector('[data-testid=\"mfa-state\"]')?.innerText || ''");
    if (/未启用|not enabled/i.test(state)) ok('页面显示两步验证未启用', state.trim());
    else bad('页面显示两步验证未启用', state || '(空)');

    const clicked = await clickSel('[data-testid="mfa-enroll"]');
    if (clicked !== 'CLICKED') bad('点「启用两步验证」', clicked);
    else {
      const shown = await waitFor("!!document.querySelector('[data-testid=\"mfa-secret\"]')", 20000);
      if (!shown.ok) {
        const err = await evalIn("document.querySelector('[data-testid=\"security-error\"]')?.innerText || '(无错误)'");
        bad('登记后显示密钥', err);
      } else {
        secret = await evalIn("document.querySelector('[data-testid=\"mfa-secret\"]').innerText.trim()");
        ok('登记后显示密钥（供手动录入验证器）', `${String(secret).slice(0, 6)}…`);
        await fill('[data-testid="mfa-confirm-code"]', totp(secret));
        await clickSel('[data-testid="mfa-confirm-submit"]');
        const codes = await waitFor("!!document.querySelector('[data-testid=\"mfa-recovery-codes\"]')", 25000);
        if (codes.ok) {
          const list = await evalIn("[...document.querySelectorAll('[data-testid=\"mfa-recovery-codes\"] li')].map(li => li.innerText.trim())");
          ok('确认后返回恢复码', `${Array.isArray(list) ? list.length : 0} 个`);
          if (Array.isArray(list) && list.length >= 5) ok('恢复码数量合理（>=5）', String(list.length));
          else bad('恢复码数量合理（>=5）', String(Array.isArray(list) ? list.length : 0));
        } else {
          const err = await evalIn("document.querySelector('[data-testid=\"security-error\"]')?.innerText || '(无错误)'");
          bad('用真 TOTP 码确认启用', err);
        }
        await evalIn("document.querySelector('[data-testid=\"mfa-saved-codes\"]')?.click()");
      }
    }
  } else {
    skip('启用两步验证', '上一步（强制改密）未通过，后置步骤不再执行');
  }

  // =========================================================================
  // 3. 退出 → 重新登录 → 必须出现第二步
  // =========================================================================
  console.log('\n3) 退出后重新登录 → 第二步');
  if (FAILED === 0 && secret) {
    // 用界面退出（清掉会话 cookie）
    await goto('/');
    await evalIn(`(() => { const b = [...document.querySelectorAll('button')].find(x => /退出|Sign out|Logout/i.test(x.innerText||'')); if (b) b.click(); return !!b; })()`);
    await waitFor('/login/.test(location.pathname)', 20000);

    await goto('/login', 'document.querySelectorAll("input").length >= 2');
    await fill('input[autocomplete="username"]', createdUsername);
    await fill('input[autocomplete="current-password"]', NEW_PASSWORD);
    await clickSel('[data-testid="login-submit"]');

    const step = await waitFor("!!document.querySelector('[data-testid=\"mfa-step\"]')", 25000);
    if (step.ok) {
      ok('密码正确后出现第二步（未签发会话）');
      // 关键：此时受保护路由仍然进不去
      const navAttempt = await evalIn('location.pathname');
      if (navAttempt === '/login') ok('第二步之前仍停在 /login');
      else bad('第二步之前仍停在 /login', navAttempt);

      await fill('[data-testid="mfa-code-input"]', totp(secret));
      await clickSel('[data-testid="mfa-submit"]');
      const inHome = await waitFor("location.pathname === '/'", 30000);
      if (inHome.ok) ok('输入正确 TOTP 后进入工作台', await path());
      else {
        const errText = await evalIn("document.getElementById('root')?.innerText || ''");
        bad('输入正确 TOTP 后进入工作台', `停在 ${await path()}；${String(errText).replace(/\\s+/g, ' ').slice(0, 160)}`);
      }
    } else {
      const body = await evalIn("(document.getElementById('root')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)");
      bad('密码正确后出现第二步', body);
    }
  } else {
    skip('重新登录的第二步', '未走到启用完成，无法验证第二步');
  }

  // =========================================================================
  // 4. 错误验证码必须被拒绝（而不是放行）
  // =========================================================================
  console.log('\n4) 错误验证码');
  if (FAILED === 0 && secret) {
    await evalIn(`(async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); })()`, true);
    await goto('/login', 'document.querySelectorAll("input").length >= 2');
    await fill('input[autocomplete="username"]', createdUsername);
    await fill('input[autocomplete="current-password"]', NEW_PASSWORD);
    await clickSel('[data-testid="login-submit"]');
    const step = await waitFor("!!document.querySelector('[data-testid=\"mfa-step\"]')", 25000);
    if (!step.ok) {
      bad('错误码用例：能进入第二步', '第二步未出现');
    } else {
      // 同一个窗口内几乎不可能出现两个有效码之外的巧合；用全零码
      await fill('[data-testid="mfa-code-input"]', '000000');
      await clickSel('[data-testid="mfa-submit"]');
      await sleep(2500);
      const stillLogin = await evalIn('location.pathname');
      const errText = await evalIn("document.getElementById('root')?.innerText || ''");
      if (stillLogin !== '/') ok('错误验证码不会进入工作台', `停在 ${stillLogin}`);
      else bad('错误验证码不会进入工作台', '竟然进去了');
      if (/还可尝试|验证码不正确|重新登录|incorrect/i.test(String(errText))) ok('页面显示了服务端给出的失败原因');
      else bad('页面显示了服务端给出的失败原因', String(errText).replace(/\\s+/g, ' ').slice(0, 160));
    }
  } else {
    skip('错误验证码用例', '未走到启用完成，无法验证');
  }
}

try {
  await main();
} catch (error) {
  console.error('\n  ABORTED — ' + (error?.stack || String(error)));
  FAILED += 1;
} finally {
  if (chrome) chrome.kill();
  cleanupProfile();
  // 清理临时账号（DELETE /api/teachers 在本机库上会 500，所以优先用 SQL）
  if (createdUsername) {
    if (DB_URL) {
      try {
        const postgres = (await import('postgres')).default;
        const sql = postgres(DB_URL, { max: 1 });
        await sql`DELETE FROM teachers WHERE username = ${createdUsername}`;
        await sql.end();
        console.log(`\n清理：已删除临时账号 ${createdUsername}`);
      } catch (e) {
        console.error(`清理临时账号失败：${e?.message}`);
      }
    } else {
      console.error(`\n未能清理临时账号 ${createdUsername}（未设置 DATABASE_URL / AUTHZ_TEST_DB）`);
    }
  }
}

console.log('\n=== RESULT ===');
console.log(`  pass=${PASSED} fail=${FAILED} skipped=${SKIPPED}`);
if (SKIPPED > 0) console.log('  ⚠️  有 ' + SKIPPED + ' 条断言被显式跳过，它们**不算通过**。');
process.exit(FAILED ? 1 : 0);
