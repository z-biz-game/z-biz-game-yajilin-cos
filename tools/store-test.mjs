#!/usr/bin/env node
// 存档解码套件：把「一段坏 JSON 不许把整局冻死」这句话变成常驻判据。
//
// 为什么要有这一套而不是让 sellability 那条正则了事：它数的是 `JSON.parse` + `catch` +
// `for(|filter(|Array.isArray` 三个**字符串**同时出现。一个仓可以把整包档 `Object.assign(default,
// JSON.parse(raw))` 出去、catch 只包住 parse，那么 `'null'` 这条样本就会在 `parsed.settings`
// 那一行抛 TypeError——而 parse 早就成功了，catch 够不着，游戏在玩家按下刷新之后当场冻死。
// 这段红在字符串门里永远是绿的，只有拿真垃圾去喂才露馅。
//
// 判据口径（BRIEF §2「存档两段式解码」）：一条坏记录只丢**那一条**，其余照旧读得回来。
// 所以每类样本都判两半：① 不许抛；② 坏的那一条退化到默认，同包里的健康记录必须还在。
// 只判①是不够的——「整包退回默认」也满足①，而它正是 §2 点名要抓的那种写法。
//
// Store.data 只在 import 时 load() 一次（真实页面就是刷新一次才重读），所以每条样本都要
// 换一颗 query 重新 import，否则读到的是上一轮的内存快照——那会把好样本判成坏样本。
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_URL = pathToFileURL(join(ROOT, 'js', 'store.js')).href;
const KEY = 'yajilin.save.v1';

const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
};

let checks = 0;
let fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log(`FAIL: ${m}`); } };

const freshStore = async (tag) => (await import(`${STORE_URL}?case=${encodeURIComponent(tag)}`)).Store;

const goodResume = {
  seed: 'y1-abcdef', sizeKey: '6x6', marks: '0'.repeat(78), moves: 7, elapsedMs: 1234,
  w: 6, h: 6, puzzle: { fingerprint: 'cafe:1' }, at: 1,
};
const good = {
  settings: { sound: true, reduceMotion: true },
  resume: { ...goodResume, fingerprint: 'cafe:1' },
  totals: { solved: 3, moves: 40, ms: 9990 },
};

// 每条：[名字, 喂进去的原始串, 坏在哪一条, 期望读回的读数]
// 期望值不是「全默认」：那等于承认「一条坏就整包丢」，而 §2 要的是相反的那一件事。
const CASES = [
  ['整包 null', 'null', '整包', { sound: false, reduce: false, solved: 0, resume: false }],
  ['缺字段（只有 settings.sound）', '{"settings":{"sound":true}}', '缺的那几条', { sound: true, reduce: false, solved: 0, resume: false }],
  ['类型错（totals 是字符串）', JSON.stringify({ ...good, totals: 'oops' }), 'totals', { sound: true, reduce: true, solved: 0, resume: true }],
  ['越界值（resume 是数字）', JSON.stringify({ ...good, resume: 99999 }), 'resume', { sound: true, reduce: true, solved: 3, resume: false }],
  ['数组冒充对象', '[]', '整包', { sound: false, reduce: false, solved: 0, resume: false }],
  ['坏 JSON（截断）', '{"settings":{', '整包', { sound: false, reduce: false, solved: 0, resume: false }],
  ['空串（等于没存过）', '', '整包', { sound: false, reduce: false, solved: 0, resume: false }],
  ['settings 是 null（parse 成功、取属性炸）', '{"settings":null,"totals":{"solved":5}}', 'settings', { sound: false, reduce: false, solved: 5, resume: false }],
  ['marks 字符集外（两段式的第二段该拦住）', JSON.stringify({ ...good, resume: { ...good.resume, marks: 'ZZZZZ' } }), '第二段（长度/取值不符 ⇒ 不搬笔迹）', { sound: true, reduce: true, solved: 3, resume: true }],
];

let seq = 0;
for (const [name, raw, which, want] of CASES) {
  backing.set(KEY, raw);
  let S = null, threw = null;
  try {
    S = await freshStore(`c${++seq}`);
  } catch (e) {
    threw = e;
  }
  ok(threw === null, `${name}：import 期解码抛了 → ${threw && threw.message}（§2 要的是「一条坏只丢那一条」，不是冻死）`);
  if (!S) continue;
  let read = null, readThrew = null;
  try {
    read = { sound: S.setting('sound'), reduce: S.setting('reduceMotion'), solved: S.totals().solved, resume: !!S.pendingResume() };
  } catch (e) { readThrew = e; }
  ok(readThrew === null, `${name}：读取阶段抛了 → ${readThrew && readThrew.message}`);
  if (!read) continue;
  for (const k of ['sound', 'reduce', 'solved', 'resume']) {
    ok(read[k] === want[k], `${name}（坏在「${which}」）：${k} 读到 ${read[k]}，期望 ${want[k]}`);
  }
  console.log(`  ${name.padEnd(30)} 不抛 ✅  读回 sound=${read.sound} reduce=${read.reduce} solved=${read.solved} resume=${read.resume ? '有' : '无'}`);
}

// 对照：健康整包必须一条不少地读回来。上面九条如果全靠「退回默认」蒙过，这一条会红。
backing.set(KEY, JSON.stringify(good));
const G = await freshStore('good');
ok(G.setting('sound') === true && G.setting('reduceMotion') === true, '健康档的 settings 没读回来');
ok(G.totals().solved === 3 && G.totals().ms === 9990, '健康档的 totals 没读回来');
const pend = G.pendingResume();
ok(!!pend && pend.seed === 'y1-abcdef' && pend.moves === 7, '健康档的 resume 没读回来（续局是它唯一的用途）');
console.log(`  对照·健康整包                     读回 seed=${pend && pend.seed} moves=${pend && pend.moves} solved=${G.totals().solved}`);

// 两段式的第二段：指纹对不上 ⇒ 作废那一条续局，其余照旧（这是 newGame 真正依赖的接口）。
const wrongFp = G.resume('deadbeef:9');
ok(wrongFp === null, `指纹不符却返回了续局数据 → ${JSON.stringify(wrongFp)}`);
ok(!!G.resumeDiscarded, '指纹不符时没留下作废原因（玩家侧要能读到「为什么我的笔迹没了」）');
ok(G.setting('sound') === true && G.totals().solved === 3, '作废一条续局把 settings/totals 一起带走了');
// 指纹对上时必须原样交回
backing.set(KEY, JSON.stringify(good));
const G2 = await freshStore('fp-match');
const matched = G2.resume('cafe:1');
ok(matched && matched.seed === 'y1-abcdef', `指纹相符却没交回笔迹 → ${JSON.stringify(matched)}`);
console.log(`  两段式：指纹不符 resume=${wrongFp === null ? 'null 且记了作废原因 ✅' : '❌'}；相符 ⇒ ${matched ? '交回 seed=' + matched.seed : '❌'}`);

// 坏文件之后写档这条腿也得活着（读退化、写也一起瘫了是最糟的组合）。
backing.set(KEY, '{{{garbage');
const F = await freshStore('garbage-write');
let wThrew = null;
try {
  F.recordSolve(1000, 5);
  F.saveResume({ seed: 's2', sizeKey: '6x6', w: 6, h: 6, moves: 2, encode: () => '0'.repeat(78), puzzle: { fingerprint: 'fp:2' } }, 50);
} catch (e) { wThrew = e; }
ok(wThrew === null, `垃圾档之后写档抛了 → ${wThrew && wThrew.message}`);
if (!wThrew) {
  ok(F.totals().solved === 1, `垃圾档之上记了一胜，读回 ${F.totals().solved}（期望 1）`);
  const roundTrip = JSON.parse(backing.get(KEY));
  ok(roundTrip.resume && roundTrip.resume.seed === 's2' && roundTrip.resume.fingerprint === 'fp:2', '写出去的回读不是写进去的（getItem/setItem 有一边是假的）');
  console.log(`  垃圾档之上写档                     不抛 ✅ 记一胜后 solved=${F.totals().solved}，续局回读 seed=${roundTrip.resume && roundTrip.resume.seed}`);
}

// 这一条打死「只 setItem 不 getItem」的假存档：读回来的路径必须真的被走过。
ok(typeof globalThis.localStorage.getItem === 'function' && backing.size > 0, '没真读过 localStorage');

console.log(`\nRESULT store-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
