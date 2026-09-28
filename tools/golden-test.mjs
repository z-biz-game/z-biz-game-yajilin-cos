#!/usr/bin/env node
// node tools/check.mjs 的其中一道门：冻结的 golden 快照（tools/golden.mjs）必须被活引擎逐字重现。
//
// 这一门管的是「不许悄悄改行为」：改规则表、改计数器、改 RNG、改邻接表，只要出货盘或推演轨迹变了，
// 这里就红。它同时是浏览器轮的对照接口 —— golden.mjs 是纯数据 + 一个纯函数，浏览器 import 之后
// 用自己的引擎跑同样的 seed，和这份数据对账，就能证明 node 与 Chrome 从同一个 seed 画出同一张盘。
//
// 除了「活引擎 == 冻结数据」，这里还独立核四件事：
//   1) 确定性卫兵：同一批 seed 连跑两遍必须逐字节相同；
//   2) 再认证：只拿冻结的**箭头三元组**喂穷举计数器，必须数出恰好 1 个解，
//      且那个解 == 冻结的 black/loop/edges —— 答案永远来自求解器，不是出题器自记；
//   3) 铅笔复跑：只拿冻结线索，pencil 必须全解且与冻结答案逐格逐边相符；
//   4) 文件卫生：golden.mjs 里不许出现 node API / import / 时钟 / 随机（它是浏览器也要读的那份）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GOLDEN, GOLDEN_SCHEMA, fingerprintOf } from './golden.mjs';
import { produceRecord, FIXES } from './write-golden.mjs';
import { Board, DIRS } from '../js/engine/grid.js';
import { verify } from '../js/engine/model.js';
import { countSolutions, materialize } from '../js/engine/counter.js';
import { pencil, ROLE, EDGE } from '../js/engine/pencil.js';
import { TIERS } from '../js/engine/generate.js';

let checks = 0, fails = 0;
const bad = (m) => { fails++; console.log('FAIL: ' + m); };
const ok = (c, m) => { checks++; if (!c) bad(m); };

console.log(`golden 对照：冻结 ${GOLDEN.length} 条（schema v${GOLDEN_SCHEMA}），档位 ${TIERS.map((t) => `${t.w}×${t.h}`).join(' ')}`);

ok(GOLDEN.length >= 5, `golden 至少 5 条 seed，实际 ${GOLDEN.length}`);
ok(GOLDEN.length === FIXES.length, `golden 条数 ${GOLDEN.length} 与 FIXES ${FIXES.length} 不一致（忘了 node tools/write-golden.mjs？）`);
const covered = new Set(GOLDEN.map((r) => `${r.w}x${r.h}`));
for (const t of TIERS) ok(covered.has(`${t.w}x${t.h}`), `档位 ${t.w}×${t.h} 没有 golden 覆盖`);

/* ---- 4) 文件卫生（先做：它红了后面都不用跑）---- */
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'golden.mjs'), 'utf8');
  for (const tok of ['node:fs', 'node:path', 'node:url', 'process.', 'Date.now', 'Math.random', 'require(']) {
    ok(!src.includes(tok), `golden.mjs 里出现了「${tok}」——它必须是纯数据（浏览器也要 import 同一份）`);
  }
  ok(!/^\s*import\s/m.test(src), 'golden.mjs 不许 import 任何东西（引擎之外零依赖，浏览器侧才能单独读它）');
}

/* ---- 1) 确定性卫兵 ---- */
const twice = FIXES.map((f) => JSON.stringify(produceRecord(f)));
const twice2 = FIXES.map((f) => JSON.stringify(produceRecord(f)));
ok(twice.every((s, i) => s === twice2[i]), '同一批 seed 连跑两遍结果不同 ⇒ seed 不再是纯函数（查 Date.now / Math.random）');

/* ---- 2) 活引擎 == 冻结数据，逐字 ---- */
let dig = '';
for (let k = 0; k < GOLDEN.length; k++) {
  const rec = GOLDEN[k];
  const tag = `${rec.w}×${rec.h} seed=${rec.seed}`;
  ok(rec.v === GOLDEN_SCHEMA, `${tag}：schema 版本 ${rec.v} != ${GOLDEN_SCHEMA}`);
  ok(Array.isArray(rec.clues) && rec.clues.every(([i, d, n]) => i >= 0 && i < rec.w * rec.h && d >= 0 && d < 4 && Number.isInteger(n) && n >= 0),
    `${tag}：clues 结构不对`);
  ok(rec.clues.every(([i], x) => x === 0 || i > rec.clues[x - 1][0]), `${tag}：clues 必须按格号升序（指纹的规范化依赖这条）`);
  ok(rec.edgeIds.every((e, x) => x === 0 || e > rec.edgeIds[x - 1]), `${tag}：edgeIds 必须严格升序`);
  // 冻结的边编号必须真的对应四邻格（编号口径 = a*n+b, a<b）
  const n = rec.w * rec.h;
  ok(rec.edgeIds.every((e) => {
    const a = Math.floor(e / n), b = e % n;
    if (!(a < b)) return false;
    const [r1, c1] = [Math.floor(a / rec.w), a % rec.w], [r2, c2] = [Math.floor(b / rec.w), b % rec.w];
    return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
  }), `${tag}：edgeIds 里有非正交相邻或编号口径不符的边`);

  const fresh = produceRecord({ w: rec.w, h: rec.h, seed: rec.seed });
  ok(JSON.stringify(fresh) === JSON.stringify(rec), `${tag}：活引擎重现的盘与冻结快照不一致\n    冻结 ${JSON.stringify(rec).slice(0, 200)}\n    现产 ${JSON.stringify(fresh).slice(0, 200)}`);
  ok(fingerprintOf(rec) === rec.fingerprint, `${tag}：冻结记录自身的指纹对不上（数据被手改过？）`);
  ok(fresh.stats.stillSolved === true, `${tag}：出货盘铅笔没推完`);
  // pDig 的账本只是观察量：over = 删除复核时 DP 预算耗尽（那一刀一律**不**保留），
  // stuck = 铅笔没解完所以根本没跑计数。红线上要求的是「没验完的删除不许留」，
  // 这条由 js/engine/generate.js 的 pDig 闸门结构上保证（stopped ⇒ 不进 removed）。
  ok(fresh.stats.over + fresh.stats.stuck + fresh.stats.unsound <= fresh.stats.tried,
    `${tag}：pDig 账本对不上（tried=${fresh.stats.tried} over=${fresh.stats.over} stuck=${fresh.stats.stuck} unsound=${fresh.stats.unsound}）`);
  dig += ` ${tag.split(' ')[0]}:删${fresh.stats.removed}/试${fresh.stats.tried}·预算耗尽${fresh.stats.over}`;

  /* ---- 2) 再认证：只拿冻结线索喂计数器 ---- */
  const b = new Board(rec.w, rec.h);
  for (const [i, d, v] of rec.clues) b.clue.set(i, { dir: d, n: v });
  const c = countSolutions(b, { limit: Infinity, collect: 1, budgetNodes: 50_000_000 });
  ok(!c.stopped && !c.capped, `${tag}：再认证被预算截断（nodes=${c.nodes} stopped=${c.stopped}）——唯一性没证完就不算数`);
  ok(c.count === 1, `${tag}：只拿冻结线索重数，解数 = ${c.count}，不是 1 ⇒ 冻结的「唯一解」认证不可复现`);
  if (c.count === 1) {
    const ans = materialize(b, c.sols[0]);
    ok([...ans.black].sort((x, y) => x - y).join() === rec.black.join(), `${tag}：计数器那张解的黑格与冻结不符`);
    ok([...ans.loop].sort((x, y) => x - y).join() === rec.loop.join(), `${tag}：计数器那张解的环格与冻结不符`);
    ok([...ans.edges].map((e) => { const [a, q] = e.split(':').map(Number); return a * n + q; }).sort((x, y) => x - y).join() === rec.edgeIds.join(),
      `${tag}：计数器那张解的边集与冻结不符`);
    ok(verify(ans).length === 0, `${tag}：冻结答案过不了 verify()：${JSON.stringify(verify(ans))}`);
    // 角色全覆盖：每格恰好一种角色
    let roles = 0;
    for (let i = 0; i < n; i++) roles += (ans.clue.has(i) ? 1 : 0) + (ans.black.has(i) ? 1 : 0) + (ans.loop.has(i) ? 1 : 0);
    ok(roles === n, `${tag}：认证解的每格恰好一种角色被破坏（计到 ${roles}/${n}）`);

    /* ---- 3) 铅笔复跑 ---- */
    const p = pencil(b);
    ok(p.contradiction === null, `${tag}：铅笔在冻结盘上报矛盾「${p.contradiction}」`);
    ok(p.solved === true, `${tag}：铅笔没把冻结盘推完（${p.rolesDone}/${p.n} 格、${p.edgesDone}/${p.edgeTotal} 边）`);
    let mism = 0;
    for (let i = 0; i < n; i++) {
      const real = ans.clue.has(i) ? ROLE.CLUE : ans.black.has(i) ? ROLE.BLACK : ROLE.LOOP;
      if (p.role[i] !== real) mism++;
    }
    ok(mism === 0, `${tag}：铅笔推出的角色与认证解有 ${mism} 格不符（可靠性红线）`);
    let edgeMism = 0;
    for (let i = 0; i < n; i++) for (const d of [1, 2]) {
      const [r, cc] = [Math.floor(i / rec.w), i % rec.w], e = DIRS[d];
      const rr = r + e.dr, cq = cc + e.dc;
      if (rr < 0 || rr >= rec.h || cq < 0 || cq >= rec.w) continue;
      const j = rr * rec.w + cq, on = p.ed[i][d] === EDGE.E_ON;
      if (on !== ans.edges.has(Board.ek(i, j))) edgeMism++;
    }
    ok(edgeMism === 0, `${tag}：铅笔定的边与认证解有 ${edgeMism} 条不符`);
  }
}

const fps = GOLDEN.map((r) => r.fingerprint);
ok(new Set(fps).size === fps.length, 'golden 里有两条 seed 画出同一张盘（覆盖不足）');
console.log(`  ${GOLDEN.length} 条 golden 逐字重现、再认证唯一、铅笔全解无不符`);
console.log(`  pDig 账本（观察量）：${dig.trim()}`);
console.log(`  指纹：${fps.join(' ')}`);

console.log(`\nRESULT golden-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
