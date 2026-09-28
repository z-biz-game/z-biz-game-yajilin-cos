// 穷举计数器（判据 2：成本要由线索引导封住）。逐字符搬自桌面筛探针 `_tmp-yajilin-counter.mjs`（仓外，见 DESIGN §八 末条）。
// 口径：解 = 给每个非线索格定角色（黑 / 环）+ 每个环格恰两条边，满足 grid.js 文件头那四条规则。
// 搜索按行主序推进；环格把边意向写进未定格的 req，于是 req≠0 的格只能是环格。
// 连通性用「开放端计数」封住：一个偏图分支的开放端恰为 2，openTotal 归零即环闭合，此后只许涂黑。
// 回滚一律走「记录旧值」的日志栈（[数组, 下标, 旧值]），不手写逆操作——逆操作写错是静默的。
//
// 出货红线（需求卡第四节）：`stopped`（预算耗尽，没数完）与 `capped`（数到 limit 就收）
// 必须分开返回，**stopped 即整盘作废**，不许写成「≥N 解」糊过去。
import { Board } from './grid.js';

const UNKNOWN = 0, BLACK = 1, LOOP = 2, CLUE = 3;
const OPP = [2, 3, 0, 1]; // DIRS = up right down left
const SHAPE2 = [];
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) SHAPE2.push((1 << a) | (1 << b));
const FIXED_SIDE = (1 << 0) | (1 << 3); // 已定侧 = up | left

export function prepare(board) {
  const n = board.n;
  const clues = [...board.clue.entries()];
  const cover = Array.from({ length: n }, () => []);
  const rayLen = clues.map(([ci, cl]) => board.ray(ci, cl.dir).length);
  clues.forEach(([ci, cl], slot) => { for (const j of board.ray(ci, cl.dir)) cover[j].push(slot); });
  const nb = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / board.w), c = i % board.w;
    nb.push([r > 0 ? i - board.w : -1, c + 1 < board.w ? i + 1 : -1, r + 1 < board.h ? i + board.w : -1, c > 0 ? i - 1 : -1]);
  }
  return { clues, cover, rayLen, nb };
}

export function countSolutions(board, { limit = Infinity, budgetNodes = Infinity, collect = 0 } = {}) {
  const { n } = board;
  const { clues, cover, rayLen, nb } = prepare(board);
  const role = new Int8Array(n);
  const shape = new Int8Array(n);      // 环格选的两侧（用于把解交回给探针验真）
  const req = new Int8Array(n);
  const parent = new Int32Array(n);
  const compOpen = new Int32Array(n);   // 该分支还挂着几条指向未定格的边
  const csize = new Int32Array(n);      // 该分支里有几个环格
  for (let i = 0; i < n; i++) { parent[i] = i; csize[i] = 1; }
  const rem = Int32Array.from(clues.map(([, cl]) => cl.n));
  const undec = Int32Array.from(rayLen);
  const openCnt = new Int32Array(1);

  const order = [];
  for (let i = 0; i < n; i++) {
    if (board.clue.has(i)) { role[i] = CLUE; for (const s of cover[i]) undec[s]--; }
    else order.push(i);
  }
  const m = order.length;
  const st = { nodes: 0, solutions: 0, stopped: false, capped: false };
  const sols = [];
  let loopN = 0;
  const log = [];
  const set = (arr, idx, val) => { log.push([arr, idx, arr[idx]]); arr[idx] = val; };
  const rewind = (mark) => { while (log.length > mark) { const [arr, idx, old] = log.pop(); arr[idx] = old; } };
  // 不带路径压缩：压缩会偷改 parent[]，而回滚日志只认 set() 写过的槽位，
  // 一次压缩就能让已经回滚的分支重新接上——环的连通判定于是两头都不对。
  const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; };

  // 显式快照式计数：任何一步不成立就 rewind 到本步之前，绝不手写逆操作
  function place(i, isBlack) {
    const mark = log.length;
    const list = cover[i];
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      if (isBlack) set(rem, s, rem[s] - 1);
      set(undec, s, undec[s] - 1);
      if (rem[s] < 0 || rem[s] > undec[s]) { rewind(mark); return false; }
    }
    return true;
  }

  let pendingClosure = false;
  function attach(i, dir) {
    const j = nb[i][dir];
    if (j < 0) return false;
    if (role[j] === UNKNOWN) {
      if (board.clue.has(j)) return false;
      set(req, j, req[j] | (1 << OPP[dir]));
      set(compOpen, find(i), compOpen[find(i)] + 1);
      set(openCnt, 0, openCnt[0] + 1);
      return true;
    }
    if (role[j] !== LOOP) return false;
    const ri = find(i), rj = find(j);
    set(compOpen, rj, compOpen[rj] - 1);
    set(openCnt, 0, openCnt[0] - 1);
    if (ri === rj) {
      // 这条边把所在分支连成了一个环。合法当且仅当：全局再无开口，且这个分支装着全部环格。
      // 少任何一半，就是"两条不相交的环同时收口"——上一版只看 openCnt 归零，把这种盘当成了合法解。
      if (openCnt[0] !== 0 || csize[rj] !== loopN) return false;
      pendingClosure = true;
      return true;
    }
    set(compOpen, ri, compOpen[ri] + compOpen[rj]);
    set(csize, ri, csize[ri] + csize[rj]);
    set(parent, rj, ri);
    return true;
  }

  function dfs(pos, closed) {
    if (st.stopped) return;
    if (++st.nodes > budgetNodes) { st.stopped = true; return; }
    if (pos === m) {
      if (closed) {
        st.solutions++;
        if (collect && sols.length < collect) sols.push({ roles: Uint8Array.from(role), shapes: Uint8Array.from(shape) });
      }
      return;
    }
    if (st.solutions >= limit) { st.capped = true; return; }
    const i = order[pos];
    const up = nb[i][0], left = nb[i][3];
    const clashBlack = (up >= 0 && role[up] === BLACK) || (left >= 0 && role[left] === BLACK);
    if (req[i] === 0 && !clashBlack) {
      const mark = log.length;
      role[i] = BLACK;
      if (place(i, true)) dfs(pos + 1, closed);
      rewind(mark);
      role[i] = UNKNOWN;
    }
    if (closed) return;
    const rq = req[i] & FIXED_SIDE;
    for (const s of SHAPE2) {
      if ((s & FIXED_SIDE) !== rq) continue;
      const mark = log.length;
      role[i] = LOOP; shape[i] = s; loopN++;
      pendingClosure = false;
      let ok = place(i, false);
      if (ok) for (let dir = 0; dir < 4 && ok; dir++) if (s & (1 << dir)) ok = attach(i, dir);
      if (ok) dfs(pos + 1, pendingClosure);
      rewind(mark);
      role[i] = UNKNOWN; loopN--;
    }
  }

  dfs(0, false);
  // count 达到 limit 时就只是"≥limit"的下界，不是精确解数——调用方必须看得见这件事
  // stopped = 没数完（预算耗尽）；capped = 数到 limit 就收工。两者都让 count 只作下界用，
  // 但只有 stopped 是缺陷，capped 是拿“是否到 2 个解”判定的正常出口。
  return { count: st.solutions, nodes: st.nodes, stopped: st.stopped, capped: st.capped, sols };
}

// 快照 → 可独立审计的 Board：黑格/环格/环边全部还原，交给 verify() 判真伪
export function materialize(board, snap) {
  const { nb } = prepare(board);
  const b = new Board(board.w, board.h);
  b.clue = new Map(board.clue);
  for (let i = 0; i < board.n; i++) {
    if (snap.roles[i] === BLACK) b.black.add(i);
    else if (snap.roles[i] === LOOP) {
      b.loop.add(i);
      for (let dir = 0; dir < 4; dir++) if (snap.shapes[i] & (1 << dir)) { const j = nb[i][dir]; if (j >= 0 && j < i) b.edges.add(Board.ek(i, j)); }
    }
  }
  return b;
}
