#!/usr/bin/env node
// 键盘的仓内常驻判据（node 侧，不开浏览器）：把 §2 那句「键盘要覆盖 Enter/Space 开始、P 暂停、
// R 重开、M 静音、F 全屏、H 教学」从「addEventListener 里查得到这个字符」变成真派发一次、
// 量到状态迁移。
//
// 为什么这一套必须存在（改前的实测事实）：`grep -rn 'keydown' tools/` 只命中
// tools/scenarios.js:562 与 :1071 —— 那两条都跑在真 Chrome 腿上，而本轮票面禁止起浏览器，
// 于是 node 门禁十一套里**没有任何一套**按下过一颗键。字符串门对下面这四种事故一律发绿：
//   ① handler 注册在 document 上而按键事件从 window 派发（或反之）；
//   ② 字符匹配写成了 `ev.key === 'Enter' && ev.code === 'Enter'` 之类多一个必要条件的形状；
//   ③ 键盘分支调的是内部函数而没 render/persist，读数变了而玩家那侧毫无反应；
//   ④ 「暂停中改盘的键要挡」那条前置 return 写反，P 之后键盘还能落笔。
// 这里全部用真派发（env._fire('keydown', ev)）+ 盘面读数来判，且自带两把阴性对照（末块）。
import { fileURLToPath } from 'node:url';
import { ROOT, buildEnv, loadGraph, flush, bootToBoard, pump, settle } from './dom-sandbox.mjs';

if (!process.execArgv.includes('--experimental-vm-modules') && !process.env.YAJ_KEY_RELIT) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, YAJ_KEY_RELIT: '1', NODE_NO_WARNINGS: '1' }, maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status === null ? 1 : r.status);
}

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };
const note = (m) => console.log('  ' + m);

async function boot() {
  const { context, env, doc } = buildEnv();
  await loadGraph(context, 'js/main.js');
  await flush();
  const booted = await bootToBoard(env, 60);
  ok(booted.ok, `关卡起不来（state=${booted.y && booted.y.state}）：键盘判据全部无从下手`);
  return { env, doc, y: booted.y };
}

// 真派发一颗键：走 main.js:578 那条 window keydown 监听（handler 是 async，返回的 promise
// 必须边喂帧边等，否则落笔/重开那几条 await 会挂在虚拟时钟里 —— 见 dom-sandbox 的 settle 注释）
async function press(env, key, { tagName = 'CANVAS' } = {}) {
  const ev = { key, code: 'Key' + String(key).toUpperCase(), target: { tagName }, currentTarget: null, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
  const hs = (env._h['keydown'] || []).slice();
  ok(hs.length > 0, `window 上没有 keydown 监听器（${env._h && Object.keys(env._h).join(',')}）——键盘是装饰`);
  for (const cb of hs) {
    const r = cb.call(env, ev);
    if (r && typeof r.then === 'function') await settle(env, r);
  }
  await flush();
  return ev;
}

// 盘面读数：判据比的是这七个，而不是「函数被调用过」
const snap = (y, doc) => ({
  segs: y.game.loopEdges().length,
  black: y.game.blackCells().length,
  cuts: y.game.offEdges().length,
  moves: y.game.moves,
  undo: y.game.undoStack.length,
  mode: y.mode,
  steps: y.fx().steps,
  particles: y.fx().particles,
  sr: doc.getElementById('sr-cell').textContent,
  state: doc.getElementById('state-line').textContent,
  clock: y.clockMs,
  paused: y.paused,
  audio: y.audio().created,
});
const diff = (a, b) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/* ═══════ 1) 未映射键与表单焦点：什么都不许改 ═══════ */
const S = await boot();
const { env, doc, y } = S;
pump(env, 10); // 让循环先跑起来，否则 steps 恒为 0 会让「没变化」这条判据空跑
ok(y.fx().steps > 0, `开机后动效步数为 ${y.fx().steps}：rAF 循环没跑，下面的等号判据全是假绿`);

const t0 = snap(y, doc);
const BOARD = ['segs', 'black', 'cuts', 'moves', 'undo', 'mode'];
await press(env, 'q'); // 未映射
ok(diff(t0, snap(y, doc)).filter((f) => BOARD.includes(f)).length === 0, `未映射键 q 改了盘面：${diff(t0, snap(y, doc)).join(' ')}`);
await press(env, 'ArrowRight', { tagName: 'INPUT' }); // 表单里的方向键不许搬光标
await press(env, 'b', { tagName: 'SELECT' });
await press(env, 'Enter', { tagName: 'TEXTAREA' });
const t1 = snap(y, doc);
ok(diff(t1, snap(y, doc)).filter((f) => BOARD.includes(f)).length === 0, `焦点在 INPUT/SELECT/TEXTAREA 时键盘改动了盘面：${diff(t1, snap(y, doc)).join(' ')}`);
note(`前置 return 成立：q 与三种表单焦点各派 1–3 发，盘面读数零漂移（黑格=${t1.black} 环段=${t1.segs} 模式=${t1.mode}）`);

/* ═══════ 2) H 教学：提示真的往盘上落了一条被迫的结论 ═══════ */
const h0 = snap(y, doc);
await press(env, 'h');
const h1 = snap(y, doc);
ok(h1.moves > h0.moves, `H 提示后步数没涨（${h0.moves} → ${h1.moves}）：这条键只是重画了一遍，没落任何结论`);
ok(h1.state !== h0.state, `H 提示后 #state-line 一个字都没变（"${h1.state.slice(0, 24)}"）：教学落子了却没说给玩家`);
note(`H：步数 ${h0.moves} → ${h1.moves}，盘上落子 ${h0.segs + h0.black + h0.cuts} → ${h1.segs + h1.black + h1.cuts}，说辞「${h1.state.slice(0, 30)}…」`);

/* ═══════ 3) B / 退格 / Z / E 四颗改盘键 ═══════ */
await press(env, 'ArrowRight'); // 光标 0 → 1
const c0 = snap(y, doc);
await press(env, 'b');
const c1 = snap(y, doc);
ok(c1.sr !== c0.sr || c1.black !== c0.black, `方向键 + B 之后光标读数与黑格都没动：光标那一步没进 game`);
ok(c1.black === c0.black + 1, `B 没有新增黑格（${c0.black} → ${c1.black}）`);
ok(c1.moves === c0.moves + 1 && c1.undo === c0.undo + 1, `B 之后步数/撤销栈没跟上（moves ${c0.moves}→${c1.moves}，undo ${c0.undo}→${c1.undo}）`);

await press(env, 'Backspace');
const c2 = snap(y, doc);
ok(c2.black === c1.black - 1, `退格没擦掉那一格黑（${c1.black} → ${c2.black}）`);

const cB = snap(y, doc);
await press(env, 'b');
const cZ = snap(y, doc);
await press(env, 'z');
const c3 = snap(y, doc);
ok(c3.black === cB.black, `Z 撤销后黑格应为 ${cB.black}（那一发 B 之前），实为 ${c3.black}`);
ok(c3.undo === cZ.undo - 1, `Z 之后撤销栈没弹出（${cZ.undo} → ${c3.undo}）`);
ok(c3.moves === cZ.moves + 1, `Z 之后步数读数应为 ${cZ.moves + 1}（本仓口径：撤销本身也记一步，与 tools/scenarios.js:1096 那句 moves=mv0+2 同一条），实为 ${c3.moves}`);

const m0 = y.mode;
await press(env, 'e');
const m1 = y.mode;
ok(m1 !== m0, `E 没有轮换画笔（${m0} → ${m1}）`);
const order = ['loop', 'black', 'cut', 'erase'];
ok(order[(order.indexOf(m0) + 1) % 4] === m1, `E 的轮换顺序不对：${m0} 之后应是 ${order[(order.indexOf(m0) + 1) % 4]}，实为 ${m1}`);
note(`四颗改盘键：B ${c0.black}→${c1.black} 黑，退格 →${c2.black}，再 B →${cZ.black} 后 Z 撤销回 ${c3.black}（撤销栈 ${cZ.undo}→${c3.undo}），E ${m0}→${m1}`);

/* ═══════ 4) P 暂停：仿真与改盘同时被冻住，再按 P 解冻 ═══════ */
await press(env, 'e'); // 把画笔转回可落黑格的那支，确保下面 P 期间的键是「本该改盘」的键
while (y.mode !== 'black') await press(env, 'e');
pump(env, 30);
const p0 = snap(y, doc);
ok(p0.paused === false, `P 之前 paused 读数已是 ${p0.paused}：开机就把局子停在暂停态，后面判不了`);
await press(env, 'p');
const p1 = snap(y, doc);
ok(p1.paused === true, 'P 之后 paused 读数不是 true');
pump(env, 120); // 暂停期间喂 2 虚拟秒
const p2 = snap(y, doc);
ok(p2.steps === p1.steps, `暂停期间仿真又推进了 ${p2.steps - p1.steps} 步`);
ok(p2.clock === p1.clock, `暂停期间时钟又走了 ${(p2.clock - p1.clock).toFixed(1)}ms`);
const blackBeforeRefused = p2.black;
await press(env, 'b');
const p3 = snap(y, doc);
ok(p3.black === blackBeforeRefused, `暂停中 B 仍然落进了黑格（${blackBeforeRefused} → ${p3.black}）：那条前置 return 是写反的`);
ok(/暂停/.test(p3.sr), `暂停中按键却没有说给读屏（aria-live="${p3.sr.slice(0, 20)}"）：静默吞键会被读成「这键盘是装饰」`);
await press(env, 'p');
const p4 = snap(y, doc);
ok(p4.paused === false, `再按 P 没有解除暂停（paused=${p4.paused}）`);
pump(env, 60);
const p5 = snap(y, doc);
ok(p5.steps > p4.steps, `恢复后动效一步都没推进（${p4.steps} → ${p5.steps}）：暂停把循环杀死了而不是按住`);
ok(p5.black === p3.black, `恢复后黑格被洗掉了（${p3.black} → ${p5.black}）：暂停不该是一次重开`);
note(`P：暂停冻住 ${(p5.steps - p2.steps)} 步的推进差且时钟停在 ${p1.clock.toFixed(1)}ms，期间 B 被拒（黑格恒为 ${blackBeforeRefused}），恢复后 ${p4.steps}→${p5.steps} 步、笔迹 ${p5.black} 格还在`);

/* ═══════ 5) M 静音：真 suspend，且静音态一颗振荡器都不许造 ═══════ */
y.setSound(true); // 存档默认 sound:false，先把「开声」这条基准立起来
// AudioContext 是懒建的：没有一次真用户手势它就还是 null（state=none），
// 于是「静音后不许再造节点」这条判据会拿一个根本没建过的 ctx 去比 0==0 —— 空跑。
{
  const canvas = doc.getElementById('board');
  const R = canvas.getBoundingClientRect();
  const g = y.view.centerOf(0);
  canvas._fire('pointerdown', { clientX: R.left + g.x, clientY: R.top + g.y, button: 0, buttons: 1, pointerId: 9, isPrimary: true, preventDefault() {} });
  canvas._fire('pointerup', { clientX: R.left + g.x, clientY: R.top + g.y, button: 0, pointerId: 9, preventDefault() {} });
}
pump(env, 10);
await flush();
const aRun = y.audio();
ok(aRun.muted === false && (aRun.state === 'running' || aRun.created > 0), `开声基准失败：muted=${aRun.muted} state=${aRun.state} created=${aRun.created}（真手势之后仍未建 AudioContext）`);
await press(env, 'm');
const aMuted = y.audio();
ok(aMuted.muted === true, 'M 之后 muted 不是 true');
ok(aMuted.state === 'suspended', `M 之后 AudioContext 是 ${aMuted.state} 而不是 suspended：只把 gain 设 0 是假静音（§2）`);
const oscAtMute = aMuted.created;
for (let i = 0; i < 3; i++) { await press(env, 'b'); await press(env, 'ArrowRight'); }
pump(env, 60);
await press(env, 'h');
const aAfter = y.audio();
ok(aAfter.created === oscAtMute, `静音态又新建了 ${aAfter.created - oscAtMute} 个音频节点（B×3 + H 之后）：那是音量 0 而不是不发声`);
ok(aAfter.state === 'suspended', `静音期间 context 被复活成 ${aAfter.state}`);
await press(env, 'm');
const aBack = y.audio();
ok(aBack.state === 'running', `再按 M 没有回到 running（${aBack.state}）：suspend/resume 不成对`);
note(`M：开声 created=${aRun.created} → 静音 ${oscAtMute}（期间 3 发 B + 1 发 H + 60 帧，增量 ${aAfter.created - oscAtMute}），再按回 ${aBack.state}`);

/* ═══════ 6) F 全屏：requestFullscreen 真的落在文档元素上 ═══════ */
const root = doc.documentElement;
const fs0 = root._fs;
await press(env, 'f');
ok(root._fs === fs0 + 1, `F 之后 documentElement.requestFullscreen 被调 ${root._fs - fs0} 次（应为 1）`);
await press(env, 'f'); // 沙箱里 fullscreenElement 恒为 null，第二发仍是请求；口径写进 note
note(`F：requestFullscreen 调用数 ${fs0} → ${root._fs}（沙箱 document.fullscreenElement 恒 null，故两发都是「进入」路径）`);

/* ═══════ 7) R 重开 + Enter/Space 落笔（§2 点名的开局键）═══════ */
await press(env, 'r');
const r0 = snap(y, doc);
ok(r0.segs === 0 && r0.black === 0 && r0.cuts === 0, `R 之后盘上还有东西（环=${r0.segs} 黑=${r0.black} 叉=${r0.cuts}）`);
ok(r0.moves === 0 && r0.undo === 0, `R 之后步数/撤销栈还在（${r0.moves}/${r0.undo}）`);
ok(r0.clock < 200, `R 之后时钟没归零：${r0.clock.toFixed(1)}ms`);
ok(r0.paused === false, `R 之后仍停在暂停态：重开必须把暂停一起清掉`);
const seedBefore = y.game.seed;
while (y.mode !== 'loop') await press(env, 'e'); // 画笔转回「画环」那支：下面判的是环段，且这支键本身也走键盘

const k0 = snap(y, doc);
await press(env, 'Enter'); // 第一次只定锚（起点还没有上一条边）
const k1 = snap(y, doc);
ok(k1.segs === k0.segs, `第一次 Enter 就落下了环段（${k0.segs} → ${k1.segs}）：锚点语义被跳过`);
ok(/锚在第/.test(k1.sr), `第一次 Enter 后 aria-live 没报锚点（"${k1.sr.slice(0, 24)}"）`);
await press(env, 'ArrowRight');
await press(env, 'Enter');
const k2 = snap(y, doc);
ok(k2.segs === k0.segs + 1, `Enter + 方向键 + Enter 之后环段应为 ${k0.segs + 1}，实为 ${k2.segs}`);
await press(env, 'ArrowRight');
await press(env, ' '); // Space 与 Enter 同一条路
const k3 = snap(y, doc);
ok(k3.segs === k2.segs + 1, `Space 没落下第二段环（${k2.segs} → ${k3.segs}）：§2 要的「Enter/Space 开始」里 Space 这支是空的`);
await press(env, 'Escape');
const e0 = snap(y, doc);
ok(e0.segs === k3.segs && e0.black === k3.black, `Escape 洗掉了盘面（环 ${k3.segs}→${e0.segs}）：它只该放掉锚点`);
await press(env, 'ArrowRight');
await press(env, 'Enter');
const e1 = snap(y, doc);
ok(e1.segs === e0.segs, `Escape 之后 Enter 仍直接落笔（${e0.segs} → ${e1.segs}）：锚点没被真的清掉`);
ok(/锚在第/.test(e1.sr), `Escape 后 Enter 没有重新定锚（"${e1.sr.slice(0, 24)}"）`);
ok(y.game.seed === seedBefore, `R 之后键盘落笔把 seed 换了（${seedBefore} → ${y.game.seed}）`);
note(`R + 开局键：重开后盘面全零（环 ${r0.segs} 黑 ${r0.black} 用时 ${r0.clock.toFixed(1)}ms），Enter 定锚→方向→Enter 得 ${k2.segs} 段，Space 得 ${k3.segs} 段，Escape 后重新定锚不越级落笔`);

/* ═══════ 8) 两把阴性对照：尺子不许是空跑的 ═══════ */
// ① 摘掉 window 上的 keydown 监听器：前面那一大串「迁移」必须立刻全部失灵，
//    否则说明我比的其实是我自己直接调的函数，键盘这条路根本没进过判据。
const fireRaw = (k) => { const ev = { key: k, target: { tagName: 'CANVAS' }, preventDefault() {} }; for (const cb of (env._h['keydown'] || []).slice()) cb.call(env, ev); };
const saved = env._h['keydown'];
env._h['keydown'] = [];
const n0 = snap(y, doc);
for (const k of ['b', 'h', 'ArrowRight', 'Enter', ' ', 'z', 'Backspace']) fireRaw(k);
pump(env, 30);
const n1 = snap(y, doc);
const frozenOut = diff(n0, n1).filter((f) => BOARD.includes(f));
ok(frozenOut.length === 0, `摘掉监听器后盘面仍被按键改动：${frozenOut.join(' ')} —— 前面那些「迁移」不是键盘产生的`);
env._h['keydown'] = saved;
await press(env, 'ArrowRight');
await press(env, 'Enter');
const n2 = snap(y, doc);
ok(diff(n1, n2).length > 0, '装回监听器后同一对键什么都没改：上一发那个等号只是常量自等，尺子空跑');
note(`阴性对照①：摘监听器 7 发键 → 盘面读数零改动（环 ${n0.segs}→${n1.segs} 黑 ${n0.black}→${n1.black} 模式 ${n0.mode}→${n1.mode}）；装回后同一对键立刻改动 ${diff(n1, n2).join('/')}`);

// ② 大小写同路：§2 的键位表写的是「P 暂停、M 静音」，玩家真按到的是 Caps Lock 下那颗大写 P。
//    只匹配小写的写法（k === 'p'）在这里必须判红——字符串门 grep 到 'p' 可不会红。
const q0 = snap(y, doc);
await press(env, 'P');
const q1 = snap(y, doc);
ok(q1.paused === !q0.paused, `大写 P 没有切暂停（${q0.paused} → ${q1.paused}）：字符匹配漏了大写`);
await press(env, 'P');
ok(snap(y, doc).paused === q0.paused, `大写 P 第二发没切回去（当前 ${snap(y, doc).paused}）`);
const oscQ = y.audio().created;
await press(env, 'M');
ok(y.audio().muted === true && y.audio().state === 'suspended', `大写 M 没有真静音（muted=${y.audio().muted} state=${y.audio().state}）`);
await press(env, 'M');
ok(y.audio().state === 'running', `大写 M 第二发没回到 running（${y.audio().state}）`);
note(`阴性对照②：大写 P 两发切暂停（${q0.paused}→${q1.paused}→${snap(y, doc).paused}），大写 M 两发切 suspend/resume（created ${oscQ} → ${y.audio().created}）`);

console.log(`RESULT keyboard-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
