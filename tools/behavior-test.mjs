#!/usr/bin/env node
// 「行为成立」而不是「字符串命中」——BRIEF_COS §2 点名的那五条，在 node 侧用真模块跑一遍。
//
// 为什么不能只靠 sellability 那条正则：它数的是 `suspend` / `pause` / `restart` 这些**字符串**
// 在不在。把 gain 设成 0 也叫静音、`init()` 调了但累加器还在跑也叫暂停、按钮存在但 rect
// 换算漏了缩放也叫触摸——字符串门对这三种一律发绿。所以这里逐条钉一个可数的读数：
//   静音  ⇒ AudioContext 真 suspended，且静音期间**振荡器计数一格都不许涨**
//   暂停  ⇒ 喂 120 帧而 fx 步数与用时读数一动不动；恢复后笔迹还在
//   重开  ⇒ 环段/黑格/排除/步数/时钟/动效累加器全部归零，而且 seed 不变（同一张盘）
//   触摸  ⇒ 画布被 CSS 缩到 0.5 时，点在第 k 格的视觉格心必须命中第 k 格（环段与叉同一条换算）
//   全屏  ⇒ requestFullscreen 真的落在文档元素上，并且是由 HUD 里那颗真实存在的按钮触发的
//
// 存档的两段式解码不在这里重复：tools/store-test.mjs 已经拿九发真垃圾常驻判了。
import { fileURLToPath } from 'node:url';
import { ROOT, buildEnv, loadGraph, flush, bootToBoard, pump, settle } from './dom-sandbox.mjs';

// vm.SourceTextModule 只在 --experimental-vm-modules 下可用，裸 `node tools/…` 时自举一次。
if (!process.execArgv.includes('--experimental-vm-modules') && !process.env.YAJ_BEH_RELIT) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, YAJ_BEH_RELIT: '1', NODE_NO_WARNINGS: '1' }, maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status === null ? 1 : r.status);
}

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };
const note = (m) => console.log('  ' + m);

async function bootSandbox() {
  const { context, env, doc } = buildEnv();
  await loadGraph(context, 'js/main.js');
  await flush();
  const booted = await bootToBoard(env, 60);
  ok(booted.ok, `关卡起不来（state=${booted.y && booted.y.state}）`);
  return { env, doc, y: booted.y };
}

// 喂 n 帧真实 rAF 与 settle 的口径都在 tools/dom-sandbox.mjs（帧率/键盘套件共用同一把尺）。

// 真拖一笔：pointerdown 在 A 格心、pointermove 到相邻格心、pointerup。
// 只按 pointerdown 在「画环」这支笔下不会长出环段（起点还没有上一条），所以判据要用 drag。
function dragCells(doc, y, from, to) {
  const canvas = doc.getElementById('board');
  const R = canvas.getBoundingClientRect();
  const a = y.view.centerOf(from), b = y.view.centerOf(to);
  const ev = (x, btn) => ({ clientX: R.left + x.x, clientY: R.top + x.y, button: btn, buttons: 1, pointerId: 7, isPrimary: true, preventDefault() {} });
  canvas._fire('pointerdown', ev(a, 0));
  canvas._fire('pointermove', ev(b, 0));
  canvas._fire('pointerup', ev(b, 0));
}

function press(doc, clientX, clientY, button = 0) {
  const canvas = doc.getElementById('board');
  canvas._fire('pointerdown', { clientX, clientY, button, pointerId: 7, isPrimary: true, preventDefault() {} });
  canvas._fire('pointerup', { clientX, clientY, button, pointerId: 7, preventDefault() {} });
}

/* ---------- 1) 静音：真停 AudioContext，且不再造振荡器 ---------- */
{
  const { env, doc, y } = await bootSandbox();
  y.setSound(true);
  const g0 = y.view.centerOf(0);
  press(doc, g0.x + env.__doc.getElementById('board').getBoundingClientRect().left, g0.y + 60);
  note(`按键路径已走：canvas 上按过 pointerdown（坐标 ${g0.x.toFixed(1)},${g0.y.toFixed(1)}）`);
  let a = y.audio();
  note(`开声态 audio() = state=${a.state} built=${a.built} muted=${a.muted} created=${a.created}`);
  ok(a.state === 'running' || a.created > 0, `开声态既没 running 也没造过节点：这条按键没经过音频（state=${a.state} created=${a.created}）`);

  y.setSound(false);
  a = y.audio();
  note(`静音后 audio() = state=${a.state} muted=${a.muted} created=${a.created}`);
  ok(a.muted === true, 'setSound(false) 之后 muted 不是 true');
  ok(a.state === 'suspended', `静音后 AudioContext 还停在 ${a.state}：只把 gain 设 0 是假静音（BRIEF §2）`);
  const oscBefore = a.created;
  for (let i = 0; i < 6; i++) { const g = y.view.centerOf(i); press(doc, g.x + 8, g.y + 60); }
  pump(env, 30);
  const after = y.audio();
  note(`静音态连按 6 格 + 喂 30 帧：created ${oscBefore} → ${after.created}，state=${after.state}`);
  ok(after.created === oscBefore, `静音态又新建了 ${after.created - oscBefore} 个音频节点：那是「音量 0」而不是「不发声」`);
  ok(after.state === 'suspended', `静音期间 context 被resume成了 ${after.state}`);

  y.setSound(true);
  const resumeState = y.audio().state;
  ok(resumeState === 'running', `取消静音后 context 是 ${resumeState}，不是 running`);
  note(`取消静音：state=${resumeState}（suspend/resume 成对）`);
}

/* ---------- 2) 暂停：喂帧而仿真一步不推、时钟停在当前毫秒 ---------- */
{
  const { env, doc, y } = await bootSandbox();
  pump(env, 60);                       // 1 虚拟秒 = 60 个 SIM_STEP
  const s1 = y.fx().steps, c1 = y.clockMs;
  ok(s1 > 0, `暂停前 fx 步数是 ${s1}：循环根本没跑，后面比不出东西`);
  dragCells(doc, y, 0, 1);            // 落一段真环，待会儿验证「恢复后不丢状态」（0→1 才相邻，5→6 在 6x6 上是换行）
  const segsBefore = y.game.loopEdges().length;
  ok(segsBefore > 0, `拖了一笔仍然 0 段环（${segsBefore}）：这条路没走到 game.toggleEdge，判据空跑`);

  y.setPaused(true);
  ok(y.paused === true, 'setPaused(true) 之后 paused 读数不是 true');
  pump(env, 120);                      // 暂停期间喂 2 虚拟秒
  const s2 = y.fx().steps, c2 = y.clockMs;
  note(`暂停：steps ${s1} → ${s2}（应为等号），clockMs ${c1.toFixed(1)} → ${c2.toFixed(1)}（应为等号），期间喂了 120 帧`);
  ok(s2 === s1, `暂停期间仿真仍推进了 ${s2 - s1} 步`);
  ok(c2 === c1, `暂停期间时钟又走了 ${c2 - c1} ms（BRIEF §2「时钟停在当前毫秒」）`);

  dragCells(doc, y, 2, 3);
  ok(y.game.loopEdges().length === segsBefore, `暂停期间笔还能进盘（环段 ${segsBefore} → ${y.game.loopEdges().length}）：pointer 路径没被暂停拦住`);
  note(`暂停期间再按一下：环段仍 ${y.game.loopEdges().length}（与暂停前 ${segsBefore} 相同）`);

  y.setPaused(false);
  pump(env, 60);
  const s3 = y.fx().steps, segsAfter = y.game.loopEdges().length;
  note(`恢复：steps ${s2} → ${s3}（应重新推进），环段 ${segsBefore} → ${segsAfter}（状态不许丢）`);
  ok(s3 > s2, `恢复后 fx 步数没接着走（${s3} ≤ ${s2}）`);
  ok(segsAfter === segsBefore, `恢复后笔迹被洗掉了（${segsBefore} → ${segsAfter}）`);
}

/* ---------- 3) 重开：这张盘从零开始，缓存一个都不留 ---------- */
{
  const { env, doc, y } = await bootSandbox();
  const seed = y.game.seed;
  y.setMode('loop');
  dragCells(doc, y, 0, 1);
  dragCells(doc, y, 1, 2);
  dragCells(doc, y, 2, 3);
  y.setMode('black');
  const b = y.view.centerOf(20);
  press(doc, b.x + 8, b.y + 60);
  pump(env, 90);
  const before = { segs: y.game.loopEdges().length, black: y.game.blackCells().length, moves: y.game.moves, undo: y.game.undoStack.length, steps: y.fx().steps, accum: y.fx().accum, clock: y.clockMs };
  note(`重开前：环段=${before.segs} 黑格=${before.black} 步数=${before.moves} 撤销栈=${before.undo} 动效步=${before.steps} accum=${before.accum.toFixed(6)} 用时=${before.clock.toFixed(1)}ms`);
  ok(before.segs + before.black > 0, '重开前一笔都没落下，这条判据等于空跑');

  await settle(env, y.restart());
  await flush();
  // 动效那三个读数在 restart 落地的那一刻就要读：晚一帧就多了那帧自己的 dt（那不是泄漏）
  const fxNow = y.fx();
  pump(env, 1); // 让 render 真正跑一次，读数落到 UI 上
  const after = { segs: y.game.loopEdges().length, black: y.game.blackCells().length, cuts: y.game.offEdges().length, moves: y.game.moves, undo: y.game.undoStack.length, steps: fxNow.steps, accum: fxNow.accum, particles: fxNow.particles, clock: y.clockMs, seed: y.game.seed };
  note(`重开后：环段=${after.segs} 黑格=${after.black} 排除=${after.cuts} 步数=${after.moves} 撤销栈=${after.undo} 动效步=${after.steps} accum=${after.accum.toFixed(6)} 粒子=${after.particles} 用时=${after.clock.toFixed(1)}ms seed=${after.seed}`);
  ok(after.seed === seed, `重开换了盘（seed ${seed} → ${after.seed}）：那是「换一局」不是「重来」`);
  ok(after.segs === 0 && after.black === 0 && after.cuts === 0, `重开后笔表没清干净（环段=${after.segs} 黑格=${after.black} 排除=${after.cuts}）`);
  ok(after.moves === 0 && after.undo === 0, `重开后步数/撤销栈还在（moves=${after.moves} undo=${after.undo}）`);
  ok(after.steps === 0 && after.particles === 0, `重开后动效缓存还在（步=${after.steps} 粒子=${after.particles}）`);
  ok(after.accum < y.simStep, `重开后累加器还攒着 ${(after.accum * 1000).toFixed(3)}ms（≥ 一步 ${y.simStep}）：下一局会白捡一步`);
  ok(after.clock < 200, `重开后时钟没归零：${after.clock.toFixed(1)}ms`);
}

/* ---------- 4) 触摸命中：画布被 CSS 缩过也要点 A 打 A ---------- */
{
  const { y, doc } = await bootSandbox();
  const canvas = doc.getElementById('board');
  const geo = y.view.geo;
  ok(geo.w > 0 && geo.cell > 0, `geo 没就绪（w=${geo.w} cell=${geo.cell}），这条判据无从下手`);
  const targets = [0, 7, 13, 22, 35];
  for (const k of targets) {
    const c = y.view.centerOf(k); // CSS 像素的格心（画布本地）
    for (const scale of [1, 0.6, 0.5, 1.7]) {
      canvas._scale = scale;
      const rect = canvas.getBoundingClientRect();
      const vx = rect.left + c.x * scale;
      const vy = rect.top + c.y * scale;
      const got = y.view.hitCell(vx, vy);
      ok(got === k, `CSS 缩放 ${scale} 下点第 ${k} 格的视觉格心 → 命中第 ${got} 格（点 A 打 B）`);
      const edge = y.view.hitEdge(vx + (geo.cell * scale) / 4, vy);
      if (edge) ok(edge.cell === k, `缩放 ${scale} 下 hitEdge 落到了第 ${edge.cell} 格（应仍是 ${k}）`);
    }
  }
  canvas._scale = 1;
  note(`缩放命中：${targets.length} 个格 × 4 档缩放（1 / 0.6 / 0.5 / 1.7）全部逐格对上`);

  // 换掉换算式之前先证明这一发不是空跑：同一批 client 坐标按**旧公式**（不减缩放）再算一遍，
  // 在缩放 ≠ 1 的档上必须落到别的格去。旧公式照样命中的话，上面那 20 条断言就一条都没在量东西。
  let wouldMiss = 0, samples = 0;
  for (const k of targets) {
    const c = y.view.centerOf(k);
    for (const scale of [0.6, 0.5, 1.7]) {
      canvas._scale = scale;
      const R = canvas.getBoundingClientRect();
      const vx = R.left + c.x * scale, vy = R.top + c.y * scale;
      const legacy = (() => { // board.js 改之前的那一段：只减 rect，不除缩放
        const px = vx - R.left - geo.x, py = vy - R.top - geo.y;
        const gx = Math.floor(px / geo.cell), gy = Math.floor(py / geo.cell);
        if (gx < 0 || gy < 0 || gx >= y.game.w || gy >= y.game.h) return -1;
        return gy * y.game.w + gx;
      })();
      samples++;
      if (legacy !== k) wouldMiss++;
    }
  }
  canvas._scale = 1;
  note(`阴性对照（旧换算式）：${samples} 个缩放样本里 ${wouldMiss} 个会命中错格 ⇒ 上面那批断言确实在量东西`);
  ok(wouldMiss >= Math.floor(samples * 0.6), `旧公式只错位 ${wouldMiss}/${samples}：这一发近似空跑，判据抓不到「点 A 打 B」`);
}

/* ---------- 5) 全屏：绑在 HUD 里真实存在的那颗按钮上 ---------- */
{
  const { doc, y } = await bootSandbox();
  const btn = doc.getElementById('btn-full');
  ok(!!btn, 'index.html 里没有 id="btn-full"：HUD 上那颗按钮不存在');
  const root = doc.documentElement;
  const before = root._fs;
  btn._fire('click', {});
  await flush();
  note(`点 btn-full → documentElement.requestFullscreen 调用数 ${before} → ${root._fs}`);
  ok(root._fs === before + 1, `点全屏按钮没有触发 requestFullscreen（${before} → ${root._fs}）`);
  ok(typeof y.toggleFullscreen === 'function', '门面没暴露 toggleFullscreen');
}

console.log(`RESULT behavior-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
