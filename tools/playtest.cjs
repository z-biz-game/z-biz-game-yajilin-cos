// Minimal CDP driver for headless playtesting (Node 22+ global WebSocket/fetch).
//
// env: CDP_PORT (devtools port, default 9378), BASE_URL (page URL, default
//      http://127.0.0.1:5326/), MOBILE=1 (+ MOBILE_W/MOBILE_H/MOBILE_DPR)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>'       evaluate, await promises, print result
//   node tools/playtest.cjs eval '<expr>' nonav don't navigate first
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __ng.<name>()
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// MOBILE=1 的下法只有一种：**在本会话 attach 之后、导航之前**发
// Emulation.setDeviceMetricsOverride / setTouchEmulationEnabled，并且发完就把它自己读回的
// innerWidth/devicePixelRatio 打到 stderr（EMULATION 那行）。
// ⚠ 另起一个进程/另一个 tab 去设覆写，然后在这个会话里跑断言，读到的是桌面的形状：
// 那条「移动腿」就退化成桌面断言重跑一遍的假绿。覆写是 per-session 的，腿也必须是这样。
//
// Which page to attach to is decided by BASE_URL's **origin**, never by a hard-coded port:
// 一个悄悄落在 about:blank 上的 eval 读起来像是部署坏了，其实是门禁在给错的 DOM 打分。
//
// 这三个默认号（5326 静态服务器 / 5327 前缀腿 / 9378 DevTools）是本仓自己的一对，
// 与 server.cjs 的 DEFAULT_PORT/PREFIX_PORT、package.json 的 dev 脚本、tools/verify.sh 的
// 默认值必须是同一批数——任何一处漂了，一个忘关的别人家的服务器就会被当成本仓的盘面来测。
//
// 每个 scenario 都先 Page.navigate(BASE_URL)：那是**真导航**（文档被换掉、JS 堆重建），
// marks→resume 那一对靠的就是它。写 `location.hash = ...` 不算——同文档跳转连 JS 上下文都不换，
// 用它冒充「刷新过了」就是把门禁改成在测自己编的故事。
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9378);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5326/';
const ORIGIN = new URL(BASE).origin;
const MOBILE = process.env.MOBILE === '1';
const MW = Number(process.env.MOBILE_W || 390);
const MH = Number(process.env.MOBILE_H || 844);
const MDPR = Number(process.env.MOBILE_DPR || 3);
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

const logs = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      // 404 也要收：前缀腿最容易出的事故就是「css 里写死了根路径」，它只在控制台里响一声。
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  // 覆写与「它真的生效了」的读数必须在同一个 sessionId 上、在同一段代码里：
  // 设完不自证，桌面腿和移动腿就会跑出一样的数字而谁都发现不了。
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: MW, height: MH, deviceScaleFactor: MDPR, mobile: true }, sessionId);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    }, sessionId);
    const witness = await evaluate('JSON.stringify([innerWidth,innerHeight,devicePixelRatio,Math.round(visualViewport.width),navigator.maxTouchPoints,("ontouchstart" in window)])');
    console.error(`EMULATION set-in-session sessionId=${sessionId} want=${MW}x${MH}@${MDPR} page-back=${witness}`);
  } else {
    // 桌面腿也要自证「这一趟没有被上一趟的移动覆写留下东西」：覆写是 per-session 的，
    // 新进程新 session 本就不该有，读回 innerWidth 就是把这句写死的话变成一次实测。
    console.error('EMULATION desktop-session');
  }

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await navigate(BASE);
    // Headless reports the page as hidden, and the render loop is allowed to skip
    // frames when hidden — so a scenario that waits on animation would time out
    // against a browser that is only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const out = await evaluate(`(async()=>{
      if (!window.__ng) throw new Error('scenarios.js never installed');
      const fn = window.__ng[${JSON.stringify(arg)}];
      if (typeof fn !== 'function') throw new Error('no such scenario: ' + ${JSON.stringify(arg)});
      const r = await fn();
      return JSON.stringify(r);
    })()`);
    // Console noise first, machine-readable line last: the parser in verify.sh takes the
    // final RESULT line, so a stray '{' in a log cannot hijack the report.
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + out);
  } else if (cmd === 'shot') {
    // A background tab only pushes compositor frames when something repaints it, so a
    // capture taken right after a pure CSS state change can return the previous frame.
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else if (cmd === 'reload-logs') {
    await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR ' + (err.message || err));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
