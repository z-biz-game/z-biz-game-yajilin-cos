// 盘面骨架：方向表 + Board（每格恰好三种角色之一：箭头 / 黑格 / 环格）。
// 逐字符搬自桌面筛探针 `_tmp-yajilin-model.mjs:8-13`（DIRS）与 :29-53（Board），该文件在仓外（DESIGN §八 末条）。
// 这一层**不含任何规则判定**——规则的真值审计器在 model.js 的 verify() 里。
// 角色口径（三家原文对齐，无灰格版，见需求卡第一节）：
//   1) 盘面每格恰好三种角色之一：环上格 / 黑格 / 线索格（箭头+数字）；
//   2) 环 = 一条不自交的正交闭合环，穿过**所有**非黑非线索格（Puzzle Wiki 的严格读法）；
//   3) 黑格之间不得正交相邻；
//   4) 线索 (格, 方向, N)：该方向射线（不含线索格自己，一直到盘边）上的黑格数 = N。

export const DIRS = [
  { name: 'up', dr: -1, dc: 0 },
  { name: 'right', dr: 0, dc: 1 },
  { name: 'down', dr: 1, dc: 0 },
  { name: 'left', dr: 0, dc: -1 },
];

export class Board {
  constructor(w, h) {
    this.w = w; this.h = h; this.n = w * h;
    this.clue = new Map();   // id -> {dir:0..3, n:int}
    this.black = new Set();  // ids
    this.loop = new Set();   // ids
    this.edges = new Set();  // "a:b" a<b
  }
  id(r, c) { return r * this.w + c; }
  rc(i) { return [Math.floor(i / this.w), i % this.w]; }
  inBounds(r, c) { return r >= 0 && r < this.h && c >= 0 && c < this.w; }
  neighbors(i) {
    const [r, c] = this.rc(i), out = [];
    for (const d of DIRS) { const rr = r + d.dr, cc = c + d.dc; if (this.inBounds(rr, cc)) out.push(this.id(rr, cc)); }
    return out;
  }
  static ek(a, b) { return a < b ? a + ':' + b : b + ':' + a; }
  // 射线：从 id 沿 dir 走到盘边，不含 id 自己
  ray(id, dir) {
    const [r0, c0] = this.rc(id); const d = DIRS[dir]; const out = [];
    for (let k = 1; ; k++) { const rr = r0 + d.dr * k, cc = c0 + d.dc * k; if (!this.inBounds(rr, cc)) break; out.push(this.id(rr, cc)); }
    return out;
  }
  degree(i) { let deg = 0; for (const e of this.edges) { const [a, b] = e.split(':').map(Number); if (a === i || b === i) deg++; } return deg; }
}
