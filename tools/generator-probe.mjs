#!/usr/bin/env node
// 剂量表（需求卡第二节的判据 2 + 判据 1 的选择性证据）：每档出货 N 盘，把「出货墙钟、
// 计数器节点数、规则命中盘数、铅笔轮数/步数、废因」全部量出来。
//
// 这就是那张表的口径，引擎里一个环境变量都不读，所以口径只能写在这里：
//   N=16  ATTEMPTS=60  FRACS=0.45,0.5,0.55  SIZES=6x6,8x8,10x10,12x12
// 默认值就是这张表；跑别的大小要用环境变量，那属于"复现别机的读数"，不是出货策略。
//
// 红线（fail 就 exit 1，一条都不许放宽）：
//   出货 N/N、计数器 stopped 0 次、铅笔矛盾 0 条、推错角色 0 盘、挖完线索仍全解、
//   P10 命中盘数 0（需求卡第五节短板 1：它是健全性证人，不是难度梯级——真变了就要大声说）。
// 墙钟只列观测值，且必须带机器负载：同一段代码在 load 30 的机器上能慢 30% 以上。
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { makePencilBoard, DEFAULT_LOOP_FRACS, DEFAULT_MAX_ATTEMPTS, TIERS } from '../js/engine/generate.js';
import { pencil, RULES } from '../js/engine/pencil.js';

const N = Number(process.env.N || 16);
const ATTEMPTS = Number(process.env.ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
const FRACS = (process.env.FRACS || DEFAULT_LOOP_FRACS.join(',')) .split(',').map(Number);
const SIZES = (process.env.SIZES || TIERS.map((t) => t.key).join(',')).split(',').map((s) => s.split('x').map(Number));
const TAG = process.env.TAG || 'pg'; // 默认 tag 形状与判据轮一致：pg-6x6-0-a3

const med = (a) => { const x = a.slice().sort((m, n) => m - n); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
const q = (a, x) => { const b = a.slice().sort((m, n) => m - n); return b.length ? b[Math.min(b.length - 1, Math.ceil(x * b.length) - 1)] : NaN; };

let checks = 0;
const fails = [];
const ok = (cond, name, detail = '') => { checks++; if (!cond) { fails.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` :: ${detail}` : ''}`); } return !!cond; };

const UNK = 0, BLACK = 1, LOOP = 2, CLUE = 3;
// 铅笔推出来的角色与计数器认证的那张逐格对照；UNK（没推到）不算分歧，那是"没推完"不是"推错"
const mismatch = (board, p) => {
  const bad = [];
  for (let i = 0; i < board.n; i++) {
    if (p.role[i] === UNK) continue;
    const want = board.clue.has(i) ? CLUE : board.black.has(i) ? BLACK : LOOP;
    if (p.role[i] !== want) bad.push(`${i}:${p.role[i]}≠${want}`);
  }
  return bad;
};

console.log(`剂量表口径：N=${N} ATTEMPTS=${ATTEMPTS} FRACS=${FRACS.join('/')} SIZES=${SIZES.map(([w, h]) => `${w}x${h}`).join(',')}`);
console.log(`机器：${os.type()} ${os.release()} ${os.arch()}，${os.cpus().length} 核，起跑 load1/5/15 = ${os.loadavg().map((x) => x.toFixed(2)).join(' / ')}`);

const rows = [];
for (const [w, h] of SIZES) {
  const key = `${w}x${h}`;
  const lines = []; const dead = {};
  const t0 = performance.now();
  const per = []; const recs = [];
  let contra = 0, badRole = 0, stillBad = 0, stoppedSeen = 0, stuckSeen = 0, removedSum = 0;
  for (let s = 0; s < N; s++) {
    const b0 = performance.now();
    const r = makePencilBoard(`${TAG}-${key}-${s}`, w, h, { maxAttempts: ATTEMPTS, loopFracs: FRACS });
    const ms = performance.now() - b0;
    for (const [k, v] of Object.entries(r.dead || {})) dead[k] = (dead[k] || 0) + v;
    per.push(ms);
    if (!r.ok) { ok(false, `${key}#${s} 没出货`, `用了 ${ATTEMPTS} 次尝试仍废，废因 ${JSON.stringify(r.dead)}`); continue; }
    recs.push(r);
    // 独立复核：不用出题器递出来的那份 fired，重新跑一遍铅笔
    const p = pencil(r.board);
    if (p.contradiction) { contra++; ok(false, `${key}#${s} 出货盘上铅笔报矛盾`, p.contradiction); }
    const bad = mismatch(r.board, p);
    if (bad.length) { badRole++; ok(false, `${key}#${s} 铅笔推错角色 ${bad.length} 格`, bad.slice(0, 6).join(' ')); }
    if (!r.stillSolved) stillBad++;
    if (r.over > 0) stoppedSeen += r.over;   // over 的真义：删除复核时 DP 预算真的耗尽（不是「铅笔没解完」）
    stuckSeen += r.stuck || 0;
    removedSum += r.removed || 0;
  }
  const wall = performance.now() - t0;
  const hits = Object.fromEntries(RULES.map((x) => [x, 0]));
  for (const r of recs) for (const k of RULES) if (r.fired[k]) hits[k]++;
  const nodes = recs.map((r) => r.nodes);
  rows.push({ key, w, h, ship: recs.length, per, wall, dead, hits, nodes, recs, contra, badRole, stillBad, stoppedSeen, stuckSeen, removedSum, med, q });

  ok(recs.length === N, `${key} 必须出货 ${N}/${N}`, `实出 ${recs.length}/${N}，废因 ${JSON.stringify(dead)}`);
  ok(contra === 0, `${key} 铅笔矛盾必须为 0 盘`, `contra=${contra}`);
  ok(badRole === 0, `${key} 推错角色的盘必须为 0`, `badRole=${badRole}`);
  ok(stillBad === 0, `${key} 挖完线索后铅笔仍须全解`, `不全解 ${stillBad}/${recs.length}`);
  ok(hits['P10-cut-vertex'] === 0, `${key} P10 命中盘数变了（需求卡披露的是四档全 0；它不是难度梯级，别把它算进"用到的规则数"）`, `P10 命中 ${hits['P10-cut-vertex']}/${N} 盘`);
  ok(stoppedSeen === 0, `${key} pDig 的每一次删除复核都必须在预算内数完（撞预算 = 唯一性没证完的删除）`, `over=${stoppedSeen}`);
}

console.log('\n档位   出货   墙钟 ms（med/p95/max，含换盘重试）   计数器 nodes（med/max）   箭头/黑格/环格      尝试次数 med/max');
for (const r of rows) {
  const clue = r.recs.map((x) => x.clues), blk = r.recs.map((x) => x.board.black.size), lp = r.recs.map((x) => x.board.loop.size);
  const at = r.recs.map((x) => x.attempts);
  console.log(
    `${r.key.padEnd(6)} ${(r.ship + '/' + N).padEnd(6)} ` +
    `${med(r.per).toFixed(0)}/${r.q(r.per, 0.95).toFixed(0)}/${Math.max(0, ...r.per).toFixed(0)} 的墙钟`.padEnd(34) +
    `${med(r.nodes)}/${Math.max(0, ...r.nodes)}`.padEnd(23) +
    `${med(clue)}/${med(blk)}/${med(lp)} of ${r.w * r.h}`.padEnd(20) +
    `${med(at)}/${Math.max(0, ...at)}`
  );
}
console.log('\npDig 极小化账本（观察量）：删掉的箭头数 / 试过的删除 / 铅笔没解完而没跑计数（stuck）');
for (const r of rows) console.log(`  ${r.key.padEnd(6)} 删 ${String(r.removedSum).padEnd(4)} 试 ${String(r.recs.reduce((a, x) => a + (x.tried || 0), 0)).padEnd(5)} stuck=${r.stuckSeen} 预算耗尽=${r.stoppedSeen}`);
console.log('\n规则命中盘数（至少命中一次的盘数 / 出货盘数）：');
for (const r of rows) console.log(`  ${r.key.padEnd(6)} ${RULES.map((k) => `${k.split('-')[0]}:${r.hits[k]}`).join(' ')}`);
console.log('\n铅笔推进（轮数 med/max、推导步数 med/max）与废因：');
for (const r of rows) {
  const ps = r.recs.map((x) => x.passes), st = r.recs.map((x) => x.steps);
  console.log(`  ${r.key.padEnd(6)} 轮 ${med(ps)}/${Math.max(0, ...ps)} 步 ${med(st)}/${Math.max(0, ...st)}｜废因 ${JSON.stringify(r.dead)}｜出货总墙钟 ${r.wall.toFixed(0)}ms`);
}
console.log(`\n收尾时机器负载 load1/5/15 = ${os.loadavg().map((x) => x.toFixed(2)).join(' / ')}（墙钟是这趟负载下的观测值，不是最坏值）`);

console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 12)) console.log(`  ✗ ${f}`);
console.log(`RESULT generator-probe ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
