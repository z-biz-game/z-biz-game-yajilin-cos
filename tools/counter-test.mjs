#!/usr/bin/env node
// 计数器的门：DP（js/engine/counter.js）对一台**完全独立**的暴力枚举器（tools/reference.mjs）。
// 口径照搬判据探针 _tmp-yajilin-probe.mjs：5×5 上逐盘比解数，红线是
//   MISMATCH 0（两台机器数出的解数必须相同）与 ZERO-BUT-SOLVABLE 0（DP 报 0 解的盘必须真没解）。
// 第二条专防"计数器把合法解丢了"——DP 报 0 看着像"这盘没解"，其实可能是搜索写歪了；
// 而已知可解的盘（模型自己出的、verify() 全绿的）DP 必须报 ≥1。
//
// 另一条独立红线写在最后：`stopped`（预算耗尽 = 没数完）与 `capped`（数到 limit 收工）
// 必须是两个字段。需求卡第四节：stopped 即整盘作废，不许混进"≥N 解"里糊过去。
import { performance } from 'node:perf_hooks';

import { Board } from '../js/engine/grid.js';
import { generate, verify } from '../js/engine/model.js';
import { countSolutions, materialize } from '../js/engine/counter.js';
import { bruteCount } from './reference.mjs';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) { fails.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` :: ${detail}` : ''}`); }
  return !!cond;
}

const SIZES = (process.env.SIZES || '5x5').split(',').map((s) => s.split('x').map(Number));
const N = Number(process.env.N || 12);
let agree = 0, mismatch = 0, zeroButSolvable = 0, skipped = 0, maxNodes = 0;
const walls = [];

for (const [w, h] of SIZES) {
  for (let s = 0; s < N; s++) {
    const g = generate(`audit-${w}x${h}-${s}`, w, h, { loopFrac: 0.6 });
    if (!g.ok) { ok(false, `${w}x${h}#${s} 模型出题失败`, g.status); continue; }
    const b = g.board;
    // 已知可解：verify() 独立判过的盘，DP 说 0 就是 DP 撒谎
    ok(verify(b).length === 0, `${w}x${h}#${s} 示范盘必须过 verify()`);
    const t0 = performance.now();
    const c = countSolutions(b, { limit: Infinity, budgetNodes: 50_000_000, collect: 64 });
    walls.push(performance.now() - t0);
    ok(!c.stopped, `${w}x${h}#${s} 50M 预算内必须数完`, `nodes=${c.nodes}`);
    // DP 交回的每一份解都要能被独立审计器判绿：sols 不是装饰品
    let dpBad = 0; const dpErrs = [];
    for (const snap of c.sols) {
      const e = verify(materialize(b, snap));
      if (e.length) { dpBad++; if (dpErrs.length < 2) dpErrs.push(e[0]); }
    }
    ok(dpBad === 0, `${w}x${h}#${s} DP 交回的解必须全部过 verify()`, `${dpBad}/${c.sols.length} ${JSON.stringify(dpErrs)}`);
    ok(c.sols.length === Math.min(c.count, 64), `${w}x${h}#${s} collect 到的份数与 count 一致`, `sols=${c.sols.length} count=${c.count}`);
    if (c.count === 0) zeroButSolvable++;
    const bf = bruteCount(b);
    if (!bf) { skipped++; notes.push(`${w}x${h}#${s} 暴力枚举跳过（free 太多）`); continue; }
    if (bf.total === c.count) agree++;
    else { mismatch++; console.log(`  MISMATCH ${w}x${h} #${s} dp=${c.count} brute=${bf.total} clues=${b.clue.size} free=${w * h - b.clue.size}`); }
    ok(bf.total >= 1, `${w}x${h}#${s} 暴力枚举必须至少找到 1 个解（模型盘自己是解）`, `brute=${bf.total}`);
    maxNodes = Math.max(maxNodes, c.nodes);
  }
}

ok(mismatch === 0, `MISMATCH 必须为 0（DP 与暴力在每一盘上 agreement）`, `MISMATCH ${mismatch} / AGREE ${agree} / SKIPPED ${skipped}`);
ok(zeroButSolvable === 0, 'ZERO-BUT-SOLVABLE 必须为 0（DP 不许把可解的盘报成 0 解）', `ZERO-BUT-SOLVABLE ${zeroButSolvable}`);
ok(agree > 0, '逐盘比对必须真的跑过（一台没跑上的枚举器不算证人）', `AGREE ${agree}`);
ok(skipped === 0, '5×5 这一档不许有盘被跳过（跳过 = 这一盘没有第二条证据）', `SKIPPED ${skipped}`);

// ——— stopped / capped 是两个字段：这里各造一个现场 ———
{
  const g = generate('audit-states-1', 5, 5, { loopFrac: 0.6 });
  ok(g.ok === true, 'stopped/capped 现场：示范盘要出得来', g.status);
  const b = g.board;
  const many = countSolutions(b, { limit: 2, budgetNodes: 50_000_000 });
  ok(many.count >= 1 && many.stopped === false, 'limit=2 的常规收口不算 stopped', `count=${many.count} stopped=${many.stopped}`);
  ok(verify(materialize(b, countSolutions(b, { limit: 1, budgetNodes: 50_000_000, collect: 1 }).sols[0])).length === 0,
    'limit=1 交回的那份解必须仍然过 verify()');
  // 一格箭头都不留 = 全盘自由：解数极多，把预算压到 1 个节点，必须看见 stopped
  // 一格箭头都不留 = 25 格全自由：解数天文级，把预算压到 1 个节点，必须看见 stopped
  const wide = countSolutions(new Board(5, 5), { limit: Infinity, budgetNodes: 1 });
  ok(wide.stopped === true, '预算 1 节点必须报 stopped（没数完就是没数完）', `stopped=${wide.stopped} count=${wide.count}`);
  ok(wide.capped === false, 'stopped 那一趟不许同时报 capped', `capped=${wide.capped}`);
  const capped = countSolutions(new Board(5, 5), { limit: 3, budgetNodes: 50_000_000 });
  ok(capped.capped === true && capped.stopped === false, '数到 limit 收工只许报 capped', `capped=${capped.capped} stopped=${capped.stopped} count=${capped.count}`);
  ok(capped.count === 3, 'capped 时 count 就是 limit 这个下界', `count=${capped.count}`);
}

notes.push(`5×5 比对：AGREE ${agree} MISMATCH ${mismatch} ZERO-BUT-SOLVABLE ${zeroButSolvable} SKIPPED ${skipped}｜DP 节点 max ${maxNodes}｜暴力+DP 墙钟 max ${Math.max(...walls).toFixed(0)}ms`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 12)) console.log(`  ✗ ${f}`);
console.log(`RESULT counter-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
