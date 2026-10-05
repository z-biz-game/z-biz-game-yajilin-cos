#!/usr/bin/env node
// node 侧的最小可信 DOM / canvas / 时钟沙箱，供 tools/frame-rate-test.mjs 与 tools/behavior-test.mjs 共用。
//
// 为什么要在 node 里养一个 DOM 假面：本仓是 `<script type="module">` 的 ESM 形状，
// 官方那把帧率尺子（polish/script/cos_frame_probe.js）用 `vm.runInContext` 当经典脚本跑，
// 于是任何 ESM 仓都只报 `Cannot use import statement outside a module`（同形的 zebra-cos 一样红）。
// 要在 CI 里常驻「帧率无关 / 静音真停 / 暂停真停 / 重开真复位」这几条判据，就得有一个
// 认 ESM、带虚拟时钟、能开真盘的执行面——浏览器那条线归 tools/verify.sh，两边不重复记账。
//
// 三条口径是实测踩出来的，改动这里前先读完它们：
//  ① 时戳给 C0 + i*interval（乘法）。把 interval 一份份加上去，1000/60 的浮点亏空会让
//     60Hz 少攒满一个 SIM_STEP（本地实测 179 vs 180），凭空判成帧率依赖。
//  ② 虚拟时钟从 1000ms 起。从 0 起步会撞上 `lastFrameSec === 0` 那种首帧哨兵，少跑一帧。
//  ③ Math.random / crypto.getRandomValues 全部换成定种子 LCG：三档帧率比的是同一条随机流，
//     否则「同一虚拟时长不同帧率」其实是两次不同的抽样。
//
// AudioContext 是**计数**的假面（created.ctx/osc/suspend/resume），因为「静音」这条判据
// 要量的是「静音态有没有还在造振荡器」，读 gain 设成 0 那种假静音只能靠计数抓出来。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 阴性对照用的那根针：mutate 只钉 anim.js 里仍在吃帧 dt 的 `accum += e`。
// 打不上就直接抛——静默跳过等于把「尺子空跑」当成「判据通过」。
export function readSrc(rel, mutate) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (mutate) {
    const out = src.replace(/\n(\s*)accum \+= e;/, '\n$1accum += 1 / 60;');
    if (out === src) throw new Error('阴性对照打不上：js/render/anim.js 里找不到 `accum += e` 这一行');
    src = out;
  }
  return src;
}


/* ---------------- 沙箱：DOM / canvas / 时钟 的最小可信面 ---------------- */
export function ctxStub() {
  const grad = { addColorStop() {} };
  const base = {
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({ setTransform() {} }),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      t[k] = () => undefined;
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

export function buildEnv({ reduce = false } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const elMap = new Map();
  let clock = 1000;                 // 坑②：虚拟时钟从 1000ms 起
  let rs = 0x2f6e2b1;               // 坑③：定种子 LCG，三档同一条流
  const seededRandom = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const pending = [];
  const timers = [];
  let timerId = 1;
  const created = { ctx: 0, osc: 0, suspend: 0, resume: 0 };

  const makeEl = (id) => {
    const self = {
      id, tagName: 'DIV', value: '', textContent: '', innerHTML: '', src: '', title: '',
      disabled: false, hidden: false, width: 300, height: 300, clientWidth: 320, clientHeight: 320,
      style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '', display: '', width: '', height: '' },
      dataset: {}, children: [], _h: {}, _attrs: {}, _q: {}, _fs: 0, _rectLeft: 8, _rectTop: 60,
      classList: (() => {
        const s = new Set();
        return {
          add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
          contains: (c) => s.has(c),
          toggle: (c, on) => { const v = on === undefined ? !s.has(c) : !!on; if (v) s.add(c); else s.delete(c); return v; },
          _set: s,
        };
      })(),
      setAttribute(k, v) { self._attrs[k] = String(v); if (k === 'hidden') self.hidden = true; },
      getAttribute(k) { return k in self._attrs ? self._attrs[k] : null; },
      removeAttribute(k) { delete self._attrs[k]; if (k === 'hidden') self.hidden = false; },
      appendChild(c) { self.children.push(c); return c; },
      removeChild(c) { self.children = self.children.filter((x) => x !== c); return c; },
      insertBefore(c) { self.children.unshift(c); return c; },
      remove() {}, focus() {}, blur() {}, click() { self._fire('click', {}); },
      addEventListener(t, cb) { (self._h[t] = self._h[t] || []).push(cb); },
      removeEventListener(t, cb) { self._h[t] = (self._h[t] || []).filter((f) => f !== cb); },
      _fire(t, ev) { for (const cb of (self._h[t] || []).slice()) cb.call(self, ev); },
      // 矩形可按 _scale 收窄/放大：CSS 缩放命中判据（board.js 的 scaleOf）要在 node 侧复现，
      // 靠的就是「style 宽与 rect 宽不等」这一件事，而不是把画布真渲染一遍。
      _scale: 1,
      getBoundingClientRect: () => ({ left: self._rectLeft, top: self._rectTop, x: self._rectLeft, y: self._rectTop, width: self.clientWidth * self._scale, height: self.clientHeight * self._scale, right: self._rectLeft + self.clientWidth * self._scale, bottom: self._rectTop + self.clientHeight * self._scale }),
      querySelector(sel) { if (!self._q[sel]) self._q[sel] = makeEl(`${id}::${sel}`); return self._q[sel]; },
      querySelectorAll: () => [],
      closest: () => null, contains: () => false, scrollIntoView() {},
      getContext: () => (self._ctx || (self._ctx = ctxStub())),
      requestFullscreen: () => { self._fs++; return Promise.resolve(); },
    };
    return self;
  };

  const doc = {
    _h: {},
    getElementById(i) { if (!ids.has(i)) return null; if (!elMap.has(i)) elMap.set(i, makeEl(i)); return elMap.get(i); },
    querySelector(sel) { const m = /^#([\w-]+)/.exec(sel); return m ? doc.getElementById(m[1]) : makeEl('q:' + sel); },
    querySelectorAll: () => [],
    createElement: (t) => makeEl('created-' + t),
    createTextNode: (t) => ({ textContent: t }),
    body: makeEl('body'), documentElement: makeEl('html'),
    hidden: false, visibilityState: 'visible', title: '', baseURI: 'http://localhost:8000/',
    fullscreenElement: null, webkitFullscreenElement: null,
    addEventListener(t, cb) { (doc._h[t] = doc._h[t] || []).push(cb); },
    removeEventListener(t, cb) { doc._h[t] = (doc._h[t] || []).filter((f) => f !== cb); },
    _fire(t, ev) { for (const cb of (doc._h[t] || []).slice()) cb(ev); },
    exitFullscreen: () => Promise.resolve(), webkitExitFullscreen: () => Promise.resolve(),
  };

  const ls = new Map();
  const env = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: doc,
    setTimeout: (fn, ms) => { timers.push({ id: timerId, at: clock + (ms || 0), fn, interval: null }); return timerId++; },
    setInterval: (fn, ms) => { timers.push({ id: timerId, at: clock + (ms || 0), fn, interval: ms || 1 }); return timerId++; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    clearInterval: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    requestAnimationFrame: (cb) => { pending.push(cb); return pending.length; },
    cancelAnimationFrame: () => {},
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k), clear: () => ls.clear(),
      key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
    },
    matchMedia: (q) => ({ media: q, matches: /prefers-reduced-motion/.test(q) && reduce, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null }),
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(seededRandom() * 256); return a; }, randomUUID: () => 'u' + Math.floor(seededRandom() * 1e9) },
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    navigator: { userAgent: 'node-frame-gate', maxTouchPoints: 0 },
    location: { href: 'http://localhost:8000/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8000', pathname: '/' },
    Image: class { constructor() { this.width = 1; this.height = 1; } addEventListener() {} },
    Path2D: class { moveTo() {} lineTo() {} arc() {} rect() {} closePath() {} },
    fetch: () => Promise.reject(new Error('harness 无网络')),
    URL, TextEncoder, TextDecoder,
    performance: { now: () => clock, timeOrigin: 0, mark() {}, measure() {} },
    _h: {},
    addEventListener(t, cb) { (env._h[t] = env._h[t] || []).push(cb); },
    removeEventListener(t, cb) { env._h[t] = (env._h[t] || []).filter((f) => f !== cb); },
    _fire(t, ev) { for (const cb of (env._h[t] || []).slice()) cb(ev); },
    __clock: () => clock,
    __advance: (ms) => {
      clock += ms;
      for (const t of timers.slice()) {
        if (t.dead || t.at > clock) continue;
        if (t.interval) t.at = clock + t.interval; else t.dead = true;
        t.fn();
      }
    },
    __pending: pending, __created: created, __doc: doc,
  };
  env.window = env; env.globalThis = env; env.self = env; env.global = env;
  env.Math = new Proxy(Math, { get: (t, k) => (k === 'random' ? seededRandom : t[k]), set: () => true });
  env.Date = new Proxy(Date, {
    get: (t, k) => (k === 'now' ? () => clock : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])),
    construct: (t, a) => (a.length ? new t(...a) : new t(clock)),
  });
  env.AudioContext = env.webkitAudioContext = class {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = { connect() {} }; this.currentTime = 0; created.ctx++; }
    createOscillator() { created.osc++; return { type: '', frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBiquadFilter() { return { type: '', frequency: { value: 0, setValueAtTime() {} }, Q: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {}, playbackRate: { value: 1 } }; }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len), length: len, numberOfChannels: ch }; }
    resume() { this.state = 'running'; created.resume++; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; created.suspend++; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  return { context: vm.createContext(env), env, doc, pending, created };
}

/* ---------------- ESM 图加载（官方尺子缺的那一段）---------------- */
export async function loadGraph(context, entryRel, mutateAnim) {
  const cache = new Map();
  async function inst(rel) {
    const key = rel.replace(/^\.\//, '');
    if (cache.has(key)) return cache.get(key);
    const sm = new vm.SourceTextModule(readSrc(key, mutateAnim && key === 'js/render/anim.js'), { identifier: key, context });
    cache.set(key, sm);
    await sm.link(async (spec, ref) => inst(path.posix.normalize(path.posix.join(path.posix.dirname(ref.identifier), spec))));
    return sm;
  }
  const m = await inst(entryRel);
  await m.evaluate();
  return m;
}

export const flush = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 0)); } };

// 喂 n 帧真实 rAF（时戳走 C0+i*interval，见头部口径①）
export function pump(env, n, interval = 1000 / 60) {
  const C0 = env.__clock();
  for (let i = 1; i <= n; i++) {
    const cb = env.__pending.shift();
    env.__advance(interval);
    if (cb) cb(C0 + i * interval);
  }
}

// 沙箱里的 setTimeout 走的是虚拟时钟，只有喂帧时才会到期；所以任何 await 都得边喂帧边等，
// 否则 await 里那句 `setTimeout(r, 0)` 会把整条 promise 挂死（实测）。
export async function settle(env, promise, { frames = 20, rounds = 60 } = {}) {
  let settled = false, value = null, error = null;
  promise.then((v) => { value = v; settled = true; }, (e) => { error = e; settled = true; });
  for (let r = 0; r < rounds && !settled; r++) {
    pump(env, frames);
    await new Promise((res) => setImmediate(res));
  }
  if (!settled) throw new Error(`settle: 等了 ${rounds * frames} 帧，promise 仍未落地`);
  if (error) throw error;
  return value;
}

// 真开机：一直喂帧到有盘且 state 离开 booting（§3「⚪ 仅标题态」不算通过）
export async function bootToBoard(env, fps) {
  const interval = 1000 / fps;
  let y = env.window.yajilin, guard = 0;
  while ((!y || !y.game || y.state === 'booting') && guard++ < 6000) {
    const cb = env.__pending.shift();
    env.__advance(interval);
    if (cb) cb(env.__clock());
    await flush();
    y = env.window.yajilin;
  }
  return { y, ok: !!y && !!y.game && y.state !== 'booting' };
}
