#!/usr/bin/env node
// 帧率无关的仓内常驻判据（node 侧，不开浏览器）。
//
// 为什么要在仓里再养一套，而不是念官方量具：`polish/script/cos_frame_probe.js` 用
// `vm.runInContext` 把 index.html 里的 <script> 当**经典脚本**跑，本仓是
// `<script type="module">`，于是三档全报 `SyntaxError: Cannot use import statement outside a module`，
// 结论行写「无法比对」。这不是本仓的缺陷（同形的 zebra-cos 一样红），是尺子不认 ESM。
// BRIEF_COS §3 对这种情况的说法是「必须靠你自己的 harness 补判并把数字贴出来」，所以这里补。
//
// 三档对拍的口径（§3 的三条实测坑都在这儿）：
//  ① 按 sim 步号对齐，不按墙钟虚拟秒：1000/60 逐份相加的浮点亏空会让 60Hz 少攒满一步
//     （本地实测 179 vs 180），那是尺子的错。这里时戳给 C0 + i*interval（乘法），误差不再累积。
//  ② 虚拟时钟从 1000ms 起：从 0 起步会被 `lastFrameSec === 0` 那种首帧哨兵吃掉一帧。
//  ③ 随机数必须定种子：沙箱里 Math.random 换成 LCG，粒子形状另走 fxSeed 那条 mulberry32，
//     于是三档拿到的是同一条随机流——否则比的是两次不同的抽样。
//
// 阴性对照内置（§6）：本仓动效已经是定步长累加器（`fx.advance` 里 `accum += 帧间隔`，
// 每步恒为 SIM_STEP），所以「把 p.x += p.vx*dt 换成常量」这种变异在仓里不可表达、
// 尺子照旧绿。正确的那一发钉在**仍在吃帧 dt 的那一行**：把 `accum += e` 钉成 `accum += 1/60`
// 之后，步数必须随帧率发散（实测 90/180/360）。这一发不打红，就说明尺子在空跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// vm.SourceTextModule 只在 --experimental-vm-modules 下存在，而 `npm test` 与 CI 是裸
// `node tools/frame-rate-test.mjs` 拉起本套件的。所以缺 flag 时自己带 flag 重起一次，
// 判据口径不因为量具的启动方式而变（YAJ_FRAME_RELIT 防止递归重入）。
if (!process.execArgv.includes('--experimental-vm-modules') && !process.env.YAJ_FRAME_RELIT) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, YAJ_FRAME_RELIT: '1', NODE_NO_WARNINGS: '1' }, maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status === null ? 1 : r.status);
}

const FPS = [30, 60, 120];
const VSEC = 3; // 虚拟时长（秒）：3s = 180 个 SIM_STEP
// 粒子寿命 0.55–1.0s、每步 ×0.94，约 52 步就灭 ⇒ 打点必须落在前半段，否则比的是恒为 0 的读数
const CHECKPOINTS = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42, 48, 54, 60];

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };
const note = (m) => console.log('  ' + m);

function readSrc(rel, mutate) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (mutate) {
    const out = src.replace(/\n(\s*)accum \+= e;/, '\n$1accum += 1 / 60;');
    if (out === src) throw new Error('阴性对照打不上：js/render/anim.js 里找不到 `accum += e` 这一行');
    src = out;
  }
  return src;
}

/* ---------------- 沙箱：DOM / canvas / 时钟 的最小可信面 ---------------- */
function ctxStub() {
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

function buildEnv({ reduce = false } = {}) {
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
      dataset: {}, children: [], _h: {}, _attrs: {}, _q: {},
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
      getBoundingClientRect: () => ({ left: 8, top: 60, x: 8, y: 60, width: self.clientWidth, height: self.clientHeight, right: 8 + self.clientWidth, bottom: 60 + self.clientHeight }),
      querySelector(sel) { if (!self._q[sel]) self._q[sel] = makeEl(`${id}::${sel}`); return self._q[sel]; },
      querySelectorAll: () => [],
      closest: () => null, contains: () => false, scrollIntoView() {},
      getContext: () => (self._ctx || (self._ctx = ctxStub())),
      requestFullscreen: () => Promise.resolve(),
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
async function loadGraph(context, entryRel, mutateAnim) {
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

const flush = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 0)); } };

// 真开机：一直喂帧到有盘且 state 离开 booting（§3「⚪ 仅标题态」不算通过）
async function bootToBoard(env, fps) {
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

async function tier(fps, { reduce = false, mutate = false } = {}) {
  const { context, env } = buildEnv({ reduce });
  await loadGraph(context, 'js/main.js', mutate);
  await flush();
  const booted = await bootToBoard(env, fps);
  if (!booted.ok) throw new Error(`${fps}Hz 关卡起不来（state=${booted.y && booted.y.state}）`);
  const y = booted.y;
  const interval = 1000 / fps;

  y.fxReset();
  y.fxSeed('frame-gate');            // 粒子随机走 seed 派生流，三档同一条
  const o = y.view.centerOf(0);
  const spawned = y.fxBurst(o.x, o.y, 12, '#FFC85C') + y.fxBurst(o.x, o.y, 12, '#3CEB8A');

  // (A) 真实 rAF 面：走 main.js 的 frame()（时间戳差分算 dt），只取末态。
  const C0 = env.__clock();
  const FRAMES = Math.round(VSEC * fps);
  for (let i = 1; i <= FRAMES; i++) {
    const cb = env.__pending.shift();
    env.__advance(interval);
    if (cb) cb(C0 + i * interval);   // 坑①：时戳给乘法，误差不再逐帧累积
  }
  const a = y.fx();

  // (B) 同步数面：重开一份动效，用仓内给门禁留的 fxAdvance 接缝喂「精确的 1/fps」。
  // 为什么要换接缝：C0+i*interval 差分出来的 dt 带着 1e-17 的抖动，于是 60Hz 某些帧
  // 推进 0 步、某些帧 2 步，三档观测到的步数集合只剩 4 个交集（B 面就退化成比零读数）。
  // 而 1/30 = 2×(1/60)、2×(1/120) = 1/60 在 IEEE754 下是精确的 ⇒ 30Hz 每帧整 2 步、
  // 60Hz 整 1 步、120Hz 两帧整 1 步，步数集合天然对齐。吃的还是 anim.js 那一个累加器。
  y.fxReset();
  y.fxSeed('frame-gate');
  y.fxBurst(o.x, o.y, 12, '#FFC85C');
  y.fxBurst(o.x, o.y, 12, '#3CEB8A');
  const byStep = new Map();
  for (let i = 0; i < FRAMES; i++) {
    y.fxAdvance(1 / fps);
    const st = y.fx();
    if (!byStep.has(st.steps)) byStep.set(st.steps, { n: st.particles, pulse: st.pulse, sx: st.sumX, sy: st.sumY, sl: st.sumLife, ss: st.sumSpin });
  }
  const st = y.fx();
  return { fps, frames: FRAMES, state: y.state, board: y.game.sizeKey, spawned, steps: a.steps, simTime: a.simTime, accum: a.accum, byStep, reduce: st.reduce };
}

/* ---------------- 判据 ---------------- */
const runNormal = [];
for (const fps of FPS) runNormal.push(await tier(fps));

note(`开机：${runNormal.map((r) => `${r.fps}Hz state=${r.state} 盘=${r.board} 粒子=${r.spawned}`).join('  ')}`);
ok(runNormal.every((r) => r.state !== 'booting'), '有档没真进关卡（state 还停在 booting）');
ok(runNormal.every((r) => r.spawned > 0), 'fxBurst 一个粒子都没生：那三档比的是恒为 0 的假绿');

// (A) 等虚拟时长面：喂满同样的 T 秒，推进的步数/时长必须与帧率无关
const DUR = ['steps', 'simTime', 'accum'];
note(`(A) 等 ${VSEC} 虚拟秒末态（喂帧 ${runNormal.map((r) => r.frames).join('/')}）：`);
for (const f of DUR) {
  const v = runNormal.map((r) => Number(r[f].toFixed(9)));
  ok(v.every((x) => x === v[0]), `(A) ${f} 随帧率发散：${v.join(' / ')}`);
  note(`    ${f.padEnd(9)} ${v.join('  ')} ${v.every((x) => x === v[0]) ? '一致' : 'DIVERGE'}`);
}
ok(runNormal[1].steps >= 60, `(A) 只推进了 ${runNormal[1].steps} 步，探针没让关卡跑起来`);

// (B) 同步数面：同一 sim 步号上的粒子积分必须逐位相同（定步长的定义就是这样）
const common = CHECKPOINTS.filter((cp) => runNormal.every((r) => r.byStep.has(cp)));
const live = common.filter((cp) => runNormal[0].byStep.get(cp).n > 0);
note(`(B) 同步数打点：可用 ${common.length}/${CHECKPOINTS.length} 个，其中粒子在场 ${live.length} 个`);
ok(live.length >= 4, `(B) 只有 ${live.length} 个打点上粒子还在场——比的是零读数，判据空跑`);
const STEPKEY = { n: '粒子数', pulse: '脉冲', sx: 'Σx', sy: 'Σy', sl: 'Σlife', ss: 'Σspin' };
let cmpB = 0, badB = 0;
for (const cp of live) {
  for (const k of Object.keys(STEPKEY)) {
    const v = live && cp ? runNormal.map((r) => Number(r.byStep.get(cp)[k].toFixed(9))) : [];
    cmpB++;
    if (!v.every((x) => x === v[0])) { badB++; ok(false, `(B) step=${cp} ${STEPKEY[k]} 发散：${v.join(' / ')}`); }
  }
  if (cp === live[Math.floor(live.length / 2)]) {
    const v = runNormal.map((r) => Number(r.byStep.get(cp).sx.toFixed(9)));
    note(`    step=${cp} Σx = ${v.join('  ')}（${v[0] === v[1] && v[1] === v[2] ? '三档逐位相同' : 'DIVERGE'}）`);
  }
}
ok(badB === 0, `(B) ${badB}/${cmpB} 个同步数读数随帧率发散`);
note(`(B) 共比对 ${cmpB} 个读数，发散 ${badB} 个`);

// (C) 阴性对照：把仍在吃帧 dt 的那一行钉成常量，必须变红（§6）
const neg = [];
for (const fps of FPS) neg.push(await tier(fps, { mutate: true }));
const negSteps = neg.map((r) => r.steps);
note(`(C) 阴性对照 accum += e → accum += 1 / 60：steps = ${negSteps.join(' / ')}，simTime = ${neg.map((r) => Number(r.simTime.toFixed(3))).join(' / ')}`);
ok(new Set(negSteps).size === negSteps.length, `(C) 阴性对照没红：三档步数仍是 ${negSteps.join('/')}，说明尺子在空跑`);
ok(negSteps[0] < negSteps[2], `(C) 阴性对照的方向不对（30Hz=${negSteps[0]} 应少于 120Hz=${negSteps[2]}：常量 accum 让步数变成按帧计数）`);

// (D) reduce-motion 是真分支：循环不启动、粒子不生成（不是「把时长写成 0」）
const red = [];
for (const fps of FPS) red.push(await tier(fps, { reduce: true }));
note(`(D) prefers-reduced-motion: reduce ⇒ reduce=${red.map((r) => r.reduce).join('/')} 粒子生成数=${red.map((r) => r.spawned).join('/')} 步数=${red.map((r) => r.steps).join('/')}`);
ok(red.every((r) => r.reduce === true), '(D) reduce 位没有真落到 fx 上');
ok(red.every((r) => r.spawned === 0), '(D) 减少动效下仍然生出了粒子：那不是真分支');

console.log(`RESULT frame-rate-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
