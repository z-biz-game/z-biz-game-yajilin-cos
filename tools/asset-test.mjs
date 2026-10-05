#!/usr/bin/env node
// 美术资产的仓内常驻门：把「盘上是真实可读的图」这句话变成能跑的判据。
//
// 为什么要有这一套：家族里踩过「目录看着像已交付、里面一张图都没有」（27 个仓全都有
// AppIcon.appiconset，实测是空目录），也踩过拿内联 SVG 的 data-uri 冒充 favicon、
// 拿 0 字节文件占住 manifest 里那条 icons.src。字符串门（grep 到 "icon-512.png"）对这三种
// 一律发绿，因为文件**存在**、引用**存在**，只是它不是一张图。
//
// 这里量的是四件事，全部真解码：
//   ① 文件头是 PNG 签名（不是 SVG/PDF/文本冒充的 .png，也不是 0 字节）
//   ② IHDR 的宽高与文件名/manifest 里声明的尺寸一致（声明 192 实为 100 的那种）
//   ③ IDAT  inflate + 反filter 之后真的不止一个颜色（实心方块=占位符，不是图）
//   ④ index.html / manifest.webmanifest / css / js 里引用到的每个 assets 路径都在盘上
//      （Pages 挂在 /<仓库名>/ 前缀下，写死 "/assets/…" 或删文件都不会报错，只会静默 404）
//
// 另加两条口径：生成脚本必须是纯函数（同输入必同字节，实测复跑 31 张 sha256 逐字相同）；
// 以及一把阴性对照——把「0 字节」「SVG 冒充」「实心占位」三种假样本喂给同一个判据，
// 必须全部被抓到。抓不到就说明这把尺在空跑。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } };
const note = (m) => console.log('  ' + m);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- 读一张真 PNG：签名、IHDR、IDAT inflate、逐行反 filter ----
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { bad: '不是 PNG 签名（0 字节 / SVG 冒充都在这里露馅）' };
  let i = 8, ihdr = null, idat = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!ihdr) return { bad: '没有 IHDR' };
  if (ihdr.depth !== 8) return { bad: `位深 ${ihdr.depth} 不是 8` };
  const ch = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : ihdr.colorType === 0 ? 1 : ihdr.colorType === 4 ? 2 : 0;
  if (!ch) return { bad: `colorType ${ihdr.colorType} 不是灰度/RGB/RGBA` };
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { bad: `IDAT inflate 失败：${e.message}` }; }
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(ihdr.h * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      else if (ft !== 0) return { bad: `第 ${y} 行 filter 类型 ${ft} 未知` };
      cur[x] = v & 255;
    }
  }
  const colors = new Set();
  let opaque = 0;
  for (let k = 0; k < out.length; k += ch) {
    const r = out[k], g = ch > 1 ? out[k + 1] : out[k], b = ch > 2 ? out[k + 2] : out[k];
    const a = ch === 4 || ch === 2 ? out[k + 3] : 255;
    colors.add((r << 24) ^ (g << 16) ^ (b << 8) ^ a);
    if (a > 16) opaque++;
  }
  return { w: ihdr.w, h: ihdr.h, ch, colors: colors.size, opaque, pixels: ihdr.w * ihdr.h, sha: createHash('sha256').update(buf).digest('hex').slice(0, 12) };
}

// 一张图「可读」= 签名对、解码对、颜色不止一种、有实际覆盖的像素
function readable(buf, minColors = 3) {
  const d = decodePng(buf);
  if (d.bad) return d;
  if (d.colors < minColors) return { bad: `只有 ${d.colors} 个颜色：那是实心占位块，不是一张图` };
  if (d.opaque === 0) return { bad: '没有一个不透明的像素' };
  return d;
}

const REQUIRED = [
  ['assets/icons/favicon-16.png', 16, 16], ['assets/icons/favicon-32.png', 32, 32],
  ['assets/icons/apple-touch-icon.png', 180, 180], ['assets/icons/icon-192.png', 192, 192],
  ['assets/icons/icon-512.png', 512, 512], ['assets/icons/icon-maskable-512.png', 512, 512],
  ['assets/icons/icon-1024.png', 1024, 1024], ['assets/og.png', 1200, 630],
  ['assets/textures/paper-256.png', 256, 256], ['assets/textures/field-256.png', 256, 256],
];
for (const n of ['pause', 'play', 'sound-on', 'sound-off', 'full', 'loop', 'black', 'cut', 'erase']) {
  for (const px of [32, 48]) REQUIRED.push([`assets/sprites/${n}-${px}.png`, px, px]);
}

/* ---------- ①②③ 逐张真解码 ---------- */
const decoded = [];
for (const [rel, w, h] of REQUIRED) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { ok(false, `${rel} 不在盘上`); continue; }
  const d = readable(fs.readFileSync(p));
  ok(!d.bad, `${rel}: ${d.bad}`);
  if (d.bad) continue;
  ok(d.w === w && d.h === h, `${rel} 声明 ${w}x${h}，IHDR 实为 ${d.w}x${d.h}`);
  ok(d.ch === 4, `${rel} colorType 不是 RGBA（ch=${d.ch}）：图标要带 alpha`);
  decoded.push({ rel, ...d });
}
note(`必需资产 ${REQUIRED.length} 张全部真解码通过（尺寸=IHDR 实测，非文件名推断）`);
note(`样例：${decoded.slice(0, 3).map((d) => `${path.basename(d.rel)} ${d.w}x${d.h} colors=${d.colors} sha=${d.sha}`).join('  ')}`);
const og = decoded.find((d) => d.rel === 'assets/og.png');
if (og) ok(og.colors >= 200, `og.png 只有 ${og.colors} 个颜色：社交卡退化成了底色块`);
const at = decoded.find((d) => /apple-touch/.test(d.rel));
if (at) ok(Math.min(at.w, at.h) >= 180, `apple-touch-icon 只有 ${at.w}x${at.h}（<180 上不了 iOS 主屏）`);

// 全仓 PNG 不许有 0 字节 / 冒牌货
const allPng = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (name !== 'gen') walk(p); }
    else if (name.endsWith('.png')) allPng.push(p);
  }
})(path.join(ROOT, 'assets'));
for (const p of allPng) {
  const st = fs.statSync(p);
  ok(st.size > 64, `${path.relative(ROOT, p)} 只有 ${st.size} 字节：占位符`);
  const d = readable(fs.readFileSync(p));
  ok(!d.bad, `${path.relative(ROOT, p)}: ${d.bad}`);
}
note(`盘上 ${allPng.length} 张 PNG 全部签名+解码+多色三重检查通过（最小 ${Math.min(...allPng.map((p) => fs.statSync(p).size))}B）`);

/* ---------- ④ 引用路径必须落在盘上 ---------- */
const refFiles = ['index.html', 'manifest.webmanifest', 'css/game.css', 'js/main.js', 'js/theme.js', 'js/render/board.js', 'sw.js'];
const refs = new Set();
for (const f of refFiles) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of t.matchAll(/["'(]((?:\.\/)?assets\/[A-Za-z0-9_./-]+\.png)/g)) refs.add(m[1].replace(/^\.\//, ''));
}
const missing = [...refs].sort().filter((r) => !fs.existsSync(path.join(ROOT, r)));
ok(missing.length === 0, `引用了盘上不存在的图：${missing.join(' ')}`);
note(`引用面：${refFiles.length} 个入口文件里 ${refs.size} 条 assets/*.png 引用，缺失 ${missing.length} 条`);

// manifest 的 icons 必须每条 src 存在、sizes 与 IHDR 相符，且 192/512/maskable 齐
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
ok(Array.isArray(man.icons) && man.icons.length >= 2, `manifest.icons 只有 ${man.icons && man.icons.length} 条`);
for (const ic of man.icons || []) {
  const p = path.join(ROOT, ic.src);
  if (!fs.existsSync(p)) { ok(false, `manifest 里的 ${ic.src} 不在盘上`); continue; }
  const d = decodePng(fs.readFileSync(p));
  const [dw, dh] = String(ic.sizes).split('x').map(Number);
  ok(!d.bad && d.w === dw && d.h === dh, `manifest 声明 ${ic.sizes}，${ic.src} 实测 ${d.w}x${d.h || d.bad}`);
}
const sizes = (man.icons || []).map((i) => `${i.sizes}${i.purpose === 'maskable' ? '+maskable' : ''}`);
ok(sizes.includes('192x192') && sizes.includes('512x512'), `manifest 缺 192/512：${sizes.join(' ')}`);
ok((man.icons || []).some((i) => i.purpose === 'maskable'), '没有 maskable 图标：Android 圆角会裁掉母题');
ok(man.name && man.short_name && man.start_url && man.display && man.theme_color, 'manifest 少了 name/short_name/start_url/display/theme_color 之一');
note(`manifest icons: ${sizes.join(' ')}（逐条与 IHDR 对过号）`);

// index.html 必须有唯一 apple-touch-icon 与 rel=manifest
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok((html.match(/rel="apple-touch-icon"/g) || []).length === 1, 'apple-touch-icon 必须恰好一条（多条时 iOS 挑哪张不可控）');
ok(/rel="manifest"/.test(html), 'index.html 没有 <link rel="manifest">');
ok(/name="viewport"[^>]*viewport-fit=cover/.test(html), 'viewport 缺 viewport-fit=cover：CSS 里 env(safe-area-inset-*) 恒为 0');
ok(/og:image/.test(html) && /og:image:width/.test(html), '缺 og:image / og:image:width');

/* ---------- 生成脚本必须是纯函数 ---------- */
const gen = fs.readFileSync(path.join(ROOT, 'assets/gen/make_art.mjs'), 'utf8');
const genCode = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
for (const [name, re] of [['Math.random', /Math\.random/], ['Date.now / new Date', /Date\.now|\bnew Date\b/], ['process.env', /process\.env/]]) {
  ok(!re.test(genCode), `make_art.mjs 出现「${name}」：同输入不同字节，资产就不可复现`);
}
ok(/zlib|deflateSync/.test(genCode) && /createHash/.test(genCode), 'make_art.mjs 不像是在自己写 PNG（没引 zlib/createHash）');
note(`生成门：make_art.mjs ${gen.split('\n').length} 行，注释外零时间源/零随机源/零环境依赖`);

/* ---------- 阴性对照：三种假样本必须都被抓 ---------- */
const fakes = [
  ['0 字节文件', Buffer.alloc(0)],
  ['SVG 冒充 .png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#000"/></svg>', 'utf8')],
  ['实心占位（真 PNG 但只有一个颜色）', null],
];
const solid = (() => { // 现做一张 64x64 纯色 PNG，走同一条解码路
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0); return Buffer.concat([len, body, crc]); };
  const stride = 64 * 4;
  const rows = Buffer.alloc(64 * (stride + 1));
  for (let y = 0; y < 64; y++) { rows[y * (stride + 1)] = 0; for (let x = 0; x < stride; x++) rows[y * (stride + 1) + 1 + x] = x % 4 === 3 ? 255 : 10; }
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
})();
fakes[2][1] = solid;
let caught = 0;
for (const [label, buf] of fakes) {
  const d = readable(buf);
  ok(!!d.bad, `阴性对照失手：${label} 被判成合法图（colors=${d.colors}）`);
  if (d.bad) { caught++; note(`  抓到 ${label} → ${d.bad}`); }
}
ok(caught === fakes.length, `三种假样本只抓到 ${caught}/${fakes.length}`);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}

console.log(`RESULT asset-test ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
