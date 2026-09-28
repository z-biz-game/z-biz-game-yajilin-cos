// 题面适配器：把引擎的 shipBoard(seed, w, h) 接成界面要的那副形状。
//
// 这里**一条规则都没有**：出题、认证、判定全部住在 js/engine/，本文件只做三件事——
//   1) 调 engine/generate.js 的 shipBoard（seed→盘 是纯函数），把结果原样留着；
//   2) 用 engine/grid.js 的 Board 类另拷一份**只带箭头**的题面（question）。
//      出货盘上那份 board 带着计数器认证过的解（black/loop/edges），它是答案，
//      只许 harness 读一次，玩家那条路（渲染/落笔/判胜）一律只看 question 的箭头。
//   3) 算一个指纹：题面的箭头逐条编码后交给 engine/rng.js 的 hashSeed。
//      存档靠它对账（js/store.js），对不上就不搬旧笔迹。
import { Board } from '../engine/grid.js';
import { hashSeed } from '../engine/rng.js';
import { shipBoard, TIERS } from '../engine/generate.js';

export { TIERS };

// 菜单＝TIERS 里 inMenu 的那几档（尺寸仍只有一份，别让界面自己数一套；12×12 在表里但不在菜单里）
export const SIZES = TIERS.filter((t) => t.inMenu).map((t) => t.key);

// parseSize 却按**整张 TIERS** 解析：降出菜单的那一档不再能新开，但玩家存档里那一局照旧续得上
// （把它夹到 6×6 的话，界面会说谎——seed 是 12×12 那颗、盘却换了，笔迹全被指纹对账丢掉）。
export function parseSize(key) {
  const t = TIERS.find((x) => x.key === key) || TIERS.find((x) => x.inMenu);
  return { w: t.w, h: t.h, key: t.key };
}

export function fingerprintOf(question) {
  const parts = [];
  for (const [i, cl] of [...question.clue.entries()].sort((a, b) => a[0] - b[0])) parts.push(`${i}:${cl.dir}:${cl.n}`);
  return `${hashSeed(parts.join('|')).toString(16)}-${question.w}x${question.h}-${question.clue.size}`;
}

// 默认出题参数：引擎里的 DEFAULT_* 就是出货口径，界面上一个都不改。
// 「换一局」允许再敲一颗 seed：撞满 maxAttempts=60 时 shipBoard 如实返回 NO_BOARD，而 12×12
// 观测到的最坏 attempts 已经到 55/60（复跑口径与逐样本读数在 README 第五节那条「不承诺最坏」）。
// 调用方给了明确 seed 时**不许**偷偷换——
// 门禁与存档靠的就是「同一个 seed 同一张盘」这句话。
export function makeQuestion(seed, sizeKey, opts = {}) {
  const { w, h } = parseSize(sizeKey);
  const r = shipBoard(seed, w, h, opts);
  if (!r.ok) return r;
  const question = new Board(w, h);
  question.clue = new Map(r.board.clue);
  return {
    ok: true,
    seed: String(seed),
    sizeKey,
    w,
    h,
    question,
    solution: r.board, // ← 答案。产品代码里没有任何一处读它
    fingerprint: fingerprintOf(question),
    clues: question.clue.size,
    stats: { attempts: r.attempts, nodes: r.nodes, rounds: r.rounds, removed: r.removed, dead: r.dead },
  };
}
