// 动效层。整个文件只解决一件事：**状态推进不许依赖帧率**。
//
// 为什么单独一层：这个游戏的推理是纯函数、画布是按需重画，唯一跟时间有关系的成分就是动效
// （胜利时的粒子、提示的脉冲）。而「144Hz 屏上动得比 60Hz 快」这类事故恰恰只发生在这一层。
//
// 办法是标准的那一个，也是唯一可被量的那一个：**固定步长 + 累加器**。
//   advance(帧间隔) → accum += 帧间隔 → 攒够一个 SIM_STEP 才 step(SIM_STEP) 一次，余数留下帧。
// 于是状态是「走了多少步」的函数，与「这一帧隔了多久」无关：30/60/120Hz 在同样 2 秒墙上时间里
// 推进的步数同为 120，每颗粒子的 x/y/life 逐位相同。
//
// 反过来，任何一处 `x += v * 帧间隔` 或 `k *= 0.94`（不写成 pow(k, dt*60)）都会让三档比对发散。
// 这条性质不是信仰，tools 之外的那个三档体检（/tmp 里的量法，见本轮交付报告）就是量这个的，
// 而它的反证（negative control）是把 `accum += 帧间隔` 改成 `accum += 1/60` —— 那一改必须变红。

export const SIM_STEP = 1 / 60; // 秒：一步固定 1/60，状态只由步数决定
const GRAV = 620; // px/s²，重力按秒的平方走，不是「每帧加一点」
const DRAG = 0.985; // 每 1 个 60Hz 步的速度衰减
const LIFE_DECAY = 0.94; // 每 1 个 60Hz 步的寿命衰减
const MAX_PARTICLES = 260;
const PULSE_LIFE = 0.9; // 提示脉冲的秒数

export function createFx({ max = MAX_PARTICLES } = {}) {
  let particles = [];
  let accum = 0; // 攒着没凑满一步的那点时间
  let steps = 0;
  let simTime = 0;
  let pulse = 0; // >0 = 正在脉冲，值 = 已进入的秒数；0 = 没有
  let pulseAt = null;
  let reduce = false;

  function step(dt) {
    simTime += dt;
    if (pulse > 0) {
      pulse += dt;
      if (pulse > PULSE_LIFE) { pulse = 0; pulseAt = null; }
    }
    if (!particles.length) { steps++; return; }
    const kv = Math.pow(DRAG, dt * 60); // 帧率无关的衰减：0.985 是「每 1/60 秒」的系数
    const kl = Math.pow(LIFE_DECAY, dt * 60);
    for (const p of particles) {
      p.vy += GRAV * dt;
      p.vx *= kv;
      p.vy *= kv;
      p.x += p.vx * dt; // 位置吃的是步长，不是帧间隔
      p.y += p.vy * dt;
      p.life *= kl;
      p.spin += p.spinV * dt;
    }
    particles = particles.filter((p) => p.life > 0.03);
    steps++;
  }

  // 唯一吃「帧间隔」的入口。返回这一步真正推进了几个 SIM_STEP，让调用方决定要不要重画。
  function advance(elapsedSec) {
    let e = Number(elapsedSec);
    if (!Number.isFinite(e) || e <= 0) return 0;
    // 切走十分钟回来不该一次补六万步：那是卡顿，不是追赶。上限 0.25s = 15 步。
    if (e > 0.25) e = 0.25;
    accum += e;
    let n = 0;
    while (accum >= SIM_STEP) {
      step(SIM_STEP);
      accum -= SIM_STEP;
      n++;
    }
    return n;
  }

  // rng 由调用方注入：测量要的是「同一颗 seed 跑三档，逐位可比」，这里不藏 Math.random。
  function burst(x, y, n = 12, rng = Math.random, color = '#FFC85C') {
    if (reduce || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (particles.length >= max) break;
      const a = rng() * Math.PI * 2;
      const sp = 60 + rng() * 220;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 90,
        life: 0.55 + rng() * 0.45,
        size: 2 + rng() * 3.5,
        spin: rng() * Math.PI,
        spinV: (rng() - 0.5) * 9,
        color,
      });
      made++;
    }
    return made;
  }

  function hintPulse(x, y) {
    if (reduce) return false; // 减少动效是真分支：脉冲压根不起
    pulse = SIM_STEP;
    pulseAt = { x, y };
    return true;
  }

  // 画在同一个 2D 上下文上（view.draw 之后叠一层）。reduce 时这两样都不存在，画面就是静帧。
  function draw(ctx) {
    if (reduce || (!particles.length && !pulse)) return false;
    for (const p of particles) {
      const a = Math.max(0, Math.min(1, p.life));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      const s = p.size;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }
    if (pulse && pulseAt) {
      const k = pulse / PULSE_LIFE;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.8 * (1 - k));
      ctx.strokeStyle = '#3CEB8A';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pulseAt.x, pulseAt.y, 6 + 26 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return true;
  }

  function reset() {
    particles = [];
    accum = 0;
    steps = 0;
    simTime = 0;
    pulse = 0;
    pulseAt = null;
  }

  // 给门禁与排障读：steps/simTime 是「推进了多少」，accum 是「攒着多少没凑满一步」，
  // 四个 sum* 是粒子**位置本身**的逐位对照面——只有步数相同、位置却各帧率一套，那就正是帧率相关。
  function state() {
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let ss = 0;
    for (const p of particles) {
      sx += p.x;
      sy += p.y;
      sl += p.life;
      ss += p.spin;
    }
    return { steps, simTime, accum, particles: particles.length, pulse, reduce, sumX: sx, sumY: sy, sumLife: sl, sumSpin: ss };
  }

  function setReduce(v) {
    reduce = !!v;
    if (reduce) { particles = []; pulse = 0; pulseAt = null; }
    return reduce;
  }

  return {
    advance, burst, hintPulse, draw, reset, state, setReduce,
    get busy() { return particles.length > 0 || pulse > 0; },
  };
}
