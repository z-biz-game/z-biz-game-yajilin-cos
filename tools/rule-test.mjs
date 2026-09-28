#!/usr/bin/env node
// 规则模型的门：verify() 的正反例 + Board 的射线/邻接原语。
//
// 三条不能少的正例（需求卡第一节 + 第五节）：
//   1 由解出题的 generate() 交回的盘必须自己过 verify()（模型没写错）；
//   2 **环必须盖住所有非黑非箭头格**——本变体没有灰格，漏一格就是红；
//   3 **黑格允许贴着箭头格**：只有黑-黑共边才违法，把这条写死成断言，
//     否则将来谁"顺手加一条黑格不许挨箭头"的约束，会把整档难度梯子悄悄推倒。
// 反例用**故意改坏**的盘：每一条都必须被 verify() 抓住，而且抓住的理由要写对
// （"报了个错"不算数，报错的那条不是被测的那条也不算数）。
import { Board, DIRS } from '../js/engine/grid.js';
import { verify, generate, recompute } from '../js/engine/model.js';
import { makePencilBoard, DEFAULT_LOOP_FRACS } from '../js/engine/generate.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) { fails.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` :: ${detail}` : ''}`); }
  return !!cond;
}
// 反向断言：verify() 里必须出现一条**提到这件事**的错，光"非空"不算抓到
function errHas(errs, needle, name) {
  ok(errs.some((e) => e.includes(needle)), name, `errs=${JSON.stringify(errs.slice(0, 4))} 期望含「${needle}」`);
}

const clone = (b) => {
  const c = new Board(b.w, b.h);
  c.clue = new Map(b.clue); c.black = new Set(b.black); c.loop = new Set(b.loop); c.edges = new Set(b.edges);
  return c;
};

// ————————————————————————————— Board 原语 —————————————————————————————
{
  const b = new Board(4, 3);
  ok(b.n === 12 && b.id(2, 3) === 11 && String(b.rc(11)) === '2,3', 'Board 行主序编号 id/rc 互逆');
  ok(b.inBounds(0, 0) && !b.inBounds(3, 0) && !b.inBounds(-1, 1) && !b.inBounds(0, 4), 'inBounds 上下左右四边都封住');
  ok(b.ray(5, 0).length === 1 && b.ray(5, 0)[0] === 1, 'ray 向上到盘边为止，不含自己');
  ok(String(b.ray(0, 1)) === '1,2,3', 'ray 向右 = 整行剩余格');
  ok(String(b.ray(0, 2)) === '4,8', 'ray 向下 = 整列剩余格');
  ok(String(b.ray(3, 3)) === '2,1,0', 'ray 向左 = 反向整行');
  ok(b.ray(8, 0).length === 2 && b.ray(11, 1).length === 0, '角落格射线长度按方向不对称（右/下没格子，上只剩 2 格）');
  ok(b.neighbors(0).length === 2 && b.neighbors(5).length === 4 && b.neighbors(11).length === 2, '角落 2 邻、内格 4 邻');
  ok(Board.ek(7, 3) === '3:7' && Board.ek(3, 7) === '3:7', 'ek 边键与端点顺序无关');
  ok(DIRS.map((d) => d.name).join(',') === 'up,right,down,left', 'DIRS 顺序 up/right/down/left（counter 的 OPP 表按它写）');
}

// ————————————————————————————— 正例 —————————————————————————————
// 1) 由解出题：模型自己的盘必须全绿，而且必须真的存在「黑格挨着箭头格」这一型
let sample = null;
for (const seed of ['rule-6x6-0', 'rule-6x6-1', 'rule-8x8-0', 'rule-8x8-3']) {
  const w = seed.startsWith('rule-6') ? 6 : 8, h = w;
  const g = generate(seed, w, h, { loopFrac: 0.5 });
  if (!g.ok) { ok(false, `${seed} 模型自出题失败`, g.status); continue; }
  const errs = verify(g.board);
  ok(errs.length === 0, `${seed} generate() 的盘必须过 verify()`, JSON.stringify(errs.slice(0, 3)));
  if (seed === 'rule-6x6-0') sample = g.board;
}
ok(!!sample, '至少一颗 seed 要能出示范盘（后面的反例全在它身上改）');

if (sample) {
  // 2) 环覆盖 = 每格恰好一个角色：非黑非箭头的格必须全在环上
  const uncovered = [];
  for (let i = 0; i < sample.n; i++) if (!sample.clue.has(i) && !sample.black.has(i) && !sample.loop.has(i)) uncovered.push(i);
  ok(uncovered.length === 0, '正例：所有非黑非箭头格都在环上（本变体没有灰格）', JSON.stringify(uncovered));

  // 3) 黑格可以贴箭头格：先在示范盘上找到这一型，找到才说明这个正例不是空话
  let blackOnClue = null;
  for (const i of sample.black) { const j = sample.neighbors(i).find((k) => sample.clue.has(k)); if (j !== undefined) { blackOnClue = [i, j]; break; } }
  ok(!!blackOnClue, '示范盘里就该出现「黑格挨着箭头格」（greedy 独立集的构造保证它有）');
  if (blackOnClue) {
    const keep = clone(sample);
    ok(verify(keep).length === 0, '正例：黑格贴着箭头格是合法盘（只有黑-黑共边才违法）');
  }
  // 射线读数与 verify 的判定同源：手动数一遍，必须等于题面数字
  let rayAllMatch = true;
  for (const [i, cl] of sample.clue) {
    let got = 0; for (const j of sample.ray(i, cl.dir)) if (sample.black.has(j)) got++;
    if (got !== cl.n) rayAllMatch = false;
  }
  ok(rayAllMatch, '正例：每条箭头的射线黑格数都等于题面数字');
}

// ————————————————————————————— 反例：故意改坏，必须报红 —————————————————————————————
const bad = (mutate, needle, name) => {
  if (!sample) return;
  const b = clone(sample);
  mutate(b);
  errHas(verify(b), needle, `反例 ${name}`);
};
const dropCell = (b) => { const i = [...b.loop][0]; b.loop.delete(i); for (const e of [...b.edges]) { const [x, y] = e.split(':').map(Number); if (x === i || y === i) b.edges.delete(e); } };
bad(dropCell, '既不在环上也不是黑格/线索', '把一格从环上摘下来（灰格）⇒ 环没盖住所有该盖的格');
bad((b) => { const i = [...b.loop][0]; b.black.add(i); }, '同时是多种角色', '一格既是环格又是黑格');
// 「把一格环格改成黑格」要先确认这盘里有这样的相邻对，没有就该红在断言上而不是悄悄跳过
{
  const findPair = () => {
    if (!sample) return null;
    for (const i of sample.black) { const j = sample.neighbors(i).find((k) => sample.loop.has(k)); if (j !== undefined) return [i, j]; }
    return null;
  };
  const pair = findPair();
  ok(!!pair, '示范盘里要有「黑格挨着环格」这一型（黑-黑相邻的反例要在它身上改）');
  if (pair) bad((b) => {
    const [, j] = pair;
    b.loop.delete(j);
    for (const e of [...b.edges]) { const [x, y] = e.split(':').map(Number); if (x === j || y === j) b.edges.delete(e); }
    b.black.add(j);
  }, '黑格相邻', '把一格环格涂黑 ⇒ 它和邻居黑格共边（本变体唯一禁止的相邻组合）');
}
bad((b) => { const [i, cl] = [...b.clue.entries()][0]; b.clue.set(i, { dir: cl.dir, n: cl.n + 1 }); }, '实数', '箭头数字改大 1（射线上的黑格数对不上）');
bad((b) => { const [i, cl] = [...b.clue.entries()][0]; b.clue.set(i, { dir: (cl.dir + 1) % 4, n: cl.n }); }, '实数', '箭头转 90°（同数字换了射线，多半不再是那个数）');
bad((b) => { const i = [...b.loop][0]; b.edges.delete([...b.edges].find((e) => e.startsWith(`${i}:`) || e.endsWith(`:${i}`))); }, '度数 1≠2', '把一条环边抽掉 ⇒ 端点度数不足 2');
bad((b) => { const i = [...b.loop][0]; const other = [...b.loop].find((j) => j !== i && !b.neighbors(i).includes(j)); b.edges.add(Board.ek(i, other)); }, '度数 3≠2', '给环格多接一条边（度数 >2）');
bad((b) => { const i = [...b.loop][0]; b.edges.add(Board.ek(i, [...b.black][0])); }, '端点不在环上', '环边连到黑格上');

// 两条不相交的环：单环判定必须抓住（"环只覆盖 k/n"）
{
  const b = new Board(4, 4);
  const cyc = (cells) => { for (let k = 0; k < cells.length; k++) { b.loop.add(cells[k]); b.edges.add(Board.ek(cells[k], cells[(k + 1) % cells.length])); } };
  cyc([0, 1, 5, 4]); cyc([10, 11, 15, 14]);
  for (let i = 0; i < 16; i++) if (!b.loop.has(i)) b.clue.set(i, { dir: 1, n: 0 });
  const errs = verify(b);
  errHas(errs, '不是单一环', '反例 两个 2×2 小环并存（每个环格度数都是 2，只有"一条环"能抓它）');
  ok(!errs.some((e) => e.includes('度数')), '反例 双环那盘的每个环格度数确实都是 2（错只错在不连通）', JSON.stringify(errs.slice(0, 3)));
}

// 一格三角色全无也不能出货：本变体没有灰格，漏一格就是红
{
  const b = new Board(3, 3);
  for (let i = 0; i < 9; i++) b.clue.set(i, { dir: 1, n: 0 });
  b.clue.delete(4);
  errHas(verify(b), '既不在环上也不是黑格/线索', '反例 一格三角色全无（既没涂黑也没上环也没箭头）');
  b.black.add(4);
  recompute(b); // 箭头数字必须跟着黑格集合走，否则下面这条正例是在考自己的谎
  ok(verify(b).length === 0, '正例 3×3 全箭头 + 一格涂黑：角色齐了就是合法盘（黑格贴箭头合法）', JSON.stringify(verify(b)));
}

// ————————————————————————————— 出货盘必须过同一台审计器 —————————————————————————————
// 这条是需求卡第四节那条红线的正面写法：出货盘上的 black/loop/edges 是**计数器那张**，
// 而 verify() 是对整盘独立判的第二台机器（出题器自记的那份在坑 2 里说过谎）。
for (const [w, h] of [[6, 6], [8, 8]]) {
  let shipped = 0;
  for (let s = 0; s < 2; s++) {
    const r = makePencilBoard(`rule-${w}x${h}-${s}`, w, h, { maxAttempts: 60, loopFracs: DEFAULT_LOOP_FRACS });
    if (!r.ok) { ok(false, `${w}x${h}#${s} 出货失败`, JSON.stringify(r.dead)); continue; }
    shipped++;
    const errs = verify(r.board);
    ok(errs.length === 0, `${w}x${h}#${s} 出货盘整盘 verify() 必须全绿`, JSON.stringify(errs.slice(0, 3)));
    ok(r.stillSolved === true, `${w}x${h}#${s} 挖完线索后铅笔仍须全解（"极小"不等于"推不完"）`);
    // 出货盘的角色必须恰好三选一，且环非空（环空 = 整盘涂黑的退化盘）
    let three = 0;
    for (let i = 0; i < r.board.n; i++) if ((r.board.clue.has(i) ? 1 : 0) + (r.board.black.has(i) ? 1 : 0) + (r.board.loop.has(i) ? 1 : 0) === 1) three++;
    ok(three === r.board.n, `${w}x${h}#${s} 每格恰好一种角色`, `${three}/${r.board.n}`);
    ok(r.board.loop.size >= 4 && r.board.black.size > 0 && r.board.clue.size > 0, `${w}x${h}#${s} 三种角色都在盘上出现（退化盘不许出货）`);
  }
  notes.push(`出货盘 ${w}x${h}：${shipped}/2 过整盘 verify()`);
}

for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 12)) console.log(`  ✗ ${f}`);
console.log(`RESULT rule-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
