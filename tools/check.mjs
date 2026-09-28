#!/usr/bin/env node
// npm test / CI 的总门：先做两道静态检查，再把逻辑套件逐个跑起来，最后逐条读它们打印的 RESULT 行。
//
// 为什么静态门要跑在逻辑门前面：引擎里混进一个 process.env 或 Math.random，逻辑测试**当天**还是全绿的
// （node 恰好有那个环境变量、或者随机数恰好站在正确答案那边），红的是三个月后的部署站点或另一台机器。
// 所以这两条不许靠"跑一遍看看"，必须在读源码的门里就打死。
//
// 为什么最后要数 RESULT 的行数：套件被改名、被漏跑、spawn 失败但退出码没传上来，
// 这三种情况都会表现为"绿了，但少跑了一套"。行数对不上就是红。
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTS = ['.js', '.mjs', '.cjs'];
const SUITES = [
  ['rule-test', ['tools/rule-test.mjs']],
  ['pencil-test', ['tools/pencil-test.mjs']],
  ['counter-test', ['tools/counter-test.mjs']],
  ['golden-write', ['tools/write-golden.mjs', '--check']],
  ['golden-test', ['tools/golden-test.mjs']],
  ['generator-probe', ['tools/generator-probe.mjs']],
];

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };

/* ---------- 1) 语法门 ---------- */
const files = ['js', 'tools'].map((d) => join(ROOT, d)).filter((d) => existsSync(d)).reduce((a, d) => walk(d, a), []);
ok(files.length >= 10, `只找到 ${files.length} 个源文件，目录名不对？`);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  ok(r.status === 0, `node --check ${relative(ROOT, f)}\n${(r.stderr || '').trim()}`);
}
console.log(`语法门：${files.length} 个文件`);

/* ---------- 2) 判定路径上的禁词（引擎侧）----------
 * process.env  : 测量口径属于调用方（tools/generator-probe.mjs），引擎读 env 就等于把出货口径交给部署环境
 * Math.random  : seed 必须是纯函数；一次随机 = node 与 Chrome 画出两张不同盘（家族里已经栽过）
 * Date.now / performance.now / new Date : 判定路径上不许有时间，也不许把墙钟当输入
 */
const FORBID = [
  ['process.env', /process\.env/],
  ['Math.random', /Math\.random/],
  ['Date.now', /Date\.now|\bnew Date\b/],
  ['performance.now', /performance\.now/],
  ['require(', /\brequire\s*\(/],
  ['node: 内置模块', /from\s+['"]node:/],
  ['node: 内置模块(import)', /import\s*\(\s*['"]node:/],
];
const engineFiles = walk(join(ROOT, 'js', 'engine'), []);
ok(engineFiles.length === 6, `js/engine 应该有 6 个文件（grid/model/rng/counter/pencil/generate），实为 ${engineFiles.length}`);
for (const f of engineFiles) {
  const src = readFileSync(f, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // 注释里谈禁词是文档，不是违规
  for (const [name, re] of FORBID) ok(!re.test(code), `${relative(ROOT, f)}：判定路径上出现「${name}」`);
}
// 浏览器侧的入口在轮 2 才建，这一轮只保证引擎干净
console.log(`禁词门：${engineFiles.length} 个引擎文件 × ${FORBID.length} 个禁词，注释外零命中`);

/* ---------- 2b) 默认 seed 的来源：mintSeed 体内零时间 ----------
 * 「默认种子不按日期算」这句话有两种证法。跑一遍看 seed 长什么样是错的证法：同一天里连铸两颗
 * 也会因为计数器自增而各不相同，日期当 seed 的话反而看不出来。所以这里读源码：
 * mintSeed 的函数体里只许出现 crypto.getRandomValues 与 seedCounter++，
 * 出现 Date / performance.now / Math.random 任意一个就直接红——那才是「按日期算」的写法。
 */
{
  const main = readFileSync(join(ROOT, 'js', 'main.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const st = main.indexOf('function mintSeed() {');
  ok(st >= 0, 'js/main.js 里找不到 function mintSeed()——换一局的 seed 是从哪儿来的？');
  const body = st >= 0 ? main.slice(st, main.indexOf('\n}', st) + 2) : '';
  ok(/crypto\.getRandomValues/.test(body), `mintSeed 体内没有 crypto.getRandomValues：${body.slice(0, 200)}`);
  ok(/seedCounter\+\+|seedCounter \+= 1|seedCounter = seedCounter \+ 1/.test(body),
    `mintSeed 体内没有 seedCounter 自增（换一局就不是 seed+k 的自增）：${body.slice(0, 240)}`);
  for (const [name, re] of FORBID.filter(([, r]) => /Date|performance|Math\.random/.test(r.source))) {
    ok(!re.test(body), `mintSeed 体内出现「${name}」：默认 seed 就成了按日期算的那种`);
  }
  // seedCounter 的初值也不能是时间（`let seedCounter = Date.now()` 一样是把一天当 seed）
  const init = /(let|var|const)\s+seedCounter\s*=\s*([^;\n]+)/.exec(main);
  ok(!!init, '找不到 seedCounter 的初值声明');
  if (init) {
    for (const [name, re] of FORBID.filter(([, r]) => /Date|performance|Math\.random/.test(r.source))) {
      ok(!re.test(init[2]), `seedCounter 初值出现「${name}」：${init[2]}`);
    }
  }
  // 换一局这条按钮路径必须真的过 mintSeed（而不是自己现拼一个 seed，更不是拿 Date 现拼）
  const btnNew = /['"]btn-new['"]\)\.addEventListener\([\s\S]{0,120}?\(\)\s*=>\s*newGame\(\s*\{\s*\}\s*\)/.exec(main);
  ok(!!btnNew, "找不到 $('btn-new').addEventListener(…) → newGame({}) 那条路（换一局不经过 mintSeed？）");
  ok(/btn-again['"]\)\.addEventListener\([\s\S]{0,120}?\(\)\s*=>\s*newGame\(\s*\{\s*\}\s*\)/.test(main),
    "找不到 $('btn-again') → newGame({})：胜利卡片里那颗「再来一局」也得走同一个 mintSeed");
  console.log(`seed 门：mintSeed 体内 ${body.split('\n').length} 行，零时间源；初值="${init ? init[2].trim() : '?'}"`);
}

/* ---------- 3) 逻辑套件 ---------- */
const got = [];
for (const [name, args] of SUITES) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split('\n').reverse().find((l) => l.startsWith('RESULT ')) || '';
  const m = /^RESULT\s+(\S+)\s+ok=(\S+)\s+checks=(\d+)\s+fails=(\d+)/.exec(line);
  ok(!!m, `${name}: 没打印 RESULT 行（退出码 ${r.status}）\n${out.slice(-800)}`);
  if (!m) continue;
  got.push(m[1]);
  ok(m[1] === name, `${name}: RESULT 自称 ${m[1]}，与套件名不符`);
  ok(m[2] === 'true' && Number(m[4]) === 0 && r.status === 0, `${name}: ok=${m[2]} fails=${m[4]} 退出码=${r.status}\n${out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 8).join('\n')}`);
  ok(Number(m[3]) > 0, `${name}: checks=0，等于没断言`);
  // 把每套自己的 RESULT 行**原样**再念一遍：ci.yml 与 tools/verify.sh 数的就是这些行
  // （统一格式 RESULT <name> ok=… checks=… fails=…）。只报一条聚合行的话，「少跑了一套」
  // 在门禁那一侧读不出来——它看到的永远是 1 行绿。
  console.log('  ' + name.padEnd(20) + ' ｜ ' + out.split('\n').filter((l) => /墙钟|load1|出货|loadavg/.test(l)).slice(0, 2).join(' ').slice(0, 90));
  console.log(line);
}
ok(got.length === SUITES.length, `只收到 ${got.length}/${SUITES.length} 套 RESULT：${got.join(' ')}`);

/* ---------- 6) 产物边界：本地把 CI 那两条 grep 原样跑一遍 ----------
 * 为什么要在 node 侧门里再跑一次：这两条原先**只有 CI 有**，于是「npm test 全绿」与「CI 绿」
 * 不是一回事。本仓第一次推上去就是靠这条抓到红的——引擎注释里写了 `tools/generator-probe.mjs`
 * 这样的路径，本地六套照样绿，CI 的边界 grep 当场红。
 * 口径与 CI 逐字一致：同一个正则、同样**不分注释**（一行注释提到 tools/ 也算命中），
 * 因为这条门要管的是「Pages 产物里到底有没有那些文件」，而 grep 不知道哪段是注释。
 */
const BOUNDARY = /tools\/(golden|reference|check|rule-test|pencil-test|counter-test|generator-probe|write-golden|golden-test)/;
const IMPORT_TOOLS = /(import|export)[^;]*from '[^']*tools\//;
const runtimeFiles = walk(join(ROOT, 'js'), []).concat([join(ROOT, 'index.html')]).filter((f) => existsSync(f));
ok(runtimeFiles.length >= 7, `运行时产物只扫到 ${runtimeFiles.length} 个文件（js/** + index.html）`);
for (const f of runtimeFiles) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  ok(!BOUNDARY.test(src), `${rel}：提到了 tools/ 下的门禁文件——Pages 产物里不会有它（要谈测量口径请写 DESIGN）`);
  ok(!IMPORT_TOOLS.test(src), `${rel}：运行时模块 import 了 tools/ 下的东西——分层倒了`);
}
console.log(`边界门：${runtimeFiles.length} 个运行时文件 × 2 条 grep，与 CI 同正则`);

console.log(`\nRESULT check ok=${fails === 0} checks=${checks} fails=${fails}（套件 ${SUITES.map((s) => s[0]).join(' ')}）`);
process.exit(fails === 0 ? 0 : 1);
