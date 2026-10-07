#!/usr/bin/env node
// ========================================
// tools/docs-test.mjs —— 文档行号对账（零依赖）
//
// README / DESIGN 里每个数字后面都挂着 `文件:行号`，那句"行号指本仓代码"必须有机器读回来。
// 只查"行号不超过文件长度"连隔壁一行都抓不住：本轮清出来的那条漂移（`generate.js:150` 指的是
// `ps.status`，`pSet(...)` 的调用在 149 行）稳稳落在界内，界内检查一条都不会红。所以加上锚点：
// 贴着引用写在反引号里的那个名字，必须真的出现在被指的那几行里。
//
// 规则与家族里其余四份（ferry / tatamibari / echo-location / creek / lightsout）同一份：
//   · 五种贴法都认——`name`（`path:NN`）、`path:NN`（`name`）、`path:NN` 的 `name`、
//     `path:NN`（`fn(a, b)`）的调用形式、`path:NN`（`dir/file.js::symbol`）的符号形式；
//   · `::` 取段排在 `/` 判据之前，否则带目录限定的符号名会被当成路径而丢掉锚点；
//   · 带 `<占位>` 的模板 body 取字面量前缀（只有真写了占位符才这么拆，否则 `test:syntax` 会拆成 `test`）；
//   · 带空格的 body 是命令行（`npm test`），按首词钉就是一次假红；
//   · 纯标点间隔（`，`、`、`）不构成指认——前面那个名字只是列表的上一项。
//
// 这一条腿不覆盖什么，写在 README 的「没有覆盖」里，别把它当成全量对账。
//
// 两种跑法：npm test 里由 tools/check.mjs import 后调 run(ok)，它进的是聚合那一行 RESULT
// （所以不占 SUITES 的名额，「六套」这个数不用改）；直接 node tools/docs-test.mjs 则自己打印
// 一行 RESULT docs-test，便于单独复跑这一条。
// ========================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATH_SRC = '[\\w./-]+?\\.(?:js|mjs|cjs|sh|json|yml|html|css)';
const CITE = new RegExp('^(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)$');
// 锚点可以是成员路径（`view.cellCenter`），但不许是文件路径：body 里带 `/` 的那一类是另一条引用，
// 把它当锚点按字符串去被指的那几行里找，只会凭空造出假红。
const ID = /^[A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]+)*$/;
const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const tpl = /^([^<>]+?)<[^<>\s]+>/.exec(seg);
  if (tpl && ID.test(tpl[1].split(':')[0].trim())) return tpl[1].split(':')[0].trim();
  const head = seg.split('(')[0].trim();
  if (ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return ID.test(lhs) ? lhs : '';
};

const lineCache = new Map();
const linesOf = (p) => {
  if (!lineCache.has(p)) {
    let arr = null;
    try {
      arr = fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n');
      if (arr[arr.length - 1] === '') arr.pop();
    } catch {
      arr = null;
    }
    lineCache.set(p, arr);
  }
  return lineCache.get(p);
};

function parseRefs(text) {
  const spans = [];
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text))) spans.push({ body: m[1], s: m.index, end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i].body.match(CITE);
    if (!c) continue;
    let anchor = '';
    let consumed = false;
    const next = spans[i + 1];
    const gA = next ? text.slice(spans[i].end, next.s) : null;
    if (gA !== null && gA.length <= 4 && !gA.includes('\n')) {
      const gN = gA.replace(/\s+/g, '');
      if (/^[（(]/.test(gN) || gN === '的') { consumed = true; anchor = tokOf(next.body); }
    }
    // 前向没认出注解形状时才接着试后向。用 `else if` 挂在前向条件上，
    // 「`NAME` 在 `js/….js:1`、」这种后面紧跟短间隔的写法就把后向那把弄哑了。
    if (!consumed && i > 0) {
      const prev = spans[i - 1];
      const gap = text.slice(prev.end, spans[i].s);
      const gT = gap.replace(/\s+/g, '');
      const shaped = /^[（(]/.test(gT) || /[\w一-鿿]/.test(gT);
      if (shaped && !/\s/.test(prev.body) && gap.length <= 4 && !gap.includes('\n')) anchor = tokOf(prev.body);
    }
    for (const seg of c[2].split(',')) {
      const parts = seg.split('-').map(Number);
      out.push({ path: c[1], from: parts[0], to: parts[parts.length - 1] || parts[0], anchor });
    }
  }
  return out;
}

function audit(text) {
  const refs = parseRefs(text);
  const outOfRange = [];
  const anchorBad = [];
  for (const r of refs) {
    const label = `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}`;
    const lines = linesOf(r.path);
    if (!lines) { outOfRange.push(`${label} 文件不存在`); continue; }
    if (r.from < 1 || r.to > lines.length) {
      outOfRange.push(`${label} 越界（该文件共 ${lines.length} 行）`);
      continue;
    }
    if (r.anchor && !lines.slice(r.from - 1, r.to).join('\n').includes(r.anchor)) {
      anchorBad.push(`${label} 那几行里没有 ${r.anchor}`);
    }
  }
  // `` `文件`（N 行）`` 这种实测值按等式收：写歪一格、文件不在，都算指不回实处。
  const cntRe = new RegExp('`(' + PATH_SRC + ')`（([0-9]+) 行）', 'g');
  let k;
  while ((k = cntRe.exec(text))) {
    const lines = linesOf(k[1]);
    if (!lines) outOfRange.push(`${k[1]}（${k[2]} 行）文件不存在`);
    else if (lines.length !== Number(k[2])) outOfRange.push(`${k[1]} 实测 ${lines.length} 行，文档写的是 ${k[2]}`);
  }
  return { refs, outOfRange, anchorBad };
}

export function run(ok) {
  // 文档清单从目录里现数，不手抄——手抄的清单会让这条腿自己缩样，而它照样打印"全部在范围内"。
  const docFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
  ok(docFiles.length >= 2, `docs: 本仓根下有两份以上的文档可审（输入集不许自己空掉）· ${docFiles.join(',')}`);

  let docText = '';
  const bad = [];
  const anchorBad = [];
  let refs = 0;
  for (const f of docFiles) {
    const a = audit(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    docText += fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n';
    refs += a.refs.length;
    for (const b of a.outOfRange) bad.push(`${f} · ${b}`);
    for (const b of a.anchorBad) anchorBad.push(`${f} · ${b}`);
  }
  const anchored = anchorCount(docText);

  ok(refs >= 200, `docs: 这条腿读到的引用数多到它自己算覆盖面（少于 200 条就是输入集缩了）· 本次解析 ${refs} 条`);
  ok(bad.length === 0, `docs: 文档里每一条 文件:行号 都在盘上、在界内（写了行号就得还在文件里）· 解析 ${refs} 条` +
    (bad.length ? ` · 不在的 ${bad.length} 处：${bad.join(' | ')}` : ''));
  ok(anchorBad.length === 0, `docs: 贴着引用的那个名字真的出现在被指的那几行里（漂到隔壁一行要红）` +
    (anchorBad.length ? ` · 锚点漂 ${anchorBad.length} 处：${anchorBad.join(' | ')}` : ` · ${anchored} 条带锚点的全部落回原处`));
  ok(anchored >= 12, `docs: 文档里确实有足够多的引用带指认（少于 12 条就是锚点腿空转）· 本次认到锚点的 ${anchored} 条`);

  // 等式闸：文档转写的「解析 N 条」必须等于这条腿自己数到的，且文档确实写了它——删掉数字同样算红。
  const claims = [...docText.matchAll(/解析 (\d+) 条/g)].map((x) => Number(x[1]));
  ok(claims.length >= 1 && claims.every((c) => c === refs),
    `docs: 文档里每一处「解析 N 条」都等于这条腿自己数到的（删掉这个数字同样算红）· 闸数到 ${refs} · ` +
    `文档写了 ${claims.length} 处：${[...new Set(claims)].join('/') || '（一处都没写）'}`);

  // 反空转：七把假引用必须一把不落——文件不存在、行号越界、四种写法各自的锚点漂、行数写错。
  const F = audit('出处 `js/engine/nope.js:1`、`js/engine/generate.js:99999`、`NO_SUCH_NAME` 在 `js/engine/generate.js:1`、' +
    '`package.json`（999 行）、`js/engine/generate.js:1`（`setPaused`）、`js/engine/generate.js:1` 的 `setPaused`、' +
    '`js/engine/generate.js:149`（`Math.max(3, 4)`）');
  ok(F.outOfRange.length + F.anchorBad.length === 7,
    `docs: 假引用七把全被抓到（不存在 / 越界 / 行数错 / 后向锚点漂 / 前向括号锚点漂 / 「的」锚点漂 / 函数调用形式锚点漂）· ` +
    [...F.outOfRange, ...F.anchorBad].join(' | '));

  // 阳性对照：五种真注解写法 + 真行数必须判绿，否则上一条的"红"可能只是解析器自己坏了。
  const pkgLines = linesOf('package.json');
  const fwd = audit('`SUITES`（`tools/check.mjs:17`）、`tools/check.mjs:17`（`SUITES`）、`tools/check.mjs:17` 的 `SUITES`、' +
    '`js/engine/generate.js:149`（`pSet(b, { candLimit })`）、`js/main.js:69`（`js/main.js::setPaused`）、' +
    '`tools/check.mjs:17`（`npm test`） 与 `package.json`（' + (pkgLines ? pkgLines.length : 0) + ' 行）');
  ok(fwd.outOfRange.length === 0 && fwd.anchorBad.length === 0 && fwd.refs.length === 6,
    `docs: 后向、前向括号、「的」、`+ '`path::symbol`、函数调用五种真注解加带空格的命令行 body 都在同一个解析器下判绿 · ' +
    [...fwd.outOfRange, ...fwd.anchorBad].join(' | ') + `（refs=${fwd.refs.length}）`);

  // 模板前缀：`name:<占位>` 指的是那串字面量前缀。本仓文档没这么写过，所以这一把只由台架证明——
  // 规则一丢，`NOPE:<占位>` 那种假引用连锚点都不会生成，七把里就少一把。
  const tplGreen = audit('`js/engine/generate.js:149`（`pSet:<占位>`）');
  const tplRed = audit('`js/engine/generate.js:149`（`NOPE:<占位>`）').anchorBad;
  ok(tplGreen.anchorBad.length === 0 && tplGreen.refs.length === 1 && tplRed.length === 1,
    `docs: 模板 body 取字面量前缀（前缀对得上判绿、对不上必须红）· 绿=${tplGreen.anchorBad.length ? tplGreen.anchorBad.join(' | ') : 'ok'}` +
    ` · 红在 ${tplRed.join(' | ') || '（一处都没红）'}`);

  // 反方向的控制：逗号不是指认。前面那个名字只是列表的上一项，按它钉会把正确的文档读红。
  const comma = audit('`NO_SUCH_NAME`，`tools/check.mjs:17`');
  ok(comma.anchorBad.length === 0 && comma.refs.length === 1,
    `docs: 纯标点间隔（` + '`，`' + `）不构成指认：这种写法必须判绿 · ${comma.anchorBad.join(' | ') || '绿'}（refs=${comma.refs.length}）`);

  // 这条腿对本仓文档真有牙齿：把一条界内的真引用挪歪一格，只有锚点抓得住。
  // 选这一条是因为它带前向注解（`…:149-150`（`pSet` …））；文档里另外三处同样指向 149-150 的写法
  // 间隔太长或压根没贴名字，锚点看不见它们——那三处由越界那半管着。
  // 151-152 是「pencil 矛盾就 continue」那两行，在界内，越界检查不会红。
  // 改的是内存里的副本，盘上的文档一个字不动。
  const needle = '`js/engine/generate.js:149-150`（`pSet`';
  const hits = docText.split(needle).length - 1;
  const poisoned = audit(docText.replace(needle, '`js/engine/generate.js:151-152`（`pSet`'));
  ok(hits === 1 && poisoned.anchorBad.length === 1,
    `docs: 把文档里一条真引用的行号挪歪一格，这条腿必须为它变红 · needle 命中 ${hits} 处 · ` +
    `红在 ${[...poisoned.outOfRange, ...poisoned.anchorBad].join(' | ') || '（一处都没红）'}`);

  return { refs, anchored, docs: docFiles.length };
}

// 指认条数与 audit 用同一套解析，只数"有锚点的"那几条。
function anchorCount(text) {
  return parseRefs(text).filter((r) => r.anchor).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let checks = 0, fails = 0;
  const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } else console.log('ok: ' + m); };
  const r = run(ok);
  console.log(`文档行号对账：${r.docs} 份文档，解析 ${r.refs} 条、认到锚点 ${r.anchored} 条`);
  console.log(`RESULT docs-test ok=${fails === 0} checks=${checks} fails=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
