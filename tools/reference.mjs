// 独立暴力枚举器（**只在测试里用**，node 侧；引擎路径上一行都不许碰它）。
// 逐字符搬自 workspace 根的判据探针 _tmp-yajilin-probe.mjs:10-55（bruteCount + hamCycles）。
//
// 为什么测试要养一台这么慢的机器：DP 计数器（js/engine/counter.js）和它是**两条完全不同的路**——
// 这里先把非线索格的黑/非黑子集整个枚举掉（2^free），射线计数过了才在剩下的点集上
// 独立枚举哈密顿环。两条路数出同一个数字，才算「计数器没有把合法解丢掉、也没有凭空多算」。
// 需求卡第二节把这条证据链叫 `AGREE / MISMATCH 0 / ZERO-BUT-SOLVABLE 0`。
//
// 代价：指数级。free > maxFree 就直接返回 null（调用方必须看得见"这一盘没比成"，不许当通过）。

import { Board } from '../js/engine/grid.js';

// loop 点集上的哈密顿环计数：固定最小编号格为起点，有向环数 /2
export function hamCycles(board, loop, loopSet) {
  if (loop.length < 4) return 0;
  const start = Math.min(...loop);
  const onPath = new Set([start]);
  const path = [start];
  let directed = 0;
  (function walk(v) {
    if (path.length === loop.length) { if (board.neighbors(v).includes(start)) directed++; return; }
    for (const w of board.neighbors(v)) {
      if (!loopSet.has(w) || onPath.has(w)) continue;
      onPath.add(w); path.push(w); walk(w); path.pop(); onPath.delete(w);
    }
  })(start);
  return directed / 2;
}

// 全枚举：黑格子集 + 剩下的点集上的哈密顿环条数
export function bruteCount(board, { maxFree = 24 } = {}) {
  const free = [];
  for (let i = 0; i < board.n; i++) if (!board.clue.has(i)) free.push(i);
  if (free.length > maxFree) return null;
  const rays = [...board.clue.entries()].map(([ci, cl]) => board.ray(ci, cl.dir));
  const want = [...board.clue.values()].map((cl) => cl.n);
  let total = 0, masks = 0;
  const lim = 1 << free.length;
  for (let mask = 0; mask < lim; mask++) {
    masks++;
    const black = new Set();
    let bad = false;
    for (let k = 0; k < free.length; k++) if (mask & (1 << k)) black.add(free[k]);
    for (let k = 0; k < free.length && !bad; k++) if (mask & (1 << k)) {
      const c = free[k];
      for (const d of board.neighbors(c)) if (d > c && black.has(d)) { bad = true; break; }
    }
    if (bad) continue;
    let rayOK = true;
    for (let s = 0; s < rays.length && rayOK; s++) {
      let got = 0; for (const j of rays[s]) if (black.has(j)) got++;
      if (got !== want[s]) rayOK = false;
    }
    if (!rayOK) continue;
    const loop = free.filter((c) => !black.has(c));
    if (loop.length < 4) continue;
    total += hamCycles(board, loop, new Set(loop));
  }
  return { total, masks };
}

// 把一张题面（只有 clue）还原成 Board，供上面两台机器共用
export function boardOf(w, h, clues) {
  const b = new Board(w, h);
  for (const [i, dir, n] of clues) b.clue.set(i, { dir, n });
  return b;
}
