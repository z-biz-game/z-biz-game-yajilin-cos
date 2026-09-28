#!/usr/bin/env node
// 档外天花板：量 14×14 与 16×16（菜单只有 TIERS 里 inMenu 的那三档，顶到 10×10；`js/engine/generate.js:35-40`），
// 把 README §五「不承诺菜单外的档能出货」和 DESIGN §七 那两行数字变成**clone 之后重跑得出来**的数。
// 需求卡第一节原来那批数出自仓外的桌面筛探针，本机之外无法复现——这个文件就是它的户口。
//
// 口径与档内**逐字相同**，这样「越线」才是同一个尺子量出来的：
//   ATTEMPTS=60（DEFAULT_MAX_ATTEMPTS，js/engine/generate.js:28）
//   FRACS=0.45/0.5/0.55（DEFAULT_LOOP_FRACS，js/engine/generate.js:27）
//   seed = `${TAG}-${key}-${i}`，i=0..3，TAG 默认 'cl' —— 四颗 seed 写死在这里，
//   不由日期派生（家族红线：日期当 seed ⇒ 同一句话第二天就不是同一件事）。
//
// 三件事一起成立才叫「越线」（DESIGN §七）：出不了货、出货的那些贴着封顶、墙钟进到秒级。
// 唯一废因必须是 PLATEAU：一旦出现 COUNTER / stopped，卡住档位的就不再是自由度 1/2 而是 DP 成本，
// 那是**结论变了**，C2 会直接红，需要重写 DESIGN §七 而不是改判据。
//
// 不进 CI：它是量天花板的，不是门；写进 CI 就变成每天重测一次结论。
// （分工抄 z-biz-game-triplets-cos/.github/workflows/ci.yml:52-59 —— balance 进 CI 当独立 step，
//   npm run ceiling 不进。）
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  makePencilBoard, DEFAULT_LOOP_FRACS, DEFAULT_MAX_ATTEMPTS, CERT_BUDGET_NODES,
} from '../js/engine/generate.js';
import { countSolutions } from '../js/engine/counter.js';

const ATTEMPTS = Number(process.env.ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
const FRACS = (process.env.FRACS || DEFAULT_LOOP_FRACS.join(',')).split(',').map(Number);
const TAG = process.env.TAG || 'cl';
const SIZES = (process.env.SIZES || '14x14,16x16').split(',').map((s) => s.split('x').map(Number));
const SEEDS = (process.env.SEEDS || '0,1,2,3').split(',').map(Number);

// —— 撞线判据（C3）：两条绝对值，来历写在下面这几行，判据本身一条没动 ——
// 「房子口径」：一次「换一局」的等待超过 2000 ms 就不许当产品路径卖——量的是玩家等不等得起，机器快慢不算理由。
//   参照批（菜单顶档六颗 seed）**每次现量、不进下面那张 RECORD 对账表**：C3a 那行打印的就是这一趟的读数，代码里不存它。
//   14×14 / 16×16 那八颗的逐样本读数才钉在下面 RECORD——而且 C1 只按 ×[0.4, 3] 对**量级**，不逐位相等（墙钟对负载敏感）。
//   ⇒ 2000 ms 夹在菜单顶档与档外两档之间；12×12 本机与 CI runner 分别落在这条线的两侧（四次复跑与 runner 读数都在 DESIGN 第七节），2026-09-29 降出菜单。
const HOUSE_MS = Number(process.env.HOUSE_MS || 2000);
// 菜单档的 p95 绝对值线：与 tools/balance.mjs 的 B6 同一个数（那里判 TIERS.inMenu 那几档，这里复测顶档当参照）。
const MENU_P95_CEILING_MS = Number(process.env.MENU_CEILING || 2000);
// C3 的参照批次：菜单顶档——12×12 于 2026-09-29 降出菜单（账在 DESIGN 第七节），现在顶档是 10×10。
const REF_SIZE = [10, 10];
const REF_SEEDS = 6;

// —— C1 的对账表：钉住的那批形状；README §五 与 DESIGN §七 引用的是它，不是某一趟的观测值 ——
// 表里存的**就是本文件用这四颗 seed 重跑出来的数**。
// ⚠ 与仓外桌面筛探针的旧读数不一致：旧那批（探针自己的 tag，仓里没有）读的是
//   14×14 出货 3/4、16×16 出货 1/4；本文件这四颗 seed 读的是**两档都 0/4**。
//   差别来自 seed 空间换了，不是流水线变了（剂量表四档的确定量认证 nodes 1623/4250、344/6474
//   与 DESIGN §七 那张表逐字相同，可作对照）。旧读数在仓里没有出处，所以文档以仓内这一份为准。
// wallTol：逐样本墙钟的允许区间（相对表值）——墙钟对负载敏感，这里只抓量级漂移；
// 出货 seed、attempts、PLATEAU 累计都是确定量，逐颗对死。
const RECORD = {
  '14x14': { ship: [], walls: [3229, 2983, 3072, 3131], attempts: [], plateau: 240, wallTol: [0.4, 3] },
  '16x16': { ship: [], walls: [4462, 5283, 5076, 5546], attempts: [], plateau: 240, wallTol: [0.4, 3] },
};

const sorted = (a) => a.slice().sort((x, y) => x - y);
const med = (a) => { const x = sorted(a); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
const q = (a, x) => { const b = sorted(a); return b.length ? b[Math.min(b.length - 1, Math.ceil(x * b.length) - 1)] : NaN; };
const imax = (a) => Math.max(0, ...a);

let checks = 0, fails = 0;
const ok = (cond, name, detail = '') => {
  checks++;
  if (!cond) { fails++; }
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
  return !!cond;
};

const LOAD_BEFORE = os.loadavg().map((x) => x.toFixed(2)).join(' / ');
console.log('================================================================================');
console.log('YAJILIN CEILING — 档外天花板（14×14 / 16×16，出货默认值一字不改）');
console.log(`口径      : ATTEMPTS=${ATTEMPTS} FRACS=${FRACS.join('/')} TAG=${TAG} SEEDS=${SEEDS.join(',')}`);
console.log(`机器      : ${os.type()} ${os.release()} ${os.arch()}，${os.cpus().length} 核，node ${process.version}`);
console.log(`负载      : load1/5/15 before = ${LOAD_BEFORE}`);
console.log('================================================================================');

const results = {};
for (const [w, h] of SIZES) {
  const key = `${w}x${h}`;
  const per = [];
  const dead = {};
  const ship = [];
  const nodes = [];
  console.log(`\n【${key}】逐样本（墙钟 ms / attempts / 废因 / 认证 nodes）：`);
  for (const i of SEEDS) {
    const seed = `${TAG}-${key}-${i}`;
    const b0 = performance.now();
    const r = makePencilBoard(seed, w, h, { maxAttempts: ATTEMPTS, loopFracs: FRACS });
    const ms = performance.now() - b0;
    per.push(ms);
    for (const [k, v] of Object.entries(r.dead || {})) dead[k] = (dead[k] || 0) + v;
    if (r.ok) {
      // 独立重跑认证计数：不用 shipBoard 自记的那笔账（家族坑：自记的答案会说谎）
      const cert = countSolutions(r.board, { limit: Infinity, budgetNodes: CERT_BUDGET_NODES, collect: 1 });
      ship.push({ i, ms, attempts: r.attempts, nodes: r.nodes, certNodes: cert.nodes, stopped: cert.stopped, count: cert.count });
      nodes.push(r.nodes);
      console.log(`  seed ${seed.padEnd(12)} 出货  墙钟 ${String(Math.round(ms)).padStart(5)} ms  attempts ${String(r.attempts).padStart(2)}/${ATTEMPTS}  nodes ${String(r.nodes).padStart(5)}（重跑认证 ${cert.nodes}，count=${cert.count}，stopped=${cert.stopped}）  箭头 ${r.clues}`);
    } else {
      console.log(`  seed ${seed.padEnd(12)} 没出货 墙钟 ${String(Math.round(ms)).padStart(5)} ms  attempts ${ATTEMPTS}/${ATTEMPTS}（撞封顶）  废因 ${JSON.stringify(r.dead)}`);
    }
  }
  results[key] = { per, dead, ship, nodes };
  const shippedIdx = ship.map((s) => s.i);
  console.log(`  —— ${key}：出货 ${ship.length}/${SEEDS.length}（seed 序号 ${shippedIdx.join(' ') || '无'}）｜逐样本墙钟 [${per.map((x) => Math.round(x)).join(' ')}] ms｜累计废因 ${JSON.stringify(dead)}`);
}

// —— C1：与文档那张表对账（出货颗数与 attempts 是确定量，墙钟给区间）——
console.log('\n── C1 与 README §五 / DESIGN §七 那张表对账 ──');
for (const key of Object.keys(results)) {
  const rec = RECORD[key];
  const got = results[key];
  if (!rec) { ok(false, `C1 ${key} 表里没有这一档`, '本文件里 RECORD 那张表要跟文档同步'); continue; }
  const gotShip = got.ship.map((s) => s.i);
  ok(gotShip.join(',') === rec.ship.join(','), `C1 ${key} 出货 seed 必须与表一致：[${rec.ship.join(' ')}]`,
    `实收 [${gotShip.join(' ') || '无'}]（出货 ${gotShip.length}/${SEEDS.length}）`);
  // 逐样本墙钟：负载下的观测值，给 ×[lo, hi] 的量级区间
  rec.walls.forEach((want, k) => {
    if (got.per[k] === undefined) { ok(false, `C1 ${key} 表里有第 ${k + 1} 颗、这趟没跑到`, `表 ${want} ms`); return; }
    const [lo, hi] = rec.wallTol;
    ok(got.per[k] >= want * lo && got.per[k] <= want * hi, `C1 ${key} seed#${SEEDS[k]} 墙钟 ${Math.round(got.per[k])} ms 落在表值 ${want} ms 的 ×[${lo}, ${hi}] 内`,
      '这条只抓量级漂移（慢 3 倍 ⇒ 机器或流水线变了），不抓抖动');
  });
  // 出货的那些：attempts 与认证 nodes 是确定量，逐颗对死
  rec.ship.forEach((i, k) => {
    const s = got.ship.find((x) => x.i === i);
    if (!s) { ok(false, `C1 ${key} seed#${i} 表里出货、这趟没出货`, `表 attempts ${rec.attempts[k]}`); return; }
    ok(s.attempts === rec.attempts[k], `C1 ${key} seed#${i} attempts 必须逐颗相等（确定量）`, `表 ${rec.attempts[k]}，实收 ${s.attempts}`);
    console.log(`  读数 C1 ${key} seed#${i}：墙钟 ${Math.round(s.ms)} ms｜attempts ${s.attempts}/${ATTEMPTS}（表 ${rec.attempts[k]}）｜nodes ${s.nodes}（重跑认证 ${s.certNodes}）`);
  });
  console.log(`  读数 C1 ${key}：逐样本墙钟 [${got.per.map((x) => Math.round(x)).join(' ')}]（表 [${rec.walls.join(' ')}]）｜出货 [${gotShip.join(' ') || '无'}]（表 [${rec.ship.join(' ') || '无'}]）`);
  const plateau = got.dead.PLATEAU || 0;
  ok(plateau === rec.plateau, `C1 ${key} PLATEAU 累计必须等于表值 ${rec.plateau}`, `实收 ${plateau}，全部废因 ${JSON.stringify(got.dead)}`);
}

// —— C2：废因只能还是 PLATEAU；计数器一次都不许撞预算 ——
console.log('\n── C2 废因与计数器预算（结论变了就红，别改判据）──');
for (const key of Object.keys(results)) {
  const got = results[key];
  const others = Object.entries(got.dead).filter(([k]) => k !== 'PLATEAU');
  ok(others.length === 0, `C2 ${key} 废因分布里除了 PLATEAU 不许有别的`,
    others.length ? `出现了 ${JSON.stringify(Object.fromEntries(others))}——DESIGN §七 的「唯一废因是 PLATEAU」不再成立` : `PLATEAU ${got.dead.PLATEAU || 0}`);
  const stopped = got.ship.filter((s) => s.stopped);
  ok(stopped.length === 0, `C2 ${key} 出货盘独立重跑认证计数：stopped 必须 0`, `stopped ${stopped.length} 盘`);
  ok(got.ship.every((s) => s.count === 1), `C2 ${key} 出货盘认证 count 必须恰好 1（不是「≥1 解」）`,
    got.ship.map((s) => `#${s.i}:${s.count}`).join(' ') || '无出货盘');
  const maxNodes = got.nodes.length ? imax(got.nodes) : 0;
  if (got.ship.length === 0) {
    console.log(`  读数 C2 ${key}：0 颗出货 ⇒ 认证计数那一步（js/engine/generate.js:155）压根没跑到，DP 成本无从观测；「卡住的不是计数器」这一条由上面那条废因分布承担`);
  } else {
    console.log(`  读数 C2 ${key}：认证 nodes max ${maxNodes}｜CERT_BUDGET_NODES ${CERT_BUDGET_NODES}｜占预算 ${(maxNodes / CERT_BUDGET_NODES * 100).toFixed(4)}%`);
    ok(maxNodes < CERT_BUDGET_NODES / 100, `C2 ${key} 最坏那张盘的 nodes 必须离预算差两个数量级（离 DP 成本还有多远）`,
      `max=${maxNodes}，预算的 1% = ${Math.floor(CERT_BUDGET_NODES / 100)}`);
  }
}

// —— C3：两条撞线判据 ——
console.log('\n── C3 撞线判据（菜单档 p95 ≤ 绝对值 / 越过房子口径记 unshippable）──');
const refPer = [];
for (let i = 0; i < REF_SEEDS; i++) {
  const b0 = performance.now();
  makePencilBoard(`${TAG}-ref-${REF_SIZE[0]}x${REF_SIZE[1]}-${i}`, REF_SIZE[0], REF_SIZE[1], { maxAttempts: ATTEMPTS, loopFracs: FRACS });
  refPer.push(performance.now() - b0);
}
const refP95 = q(refPer, 0.95);
console.log(`  参照 ${REF_SIZE[0]}x${REF_SIZE[1]}（菜单最高档，${REF_SEEDS} 颗 seed）墙钟 [${refPer.map((x) => Math.round(x)).join(' ')}] ms → med ${Math.round(med(refPer))} / p95 ${Math.round(refP95)} ms`);
ok(refP95 <= MENU_P95_CEILING_MS, `C3a 菜单档 p95 必须 ≤ ${MENU_P95_CEILING_MS} ms（与 tools/balance.mjs 的 B6 同一个数）`,
  `实测 p95 ${Math.round(refP95)} ms；这条与档外无关，它守的是「档内还是房子口径」`);
for (const key of Object.keys(results)) {
  const got = results[key];
  const unship = got.per.filter((x) => x > HOUSE_MS).length;
  const shippedOver = got.ship.filter((s) => s.ms > HOUSE_MS);
  const shipMedWall = got.ship.length ? med(got.ship.map((s) => s.ms)) : NaN;
  console.log(`  读数 C3 ${key}：${SEEDS.length} 颗里 ${unship} 颗越过 ${HOUSE_MS} ms（出货的 ${shippedOver.length}/${got.ship.length} 颗）｜出货样本墙钟 med ${got.ship.length ? Math.round(shipMedWall) : '—'} ms｜出货样本 attempts max ${got.ship.length ? imax(got.ship.map((s) => s.attempts)) : '—'}/${ATTEMPTS}`);
  // 「出不了货」这条腿：四颗 seed 里必须至少有一颗敲不出盘（全出 ⇒ 这一档该进菜单）
  ok(got.ship.length < SEEDS.length, `C3b ${key} 不许四颗 seed 全出货（全出就该把这一档放回菜单 TIERS[].inMenu）`,
    `实出 ${got.ship.length}/${SEEDS.length}`);
  // 「墙钟进到秒级」这条腿：出货那些盘的墙钟中位数必须越过房子口径（一颗都没出货时由 C3b 承担）
  ok(got.ship.length === 0 || shipMedWall > HOUSE_MS, `C3c ${key} 出货样本的墙钟 med 必须越过房子口径 ${HOUSE_MS} ms ⇒ 整档记 unshippable`,
    got.ship.length ? `med ${Math.round(shipMedWall)} ms ≤ ${HOUSE_MS} ms——那就不是「越线」，得重议 TIERS 上限` : `这趟 0/${SEEDS.length} 出货，这条腿空转，由 C3b 承担`);
}

const LOAD_AFTER = os.loadavg().map((x) => x.toFixed(2)).join(' / ');
console.log(`\n负载      : load1/5/15 after = ${LOAD_AFTER}（before ${LOAD_BEFORE}）`);
console.log('以上墙钟都是这趟负载下的**观测值，不是最坏值**；档外的结论只有一条：这两档不在菜单里，出货率不是承诺。');
console.log(`断言 ${checks} 条，红 ${fails} 条`);
console.log(`RESULT ceiling ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
