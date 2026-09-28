// 对局状态。这一层**不含一条 Yajilin 规则**：它只把玩家的落笔写进两张表——
//   role[i]  每格：UNK / BLACK（玩家涂的黑）/ CLUE（题面给定的箭头格，改不动）
//   ed[i][d] 每条边：E_UNK / E_ON（画的环段）/ E_OFF（画的排除叉），界外的边一上来就记成 E_OFF
// 两张表的取值就是引擎 js/engine/pencil.js 导出的 ROLE / EDGE（文件注释里点名要轮 2 的画布按它上色），
// 本文件不另立第二套字面量。「环上格」不在表里：它是**从画下的边推出来的**，
// 所以 UI 永远不可能在「我标了它在环上」和「环根本没连到它」之间各说一套。
//
// 判胜只有一条路：board() 把这两张表装成 engine/grid.js 的 Board，交给 engine/model.js 的 verify()。
// verify 返回空数组就是赢。这里没有记分板、没有「差一点就对了」的安慰判定。
//
// 铅笔层同理：结论全部来自 engine/pencil.js 对**题面**（只有箭头）跑出来的事件流水 this.ladder，
// 本文件只做两件事——把已经反映在盘上的事件跳过去、把下一条经 setRole/setEdge 落下去。
// 落下去的那一笔和玩家自己拖的一笔在撤销栈、moves、渲染上是同一条路，没有旁路。
import { Board, DIRS } from '../engine/grid.js';
import { verify } from '../engine/model.js';
import { prepare } from '../engine/counter.js';
import { pencil, ROLE, EDGE, RULES } from '../engine/pencil.js';

export { Board, DIRS, ROLE, EDGE, RULES };
export const UNK = ROLE.UNK;
export const BLACK = ROLE.BLACK;
export const LOOPR = ROLE.LOOP; // 环上格：board() 里由画下的边推出，玩家笔表里没有这一态
export const CLUE = ROLE.CLUE;
export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;
export const E_UNK = EDGE.E_UNK;
export const E_ON = EDGE.E_ON;
export const E_OFF = EDGE.E_OFF;
export const CANON = [RIGHT, DOWN]; // 每条无向边只从这两侧各记一次/各画一次
export const DIR_NAME = { [UP]: '上', [RIGHT]: '右', [DOWN]: '下', [LEFT]: '左' };

// 规则原句：KEY 用的是 engine/pencil.js 的 RULES 字符串本身（改名就等于作废历史读数）。
// 这里是**给人看的一句话**，判定与推导一条都不靠它——引擎说哪条，这里就念哪条。
export const RULE_TEXT = {
  'P1-zero-ray': '箭头是 0：这条射线上一个黑格都没有，全是环格',
  'P2-ray-full': '箭头还差 k 个黑格、射线上只剩 k 格未定：那 k 格全是黑格',
  'P3-ray-empty': '箭头要的黑格已经数齐：射线剩下的格全是环格',
  'P4-black-neighbors': '黑格四邻必须上环，指进黑格/箭头格的边全部断掉',
  'P5-degree': '环格恰好两条边：够了就断掉余边，只剩一条候选就把它连上',
  'P6-no-subtour': '连上就提前闭环、而还有必上环的格没进环：这条边断掉',
  'P7-subtract': '同线同向两个箭头相减：两箭头之间那段的黑格数就定了',
  'P8-pinch': '射线未定格恰 2N−1 且要 N 个互不相邻的黑格：只能 1、3、5 交替涂黑',
  'P9-no-room': '能下边的邻居不足两个：这一格上不了环，只能涂黑',
  'P10-cut-vertex': '环是一整条，不能被掐断：涂黑它会隔开必上环的格，那它只能在环上',
};

// 存档字符表：前 n 个字符是格（'0' 没落笔 / '1' 黑格），后 E 个字符是边（'0'/'1' 环段 / '2' 排除叉）。
export const CELL_CHAR = { [UNK]: '0', [BLACK]: '1' };
export const EDGE_CHAR = { [E_UNK]: '0', [E_ON]: '1', [E_OFF]: '2' };

export class Game {
  constructor(puzzle) {
    if (!puzzle || !puzzle.ok) throw new Error('拿不到题面，开不了局');
    this.puzzle = puzzle;
    this.seed = puzzle.seed;
    this.sizeKey = puzzle.sizeKey;
    this.w = puzzle.w;
    this.h = puzzle.h;
    this.n = puzzle.w * puzzle.h;
    // 题面：只有箭头的 Board（engine/grid.js 的类）。渲染、寻边、射线全部经它，不自己算几何。
    this.question = puzzle.question;
    // 方向索引的邻接表取自 engine/counter.js 的 prepare()：nb[cell][d] 出盘就是 -1。
    // ⚠ 不能用 Board.neighbors(i)——它把出盘的邻居**筛掉**了，返回的是压紧的数组，
    // 边角格上 neighbors(i)[d] 会指到隔壁方向去（那是「画对了、点偏一格」这一类事故的根）。
    // counter.js 与 pencil.js 用的都是 prepare 的 nb，所以笔表与引擎判定看到的是同一张邻接表。
    this.nb = prepare(this.question).nb;
    // 玩家笔表（与 pencil() 的输出同形，所以两套读数可以直接叠在一起比）
    this.role = new Int8Array(this.n);
    this.ed = [];
    for (let i = 0; i < this.n; i++) {
      const row = new Int8Array(4);
      for (let d = 0; d < 4; d++) if (this.neighbor(i, d) < 0) row[d] = E_OFF; // 界外=断，与 pencil.js:35 同一口径
      this.ed.push(row);
    }
    for (const i of this.question.clue.keys()) this.role[i] = CLUE;
    this.undoStack = [];
    this._group = null;
    this.moves = 0;
    // 铅笔层：引擎对题面的一次推导（不回溯、不猜）。答案一个字节都没进来——pencil() 只吃箭头。
    const p = pencil(this.question);
    this.ladder = p.events.filter((e) => e.kind === 'edge' || (e.kind === 'role' && e.v === BLACK));
    this.ladderAll = p.events.length;
    this.ladderSolved = p.solved;
    this.ladderFired = p.fired;
    this.ladderTelemetry = { rolesDone: p.rolesDone, edgesDone: p.edgesDone, edgeTotal: p.edgeTotal, passes: p.passes, steps: p.steps };
    this.ghost = new Map(); // key -> 铅笔落下的那个值；玩家在同一处自己改过就把它顶掉
  }

  // ── 几何（一律经引擎的 Board，本文件不重算索引）───────────────────────────
  neighbor(cell, d) {
    return d >= 0 && d < 4 ? this.nb[cell][d] : -1;
  }

  dirTo(from, to) {
    return this.nb[from].indexOf(to);
  }

  inside(r, c) {
    return this.question.inBounds(r, c);
  }

  cellOf(r, c) {
    return this.question.id(r, c);
  }

  cellRC(cell) {
    return this.question.rc(cell);
  }

  isClue(cell) {
    return this.question.clue.has(cell);
  }

  clueAt(cell) {
    return this.question.clue.get(cell) || null;
  }

  edges() {
    const out = [];
    for (let cell = 0; cell < this.n; cell++) {
      for (const d of CANON) {
        const nb = this.neighbor(cell, d);
        if (nb >= 0) out.push([cell, d]);
      }
    }
    return out;
  }

  edgeCount() {
    return (this.w - 1) * this.h + (this.h - 1) * this.w;
  }

  edgeKey(cell, d) {
    const nb = this.neighbor(cell, d);
    return nb < 0 ? null : Board.ek(cell, nb);
  }

  // ── 落笔的唯一入口 ────────────────────────────────────────────────────────
  // 三条玩家路（拖拽、右键、键盘）与提示都过这里，所以撤销栈与 moves 记的就是玩家干的活。
  // 不在手势里 = 自己就是一组；在手势里 = 并进 beginGesture/endGesture 这一组。
  setEdge(cell, d, v, by = 'pen') {
    const nb = this.neighbor(cell, d);
    if (nb < 0) return null; // 那里根本没有边（出盘了）
    const e = this.edgeKey(cell, d);
    const prev = this.ed[cell][d];
    if (prev === v) return null;
    this.ed[cell][d] = v;
    // 无向边只有一份真值：另一侧的读数跟着走，免得 render 与 hit 读到两张表
    this.ed[nb][Game.opp(d)] = v;
    const rec = { kind: 'edge', e, cell, d, prev, v, by };
    this._track(rec, by);
    return rec;
  }

  static opp(d) {
    return [DOWN, LEFT, UP, RIGHT][d];
  }

  setRole(cell, v, by = 'pen') {
    if (this.isClue(cell)) return null; // 箭头格是题面，改不动（这不是规则推理，是给定条件）
    if (v === LOOPR || v === CLUE) return null; // 环上格由边推出，笔表里没有这一态
    const prev = this.role[cell];
    if (prev === v) return null;
    this.role[cell] = v;
    const rec = { kind: 'role', e: `c${cell}`, cell, prev, v, by };
    this._track(rec, by);
    return rec;
  }

  _track(rec, by) {
    if (by === 'hint') this.ghost.set(rec.e, rec.v);
    else this.ghost.delete(rec.e); // 玩家在同一处自己落了笔，那条铅笔结论就不再是「铅笔的」
    if (this._group) this._group.push(rec);
    else {
      this.undoStack.push([rec]);
      this.moves++;
    }
  }

  // 排除叉在「叉」和「没落笔」之间来回：右键那一下走这里。E_ON 时也一步变成叉
  //（这条我原先画错了，现在排除），撤销照旧能退回环段。
  toggleCut(cell, d) {
    const cur = this.ed[cell] ? this.ed[cell][d] : E_OFF;
    if (this.neighbor(cell, d) < 0) return null;
    return this.setEdge(cell, d, cur === E_OFF ? E_UNK : E_OFF);
  }

  toggleBlack(cell) {
    return this.setRole(cell, this.role[cell] === BLACK ? UNK : BLACK);
  }

  beginGesture() {
    this._group = [];
  }

  endGesture() {
    const g = this._group || [];
    this._group = null;
    if (!g.length) return false;
    this.undoStack.push(g);
    this.moves++;
    return true;
  }

  // 擦掉一格：黑格回到没落笔，四条边一起回到 E_UNK。
  // 四向都要过（不是只过 CANON）：左边那条边的真值住在邻居的 RIGHT 槽里，
  // 只擦本格右侧两条边就会留下「这一格擦了、邻居那条还连着」。同一条边被写第二遍时
  // setEdge 发现值没变，返回 null，所以一笔仍然只记一步。
  eraseAt(cell) {
    let touched = 0;
    for (let d = 0; d < 4; d++) if (this.setEdge(cell, d, E_UNK)) touched++;
    if (this.setRole(cell, UNK)) touched++;
    return touched;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return false;
    for (let i = g.length - 1; i >= 0; i--) {
      const rec = g[i];
      if (rec.kind === 'role') this.role[rec.cell] = rec.prev;
      else {
        this.ed[rec.cell][rec.d] = rec.prev;
        const nb = this.neighbor(rec.cell, rec.d);
        if (nb >= 0) this.ed[nb][Game.opp(rec.d)] = rec.prev;
      }
      if (rec.by === 'hint') this.ghost.delete(rec.e);
    }
    this.moves++;
    return true;
  }

  clearAll() {
    const recs = [];
    for (let cell = 0; cell < this.n; cell++) {
      if (this.role[cell] === BLACK) {
        const r = this.setRole(cell, UNK);
        if (r) recs.push(r);
      }
      for (const d of CANON) {
        const r = this.setEdge(cell, d, E_UNK);
        if (r) recs.push(r);
      }
    }
    this.moves++;
    return recs.length;
  }

  // ── 读数（纯计数，不推理）──────────────────────────────────────────────────
  degree(cell) {
    let n = 0;
    for (let d = 0; d < 4; d++) if (this.ed[cell][d] === E_ON) n++;
    return n;
  }

  loopEdges() {
    const out = [];
    for (const [cell, d] of this.edges()) if (this.ed[cell][d] === E_ON) out.push(Board.ek(cell, this.neighbor(cell, d)));
    return out;
  }

  offEdges() {
    const out = [];
    for (const [cell, d] of this.edges()) if (this.ed[cell][d] === E_OFF) out.push(Board.ek(cell, this.neighbor(cell, d)));
    return out;
  }

  blackCells() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.role[i] === BLACK) out.push(i);
    return out;
  }

  // 度数 ≥3：一条简单环在这一格接不通。这条只是计数，判胜与它无关。
  badCells() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.degree(i) >= 3) out.push(i);
    return out;
  }

  endpoints() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.degree(i) === 1) out.push(i);
    return out;
  }

  // ── 装成引擎的 Board，交给 verify() ────────────────────────────────────────
  // 「没画环段又不是黑格」的格就留在三个角色之外——那是题面还没做完，
  // verify() 会照直说「既不在环上也不是黑格/线索」。补什么、怎么补，UI 一概不管。
  board() {
    const b = new Board(this.w, this.h);
    b.clue = new Map(this.question.clue);
    for (let i = 0; i < this.n; i++) if (this.role[i] === BLACK) b.black.add(i);
    for (const [cell, d] of this.edges()) {
      if (this.ed[cell][d] !== E_ON) continue;
      const nb = this.neighbor(cell, d);
      b.edges.add(Board.ek(cell, nb));
      b.loop.add(cell);
      b.loop.add(nb);
    }
    return b;
  }

  status() {
    const errs = verify(this.board());
    return { ok: errs.length === 0, errs, count: errs.length };
  }

  // ── 铅笔层 ─────────────────────────────────────────────────────────────────
  // 找第一条「还没反映在盘上」的引擎结论。已经一样 → 跳过；被玩家写成了相反的那一态 → 冲突，
  // 不落笔、照直说。这里不判断哪条结论更该先给：顺序就是 pencil() 自己的推进顺序。
  nextLadder() {
    for (let k = 0; k < this.ladder.length; k++) {
      const ev = this.ladder[k];
      if (ev.kind === 'role') {
        if (this.role[ev.i] !== ev.v) return { index: k, ev, state: this.role[ev.i] === UNK ? 'open' : 'conflict' };
      } else {
        const cur = this.ed[ev.i] ? this.ed[ev.i][ev.d] : E_OFF;
        if (cur === ev.v) continue;
        return { index: k, ev, state: cur === E_UNK ? 'open' : 'conflict' };
      }
    }
    return { index: -1, ev: null, state: 'done' };
  }

  // 落下一条结论：写仍然只经 setEdge/setRole（by='hint'），于是提示的每一笔都进撤销栈、记一步。
  hint() {
    const nx = this.nextLadder();
    if (!nx.ev) return { kind: 'done', nx };
    if (nx.state === 'conflict') return { kind: 'conflict', nx };
    const ev = nx.ev;
    const rec =
      ev.kind === 'role'
        ? this.setRole(ev.i, ev.v, 'hint')
        : this.setEdge(ev.i, ev.d, ev.v === E_ON ? E_ON : E_OFF, 'hint');
    if (!rec) return { kind: 'noop', nx };
    return { kind: ev.kind === 'role' ? 'black' : ev.v === E_ON ? 'loop' : 'off', nx, ev, rec };
  }

  ghostAt(key) {
    return this.ghost.has(key);
  }

  // ── 存档：原始 seed + 尺寸 + 一张笔表 ──────────────────────────────────────
  encode() {
    let s = '';
    for (let i = 0; i < this.n; i++) s += CELL_CHAR[this.role[i]] || '0';
    for (const [cell, d] of this.edges()) s += EDGE_CHAR[this.ed[cell][d]] || '0';
    return s;
  }

  // 长度对不上（尺寸换过、串被截断）或字符不认识，一律读成「没落笔」而不是抛——
  // 读崩一次，玩家那一局的笔迹就再也拿不回来了。步数由调用方说：续局把存下的那个数交回来，
  // 换一局不传 = 从零开始。
  decode(s, moves = 0) {
    const str = typeof s === 'string' ? s : '';
    for (let i = 0; i < this.n; i++) this.role[i] = this.isClue(i) ? CLUE : str.charCodeAt(i) === 49 ? BLACK : UNK;
    let k = this.n;
    for (const [cell, d] of this.edges()) {
      const c = str.charCodeAt(k++);
      const v = c === 49 ? E_ON : c === 50 ? E_OFF : E_UNK;
      this.ed[cell][d] = v;
      const nb = this.neighbor(cell, d);
      if (nb >= 0) this.ed[nb][Game.opp(d)] = v;
    }
    for (let i = 0; i < this.n; i++) {
      for (const d of CANON) if (this.neighbor(i, d) < 0) this.ed[i][d] = E_OFF;
    }
    this.undoStack = [];
    this._group = null;
    this.ghost.clear();
    this.moves = Number.isFinite(moves) && moves > 0 ? Math.floor(moves) : 0;
  }

  // 键盘/无障碍读数：全部来自上面的笔表与 question 的箭头。
  cellReport(cell) {
    const [r, c] = this.cellRC(cell);
    const cl = this.clueAt(cell);
    const dirs = [];
    const offs = [];
    for (let d = 0; d < 4; d++) {
      if (this.neighbor(cell, d) < 0) continue;
      if (this.ed[cell][d] === E_ON) dirs.push(DIR_NAME[d]);
      else if (this.ed[cell][d] === E_OFF) offs.push(DIR_NAME[d]);
    }
    const what = cl
      ? `箭头格（${DIR_NAME[cl.dir]}方向 ${cl.n} 个黑格，题面给定改不动）`
      : this.role[cell] === BLACK
        ? '黑格'
        : '没落笔';
    return `第 ${r + 1} 行第 ${c + 1} 列 ${what}，环段 ${dirs.length} 条：${dirs.join('、') || '无'}${
      offs.length ? `，排除 ${offs.length} 条：${offs.join('、')}` : ''
    }`;
  }
}
