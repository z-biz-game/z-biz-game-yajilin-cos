#!/usr/bin/env node
// 平衡闸（需求卡第四节）：按档量**出货路径**的耗时口径，并把这个口径写成红线。
//
// seed 空间与 tools/generator-probe.mjs **同一颗**（tag = `${TAG}-${key}-${s}`，
// 默认 TAG='pg'、ATTEMPTS=60、FRACS=0.45/0.5/0.55、同一份 TIERS），
// 所以这里量的就是剂量表那批盘——差别只在剂量表把墙钟当**观测值**打印，
// 这个文件把墙钟变成**判据**（budgetMs / band），并且逐档打印绝对值。
//
// 公式抄的是家族里那两个仓的**代码**（不是注释）：
//   budgetMs = max(10, ceil(p95 * 4 / 10) * 10)                       —— z-biz-game-hidato-cos/tools/balance.mjs:100
//   band     = [max(1, floor(med * 0.4)), max(lo + 1, ceil(p95 * 1.6))] —— 同文件 :96-99
//   墙钟判 p95、不判单次 max；HEADROOM = 2                             —— z-biz-game-zebra-cos/tools/balance.mjs:39、:181-192
// 需求卡那条「不许用『中位×2』当基线」由 B1 落实：budgetMs 只由 p95 决定，med 进不了这个式子。
//
// ⚠ 下面 MEASURED 那张表是**量出来的**，不是感觉：一台 laptop（15 核、node v26.8.1）加 CI
//   runner 上的三趟读数，一格一趟真实跑（口径与「为什么钉 runner」写在那张表的表头）。SAMPLES=16，收尾行每次重念负载。
//   它**没有**进 js/engine/generate.js 的档位表：那张表一动（哪怕只动 inMenu 那个开关），浏览器闸那 288 条
//   断言就得重跑——2026-09-29 那一轮真的重跑了一遍（账在 DESIGN 第七节）。band/budgetMs 只活在本文件。
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  makePencilBoard, DEFAULT_LOOP_FRACS, DEFAULT_MAX_ATTEMPTS, TIERS,
  CERT_BUDGET_NODES, DIG_BUDGET_NODES,
} from '../js/engine/generate.js';
import { countSolutions } from '../js/engine/counter.js';
import { pencil } from '../js/engine/pencil.js';
import { recompute } from '../js/engine/model.js';

const SAMPLES = Number(process.env.SAMPLES || process.env.N || 16);
const ATTEMPTS = Number(process.env.ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
const FRACS = (process.env.FRACS || DEFAULT_LOOP_FRACS.join(',')).split(',').map(Number);
const TAG = process.env.TAG || 'pg';   // 与剂量表同一段 seed 空间，别另起一套
const HEADROOM = Number(process.env.HEADROOM ?? 2);

// 钉住的 med/p95/max（ms）——每一格都是**一趟真实跑**的读数，不合并、不手调：
//   laptop：2026-09-29 本机 15 核、load1 1.66、node v26.8.1、SAMPLES=16。
//   ci-a0 ：run 36463860182 的 node job（2 核 ubuntu-latest、load1 0.82）。README §五 早就记着这一趟，
//           它四条 p95 都低于后面两趟——加它不挪线，只是让包络不是"照着一趟调出来的"。
//   ci-a1 / ci-a2：**同一笔 commit e7db44f、同一台 4 核 ubuntu runner（node v22.23.3）的两趟**
//              = run 37190952460 的 attempt 1（6x6 p95 读 36 → 那一趟 B1 红）与 attempt 2（6x6 p95 读 22 → 绿），
//              中间一行代码没改。
// ⚠ 分位数口径沿用 tools/generator-probe.mjs:26（q(p95) 取 ceil(0.95×N)−1 那一格），
//   所以 N=16 时 p95 **就是** max——这条不是抖动估计，是「16 张里最狠那张」，定价因此偏保守。
//   band 与 budgetMs 由**同一套公式**从这些读数现算，表里不存任何手调过的整数。
// ⚠ 为什么要钉 runner 那三趟：最小档的墙钟里固定开销占大头（本机 med 1 ms、runner med 4–5 ms），
//   同一段代码在 runner 上读 22–36 ms 是**机器差**不是**代码差**——attempt 1 红、attempt 2 绿就是当场证据。
//   拿 laptop 的绝对值判 runner 就是这个仓 B6 那次的病（账在 DESIGN 第七节，当时的处置是把 12×12 请出菜单——那是改产品换绿）。
//   这条线现在判的是**机器类包络**：本趟必须赢过「钉过的读数里最狠那一趟 × 4」。换绿不许动公式，只许再添一趟真实读数。
//   **代码变慢**不靠这条抓：golden 把 stats.attempts/nodes/rounds/steps 整条记录按 JSON 逐字比
//   （tools/golden-test.mjs:71），跨机器、跨引擎恒等，那才是算法层面的回归网。
const MEASURED = {
  '6x6': [{ who: 'laptop', med: 1, p95: 6, max: 6 }, { who: 'ci-a0', med: 4, p95: 25, max: 25 }, { who: 'ci-a1', med: 5, p95: 36, max: 36 }, { who: 'ci-a2', med: 4, p95: 22, max: 22 }],
  '8x8': [{ who: 'laptop', med: 6, p95: 38, max: 38 }, { who: 'ci-a0', med: 22, p95: 76, max: 76 }, { who: 'ci-a1', med: 17, p95: 73, max: 73 }, { who: 'ci-a2', med: 18, p95: 95, max: 95 }],
  '10x10': [{ who: 'laptop', med: 43, p95: 188, max: 188 }, { who: 'ci-a0', med: 111, p95: 458, max: 458 }, { who: 'ci-a1', med: 108, p95: 470, max: 470 }, { who: 'ci-a2', med: 84, p95: 367, max: 367 }],
  '12x12': [{ who: 'laptop', med: 568, p95: 1193, max: 1193 }, { who: 'ci-a0', med: 1419, p95: 2985, max: 2985 }, { who: 'ci-a1', med: 1426, p95: 2997, max: 2997 }, { who: 'ci-a2', med: 1129, p95: 2346, max: 2346 }],
};
// 包络两端各取一头：下界是钉过的读数里**最快**的那趟 med，上界是**最慢**的那趟 p95。
const pinLowMed = (rows) => Math.min(...rows.map((r) => r.med));
const pinHighP95 = (rows) => Math.max(...rows.map((r) => r.p95));
const pinNames = (rows) => rows.map((r) => `${r.who} ${r.p95}`).join(' / ');

// 菜单档 p95 的**绝对值**红线（需求卡：给绝对值，不给倍数；判的是 TIERS.inMenu 那几档）。
// 这条线的来历没变：它比"档内最狠一档"的实测 p95 高一格，用来抓出货路径整体变慢。
// 变的是"谁在菜单里"——12×12（本机 p95 1193 / runner 2985）于 2026-09-29 降出菜单，顶档回到
// 10×10（本机 188 / runner 458）；数、判据、2000 这个数都没改，账与代价写在 DESIGN 第七节。
const MENU_P95_CEILING_MS = Number(process.env.MENU_CEILING || 2000);

// 极小性抽样口径：**不用随机数**（家族红线：seed 与抽样都不许沾时间/随机）。
// 每张盘取 IRRED_BOARDS 张盘、每盘按序号等距取 IRRED_PER_BOARD 颗箭头。
const IRRED_BOARDS = Math.min(4, SAMPLES);
const IRRED_PER_BOARD = 6;

const sorted = (a) => a.slice().sort((x, y) => x - y);
const med = (a) => { const x = sorted(a); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
const q = (a, x) => { const b = sorted(a); return b.length ? b[Math.min(b.length - 1, Math.ceil(x * b.length) - 1)] : NaN; };
const imax = (a) => Math.max(0, ...a);

const bandOf = (m, p95) => { const lo = Math.max(1, Math.floor(m * 0.4)); return [lo, Math.max(lo + 1, Math.ceil(p95 * 1.6))]; };
const budgetOf = (p95) => Math.max(10, Math.ceil(p95 * 4 / 10) * 10);

let checks = 0, fails = 0;
const ok = (cond, name, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${name}${detail ? ` :: ${detail}` : ''}`); }
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
  return !!cond;
};

// 摘一颗箭头之后会发生什么（generate.js 的 pDig 用的就是这四条出口 + 预算耗尽）
function probeRemoval(board, key) {
  const cl = board.clue.get(key);
  board.clue.delete(key);
  board.black.add(key);
  recompute(board);
  let outcome;
  if (board.neighbors(key).some((j) => board.black.has(j))) {
    outcome = 'adj';          // 改黑即撞黑格相邻：规则 3 直接违法，压根进不了复核
  } else {
    const p = pencil(board);
    if (p.contradiction) outcome = 'contra';
    else if (!p.solved) outcome = 'stuck';
    else {
      const c = countSolutions(board, { limit: 2, budgetNodes: DIG_BUDGET_NODES });
      outcome = c.stopped ? 'stopped' : (c.count === 1 ? 'removable' : 'multi');
    }
  }
  board.black.delete(key);
  board.clue.set(key, cl);
  recompute(board);
  return outcome;
}

function irredundancy(board) {
  const keys = [...board.clue.keys()].sort((a, b) => a - b);
  const stride = Math.max(1, Math.floor(keys.length / IRRED_PER_BOARD));
  const tally = { adj: 0, contra: 0, stuck: 0, multi: 0, stopped: 0, removable: 0, tried: 0 };
  for (let taken = 0, i = 0; i < keys.length && taken < IRRED_PER_BOARD; i += stride, taken++) {
    tally[probeRemoval(board, keys[i])]++;
    tally.tried++;
  }
  return tally;
}

const LOAD_BEFORE = os.loadavg().map((x) => x.toFixed(2)).join(' / ');
console.log('================================================================================');
console.log('YAJILIN BALANCE — 出货路径的平衡闸（档内四档，seed 空间同剂量表）');
console.log(`口径      : SAMPLES=${SAMPLES} 张/档  ATTEMPTS=${ATTEMPTS}  FRACS=${FRACS.join('/')}  TAG=${TAG}`);
console.log(`机器      : ${os.type()} ${os.release()} ${os.arch()}，${os.cpus().length} 核，node ${process.version}`);
console.log(`负载      : load1/5/15 before = ${LOAD_BEFORE}`);
console.log('================================================================================');

const rows = [];
for (const tier of TIERS) {
  const key = tier.key;
  const per = [];
  const dead = {};
  const recs = [];
  let over = 0, stuck = 0, unsound = 0, certStopped = 0, notSolved = 0, attemptsSum = 0;
  const t0 = performance.now();
  for (let s = 0; s < SAMPLES; s++) {
    const b0 = performance.now();
    const r = makePencilBoard(`${TAG}-${key}-${s}`, tier.w, tier.h, { maxAttempts: ATTEMPTS, loopFracs: FRACS });
    per.push(performance.now() - b0);
    for (const [k, v] of Object.entries(r.dead || {})) dead[k] = (dead[k] || 0) + v;
    if (!r.ok) continue;
    recs.push(r);
    attemptsSum += r.attempts;
    over += r.over;
    stuck += r.stuck;
    unsound += r.unsound || 0;
    if (r.stillSolved === false) notSolved++;
  }
  const tierWall = performance.now() - t0;
  const nodes = recs.map((r) => r.nodes);
  const m = med(per), p95 = q(per, 0.95), mx = imax(per);
  const budgetMs = budgetOf(p95);
  const band = bandOf(m, p95);
  rows.push({ key, per, recs, dead, m, p95, mx, budgetMs, band, nodes, tierWall, over, stuck, unsound, certStopped, notSolved, attemptsSum });

  // —— B1：本趟 p95 必须撑得住**机器类包络**那条线（budgetOf 公式一个字没改，改的是喂进去的那格：从「一台机器的读数」到「钉过的读数里最狠那一趟」） ——
  const ref = MEASURED[key];
  console.log(`\n【${key}】出货 ${recs.length}/${SAMPLES}｜墙钟 ms：med ${m.toFixed(0)} / p95 ${p95.toFixed(0)} / max ${mx.toFixed(0)}`);
  if (ref) {
    const badRow = ref.find((r) => !(r.med <= r.p95 && r.p95 <= r.max));
    ok(!badRow, `B1 ${key} 钉表每一格都得自洽（med ≤ p95 ≤ max）`, badRow ? JSON.stringify(badRow) : '');
    const pinP95 = pinHighP95(ref);
    const setBy = ref.filter((r) => r.p95 === pinP95).map((r) => r.who).join('+');
    const refBudget = budgetOf(pinP95);
    ok(p95 <= refBudget, `B1 ${key} 本趟 p95 ${p95.toFixed(0)} ms ≤ 包络 budgetMs ${refBudget} ms`,
      `钉了 ${ref.length} 趟（${pinNames(ref)} ms）→ 最狠那趟是 ${setBy} 的 p95=${pinP95} → budgetMs=max(10, ceil(p95×4/10)×10)=${refBudget} ms；本趟 p95 ${p95.toFixed(0)} ms 已经越过——要么这台机器比钉过的任何一台都慢（那就添一趟真实读数），要么流水线变了（后者由 golden 逐字对账抓，不靠这一条）`);
    console.log(`  读数 B1 ${key}：本趟现算 budgetMs=${budgetMs} ms（p95=${p95.toFixed(0)}）｜包络 budgetMs=${refBudget} ms（定线那趟=${setBy} p95=${pinP95}）｜钉表 ${pinNames(ref)}｜HEADROOM=${HEADROOM}`);
  } else {
    ok(false, `B0 ${key} MEASURED 表里没有这一档`, '先跑一趟把 med/p95/max 填进文件头的表，别把它当缺省绿');
  }

  // —— B2：band 判定（对每档**重算**并打印；判 med 落不落在包络 band 里——下界取最快那趟，上界取最慢那趟）——
  if (ref) {
    const refBand = bandOf(pinLowMed(ref), pinHighP95(ref));
    ok(m >= refBand[0] && m <= refBand[1], `B2 ${key} med ${m.toFixed(0)} ms 落在包络 band [${refBand.join(', ')}] 内`,
      `本趟重算的 band 是 [${band.join(', ')}]（[floor(med×0.4), ceil(p95×1.6)]）；包络下界=最快那趟 med ${pinLowMed(ref)}，上界=最慢那趟 p95 ${pinHighP95(ref)}`);
    console.log(`  读数 B2 ${key}：包络 band [${refBand.join(', ')}] ｜本趟重算 band [${band.join(', ')}]`);
  }

  // —— B3：计数器 stopped 必须为 0。两条独立来源：pDig 每次删除复核的 over，
  //     加上**本文件自己重跑一遍**的认证计数——不复用 shipBoard 自记的那笔账 ——
  let recert = null;
  if (recs.length) recert = countSolutions(recs[0].board, { limit: Infinity, budgetNodes: CERT_BUDGET_NODES, collect: 1 });
  ok(over === 0, `B3 ${key} pDig 的每一次删除复核都必须在预算内数完（over = 唯一性没证完的那次删除）`,
    `over=${over} stuck=${stuck}（stuck 是「铅笔没全解、压根没走到计数」，不是预算问题）`);
  ok(recert ? !recert.stopped : false, `B3 ${key} 独立重跑认证计数：不许 stopped`,
    recert ? `stopped=${recert.stopped} nodes=${recert.nodes}` : '这一档一张盘都没出，重跑无从谈起');
  ok(recert ? recert.count === 1 : false, `B3 ${key} 独立重跑认证计数：count 必须恰好 1（不是「≥1 解」）`,
    recert ? `count=${recert.count} capped=${recert.capped}` : '');
  console.log(`  读数 B3 ${key}：认证 nodes med ${med(nodes)} / max ${imax(nodes)}｜本文件重跑那颗 seed 的 nodes=${recert ? recert.nodes : '—'}｜CERT_BUDGET_NODES ${CERT_BUDGET_NODES}｜DIG_BUDGET_NODES ${DIG_BUDGET_NODES}`);

  // —— B4：满额出货 ∧ 出货盘铅笔全解；拒绝率与废因分布逐条打印（聚合数会说谎）——
  ok(recs.length === SAMPLES, `B4a ${key} 必须出货 ${SAMPLES}/${SAMPLES}`, `实出 ${recs.length}/${SAMPLES}，废因 ${JSON.stringify(dead)}`);
  ok(notSolved === 0, `B4b ${key} 零猜测 x/N 必须等于 N：出货盘铅笔全解 ${recs.length - notSolved}/${recs.length}`, `不全解 ${notSolved} 盘`);
  const shipAttempts = recs.reduce((a, r) => a + r.attempts, 0);
  const deadTotal = Object.values(dead).reduce((a, b) => a + b, 0);
  const totalAttempts = shipAttempts + deadTotal;  // 出货那张盘的 dead 账里存着它成功之前废掉的次数
  console.log(`  读数 B4 ${key}：总尝试 ${totalAttempts}（${recs.length} 颗 seed 用掉 ${shipAttempts} 次，max/盘 ${imax(recs.map((r) => r.attempts))}/${ATTEMPTS}）｜拒绝率 ${totalAttempts ? ((deadTotal / totalAttempts) * 100).toFixed(1) : '0.0'}% (${deadTotal}/${totalAttempts})｜被拒原因分布 ${JSON.stringify(dead)}｜挖掉的箭头合计 ${recs.reduce((a, r) => a + r.removed, 0)} 颗，unsound=${unsound}`);

  // —— B5：单颗摘除意义下的极小（正面判据）——
  const tally = { adj: 0, contra: 0, stuck: 0, multi: 0, stopped: 0, removable: 0, tried: 0 };
  for (const r of recs.slice(0, IRRED_BOARDS)) {
    const t = irredundancy(r.board);
    for (const k of Object.keys(tally)) tally[k] += t[k];
  }
  ok(tally.removable === 0, `B5 ${key} 抽 ${tally.tried} 颗箭头：摘掉之后「仍唯一 ∧ 铅笔仍全解」的必须 0 颗`,
    `removable=${tally.removable}（pDig 留着一颗能摘的箭头 = 极小性没成立）`);
  ok(tally.stopped === 0, `B5 ${key} 抽样复核里 DP 预算不许耗尽（耗尽那次删除的唯一性没证完）`, `stopped=${tally.stopped} / ${DIG_BUDGET_NODES} nodes`);
  console.log(`  读数 B5 ${key}：摘除结局分布 挨黑格相邻 ${tally.adj}｜铅笔推矛盾 ${tally.contra}｜铅笔不全解 ${tally.stuck}｜计数器说非唯一 ${tally.multi}｜预算耗尽 ${tally.stopped}｜真能摘 ${tally.removable}（共 ${tally.tried} 颗，取 ${Math.min(IRRED_BOARDS, recs.length)} 张盘 × ${IRRED_PER_BOARD} 颗，等距序号取，零随机）`);
}

// —— C3 的另一半（菜单档那条绝对值线）见 tools/ceiling.mjs 的文件头说明 ——
// B6 判的是**玩家选得到的那些档**（`TIERS.inMenu`）。12×12 于 2026-09-29 降出菜单：同一份代码
// 本机 12×12 p95 读 1193 ms（过线），CI 的 ubuntu-latest（2 核）同一轮读 2985 ms（上一轮 3120），
// 而这条线要承诺的是"玩家按下换一局要等多久"，runner 不是玩家设备。降级省掉的是机器差异，
// 代价是菜单顶档少一级——两笔都记在 DESIGN 第七节，判据本身（2000 ms 绝对值）一个字没改。
const MENU_KEYS = TIERS.filter((t) => t.inMenu).map((t) => t.key);
const worstP95 = Math.max(...rows.filter((r) => MENU_KEYS.includes(r.key)).map((r) => r.p95));
ok(worstP95 <= MENU_P95_CEILING_MS, `B6 菜单档 p95 的绝对值线：菜单里最狠一档 ${worstP95.toFixed(0)} ms ≤ ${MENU_P95_CEILING_MS} ms（菜单档 = ${MENU_KEYS.join('/')}）`,
  `越过就是出货路径整体变慢，得重估档位表；这一条与 tools/ceiling.mjs 的 C3 用同一个数`);
// B6b（ANTI-DRIFT）：降档是**改产品**，不是改门。这条不看机器、不看负载，只看菜单的形状——
//   顶档的面积不许比 10×10 小，所以"顺手把 inMenu 关掉一个来换绿"这条路是红的，而"把 12×12 装回来"
//   是绿的。它存在的意义就是让降级这件事有成本，跟当年那条墙钟线一样。
const TOP_MENU = TIERS.filter((t) => t.inMenu).reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
ok(TOP_MENU.w * TOP_MENU.h >= 100, `B6b 菜单顶档面积不得小于 10×10（当前 ${TOP_MENU.key}＝${TOP_MENU.w * TOP_MENU.h} 格）`,
  '再往下缩就是拿降级躲门：要缩得先改这一行与需求卡，并把 README/DESIGN 那两张梯级表一起改');
// 降出去的那一档不是"不再量"：它每轮照样进汇总，只是不再对玩家开放。
for (const r of rows.filter((x) => !MENU_KEYS.includes(x.key))) {
  console.log(`  档外（inMenu=false，仍每轮量、仍不进菜单）${r.key}：p95 ${r.p95.toFixed(0)} ms ｜ 本趟现算 budgetMs ${r.budgetMs}（包络那条线在上面 B1 读数里）｜ 出货 ${r.recs.length}/${SAMPLES}`);
}

const LOAD_AFTER = os.loadavg().map((x) => x.toFixed(2)).join(' / ');
console.log('\n汇总（每档绝对值，ms）');
for (const r of rows) {
  console.log(`  ${r.key.padEnd(6)} med ${String(r.m.toFixed(0)).padStart(5)} / p95 ${String(r.p95.toFixed(0)).padStart(6)} / max ${String(r.mx.toFixed(0)).padStart(6)}` +
    ` ｜ budgetMs ${String(r.budgetMs).padStart(5)} ｜ band [${r.band.join(', ')}] ｜ 出货 ${(r.recs.length + '/' + SAMPLES).padEnd(7)} ｜ 本档墙钟 ${r.tierWall.toFixed(0)} ms`);
}
console.log(`\n负载      : load1/5/15 after = ${LOAD_AFTER}（before ${LOAD_BEFORE}）`);
console.log('以上所有墙钟都是**这趟负载下的观测值，不是最坏值**；同一段代码在 load 30 的机器上能慢 30% 以上（tools/generator-probe.mjs:12）。');
console.log(`断言 ${checks} 条，红 ${fails} 条`);
console.log(`RESULT balance ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
