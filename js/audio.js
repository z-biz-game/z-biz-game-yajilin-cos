// 音效。这个文件存在的意义是「静音必须是静音」，所以它的判据只有一条：
// 静音时**一个音频节点都不许被造出来**，而不是造出来再把音量设成 0。
//
// 为什么不用 gain=0 那种写法：
//  - 0 增益的 oscillator 照样在音频线程上跑，省电的账一分没省；
//  - 玩家看得见的是「有没有声音」，门禁要量的却是「有没有节点」，两者对齐才不是自证；
//  - suspend()/resume() 停的是整条渲染，恢复时不必重建图，也不会在 resume 的那一瞬漏出一声。
//
// AudioContext 只在**第一次用户手势**里创建（noteGesture）：浏览器自动播放策略下，构造在
// 手势之外的 context 一律停在 suspended，控制台里那句「AudioContext was not allowed to start」
// 会被读成游戏坏了。所以本文件不在模块顶层碰任何音频 API。
let ctx = null;
let muted = true;
let nodes = 0; // 真造出来的 oscillator 数：门禁读它，不读我的注释

const AC = () => {
  const w = typeof window !== 'undefined' ? window : null;
  return w ? (w.AudioContext || w.webkitAudioContext || null) : null;
};

function ensure() {
  if (ctx) return ctx;
  const K = AC();
  if (!K) return null;
  try {
    ctx = new K({ latencyHint: 'interactive' });
  } catch {
    ctx = null; // 没有 WebAudio（老 WebView、隐私模式禁用）：音效整体降级为无，不许影响玩法
  }
  return ctx;
}

// 静音开关。ctx 还没被手势建起来时，muted 这个位就是唯一状态——之后第一次 blip 会照它决定要不要造节点。
export function setMuted(next) {
  muted = !!next;
  if (ctx) {
    try {
      if (muted) ctx.suspend();
      else ctx.resume();
    } catch { /* suspend/resume 在不支持的实现上是抛，不是返回 rejected：吞掉，玩法继续 */ }
  }
  return muted;
}

export function isMuted() {
  return muted;
}

// 第一次用户手势：把可能停在 suspended 的 context 推到 running。没建就现在建（此刻有用户激活，不会被拦）。
export function noteGesture() {
  if (muted) return false; // 静音时没有「解锁」这件事要做的：凭空建一个悬在 suspended 的 context 只换来一条自动播放警告
  const c = ensure();
  if (!c) return false;
  if (c.state === 'suspended') {
    try { c.resume(); } catch { /* 同上 */ }
  }
  return true;
}

// 一声短促的包络音。freq/dur/peak 都直白；返回 false 表示「这一声根本没响」，调用方不许拿它当「响过了」。
export function blip(freq = 660, dur = 0.06, peak = 0.05, type = 'triangle', delay = 0) {
  if (muted) return false;
  const c = ensure();
  if (!c) return false;
  if (c.state === 'suspended') return false; // 还没被手势解锁：不排队、不假装响过
  try {
    const t = c.currentTime + delay;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    // 指数包络不能从 0 起（数学上到不了 0，也不许取负）：所以起点是 0.0001
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    nodes++;
    return true;
  } catch {
    return false;
  }
}

// 三个动作各自的形状：落笔是短促的上行，成环是三连音上行。音高不是随便挑的——
// 与 palette 里 accent/info/success 三个语义色同构：一次操作、一条线索、一局成了。
export const sfx = {
  tap: () => blip(523.25, 0.045, 0.035),
  edge: () => blip(659.25, 0.055, 0.04),
  black: () => blip(293.66, 0.05, 0.03, 'square'),
  hint: () => blip(880, 0.09, 0.03, 'sine'),
  win: () => {
    blip(523.25, 0.12, 0.05, 'sine', 0);
    blip(659.25, 0.12, 0.05, 'sine', 0.09);
    blip(783.99, 0.26, 0.055, 'sine', 0.18);
  },
};

// 留给门禁与排障：state 是 AudioContext 的真实状态，created 是真造过的节点数。
export function audioStats() {
  return { supported: !!AC(), built: !!ctx, state: ctx ? ctx.state : 'none', muted, created: nodes };
}
