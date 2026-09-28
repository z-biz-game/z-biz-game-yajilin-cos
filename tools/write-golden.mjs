#!/usr/bin/env node
// 只有这个文件用 node API（fs / path / url）。tools/golden.mjs 必须是纯数据 + 一个纯函数，
// 这样浏览器里的引擎测试也能直接 import 它。
//
// 用法：
//   node tools/write-golden.mjs          （重新冻结，只替换 GOLDEN 数组那一段）
//   node tools/write-golden.mjs --check   （只对照不写盘：漂移就 exit 1 —— check.mjs 用这个）
//
// 冻结的内容 = 固定 seed 走完 shipBoard() 的全部输出（箭头三元组 + 认证解的角色/边 +
// 逐规则命中 + 流水线统计）。这些数字是引擎行为指纹：改规则表、改计数器、改 RNG 都会让
// tools/golden-test.mjs 变红。
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { shipBoard, TIERS } from '../js/engine/generate.js';
import { RULES } from '../js/engine/pencil.js';
import { fingerprintOf, GOLDEN_SCHEMA } from './golden.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'tools', 'golden.mjs');
const BEGIN = '// === GOLDEN-BEGIN（write-golden.mjs 只替换这一段）===';
const END = '// === GOLDEN-END ===';

// 冻结哪批 seed：四档尺寸每档至少一条、合计 ≥5 条 ⇒ 尺寸全覆盖 + 多条独立证据。
// ⚠ seed 不是随便挑的：golden 是 `node tools/check.mjs` 的一环，也是浏览器轮要重画的那批盘，
//   所以每个 seed 都得是「便宜的」那张（同一档里 p95 与中位差一个数量级，挑中位附近；
//   整份 golden 现在跑 ~1s）。改档位表或改出货策略时，在这里补 seed 并重跑本文件。
export const FIXES = [
  { w: 6, h: 6, seed: 'g6a' },
  { w: 6, h: 6, seed: 'g6b' },
  { w: 8, h: 8, seed: 'g8a' },
  { w: 8, h: 8, seed: 'g8b' },
  { w: 10, h: 10, seed: 'g10a' },
  { w: 10, h: 10, seed: 'g10b' },
  { w: 12, h: 12, seed: 'g12a' },
];

// 一条固定 seed 跑一遍出货 API，压成可 JSON 序列化的记录。
// 走的是 shipBoard（界面「换一局」那同一扇门），不是自己拼三段：
// 这样 golden 冻住的就是真实出货输出，包括「答案来自计数器」这一步。
export function produceRecord({ w, h, seed }) {
  const r = shipBoard(seed, w, h);
  if (!r.ok) throw new Error(`golden: ${w}×${h} seed=${seed} 没出货：${JSON.stringify(r.dead)}`);
  const b = r.board;
  const n = w * h;
  const clues = [...b.clue.entries()].map(([i, cl]) => [i, cl.dir, cl.n]).sort((x, y) => x[0] - y[0]);
  const black = [...b.black].sort((x, y) => x - y);
  const loop = [...b.loop].sort((x, y) => x - y);
  const edgeIds = [...b.edges].map((e) => { const [a, c] = e.split(':').map(Number); return a * n + c; }).sort((x, y) => x - y);
  const fired = {}; for (const k of RULES) fired[k] = r.fired[k] || 0;
  const rec = {
    v: GOLDEN_SCHEMA, w, h, seed, clues, black, loop, edgeIds, fired,
    stats: {
      natural: r.natural, mid: r.mid, clues: r.clues, attempts: r.attempts, rounds: r.rounds,
      removed: r.removed, tried: r.tried, over: r.over, stuck: r.stuck, unsound: r.unsound, nodes: r.nodes,
      passes: r.passes, steps: r.steps, stillSolved: r.stillSolved,
    },
  };
  rec.fingerprint = fingerprintOf(rec);
  return rec;
}

const oneLine = (rec) => '  ' + JSON.stringify(rec);

export function render(records) {
  return [
    BEGIN,
    'export const GOLDEN = [',
    records.map(oneLine).join(',\n'),
    '];',
    END,
  ].join('\n');
}

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// golden-test 也 import 本文件拿 produceRecord/FIXES，所以 CLI 那段必须真的挡住。
// 第一轮这里写成 `if (!IS_MAIN) { /* 什么都不做 */ }` —— 空块不是出口，模块被 import 时照样
// 落到下面，而 `--check` 不在 argv ⇒ 走 else 分支 writeFileSync：测试一边判红一边把自己判红的
// 那份快照重写回去（证据消失、工作区变脏、下一次跑「自然变绿」）。
// 门禁没有修数据这个动作：对照就是对照（checkFrozen），冻结只能是显式命令（freeze）。
export function checkFrozen() {
  const records = FIXES.map(produceRecord);
  if (!records.length) throw new Error('golden 是空的，无从冻结');
  if (!existsSync(TARGET)) { console.error('golden.mjs 不存在'); return 1; }
  const cur = readFileSync(TARGET, 'utf8');
  const i = cur.indexOf(BEGIN), j = cur.indexOf(END);
  if (i < 0 || j < 0) { console.error('golden.mjs 缺少 BEGIN/END 标记'); return 1; }
  const frozen = cur.slice(i, j + END.length).trim();
  const fresh = render(records).trim();
  if (frozen !== fresh) {
    console.error('GOLDEN 漂移：活引擎重跑这批 seed 得到的盘与冻结快照不一致（改到引擎了就 node tools/write-golden.mjs 重新冻结）');
    const a = JSON.parse('[' + frozen.slice(frozen.indexOf('[') + 1, frozen.lastIndexOf(']')).trim() + ']');
    for (let k = 0; k < Math.max(a.length, records.length); k++) {
      const x = JSON.stringify(a[k]), y = JSON.stringify(records[k]);
      if (x !== y) console.error(`  #${k} ${records[k] && records[k].seed}: 冻结 ${x ? x.slice(0, 160) : '—'} ≠ 现产 ${y ? y.slice(0, 160) : '—'}`);
    }
    return 1;
  }
  console.log(`RESULT golden-write ok=true checks=${records.length} fails=0（--check：冻结快照与活引擎逐字一致，全程只读）`);
  return 0;
}

export function freeze() {
  const records = FIXES.map(produceRecord);
  if (!records.length) throw new Error('golden 是空的，无从冻结');
  const cur = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  const i = cur.indexOf(BEGIN), j = cur.indexOf(END);
  if (i < 0 || j < 0) throw new Error('golden.mjs 缺少 BEGIN/END 标记，不肯整文件覆写');
  // render() 以 END 标记结尾且不带换行，cur.slice(j + END.length) 的第一个字符就是 END 那行的换行。
  // 这里原来手多加了一个 '\n' ⇒ 每冻结一次文件尾就多两行空行（跑一次就脏一次工作区）。
  writeFileSync(TARGET, cur.slice(0, i) + render(records) + cur.slice(j + END.length));
  console.log(`已冻结 ${records.length} 条 golden 到 tools/golden.mjs`);
  for (const r of records) console.log(`  ${r.w}x${r.h} ${r.seed} fp=${r.fingerprint} clues=${r.clues.length} nodes=${r.stats.nodes} attempts=${r.stats.attempts}`);
  return 0;
}

if (IS_MAIN) process.exitCode = process.argv.includes('--check') ? checkFrozen() : freeze();
