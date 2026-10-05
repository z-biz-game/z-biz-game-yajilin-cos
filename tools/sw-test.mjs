#!/usr/bin/env node
// PWA 那条「网络优先」的仓内常驻判据：把 sw.js 与 js/sw-register.js 放进沙箱真跑一遍，
// 量的是「玩家这一次拿到的字节来自哪一条通道」，而不是 grep 到 `fetch(` 在 `caches.match(` 前面。
//
// 为什么这一套必须存在（改前的实测事实）：`grep -rn 'sw\.js\|serviceWorker' tools/` 只命中
// asset-test 里那条「引用路径落在盘上」与 scenarios.js 的注册观察——也就是说「手工 VERSION +
// cache-first 会把 js/css 永久钉死在旧版」这个本家族踩过的事故（BRIEF_COS §2 PWA 段），
// 在本仓没有任何一把尺子量过。字符串门对下面这四种写法一律发绿：
//   ① caches.match(req).then(hit => hit || fetch(req))   ← cache-first，出新 HTML 配旧 JS 的鬼状态
//   ② 网络优先但只存不 ok 的响应（缓存里塞满 404/500，断网时兜出一份坏字节）
//   ③ install 的预缓存没有 .catch：一个 404 就把 install 判死，玩家永远停在旧版
//   ④ activate 不清旧 VERSION 的 cache：新字节写进新 cache，旧 cache 里的 js/css 永不失效
// 这里逐条钉一个可数的读数，并在末尾拿「把网络优先改成 cache-first」那一发做阴性对照。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };
const note = (m) => console.log('  ' + m);

/* ───────────── 一份 Cache API / fetch 的假面，够 sw.js 真跑 ───────────── */
class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers || {};
    this.ok = this.status >= 200 && this.status < 300;
    this.type = init.type ?? (this.ok ? 'basic' : 'default');
  }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: this.headers, type: this.type }); }
  static error() { const r = new FakeResponse('', { status: 0, type: 'error' }); r.ok = false; return r; }
}
function makeSwHarness(src, { origin = 'https://example.com', base = origin + '/yajilin/' } = {}) {
  const cachesMap = new Map(); // name -> Map(requestUrl -> FakeResponse)
  const store = {
    open: async (name) => {
      const m = cachesMap.get(name) || new Map();
      cachesMap.set(name, m);
      return {
        add: async (req) => { const r = await harness.fetch(req); m.set(req.url, r); },
        put: async (req, res) => { m.set(typeof req === 'string' ? req : req.url, res); },
        match: async (req) => m.get(typeof req === 'string' ? req : req.url) || undefined,
      };
    },
    keys: async () => [...cachesMap.keys()],
    delete: async (name) => cachesMap.delete(name),
    match: async (req) => { for (const m of cachesMap.values()) { const hit = m.get(req.url); if (hit) return hit; } return undefined; },
  };
  const net = { queue: [] };
  const calls = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    location: { href: base + 'sw.js', origin, protocol: origin.split(':')[0] + ':' },
    URL, TextEncoder, TextDecoder,
    caches: store,
    Response: FakeResponse,
    Request: class { constructor(u, init = {}) { this.url = typeof u === 'string' ? new URL(u, base).href : u.url; this.method = init.method || 'GET'; this.mode = init.mode || 'no-cors'; } },
    Promise, setTimeout, clearTimeout,
    fetch: (req) => {
      const url = typeof req === 'string' ? new URL(req, base).href : req.url;
      calls.push(url);
      const next = net.queue.shift();
      if (!next) return Promise.reject(new TypeError('network down（harness 队列空）'));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(new FakeResponse(next.body, { status: next.status ?? 200, type: next.type ?? 'basic' }));
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => { ctx.__claimed++; return Promise.resolve(); } },
    addEventListener: (t, cb) => { (ctx.__h[t] = ctx.__h[t] || []).push(cb); },
    __h: {}, __claimed: 0, __waited: [],
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  const harness = { ctx, net, cachesMap, calls, served: [], urlOf: (u) => new URL(u, base).href };
  // fetch 要在 ctx 里被 sw.js 调用，同时又要能 push 到 harness.calls：同一个函数对象即可
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'sw.js' });
  harness.fire = async (type, ev) => {
    for (const cb of ctx.__h[type] || []) cb(ev);
    await Promise.all(ctx.__waited.splice(0).map((p) => p.catch((e) => e)));
    return ev;
  };
  harness.install = async () => {
    const ev = { waitUntil: (p) => ctx.__waited.push(Promise.resolve(p).catch((e) => e)) };
    for (const cb of ctx.__h['install'] || []) cb(ev);
    const errs = await Promise.all(ctx.__waited.splice(0).map((p) => p.then(() => null, (e) => String(e && e.message || e))));
    return errs.filter(Boolean);
  };
  harness.activate = async () => {
    const ev = { waitUntil: (p) => ctx.__waited.push(p) };
    for (const cb of ctx.__h['activate'] || []) cb(ev);
    await Promise.all(ctx.__waited.splice(0).map((p) => p.catch(() => null)));
  };
  harness.serve = async (reqInit) => {
    const req = typeof reqInit === 'string'
      ? new ctx.Request(reqInit)
      : new ctx.Request(reqInit.url, { method: reqInit.method, mode: reqInit.mode });
    const ev = { request: req, _responded: false, _p: null, respondWith: (p) => { ev._responded = true; ev._p = Promise.resolve(p); } };
    for (const cb of ctx.__h['fetch'] || []) cb(ev);
    if (!ev._responded) return { handled: false, body: null };
    const res = await ev._p;
    return { handled: true, res, body: res && res.body, status: res && res.status, type: res && res.type };
  };
  harness.cacheName = () => {
    for (const [k, m] of cachesMap) if (m.size) return k;
    return [...cachesMap.keys()][0] || null;
  };
  return harness;
}

const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* ═════ 1) 同源子资源：盘上同时有旧缓存与新网络时，玩家必须拿到新那份 ═════ */
{
  const H = makeSwHarness(swSrc);
  const url = H.urlOf('js/main.js');
  // 先把「旧字节」塞进缓存（模拟上一次访问留下的那份），再让网络给新字节
  await H.install();
  const cacheKey = H.cacheName();
  ok(!!cacheKey, 'install 之后一个 cache 都没开：预缓存那条路没走通');
  H.cachesMap.get(cacheKey).set(url, new FakeResponse('OLD-BYTES'));
  H.net.queue.push({ body: 'NEW-BYTES' });
  const r = await H.serve({ url });
  ok(r.handled, '同源 GET 没有被 respondWith 接管：这条请求绕过 SW 交给浏览器默认，网络优先无从谈起');
  ok(r.body === 'NEW-BYTES', `同源子资源拿到了 ${JSON.stringify(r.body)} 而不是网络那份：cache-first（§2 点名的鬼状态）`);
  ok(H.calls.length >= 1 && H.calls.includes(url), '整个 fetch 过程一次 network fetch 都没发生：读数再对也不是「网络优先」');
  // 网络那份必须回写进缓存，否则断网时兜不出新字节
  const stored = H.cachesMap.get(cacheKey).get(url);
  ok(stored && stored.body === 'NEW-BYTES', `网络响应没回写缓存（存的是 ${stored && stored.body}）：断网就退回旧字节`);
  note(`网络优先：缓存旧=OLD-BYTES，网络新=NEW-BYTES → 实拿 ${r.body}，回写后缓存=${stored && stored.body}（cache=${cacheKey}）`);
}

/* ═════ 2) 断网退缓存；导航请求无缓存时给一句人话而不是冷页面 ═════ */
{
  const H = makeSwHarness(swSrc);
  await H.install();
  const key = H.cacheName();
  const cssUrl = H.urlOf('css/game.css');
  H.cachesMap.get(key).set(cssUrl, new FakeResponse('CACHED-CSS'));
  H.net.queue = []; // 网络全灭
  const r1 = await H.serve({ url: cssUrl });
  ok(r1.body === 'CACHED-CSS', `断网且有缓存时拿到了 ${JSON.stringify(r1.body)}：离线打不开这一局`);
  const navUrl = H.urlOf('index.html');
  const r2 = await H.serve({ url: navUrl, mode: 'navigate' });
  ok(r2.handled && /离线/.test(r2.body || '') && r2.status === 200, `断网且没缓存的导航请求：status=${r2.status} body=${JSON.stringify((r2.body || '').slice(0, 24))}——该给一句人话`);
  const r3 = await H.serve({ url: H.urlOf('assets/icons/icon-512.png') });
  ok(r3.res && r3.res.type === 'error', `断网、无缓存、非导航：应为 Response.error()，实为 type=${r3.res && r3.res.type}（拿 200 空体会让上层以为成功）`);
  note(`断网面：有缓存→${r1.body}；导航无缓存→「${(r2.body || '').replace(/<[^>]*>/g, '').slice(0, 14)}…」 status=${r2.status}；资源无缓存→type=${r3.res && r3.res.type}`);
}

/* ═════ 3) 只存能存的：非 200/非 basic 一律不许进缓存 ═════ */
{
  const H = makeSwHarness(swSrc);
  await H.install();
  const key = H.cacheName();
  const before = H.cachesMap.get(key).size;
  H.net.queue.push({ body: 'E-500', status: 500, type: 'basic' });
  await H.serve({ url: H.urlOf('js/store.js') });
  ok(!H.cachesMap.get(key).has(H.urlOf('js/store.js')), '500 响应被写进了缓存：断网时玩家会拿到一份坏字节并以为是页面');
  H.net.queue.push({ body: 'O', status: 200, type: 'opaque' });
  await H.serve({ url: H.urlOf('js/theme.js') });
  ok(!H.cachesMap.get(key).has(H.urlOf('js/theme.js')), 'opaque 响应被写进了缓存');
  ok(H.cachesMap.get(key).size === before, `上面两发之后缓存条目涨了（${before} → ${H.cachesMap.get(key).size}）`);
  note(`写入面过滤：500 与 opaque 各一发都没进缓存（条目数恒 ${before}）`);
}

/* ═════ 4) 越界与非常规请求一律放行（不接管 = 交回浏览器）═════ */
{
  const H = makeSwHarness(swSrc);
  await H.install();
  const x = await H.serve({ url: 'https://other-origin.test/js/main.js' });
  ok(!x.handled, '跨域 GET 被 SW 接管了：本仓的兜底只该管同源');
  const post = await H.serve({ url: H.urlOf('api-like'), method: 'POST' });
  ok(!post.handled, 'POST 被接管：SW 不该改写入向请求');
  note(`放行面：跨域 GET 与 POST 都是 handled=false（原样交回浏览器）`);
}

/* ═════ 5) install 的预缓存不许把一个 404 变成 install 死亡 ═════ */
{
  const PRECACHE = /const PRECACHE = \[([^\]]+)\]/.exec(swSrc);
  ok(!!PRECACHE, '读不到 PRECACHE 清单：这条判据的锚没了');
  const items = PRECACHE ? PRECACHE[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  for (const it of items) ok(fs.existsSync(path.join(ROOT, it === './' || it === './index.html' ? 'index.html' : it)), `预缓存清单里的 ${it} 不在盘上：安装期就是一条 404`);
  const H = makeSwHarness(swSrc);
  H.net.queue = []; // 全部网络失败：预缓存必须整体不 reject
  const errs = await H.install();
  ok(errs.length === 0, `预缓存全失败时 install 吐出了 ${errs.length} 条 rejection：${errs[0]}——那等于把玩家锁在旧版本上`);
  note(`install 韧性：预缓存 ${items.length} 项（${items.join(' ')}）全部网络失败，install rejection ${errs.length} 条`);
}

/* ═════ 6) activate 只留当前 VERSION 那份 cache ═════ */
{
  const H = makeSwHarness(swSrc);
  await H.install();
  const cur = H.cacheName();
  const staleName = cur.replace(/v\d+/, 'v999');
  H.cachesMap.set(staleName, new Map([['x', new FakeResponse('OLD')]]));
  await H.activate();
  ok(H.cachesMap.has(cur), `activate 把当前 cache ${cur} 删了`);
  ok(!H.cachesMap.has(staleName), `旧 VERSION 的 cache ${staleName} 没被清掉：新 HTML 配旧 js 的鬼状态就是从这儿来的（§2）`);
  ok(H.ctx.__claimed === 1, `clients.claim 被调了 ${H.ctx.__claimed} 次（应为 1）`);
  ok(/^yajilin-v\d+$/.test(cur || ''), `cache 名字 ${cur} 不带版本位：改策略时旧缓存永不失效`);
  note(`activate：cache=${cur}（含版本位），旧版 ${staleName} 已清，claim=${H.ctx.__claimed}`);
}

/* ═════ 7) js/sw-register.js：装不上时的三种形状都必须「不抛」═════ */
const regSrc = fs.readFileSync(path.join(ROOT, 'js/sw-register.js'), 'utf8');
async function runRegister({ href, registerBehavior }) {
  const u = new URL(href);
  const log = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    URL, Promise,
    location: { href, protocol: u.protocol, hostname: u.hostname, origin: u.origin, pathname: u.pathname },
    document: { baseURI: href, querySelector: () => null },
    navigator: registerBehavior === 'absent' ? {} : {
      serviceWorker: {
        register: (url_, opts) => {
          log.push({ url: url_, scope: opts && opts.scope });
          if (registerBehavior === 'reject') return Promise.reject(Object.assign(new Error('sec'), { name: 'SecurityError' }));
          return Promise.resolve({ scope: opts && opts.scope });
        },
      },
    },
    __result: null,
  };
  // sw-register.js 是 ESM（有 export），沙箱里把它当模块跑：改成把 export 关键字摘掉的最简形状，
  // 判据量的是 registerServiceWorker 的行为而不是它的模块格式（模块格式由 node --check 与 loadGraph 管）。
  const asClassic = regSrc.replace(/export function/g, 'function').replace(/export const swRegistration = registerServiceWorker\(\);/, 'ctxOut = registerServiceWorker();');
  ctx.ctxOut = null;
  vm.createContext(ctx);
  vm.runInContext(asClassic, ctx, { filename: 'js/sw-register.js' });
  const r = await ctx.ctxOut;
  return { r, log };
}
{
  const fileRes = await runRegister({ href: 'file:///Users/xx/yajilin/index.html', registerBehavior: 'ok' });
  ok(fileRes.r && fileRes.r.ok === false, `file:// 下注册结果 ${JSON.stringify(fileRes.r)}：应当 ok=false`);
  ok(fileRes.log.length === 0, `file:// 下仍然调了 navigator.serviceWorker.register ${fileRes.log.length} 次：一定 SecurityError，且不该试第二下`);
  const lanRes = await runRegister({ href: 'http://192.168.1.7:8000/index.html', registerBehavior: 'ok' });
  ok(lanRes.r.ok === false && lanRes.r.why === 'insecure-context', `局域网裸 http 的结果 ${JSON.stringify(lanRes.r)}：应为 insecure-context`);
  const httpsRes = await runRegister({ href: 'https://pages.example/yajilin/', registerBehavior: 'ok' });
  ok(httpsRes.r.ok === true, `https + Pages 子目录应当注册成功，实为 ${JSON.stringify(httpsRes.r)}`);
  ok(httpsRes.log.length === 1 && /\/yajilin\/sw\.js$/.test(httpsRes.log[0].url), `sw.js 的路径没按 baseURI 解析：实得 ${httpsRes.log[0] && httpsRes.log[0].url}（写死 /sw.js 会去域名根要文件 → 404）`);
  ok(httpsRes.log[0] && /\/yajilin\/$/.test(httpsRes.log[0].scope), `scope 没落在页面目录：实得 ${httpsRes.log[0] && httpsRes.log[0].scope}`);
  const rejRes = await runRegister({ href: 'https://pages.example/yajilin/', registerBehavior: 'reject' });
  ok(rejRes.r && rejRes.r.ok === false && /SecurityError/.test(rejRes.r.why || ''), `register 被拒绝时应当只留一条 why，实为 ${JSON.stringify(rejRes.r)}`);
  const absentRes = await runRegister({ href: 'https://pages.example/yajilin/', registerBehavior: 'absent' });
  ok(absentRes.r.ok === false && absentRes.r.why === 'no-serviceWorker', '没有 navigator.serviceWorker 时应回 no-serviceWorker');
  note(`注册面六发：file://${fileRes.r.why || '未调 register（正确）'}、裸 http=${lanRes.r.why}、Pages 子目录 sw=${httpsRes.log[0] && httpsRes.log[0].url} scope=${httpsRes.log[0] && httpsRes.log[0].scope}、拒绝=${rejRes.r.why}、缺失=${absentRes.r.why}`);
}

/* ═════ 8) 阴性对照：把网络优先改成 cache-first，第 1 条必须换红 ═════ */
{
  const mutated = swSrc.replace('fetch(req)\n      .then((res) => {', 'caches.match(req).then((hit) => hit || fetch(req))\n      .then((res) => {');
  ok(mutated !== swSrc, 'cache-first 变异打不上：sw.js 的 fetch 链写法变了，先看清这里再改判据');
  const H = makeSwHarness(mutated);
  await H.install();
  const key = H.cacheName();
  const url = H.urlOf('js/main.js');
  H.cachesMap.get(key).set(url, new FakeResponse('OLD-BYTES'));
  H.net.queue.push({ body: 'NEW-BYTES' });
  const r = await H.serve({ url });
  ok(r.body === 'OLD-BYTES', `阴性对照失手：改成 cache-first 之后仍拿到 ${JSON.stringify(r.body)}——第 1 条判据是空跑的`);
  note(`阴性对照：同一份 harness、同一份初始缓存，只把 fetch 链换成 cache-first → 实拿 ${JSON.stringify(r.body)}（第 1 条正是判它红的）`);
}

console.log(`RESULT sw-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
