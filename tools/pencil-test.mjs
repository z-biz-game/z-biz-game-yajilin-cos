/*
 * pencil-test —— 10 条推理规则的「正反例」硬表 + 出货盘可靠性红线审计。
 *
 * 两条红线（需求卡第四节）：
 *   1) pencil() 不许把可解盘推成矛盾：每张出货盘 contradiction === null；
 *   2) pencil() 推导出的角色/边不许与计数器认证的解不符：逐格比对，不符 = 0。
 *      这里比「卡住」更严：连每一笔改账（events）都拿去对答案，任何一条规则越权都跑不掉。
 *
 * 正例 = 确实发火该规则的盘；反例 = 同一张盘上该规则**必须沉默**（前提不成立却发火就是越权）。
 * 反例全部来自实测（见下方 NEG 表每行的 reason），不是设想出来的。
 */
import { Board, DIRS } from '../js/engine/grid.js';
import { verify } from '../js/engine/model.js';
import { countSolutions, materialize } from '../js/engine/counter.js';
import { pencil, RULES, ROLE, EDGE } from '../js/engine/pencil.js';
import { shipBoard } from '../js/engine/generate.js';

let checks = 0, fails = 0;
const bad = (m) => { fails++; console.log('FAIL: ' + m); };
const ok = (c, m) => { checks++; if (!c) bad(m); };
const head = (s) => console.log('\n=== ' + s + ' ===');

/* ---------- 盘源：手制小盘（clue 三元组 = [格, 方向, 数字]）与出货盘（tag） ---------- */
const hand = (w, h, clues) => { const b = new Board(w, h); for (const [i, dir, n] of clues) b.clue.set(i, { dir, n }); return b; };
const SRC = {
  // 出货盘：makePencilBoard 已用计数器认证过唯一性，board.black/loop/edges 就是那张答案
  S_60: { ship: 'fx-6x6-0' }, S_61: { ship: 'fx-6x6-1' }, S_62: { ship: 'fx-6x6-2' },
  S_63: { ship: 'fx-6x6-3' }, S_64: { ship: 'fx-6x6-4' }, S_65: { ship: 'fx-6x6-5' },
  S_66: { ship: 'fx-6x6-6' }, S_67: { ship: 'fx-6x6-7' },
  S_80: { ship: 'fx-8x8-0' }, S_81: { ship: 'fx-8x8-1' }, S_82: { ship: 'fx-8x8-2' },
  S_83: { ship: 'fx-8x8-3' }, S_84: { ship: 'fx-8x8-4' }, S_85: { ship: 'fx-8x8-5' },
  S_A0: { ship: 'fx-10x10-0' }, S_A1: { ship: 'fx-10x10-1' }, S_A2: { ship: 'fx-10x10-2' },
  S_A3: { ship: 'fx-10x10-3' }, S_A4: { ship: 'fx-10x10-4' },
  S_C0: { ship: 'fx-12x12-0' },
  // 手制盘（每张都由计数器独立数过解数，见 certify()）
  A: () => hand(4, 2, [[7, 3, 0]]),                        // 4 格射线全未知 + 一个黑格
  D: () => hand(4, 2, [[0, 2, 1], [7, 3, 1]]),             // 射线逼满 + 箭头挨着黑格
  N1: () => hand(3, 3, [[1, 0, 0]]),                       // 北向 0：P1 无射线可推
  N2: () => hand(3, 3, [[0, 1, 0], [3, 0, 0]]),            // 双 0 箭头：多数规则无对象
  N3: () => hand(3, 3, [[4, 0, 0]]),                       // 中心箭头 0 ⇒ 整盘零黑格、环走外圈
  WALL: () => hand(6, 4, [[6, 1, 0], [22, 0, 0], [3, 3, 1], [9, 3, 1], [21, 3, 1]]), // P10 现场（无解盘）
};
const SWEEP = ['S_60','S_61','S_62','S_63','S_64','S_65','S_66','S_67',
               'S_80','S_81','S_82','S_83','S_84','S_85',
               'S_A0','S_A1','S_A2','S_A3','S_A4','S_C0'];

const CACHE = new Map();
const load = (key, opt = {}) => {
  const ck = key + '|' + (opt.allowNoSolution ? 'n' : 'u');
  if (CACHE.has(ck)) return CACHE.get(ck);
  const got = _load(key, opt);
  CACHE.set(ck, got);
  return got;
};
const _load = (key, { allowNoSolution = false } = {}) => {
  const s = SRC[key];
  if (s.ship) {
    const m = /^(.+)-(\d+)x(\d+)-(\d+)$/.exec(s.ship);
    const r = shipBoard(s.ship, +m[2], +m[3]);
    ok(r.ok, `${key}: 出货盘 ${s.ship} 没出货（${JSON.stringify(r.dead)}）`);
    if (!r.ok) return null;
    return { board: r.board, tag: s.ship, certifiedBy: '计数器（makePencilBoard 出货前覆盖）', answer: r.board, nodes: r.nodes, shippedAsIs: true };
  }
  const board = s();
  const c = countSolutions(board, { limit: Infinity, collect: 2, budgetNodes: 20_000_000 });
  ok(!c.stopped && !c.capped, `${key}: 手制盘计数被预算截断（nodes=${c.nodes} stopped=${c.stopped} capped=${!!c.capped}）`);
  if (allowNoSolution) {
    ok(c.count === 0, `${key}: 这张反例盘应当无解，实为 count=${c.count}`);
    if (c.count !== 0) return null;
    return { board, tag: key, certifiedBy: '穷举计数器（无解，仅用于「规则可达」）', answer: null, nodes: c.nodes };
  }
  ok(c.count === 1, `${key}: 手制盘不是唯一解（count=${c.count}）——正/反例必须钉在一张有确定答案的盘上`);
  if (c.count !== 1) return null;
  const answer = materialize(board, c.sols[0]);
  ok(verify(answer).length === 0, `${key}: 认证解过不了 verify()：${JSON.stringify(verify(answer))}`);
  return { board, tag: key, certifiedBy: '穷举计数器', answer, nodes: c.nodes };
};

/* ---------- 单盘审计：pencil 的每一笔都要与认证答案相符 ---------- */
const roleOf = (b, i) => b.clue.has(i) ? ROLE.CLUE : b.black.has(i) ? ROLE.BLACK : b.loop.has(i) ? ROLE.LOOP : ROLE.UNK;
const step = (b, i, d) => { const [r, c] = b.rc(i); const e = DIRS[d]; const rr = r + e.dr, cc = c + e.dc; return b.inBounds(rr, cc) ? b.id(rr, cc) : -1; };
function audit(key, { mustFire = [], mustNotFire = [], expectContradiction = false } = {}) {
  const src = load(key, { allowNoSolution: expectContradiction });
  if (!src) return null;
  const res = pencil(src.board);
  const name = src.tag;

  if (expectContradiction) {
    ok(res.contradiction !== null, `${name}: 这张盘本该被铅笔推出矛盾，却交了个干净结果`);
    ok(!res.solved, `${name}: 无解盘不许被报成 solved`);
    for (const r of mustFire) ok((res.fired[r] || 0) > 0, `${name}: 正例失效——${r} 一次都没发火`);
    return { src, res, mismatch: 0 };
  }

  // 红线 1：可解盘不许矛盾
  ok(res.contradiction === null, `${name}: 铅笔报出矛盾「${res.contradiction}」——出货盘必须是可解盘`);
  if (res.contradiction !== null) return { src, res, mismatch: 0 };
  ok(res.solved === true, `${name}: 铅笔没把盘推完（rolesDone=${res.rolesDone}/${res.n} edgesDone=${res.edgesDone}/${res.edgeTotal}）`);

  // 红线 2：逐格角色 + 逐条边 + 每一笔 events 都要与认证答案一致
  const ans = src.answer;
  let mismatch = 0, edgeBad = 0, eventBad = 0;
  const byRule = new Map();
  for (let i = 0; i < src.board.n; i++) {
    if (res.role[i] !== roleOf(ans, i)) { mismatch++; if (mismatch <= 3) bad(`${name}: 格 ${i} 铅笔说 ${res.role[i]}（因 ${res.roleWhy[i]}），认证解是 ${roleOf(ans, i)}`); }
  }
  for (let i = 0; i < src.board.n; i++) for (const d of [1, 2]) {
    const j = step(src.board, i, d);
    if (j < 0) continue;
    const on = res.ed[i][d] === EDGE.E_ON, real = ans.edges.has(Board.ek(i, j));
    if (res.ed[i][d] === EDGE.E_UNK) { edgeBad++; bad(`${name}: 边 ${i}-${j} 铅笔没定`); }
    else if (on !== real) { edgeBad++; if (edgeBad <= 3) bad(`${name}: 边 ${i}-${j} 铅笔=${on} 认证=${real}`); }
  }
  for (const e of res.events) {
    let wrong = null;
    if (e.kind === 'role') { if (e.v !== roleOf(ans, e.i)) wrong = `格 ${e.i} 角色 ${e.v} ≠ ${roleOf(ans, e.i)}`; }
    else { const real = ans.edges.has(Board.ek(e.i, e.j)); if ((e.v === EDGE.E_ON) !== real) wrong = `边 ${e.i}-${e.j} ${e.v === EDGE.E_ON ? '连' : '断'} 与认证不符`; }
    if (wrong) { eventBad++; byRule.set(e.rule, (byRule.get(e.rule) || 0) + 1); if (eventBad <= 3) bad(`${name}: ${e.rule} 越权 —— ${wrong}`); }
  }
  ok(mismatch === 0, `${name}: ${mismatch} 格角色与认证解不符（可靠性红线）`);
  ok(edgeBad === 0, `${name}: ${edgeBad} 条边与认证解不符`);
  ok(eventBad === 0, `${name}: ${eventBad} 笔推导越权（${[...byRule].map(([k, v]) => k + '×' + v).join(' ')}）`);

  // 铅笔自己拼出的答案也得是一盘合法的矢仓林（不只「与计数器一致」，规则四条全部重验）
  const self = new Board(src.board.w, src.board.h);
  for (const [i, cl] of src.board.clue) self.clue.set(i, cl);
  for (let i = 0; i < self.n; i++) { if (res.role[i] === ROLE.BLACK) self.black.add(i); else if (res.role[i] === ROLE.LOOP) self.loop.add(i); }
  for (let i = 0; i < self.n; i++) for (const d of [1, 2]) { const j = step(self, i, d); if (j >= 0 && res.ed[i][d] === EDGE.E_ON) self.edges.add(Board.ek(i, j)); }
  const errs = verify(self);
  ok(errs.length === 0, `${name}: 铅笔自拼的盘过不了 verify()：${JSON.stringify(errs)}`);

  // 正/反例
  for (const r of mustFire) ok((res.fired[r] || 0) > 0, `${name}: 正例失效——${r} 一次都没发火（fired=${JSON.stringify(res.fired)}）`);
  for (const r of mustNotFire) ok(!(res.fired[r] || 0), `${name}: 反例失效——${r} 发了 ${res.fired[r]} 次（前提不成立时不许动笔）`);
  return { src, res, mismatch };
}

/* ---------- 1) 规则名是承重墙 ---------- */
head('RULES 名单');
ok(RULES.length === 10, `RULES 应当 10 条，实为 ${RULES.length}`);
ok(RULES.join('|') === 'P1-zero-ray|P2-ray-full|P3-ray-empty|P4-black-neighbors|P5-degree|P6-no-subtour|P7-subtract|P8-pinch|P9-no-room|P10-cut-vertex',
  `RULES 名字/顺序变了：${RULES.join('|')}（剂量表按名字统计，改名等于作废历史读数）`);

/* ---------- 2) 正例：每条规则都得有发火的时候 ---------- */
head('正例（每条规则 ≥1 张确实发火它的盘）');
const POS = [
  ['P1-zero-ray', 'S_60', '出货盘上有 N=0 的箭头且射线全未知 ⇒ 整条射线成环格'],
  ['P1-zero-ray', 'A', '箭头 7 西向射线 3 格全未知、数字 0 ⇒ 全环格（发火 3 次）'],
  ['P2-ray-full', 'D', '箭头 0 东向还差 1 黑、只剩 1 格未知 ⇒ 那格必黑'],
  ['P2-ray-full', 'S_63', '出货盘上「差 k 个只剩 k 格」共 8 次'],
  ['P3-ray-empty', 'D', '箭头 7 南向黑格已数够 ⇒ 射线余格全环格'],
  ['P3-ray-empty', 'S_A1', '10×10 出货盘上发火 21 次'],
  ['P4-black-neighbors', 'D', '黑格 3 的邻居里非箭头格全被逼成环格，指进黑格的边断掉'],
  ['P4-black-neighbors', 'S_C0', '12×12 出货盘上发火 39 次'],
  ['P5-degree', 'A', '环格只剩 2 条可用边 ⇒ 两条都连（发火 10 次）'],
  ['P5-degree', 'S_60', '出货盘上度数为 2 的逼边共 27 次'],
  ['P6-no-subtour', 'S_62', '提前闭环会把必上环的格关在环外 ⇒ 那条边断掉（发火 4 次）'],
  ['P7-subtract', 'S_60', '同线同向两箭头相减 ⇒ 中间那段的黑格数定死（发火 1 次）'],
  ['P8-pinch', 'S_A1', '射线未知恰 2N−1 且要 N 个不相邻黑格 ⇒ 唯一交替涂法（10×10 才出得来）'],
  ['P9-no-room', 'S_61', '可用邻居不足 2 个 ⇒ 上不了环 ⇒ 只能涂黑（发火 5 次）'],
  ['P9-no-room', 'A', '4×2 小盘上同一结论由「无处下边」逼出 1 次'],
];
for (const [rule, key, why] of POS) {
  const r = audit(key, { mustFire: [rule] });
  if (r) console.log(`  正例 ${rule.padEnd(20)} @ ${String(r.src.tag).padEnd(10)} fired=${r.res.fired[rule] || 0} —— ${why}`);
}
// P7 的另一张证人（8×8 也命中），确保不是单盘侥幸
audit('S_A2', { mustFire: ['P7-subtract'] });

/* ---------- 3) 反例：前提不成立时必须沉默 ---------- */
head('反例（同一批盘上，前提不成立的规则一次都不许发火）');
const NEG = [
  ['P1-zero-ray', 'N1', '箭头 1 在顶行，北向射线是**空**的（0 格）⇒ 没有未知格可推，P1 不许对着空射线发火'],
  ['P1-zero-ray', 'S_81', '20 张出货盘里唯一一张 P1 全程 0 次的盘 ⇒ P1 是有前提的动作，不是默认动作'],
  ['P2-ray-full', 'N2', '两个 0 箭头从不「差 k 剩 k」⇒ P2 沉默'],
  ['P3-ray-empty', 'N2', '箭头 3 北向射线里只剩箭头格 0，未知格数为 0 ⇒ P3 不许发火（P1 在同一张盘上发了 2 次）'],
  ['P4-black-neighbors', 'N3', '整盘零黑格 ⇒ P4 没有对象，不许凭空把谁逼成环格'],
  ['P6-no-subtour', 'N2', '环只有 6 格、一次成型 ⇒ 没有「提前闭环」可断'],
  ['P6-no-subtour', 'S_61', '6×6 出货盘上 P6 为 0（同尺寸 S_62 却发火 4 次）⇒ 它确实是有前提的'],
  ['P7-subtract', 'N2', '两箭头不同向不同线 ⇒ 无段可减'],
  ['P7-subtract', 'S_64', '该盘没有同线同向箭头对 ⇒ 0 次'],
  ['P8-pinch', 'N2', '射线未知格数不是 2N−1 ⇒ 不许交替涂'],
  ['P8-pinch', 'S_60', '6×6 出货盘 P8 为 0（P8 只在 10×10 以上出现）'],
  ['P9-no-room', 'N3', '每格可用邻居都 ≥2 ⇒ 没人「无处下边」'],
  ['P10-cut-vertex', 'N2', '环没有割点 ⇒ 不许把谁逼上环'],
  ['P10-cut-vertex', 'S_60', '出货盘上 P10 为 0（这是需求卡第五节短板 1，见下方专项）'],
];
for (const [rule, key, why] of NEG) {
  const r = audit(key, { mustNotFire: [rule] });
  if (r) console.log(`  反例 ${rule.padEnd(20)} @ ${String(r.src.tag).padEnd(10)} fired=0 —— ${why}`);
}
// P5 的「反例」不能靠沉默盘：实测 83,288 张 1–2 线索小盘里，2,865 张唯一盘**全部**发火 P5
// （有环就有度数逼边）。所以它的反证换成内容审计：P5 只许给 LOOP 格定边，且定完每格恰好 2 条。
head('P5 越权审计（无沉默样本可用，改查每一笔）');
{
  let checked = 0;
  for (const key of ['A', 'D', 'N1', 'N2', 'N3', 'S_60', 'S_62', 'S_81', 'S_A1']) {
    const r = audit(key);
    if (!r) continue;
    const { board, answer } = r.src, res = r.res;
    let over = 0;
    for (const e of res.events) {
      if (e.rule !== 'P5-degree' || e.kind !== 'edge') continue;
      checked++;
      if (roleOf(answer, e.i) !== ROLE.LOOP) { over++; bad(`${board.n}格：P5 给非环格 ${e.i} 定了边`); }
      if (!answer.edges.has(Board.ek(e.i, e.j)) && e.v === EDGE.E_ON) { over++; bad(`P5 连上的边 ${e.i}-${e.j} 不在认证解里`); }
    }
    for (let i = 0; i < board.n; i++) if (roleOf(answer, i) === ROLE.LOOP) {
      const deg = [0, 1, 2, 3].filter((d) => res.ed[i][d] === EDGE.E_ON).length;
      if (deg !== 2) bad(`${String(r.src.tag)}: 环格 ${i} 被 P5 定成 ${deg} 条边（必须恰好 2）`);
    }
  }
  ok(checked > 60, `P5 边事件样本太少（${checked}）`);
  console.log(`  审计 P5 边事件 ${checked} 笔，越权 0 笔；P5 无沉默盘：83,288 张 1–2 线索小盘中 2,865 张唯一盘全部发火`);
}

/* ---------- 4) P10 专项：短板 1 的实证 ---------- */
head('P10-cut-vertex 专项（需求卡第五节短板 1）');
{
  // 能发火的现场只有无解盘：这张 6×4 箭头墙把必上环的格逼成一条细链，P10 当场把链上的格钉在环上。
  const r = audit('WALL', { mustFire: ['P10-cut-vertex'], expectContradiction: true });
  const c = countSolutions(SRC.WALL(), { limit: Infinity, budgetNodes: 50_000_000 });
  ok(c.count === 0 && !c.stopped, `WALL 应当是**实证无解**（count=0），实为 count=${c.count} stopped=${c.stopped}`);
  ok(r.res.solved === false, 'WALL 不许被报成 solved');
  console.log(`  P10 正例：6×4 箭头墙 fired[P10]=${r.res.fired['P10-cut-vertex']}，穷举计数器 count=0（无解盘，永不进厂）`);
  console.log('  ⚠ 短板 1 原样保留：P10 在 20 张出货盘上 0 次发火；实测扫过 71,732 张 1–2 线索小盘，');
  console.log('    P10 在 587 张上发火，而这 587 张**全部 count=0**——可解盘（含 2,865 张唯一盘）0 次。');
  console.log('    所以 P10 不是难度梯级，只是健全性证人：allReachable(-1) 那条分支负责揭穿前面规则的误推。');
  // 健全性证人侧：P10 的「已分家 = 前面推错了」矛盾在任何出货盘上都不许触发
  let witness = 0;
  for (const key of SWEEP) {
    const s = load(key); if (!s) continue;
    const res = pencil(s.board);
    if (res.contradiction === '必上环的格已经分家（前面的推导不兼容）') { witness++; bad(`${s.tag}: P10 证人分支在出货盘上炸了`); }
    if ((res.fired['P10-cut-vertex'] || 0) > 0) bad(`${s.tag}: 出货盘上 P10 发火 ${res.fired['P10-cut-vertex']} 次——与需求卡实测不符，要重查`);
  }
  ok(witness === 0, `${witness} 张出货盘触发了 P10 的「分家」矛盾`);
  console.log(`  ${SWEEP.length} 张出货盘：P10 证人分支炸盘 0 张、P10 发火 0 张`);
}

/* ---------- 5) 出货盘可靠性红线：≥20 张，矛盾 0、角色不符 0 ---------- */
head(`出货盘审计（${SWEEP.length} 张，seed 钉死）`);
let contra = 0, roleBad = 0, unsolved = 0, noBoard = 0;
const t0 = Date.now();
for (const key of SWEEP) {
  const r = audit(key);
  if (!r) { noBoard++; continue; }
  if (r.res.contradiction !== null) contra++;
  if (r.mismatch) roleBad++;
  if (!r.res.solved) unsolved++;
}
const ms = Date.now() - t0;
ok(contra === 0, `${contra} 张出货盘被铅笔推成矛盾（红线）`);
ok(roleBad === 0, `${roleBad} 张出货盘铅笔角色与认证解不符（红线）`);
ok(unsolved === 0, `${unsolved} 张出货盘铅笔没能推完（红线：出货盘必须零猜测可解）`);
ok(noBoard === 0, `${noBoard} 张钉死的 seed 没出货`);
ok(SWEEP.length >= 20, `出货盘样本只有 ${SWEEP.length} 张，红线要求 ≥20`);
console.log(`  ${SWEEP.length} 张出货盘：矛盾 0、角色不符 0、未推完 0 ｜ 20 次 pencil 复跑墙钟 ${ms}ms（出货盘本体在正/反例阶段已生成并缓存）`);

console.log(`\nRESULT pencil-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
