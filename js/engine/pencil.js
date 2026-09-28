// 铅笔求解器（判据 1：零猜测门槛有没有选择性）。逐字符搬自桌面筛探针 `_tmp-yajilin-pencil.mjs`（仓外，见 DESIGN §八 末条）。
// 全部规则只做「人类一眼能看懂的排除」，绝不回溯、绝不猜：
//   P1 零箭头      数字 0 ⇒ 射线上每一格都不是黑格 ⇒ 全成环格
//   P2 箭头满      射线上还差 k 个黑格、只剩 k 格未定 ⇒ 那 k 格全黑
//   P3 箭头空      射线上黑格已够 ⇒ 余下未定格全成环格
//   P4 黑格四邻     黑格四邻必是环格，且所有指进黑格/箭头格的边都不存在
//   P5 环格两进两出  已有 2 条边 ⇒ 余边全断；只剩 1 条候选 ⇒ 该边必连；四边全断 ⇒ 只能涂黑
//   P6 不许提前闭环  连上就成环、而环还没盖住所有必上环的格 ⇒ 那条边断掉
//   P7 同向相减     同一条线上同向的两个箭头相减，得到两箭头之间那段的黑格数（0 ⇒ 全环，满 ⇒ 全黑）
//   P8 2N-1 夹缝    射线未定格恰 2N-1 且需 N 个互不相邻的黑格 ⇒ 只能 1、3、5… 交替涂黑
//   P9 无处下边     可用的邻居（未断边的环格/未定格）不足 2 个 ⇒ 上不了环 ⇒ 只能涂黑
//   P10 环不能被掐断 涂黑某格会把必上环的格隔成两段 ⇒ 那格其实在环上（环是一条，不能被掐断）
// 规则原文依据见需求卡第二节（Puzzle Wiki 的 Strategy 三条 = P7/P8/P6 的 region parity）。
//
// ⚠ RULES 里这 10 个**字符串本身是承重墙**：剂量表（tools/generator-probe.mjs）按名字统计
//   「至少命中一次的盘数」，改名或换序就等于把历史读数全部作废。
// ⚠ 必须披露的短板 1（需求卡第五节）：**P10 在四档出货盘上一次都没命中过**（6/8/10/12 全 0）。
//   它的价值是健全性证人——下面 allReachable(-1) 那条矛盾一触发，就说明前面某条规则推错了；
//   它**不是**难度梯级，文档里不许把它算进「用到的规则数」。
import { prepare } from './counter.js';

const UNK = 0, BLACK = 1, LOOP = 2, CLUE = 3;
const E_UNK = 0, E_ON = 1, E_OFF = 2;
const OPP = [2, 3, 0, 1];
export const RULES = ['P1-zero-ray', 'P2-ray-full', 'P3-ray-empty', 'P4-black-neighbors', 'P5-degree', 'P6-no-subtour', 'P7-subtract', 'P8-pinch', 'P9-no-room', 'P10-cut-vertex'];

export function pencil(board) {
  const { w, h, n } = board;
  const { nb } = prepare(board);
  const role = new Int8Array(n);
  const roleWhy = new Array(n).fill(null);
  const ed = [];
  for (let i = 0; i < n; i++) ed.push(new Int8Array(4));
  // 界外的边一上来就记成「断」：否则它永远算候选边，P5 会把每个边角格的度数都算少
  for (let i = 0; i < n; i++) for (let d = 0; d < 4; d++) if (nb[i][d] < 0) ed[i][d] = E_OFF;
  for (let i = 0; i < n; i++) {
    if (board.clue.has(i)) {
      role[i] = CLUE;
      for (let d = 0; d < 4; d++) { const j = nb[i][d]; if (j >= 0) { ed[i][d] = E_OFF; ed[j][OPP[d]] = E_OFF; } }
    }
  }
  const clueList = [...board.clue.entries()].map(([i, cl]) => ({ i, dir: cl.dir, need: cl.n, ray: board.ray(i, cl.dir) }));
  const fired = new Map(RULES.map((r) => [r, 0]));
  let progress = true, contradiction = null;

  // 每一次「真的改了东西」才记账：改不动的推导（已经是这个值）不能算进展，
  // 否则不动点的 while 永远出不去（第一版就是这样卡死的）。
  const note = (rule) => { fired.set(rule, fired.get(rule) + 1); progress = true; };
  const events = [];
  const setRole = (i, r, rule) => {
    if (role[i] !== UNK) {
      if (role[i] !== r) contradiction = contradiction || `${rule}：格 ${i} 既要${role[i] === BLACK ? '黑' : role[i] === CLUE ? '箭头' : '环'}又要${r === BLACK ? '黑' : '环'}`;
      return false;
    }
    role[i] = r;
    roleWhy[i] = rule;
    events.push({ rule, kind: 'role', i, v: r });
    note(rule);
    // 黑格不相邻是硬规则：两条推导各自涂出相邻黑格时必须当场报矛盾，不能留给「卡住」
    if (r === BLACK) for (const j of nb[i]) if (j >= 0 && role[j] === BLACK) contradiction = contradiction || `${rule}：格 ${i} 与 ${j} 两个黑格相邻`;
    return true;
  };
  const setEdge = (i, d, v, rule) => {
    const j = nb[i][d];
    if (j < 0) { if (v === E_ON) contradiction = contradiction || `${rule}：格 ${i} 往界外连边`; return false; }
    if (ed[i][d] === v) return false;
    if (ed[i][d] !== E_UNK) { contradiction = contradiction || `${rule}：边 ${i}-${j} 既连又断`; return false; }
    if (v === E_ON && (role[j] === BLACK || role[j] === CLUE)) { contradiction = contradiction || `${rule}：边 ${i}-${j} 连上，但 ${j} 是${role[j] === CLUE ? '箭头' : '黑格'}`; return false; }
    ed[i][d] = v; ed[j][OPP[d]] = v;
    events.push({ rule, kind: 'edge', i, j, d, v });
    note(rule);
    // 连上的边两端必是环格：不补这一步，「某格只能靠邻居进环」就推不回去
    if (v === E_ON) setRole(j, LOOP, rule);
    return true;
  };
  const rayState = (c) => {
    let have = 0; const unk = [];
    for (const j of c.ray) {
      if (role[j] === BLACK) have++;
      else if (role[j] === UNK) unk.push(j);
    }
    return { have, unk, rem: c.need - have };
  };
  const candEdges = (i) => [0, 1, 2, 3].filter((d) => ed[i][d] === E_UNK);
  const onEdges = (i) => [0, 1, 2, 3].filter((d) => ed[i][d] === E_ON).length;

  // 并查集（每轮重建；单向推进不回滚，所以不需要日志）
  function components() {
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; };
    for (let i = 0; i < n; i++) if (role[i] === LOOP) for (const d of [0, 3]) if (ed[i][d] === E_ON) { const j = nb[i][d]; if (j >= 0 && role[j] === LOOP) parent[find(i)] = find(j); }
    return { find };
  }

  let passes = 0;
  while (progress && !contradiction) {
    if (++passes > 4 * n) { contradiction = `规则没收敛（${passes} 轮仍在改格子）`; break; }
    progress = false;

    // P1/P2/P3：箭头射线
    for (const c of clueList) {
      const { have, unk, rem } = rayState(c);
      if (have > c.need) { contradiction = `箭头 ${c.i} 说 ${c.need} 个黑格，实际已有 ${have}`; break; }
      if (c.need === 0 && unk.length) { for (const j of unk) setRole(j, LOOP, 'P1-zero-ray'); }
      else if (rem === 0 && unk.length) { for (const j of unk) setRole(j, LOOP, 'P3-ray-empty'); }
      else if (rem > 0 && rem === unk.length) { for (const j of unk) setRole(j, BLACK, 'P2-ray-full'); }
    }
    if (contradiction) break;

    // P4：黑格四邻不是箭头格就必是环格，且指进黑格/箭头/界外的边断掉。
    // 注意「四邻必是环格」要说清例外：黑格挨着箭头格完全合法（本变体没有灰格，
    // 是「非箭头非黑的格全在环上」才把邻居逼成环格，箭头格自己不在环上）。
    for (let i = 0; i < n; i++) {
      if (role[i] !== BLACK && role[i] !== CLUE) continue;
      for (let d = 0; d < 4; d++) {
        const j = nb[i][d];
        if (j < 0) continue;
        if (role[i] === BLACK && !board.clue.has(j)) setRole(j, LOOP, 'P4-black-neighbors');
        setEdge(i, d, E_OFF, 'P4-black-neighbors');
      }
    }
    if (contradiction) break;

    // P7：同线同向两箭头相减
    for (const a of clueList) {
      for (const b of clueList) {
        if (a === b || a.dir !== b.dir) continue;
        const ra = Math.floor(a.i / w), ca = a.i % w, rb = Math.floor(b.i / w), cb = b.i % w;
        const d = a.dir;
        const sameLine = (d === 1 || d === 3) ? ra === rb : ca === cb;
        const along = (d === 1) ? ca < cb : (d === 3) ? ca > cb : (d === 2) ? ra < rb : ra > rb;
        if (!sameLine || !along) continue;
        const idx = a.ray.indexOf(b.i);
        if (idx < 0) continue;
        // b 在 a 的射线里 ⇒ a.need - b.need = 两箭头之间那段的黑格数（b 自己是箭头，不算）
        const between = a.ray.slice(0, idx);
        const need = a.need - b.need;
        if (need < 0) { contradiction = `同向相减出负数：${a.i}(${a.need}) - ${b.i}(${b.need})`; break; }
        const unk = between.filter((j) => role[j] === UNK);
        const have = between.filter((j) => role[j] === BLACK).length;
        if (!unk.length) continue;
        if (need === have) { for (const j of unk) setRole(j, LOOP, 'P7-subtract'); }
        else if (need - have === unk.length) { for (const j of unk) setRole(j, BLACK, 'P7-subtract'); }
      }
      if (contradiction) break;
    }
    if (contradiction) break;

    // P8：射线未定格恰 2k-1、还需 k 个互不相邻黑格 ⇒ 唯一涂法
    for (const c of clueList) {
      const { unk, rem } = rayState(c);
      if (rem < 2 || unk.length !== 2 * rem - 1) continue;
      let contiguous = true;
      for (let k = 1; k < unk.length; k++) if (unk[k] !== unk[k - 1] + (c.dir === 1 ? 1 : c.dir === 3 ? -1 : c.dir === 2 ? w : -w)) { contiguous = false; break; }
      if (!contiguous) continue;
      for (let k = 0; k < unk.length; k++) setRole(unk[k], k % 2 === 0 ? BLACK : LOOP, 'P8-pinch');
    }
    if (contradiction) break;

    // P5：环格度数
    for (let i = 0; i < n; i++) {
      if (role[i] !== LOOP) continue;
      const on = onEdges(i), cand = candEdges(i);
      if (on + cand.length < 2) { contradiction = `环格 ${i} 只剩 ${on} 条边可连`; break; }
      if (on === 2) { for (const d of cand) setEdge(i, d, E_OFF, 'P5-degree'); }
      else if (on + cand.length === 2) { for (const d of cand) setEdge(i, d, E_ON, 'P5-degree'); }
    }
    if (contradiction) break;

    // P6：连上就提前成环、而还有必上环的格没进环 ⇒ 断掉
    const mustLoop = [];
    for (let i = 0; i < n; i++) if (role[i] === LOOP) mustLoop.push(i);
    if (mustLoop.length >= 4) {
      const { find } = components();
      for (let i = 0; i < n; i++) {
        if (role[i] !== LOOP) continue;
        for (const d of candEdges(i)) {
          const j = nb[i][d];
          if (j < 0 || role[j] !== LOOP || find(i) !== find(j)) continue;
          // 这条边会把 i 所在分支接成环；只有当全部必上环的格都在这个分支里才允许
          if (!mustLoop.every((k) => find(k) === find(i))) setEdge(i, d, E_OFF, 'P6-no-subtour');
        }
      }
    }
    // P9：可用的邻居（没被断边、且不是黑格/箭头格）不足 2 个 ⇒ 两条边凑不齐 ⇒ 上不了环 ⇒ 只能涂黑
    for (let i = 0; i < n; i++) {
      if (role[i] !== UNK) continue;
      let usable = 0;
      for (let d = 0; d < 4; d++) {
        const j = nb[i][d];
        if (j >= 0 && ed[i][d] !== E_OFF && role[j] !== BLACK && role[j] !== CLUE) usable++;
      }
      if (usable < 2) setRole(i, BLACK, 'P9-no-room');
    }
    if (contradiction) break;

    // P10：环是一整条，不能被掐断。若把某格涂黑会让「必上环的格」分家，那格其实只能在环上。
    const must = [];
    for (let i = 0; i < n; i++) if (role[i] === LOOP) must.push(i);
    if (must.length >= 2) {
      const allReachable = (skip) => {
        const seen = new Set([must[0]]);
        const stack = [must[0]];
        while (stack.length) {
          const v = stack.pop();
          for (let d = 0; d < 4; d++) {
            const j = nb[v][d];
            if (j < 0 || j === skip || ed[v][d] === E_OFF || role[j] === BLACK || role[j] === CLUE || seen.has(j)) continue;
            seen.add(j); stack.push(j);
          }
        }
        return must.every((k) => seen.has(k));
      };
      // 必上环的格已经被隔开 = 前面某条规则推错了，这里当场揭穿而不是悄悄交出一个残缺解
      if (!allReachable(-1)) { contradiction = '必上环的格已经分家（前面的推导不兼容）'; break; }
      for (let i = 0; i < n; i++) {
        if (role[i] !== UNK) continue;
        if (!allReachable(i)) setRole(i, LOOP, 'P10-cut-vertex');
      }
    }
  }

  let rolesDone = 0, edgesDone = 0, edgeTotal = 0;
  // 每条边只数一次：右、下两侧各覆盖一条无向边，四向扫会把重复边记两遍
  for (let i = 0; i < n; i++) {
    if (role[i] !== UNK) rolesDone++;
    for (const d of [1, 2]) if (nb[i][d] >= 0) { edgeTotal++; if (ed[i][d] !== E_UNK) edgesDone++; }
  }
  return { solved: !contradiction && rolesDone === n && edgesDone === edgeTotal, contradiction, fired: Object.fromEntries(fired), rolesDone, edgesDone, edgeTotal, n, passes, steps: events.length, role, roleWhy, ed, events };
}

// UNK/BLACK/LOOP/CLUE 与 E_UNK/E_ON/E_OFF 是界面与测试共用的取值表（轮 2 画布要按它上色），
// 不导出的话每个调用点都得自己抄一份字面量——抄错一位就是静默的颜色 bug。
export const ROLE = { UNK, BLACK, LOOP, CLUE };
export const EDGE = { E_UNK, E_ON, E_OFF };
