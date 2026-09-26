/**
 * One-off check: render an AUTHENTICATED page in a real browser and read it back.
 *
 * The E2E suite renders the login page only (no session), so the antd `Table` pages
 * are not covered by it. This script logs in over HTTP, injects the session cookie
 * into headless Chrome through the DevTools protocol, navigates to an admin page and
 * reports the rendered text plus the number of antd table elements found.
 *
 * Usage: node /tmp/authed-render.mjs <baseUrl> <cookieName> <cookieValue> <path>
 */
const [, , base, cookieName, cookieValue, path] = process.argv;

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { spawn } = await import('node:child_process');
const port = 9333;

const child = spawn(
  chrome,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/qls-cdp-profile',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const pages = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension://'));
      if (pages.length > 0) return pages;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          id += 1;
          const myId = id;
          return new Promise((res, rej) => {
            pending.set(myId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
            setTimeout(() => {
              if (pending.has(myId)) {
                pending.delete(myId);
                rej(new Error(`timeout: ${method}`));
              }
            }, 20000);
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

let cdp;
try {
  const list = await targets();
  cdp = await connect(list[0].webSocketDebuggerUrl);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const url = new URL(base);
  await cdp.send('Network.setCookie', {
    name: cookieName,
    value: cookieValue,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    secure: false,
  });

  await cdp.send('Page.navigate', { url: base + path });
  await sleep(6000);

  const text = await cdp.send('Runtime.evaluate', {
    expression: 'document.body.innerText.replace(/\\s+/g, " ").trim()',
    returnByValue: true,
  });
  const counts = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      tables: document.querySelectorAll('.ant-table').length,
      tableRows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
      headers: document.querySelectorAll('.ant-table-thead th').length,
      pagination: document.querySelectorAll('.ant-pagination').length,
      paginationText: (document.querySelector('.ant-pagination-total-text')||{}).innerText || '',
      sidebarLinks: document.querySelectorAll('a[href^="/"]').length,
      title: document.title,
      watermark: document.querySelectorAll('[data-custom-element^="miaoda-watermark"]').length,
    })`,
    returnByValue: true,
  });
  const href = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  console.log('URL          :', base + path, '-> actual:', href.result.value);
  console.log('document.title:', JSON.parse(counts.result.value).title);
  console.log('element counts:', counts.result.value);
  console.log('body text    :', String(text.result.value).slice(0, 400));
} finally {
  try {
    if (cdp) cdp.close();
  } catch {
    /* ignore */
  }
  child.kill('SIGKILL');
}
