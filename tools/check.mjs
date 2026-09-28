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
  console.log(`  ${name.padEnd(20)} checks=${m[3].padEnd(5)} fails=${m[4]} ｜ ${out.split('\n').filter((l) => /墙钟|load1|出货|loadavg/.test(l)).slice(0, 2).join(' ').slice(0, 90)}`);
}
ok(got.length === SUITES.length, `只收到 ${got.length}/${SUITES.length} 套 RESULT：${got.join(' ')}`);

console.log(`\nRESULT check ok=${fails === 0} checks=${checks} fails=${fails}（套件 ${SUITES.map((s) => s[0]).join(' ')}）`);
process.exit(fails === 0 ? 0 : 1);
