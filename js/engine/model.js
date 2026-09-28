// 规则模型：真值审计器 verify() + 「由解出题」的原始采样器 generate()。
// 逐字符搬自桌面筛探针 `_tmp-yajilin-model.mjs`（verify :56-98、sampleCycle :101-119、generate :121-150），该文件在仓外（DESIGN §八 末条）；
// 以及同一批探针 `_tmp-yajilin-gen.mjs:9` 的 recompute()。规则口径与角色定义写在 grid.js 文件头。
//
// ⚠ 本文件不读环境变量、不碰 node API：引擎要在浏览器里原样跑，
// 剂量表的 attempt/candLimit/loopFracs 参数全部由调用方（剂量表那一套 probe，见 DESIGN §三）显式传。
import { Board, DIRS } from './grid.js';
import { hashSeed, mulberry32 } from './rng.js';

// —— 真值审计器：一条都不许松，判据全靠它兜底 ——
export function verify(b) {
  const errs = [];
  for (let i = 0; i < b.n; i++) {
    const roles = (b.clue.has(i) ? 1 : 0) + (b.black.has(i) ? 1 : 0) + (b.loop.has(i) ? 1 : 0);
    if (roles > 1) errs.push(`cell ${i} 同时是多种角色`);
    if (roles === 0) errs.push(`cell ${i} 既不在环上也不是黑格/线索`);
  }
  for (const i of b.black) for (const j of b.neighbors(i)) if (j > i && b.black.has(j)) errs.push(`黑格相邻 ${i}-${j}`);
  const adj = new Map();
  for (const e of b.edges) {
    const [a, s] = e.split(':').map(Number);
    if (!b.loop.has(a) || !b.loop.has(s)) errs.push(`环边 ${e} 端点不在环上`);
    if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(s)) adj.set(s, new Set());
    adj.get(a).add(s); adj.get(s).add(a);
  }
  for (const i of b.loop) {
    const deg = adj.has(i) ? adj.get(i).size : 0;
    if (deg !== 2) errs.push(`环格 ${i} 度数 ${deg}≠2`);
  }
  // 单一环：从任一环格走，必须走过全部环格才回来
  if (b.loop.size > 0) {
    const startCell = b.loop.values().next().value;
    const seen = new Set([startCell]);
    let prev = -1, cur = startCell;
    while (true) {
      const ns = adj.has(cur) ? [...adj.get(cur)] : [];
      if (ns.length !== 2) { errs.push(`环在 ${cur} 处走不下去`); break; }
      const nxt = ns[0] === prev ? ns[1] : ns[0];
      prev = cur; cur = nxt;
      if (cur === startCell) break;
      if (seen.has(cur)) { errs.push(`环在 ${cur} 处自交`); break; }
      seen.add(cur);
      if (seen.size > b.loop.size) { errs.push('环不闭合/自交'); break; }
    }
    if (cur !== startCell || seen.size !== b.loop.size) errs.push(`环只覆盖 ${seen.size}/${b.loop.size} 格（不是单一环）`);
  }
  for (const [i, cl] of b.clue) {
    let got = 0;
    for (const j of b.ray(i, cl.dir)) if (b.black.has(j)) got++;
    if (got !== cl.n) errs.push(`线索 ${i}(${DIRS[cl.dir].name},${cl.n}) 实数 ${got}`);
  }
  return errs;
}

// —— 由解出题：先采一条环，再把环外贪心取极大独立集当黑格，剩下的环外格只能当线索 ——
function sampleCycle(b, rnd, targetLen, attempts) {
  let best = null;
  for (let a = 0; a < attempts; a++) {
    const start = Math.floor(rnd() * b.n);
    const path = [start]; const onPath = new Set([start]);
    let cur = start;
    while (path.length < targetLen) {
      const ns = b.neighbors(cur).filter((x) => !onPath.has(x));
      if (!ns.length) break;
      const nxt = ns[Math.floor(rnd() * ns.length)];
      path.push(nxt); onPath.add(nxt); cur = nxt;
    }
    if (path.length < 4) continue;
    if (!b.neighbors(cur).includes(start)) continue;
    if (!best || path.length > best.length) best = path.slice();
    if (best.length >= targetLen) break;
  }
  return best;
}

// 数字永远是「当前黑格集合在射线上的实际个数」，改一格箭头就要全表重算（_tmp-yajilin-gen.mjs:9）。
export function recompute(board) {
  for (const [i, cl] of board.clue) {
    let n = 0;
    for (const j of board.ray(i, cl.dir)) if (board.black.has(j)) n++;
    cl.n = n;
  }
}

// 原始「解 → 题面」采样器。出货路径上它只负责**画一张解 + 一个能自证的初始箭头集**，
// 箭头的方向/数字到这里为止还是随机的（见下面 :rnd 那一行）——
// ⚠ 需求卡第三节坑 1：同一张解配「随机方向」和「为铅笔挑的方向」是两道不同的题，
//   前者 6x6 推满率只有 1/6。所以**出货盘的箭头方向一律由 generate.js 的 pSet 贪心挑**，
//   这里抽出来的方向只是搜索起点，没有任何一张盘会带着它出货。
// ⚠ loopFrac 的默认值 0.62 是判据探针的原样默认，不是出货密度：
//   出货策略 [0.45,0.5,0.55] 写在 generate.js 的 DEFAULT_LOOP_FRACS，调用方必须显式传。
export function generate(seed, w, h, { loopFrac = 0.62, attempts = 4000 } = {}) {
  const rnd = mulberry32(hashSeed(seed));
  const b = new Board(w, h);
  const target = Math.max(8, Math.round(w * h * loopFrac));
  // 环长必须是偶数：格图二分，环在两色间交替
  let path = sampleCycle(b, rnd, target % 2 ? target + 1 : target, attempts);
  if (!path) return { ok: false, status: 'NO_CYCLE' };
  for (let i = 0; i < path.length; i++) b.loop.add(path[i]);
  for (let i = 0; i < path.length; i++) b.edges.add(Board.ek(path[i], path[(i + 1) % path.length]));
  const off = [];
  for (let i = 0; i < b.n; i++) if (!b.loop.has(i)) off.push(i);
  for (let i = off.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [off[i], off[j]] = [off[j], off[i]]; }
  // 先定角色（黑 = 环外贪心极大独立集，其余环外格只能当线索），**再**统一算射线数字：
  // 数字必须在黑格集合定下来之后才算，否则后面新添的黑格会让已写下的线索变成假话。
  const pending = [];
  for (const i of off) {
    const touchesBlack = b.neighbors(i).some((j) => b.black.has(j));
    if (!touchesBlack) b.black.add(i);
    else pending.push(i);
  }
  for (const i of pending) {
    const dirs = [0, 1, 2, 3].filter((d) => b.ray(i, d).length > 0);
    const dir = dirs[Math.floor(rnd() * dirs.length)];
    let n = 0; for (const j of b.ray(i, dir)) if (b.black.has(j)) n++;
    b.clue.set(i, { dir, n });
  }
  const errs = verify(b);
  if (errs.length) return { ok: false, status: 'SELF_INVALID', errs: errs.slice(0, 8) };
  return { ok: true, board: b, loopLen: b.loop.size, blacks: b.black.size, clues: b.clue.size };
}
