// 出货流水线（判据 1 + 判据 2 的合流）。逐字符搬自 _tmp-yajilin-pgen.mjs：
//   actions()      :18-40   一次候选动作（换方向 / 黑格↔箭头互转），undo 自带
//   pSet()         :42-63   贪心给铅笔挑箭头方向
//   pDig()         :66-93   极小化：删一条箭头要「铅笔仍全解 ∧ 计数器仍说唯一」两条都过
//   makePencilBoard():95-117 出货一张盘（含换环重试）
//
// 与探针唯一的差别是**默认值口径**（需求卡第四节）：
//   探针里 maxAttempts / candLimit / loopFracs 的默认值来自环境变量，
//   引擎里一个都不读——测量口径由调用方（tools/generator-probe.mjs）显式传参，
//   引擎里一个环境变量都不读，默认值就是**出货策略**本身：loopFracs = [0.45, 0.5, 0.55]、ATTEMPTS = 60。
//
// ⚠ 必须披露的短板 2（需求卡第五节坑 2）：**出题器自记的解会说谎**。
//   补箭头/挖箭头都会改格子角色，board.black 跟不上——修复前实测 8×8 出货盘 0/6、6×6 1/6
//   的自带解连 verify() 都过不了，而唯一性闸门全是绿的。
//   ⇒ 出货盘上的 black/loop/edges 一律用穷举计数器认证过的那一张**覆盖**（见下面 CERTIFIED 那段），
//     覆盖之后再对整盘跑一次 verify()；任何一步不过就把整盘作废。永远不要把出题器自己跟的那份当答案。
// ⚠ 必须披露的短板 3（需求卡第五节）：**12×12 的题面比印刷题密**——实测 44 条箭头 + 32 黑格 / 144 格
//   （箭头占 31%，Nikoli 印刷题量级在 15% 上下）。这是「零猜测可推完」买来的代价，
//   档位表要按实测箭头数标注，不许说成「标准 Yajilin 密度」。
import { generate, verify, recompute } from './model.js';
import { countSolutions, materialize } from './counter.js';
import { pencil } from './pencil.js';

const UNK = 0, BLACK = 1, LOOP = 2, CLUE = 3;

// —— 出货策略的默认值（不是探针参数，改了就等于改了出货口径）——
export const DEFAULT_LOOP_FRACS = [0.45, 0.5, 0.55];
export const DEFAULT_MAX_ATTEMPTS = 60;   // 换一局重试上限；封顶仍 PLATEAU 就是不出货，不是硬凑
export const DEFAULT_CAND_LIMIT = 12;
export const DEFAULT_MAX_ROUNDS = 60;
export const DIG_BUDGET_NODES = 400_000;  // pDig 每次「删一颗」的唯一性复核预算
export const CERT_BUDGET_NODES = 5_000_000; // 最终认证计数的节点预算：超了就 stopped ⇒ 整盘作废

// 四档菜单（剂量表与 golden 共用这一份，别让两处各写一遍尺寸）
export const TIERS = [
  { key: '6x6', w: 6, h: 6 },
  { key: '8x8', w: 8, h: 8 },
  { key: '10x10', w: 10, h: 10 },
  { key: '12x12', w: 12, h: 12 },
];

const scoreOf = (p) => p.rolesDone * 2 + p.edgesDone;

// 一次动作：换方向 / 撤箭头改黑格 / 黑格改箭头。undo 自己带，不手写逆操作。
function actions(board, p, { candLimit = DEFAULT_CAND_LIMIT } = {}) {
  const acts = [];
  const unkCells = [];
  for (let i = 0; i < board.n; i++) if (p.role[i] === UNK) unkCells.push(i);
  const pick = unkCells.slice(0, candLimit);
  for (const c of pick) {
    if (board.loop.has(c)) continue;
    if (board.clue.has(c)) {
      for (let d = 0; d < 4; d++) if (board.ray(c, d).length) {
        const old = board.clue.get(c);
        acts.push({ apply: () => board.clue.set(c, { dir: d, n: 0 }), undo: () => board.clue.set(c, old), kind: 'dir', cluesDelta: 0 });
      }
      if (!board.neighbors(c).some((j) => board.black.has(j))) {
        acts.push({ apply: () => { board.clue.delete(c); board.black.add(c); }, undo: () => { board.black.delete(c); board.clue.set(c, old); }, kind: 'to-black', cluesDelta: -1 });
      }
    } else if (board.black.has(c)) {
      for (let d = 0; d < 4; d++) if (board.ray(c, d).length) {
        acts.push({ apply: () => { board.black.delete(c); board.clue.set(c, { dir: d, n: 0 }); }, undo: () => { board.clue.delete(c); board.black.add(c); }, kind: 'to-clue', cluesDelta: 1 });
      }
    }
  }
  return acts;
}

// 贪心给铅笔挑方向：每轮跑一遍铅笔，从没推定的格里挑动作，留下「推进最多、箭头最少」的那个。
// 合法性：箭头只能落在环外的格上（环不动 ⇒ 解仍成立）；箭头转回黑格要求它不挨着任何黑格。
// PLATEAU / UNSOUND_PENCIL / ROUND_LIMIT 都是**废盘信号**，调用方必须重试而不是将就出货。
export function pSet(board, { maxRounds = DEFAULT_MAX_ROUNDS, candLimit = DEFAULT_CAND_LIMIT } = {}) {
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const p = pencil(board);
    if (p.contradiction) return { status: 'UNSOUND_PENCIL', why: p.contradiction, rounds, clues: board.clue.size };
    if (p.solved) return { status: 'PENCIL_SOLVED', rounds, clues: board.clue.size, fired: p.fired };
    const base = scoreOf(p);
    let best = null, bestScore = base, bestTie = Infinity;
    for (const a of actions(board, p, { candLimit })) {
      a.apply(); recompute(board);
      const q = pencil(board);
      recompute(board); a.undo();
      if (q.contradiction) continue;
      const s = scoreOf(q);
      const tie = a.cluesDelta + board.clue.size * 0.001;
      if (s > bestScore || (s === bestScore && tie < bestTie)) { best = a; bestScore = s; bestTie = tie; }
    }
    if (!best || bestScore <= base) return { status: 'PLATEAU', rounds, clues: board.clue.size, score: base, need: board.n * 2 + 1 };
    best.apply(); recompute(board);
  }
  return { status: 'ROUND_LIMIT', rounds, clues: board.clue.size };
}

// 极小化：删一条线索后，铅笔必须仍全解，且计数器必须仍说「唯一」（两条都过才留）
export function pDig(board, { budgetNodes = DIG_BUDGET_NODES, passes = 4 } = {}) {
  let removed = 0, tried = 0, over = 0, unsound = 0;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const i of [...board.clue.keys()]) {
      if (!board.clue.has(i)) continue;
      const cl = board.clue.get(i);
      board.clue.delete(i);
      board.black.add(i);
      if (!board.neighbors(i).some((j) => board.black.has(j))) {
        // 撤箭头 = 那格回到黑格，先确认这样仍有唯一解且铅笔还能全解
        recompute(board);
        tried++;
        const p = pencil(board);
        const c = p.solved ? countSolutions(board, { limit: 2, budgetNodes }) : { count: 0, stopped: true };
        if (c.stopped) over++;
        if (p.contradiction) unsound++;
        if (p.solved && !p.contradiction && c.count === 1) { removed++; changed = true; }
        else { board.black.delete(i); board.clue.set(i, cl); recompute(board); }
      } else {
        board.black.delete(i);
        board.clue.set(i, cl);
      }
    }
    if (!changed) break;
  }
  return { removed, tried, over, unsound };
}

// 出货一张盘：换环重试直到「铅笔全解 ∧ 计数器认证唯一 ∧ verify() 全绿」三关都过。
// 返回里的 dead 是废因账本（PLATEAU / UNSOUND_PENCIL / ROUND_LIMIT / COUNTER / BAD / NO_CYCLE…），
// 需求卡第二节把「推满失败的盘数」当选择性的证据，所以它必须一路带出去。
export function makePencilBoard(tag, w, h, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  candLimit = DEFAULT_CAND_LIMIT,
  loopFracs = DEFAULT_LOOP_FRACS,
  digBudgetNodes = DIG_BUDGET_NODES,
  certBudgetNodes = CERT_BUDGET_NODES,
} = {}) {
  const dead = {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const g = generate(`${tag}-a${attempt}`, w, h, { loopFrac: loopFracs[attempt % loopFracs.length] });
    if (!g.ok) { dead[g.status] = (dead[g.status] || 0) + 1; continue; }
    const b = g.board;
    const natural = b.clue.size;
    const ps = pSet(b, { candLimit });
    if (ps.status !== 'PENCIL_SOLVED') { dead[ps.status] = (dead[ps.status] || 0) + 1; continue; }
    if (pencil(b).contradiction) { dead.UNSOUND = (dead.UNSOUND || 0) + 1; continue; }
    const mid = b.clue.size;
    const dg = pDig(b, { budgetNodes: digBudgetNodes });
    // 唯一性还是要用计数器独立认证一次：铅笔全解是「推得动」，计数器说「只有这一个」
    const fin = countSolutions(b, { limit: Infinity, budgetNodes: certBudgetNodes, collect: 1 });
    // stopped = 预算耗尽、根本没数完 ⇒ 整盘作废。不许把 count===1 写成「≥1 解」糊过去。
    if (fin.count !== 1 || fin.stopped || !fin.sols.length) { dead.COUNTER = (dead.COUNTER || 0) + 1; continue; }
    const sol = materialize(b, fin.sols[0]);
    if (verify(sol).length) { dead.BAD = (dead.BAD || 0) + 1; continue; }
    // —— CERTIFIED：出货盘的 black/loop/edges **必须是计数器那张**，见文件头坑 2 ——
    b.black = sol.black; b.loop = sol.loop; b.edges = sol.edges;
    const pf = pencil(b);
    return { ok: true, board: b, natural, mid, clues: b.clue.size, attempts: attempt + 1, rounds: ps.rounds, removed: dg.removed, tried: dg.tried, over: dg.over, nodes: fin.nodes, stillSolved: pf.solved, fired: pf.fired, passes: pf.passes, steps: pf.steps, dead };
  }
  return { ok: false, dead };
}

// 界面「换一局」的那一侧：seed → 盘是纯函数（重试序列 = `${seed}-a${attempt}`，
// 换一局 = seed+1）。判定路径上没有随机数、也没有当前时间。
// 失败时把 status='NO_BOARD' 如实交回，由界面决定再敲下一颗 seed——不许静默改 seed。
export function shipBoard(seed, w, h, opts = {}) {
  const r = makePencilBoard(String(seed), w, h, opts);
  if (!r.ok) return { ok: false, status: 'NO_BOARD', seed, dead: r.dead };
  return r;
}
