#!/usr/bin/env node
// 美术资产生成器：一个母题画函数，按目标尺寸各画各的（不从母图缩放，所以 16px 也清楚）。
//
// 为什么在仓里自己画、不用 007 的图标工厂：make_icons.py 的母题表里没有本仓（它会落到兜底
// 风格），而它的输出落在**仓外**（z-biz-game-lead/007_美术资产）——本单要求改动只落本仓。
// 更根本的是：本仓玩法就是「黑格 + 一条不自交的正交环 + 箭头线索」，母题必须从玩法来、
// 颜色必须从 js/theme.js 的令牌来（这里真的 import 它），于是画布与图标不可能长成两个游戏。
//
// 零依赖：PNG 用 node 自带 zlib 手写（IHDR/IDAT/IEND + CRC32），不引 sharp/canvas/PIL。
// 反走样＝亚像素覆盖：每个形状按 ss×ss 亚像素栅格逐点 source-over（预乘 alpha 累加），
// 再盒式平均回目标尺寸。整条流水线是纯函数：无随机源（噪声是整数频率正弦和 ⇒ 可平铺且确定），
// 同输入必同字节——文件尾打印每张的 sha256 前缀，换机器复跑对得上才算复现成立。
//
// 用法：node assets/gen/make_art.mjs
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Palette } from '../../js/theme.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIRS = {
  icons: join(ROOT, 'assets', 'icons'),
  textures: join(ROOT, 'assets', 'textures'),
  sprites: join(ROOT, 'assets', 'sprites'),
  social: join(ROOT, 'assets'),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

/* ───────── 调色（逐字节来自 js/theme.js 的 Palette）───────── */
const hex = (h) => {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const C = {};
for (const [k, v] of Object.entries(Palette)) if (typeof v === 'string' && v.startsWith('#')) C[k] = hex(v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c, a = 1) => [c[0], c[1], c[2], a];
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/* ───────── 画布：亚像素、预乘 alpha、像素单位 ───────── */
// 预乘空间里叠加与盒式平均都是线性运算 ⇒ 「先亚像素后平均」与「先平均后叠加」同结果，
// 边缘不会长出暗边/亮边（非预乘做平均是经典事故）。
class Canvas {
  constructor(w, h, ss = 2) {
    this.w = w;
    this.h = h;
    this.ss = ss;
    this.SW = w * ss;
    this.SH = h * ss;
    this.buf = new Float32Array(this.SW * this.SH * 4);
  }

  over(px, py, col) { // px/py 为亚像素坐标（连续）
    const x = Math.floor(px), y = Math.floor(py);
    if (x < 0 || y < 0 || x >= this.SW || y >= this.SH) return;
    const a = col[3];
    if (a <= 0) return;
    const i = (y * this.SW + x) * 4;
    const b = this.buf;
    const ia = 1 - a;
    b[i] = col[0] * a + b[i] * ia;
    b[i + 1] = col[1] * a + b[i + 1] * ia;
    b[i + 2] = col[2] * a + b[i + 2] * ia;
    b[i + 3] = a + b[i + 3] * ia;
  }

  fill(col) {
    for (let i = 0; i < this.buf.length; i += 4) {
      this.buf[i] = col[0] * col[3];
      this.buf[i + 1] = col[1] * col[3];
      this.buf[i + 2] = col[2] * col[3];
      this.buf[i + 3] = col[3];
    }
  }

  rect(x, y, w, h, col) {
    const ss = this.ss;
    const x0 = Math.round(x * ss), y0 = Math.round(y * ss);
    const x1 = Math.round((x + w) * ss), y1 = Math.round((y + h) * ss);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.over(px, py, col);
  }

  roundRect(x, y, w, h, r, col) {
    const ss = this.ss;
    const X = x * ss, Y = y * ss, W = w * ss, H = h * ss, R = Math.max(0, Math.min(r * ss, W / 2, H / 2));
    const px0 = Math.floor(X), py0 = Math.floor(Y);
    const px1 = Math.ceil(X + W), py1 = Math.ceil(Y + H);
    for (let py = py0; py < py1; py++) {
      const fy = py + 0.5 - Y;
      for (let px = px0; px < px1; px++) {
        const fx = px + 0.5 - X;
        if (!inRound(fx, fy, W, H, R)) continue;
        this.over(px, py, col);
      }
    }
  }

  // 描边 = 逐亚像素判「在外圆角内、且不在内圆角内」，只 source-over 叠色。
  // ⚠ 别写成「填外框 + 挖内框」的差集：挖洞要把像素 alpha 归零，那会连洞内**已经画好的
  // 整幅内容**一起擦掉（实测：那样一张图标只剩一圈边框，母题全空）。
  strokeRoundRect(x, y, w, h, r, lw, col) {
    const ss = this.ss;
    const d = lw / 2;
    const ow = (w + lw) * ss, oh = (h + lw) * ss, oR = Math.max(0, (r + d) * ss);
    const iw = Math.max(0, (w - lw) * ss), ih = Math.max(0, (h - lw) * ss), iR = Math.max(0, (r - d) * ss);
    const X = (x - d) * ss, Y = (y - d) * ss;
    const inOff = lw * ss; // 内框相对外框的原点差 = 2d
    const px0 = Math.max(0, Math.floor(X)), py0 = Math.max(0, Math.floor(Y));
    const px1 = Math.min(this.SW, Math.ceil(X + ow)), py1 = Math.min(this.SH, Math.ceil(Y + oh));
    for (let py = py0; py < py1; py++) {
      const fy = py + 0.5 - Y;
      for (let px = px0; px < px1; px++) {
        const fx = px + 0.5 - X;
        if (!inRound(fx, fy, ow, oh, oR)) continue;
        if (iw > 0 && ih > 0 && inRound(fx - inOff, fy - inOff, iw, ih, iR)) continue;
        this.over(px, py, col);
      }
    }
  }

  // 折线：到折线的距离 ≤ 半宽。一个判式同时给出 round cap 与 round join。
  polyline(pts, lw, col, { closed = false } = {}) {
    const ss = this.ss;
    const hw = (lw * ss) / 2;
    const P = pts.map(([x, y]) => [x * ss, y * ss]);
    const segs = [];
    for (let i = 0; i + 1 < P.length; i++) segs.push([P[i], P[i + 1]]);
    if (closed && P.length > 2) segs.push([P[P.length - 1], P[0]]);
    for (const [a, b] of segs) {
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - hw));
      const x1 = Math.min(this.SW, Math.ceil(Math.max(a[0], b[0]) + hw) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - hw));
      const y1 = Math.min(this.SH, Math.ceil(Math.max(a[1], b[1]) + hw) + 1);
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          if (distSeg(px + 0.5, py + 0.5, a, b) <= hw) this.over(px, py, col);
        }
      }
    }
  }

  ring(cx, cy, r, lw, col) {
    const ss = this.ss;
    const ro = r * ss + (lw * ss) / 2, ri = Math.max(0, r * ss - (lw * ss) / 2);
    const x0 = Math.max(0, Math.floor(cx * ss - ro)), x1 = Math.min(this.SW, Math.ceil(cx * ss + ro) + 1);
    const y0 = Math.max(0, Math.floor(cy * ss - ro)), y1 = Math.min(this.SH, Math.ceil(cy * ss + ro) + 1);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = Math.hypot(px + 0.5 - cx * ss, py + 0.5 - cy * ss);
        if (d <= ro && d >= ri) this.over(px, py, col);
      }
    }
  }

  polygon(pts, col) {
    const ss = this.ss;
    const P = pts.map(([x, y]) => [x * ss, y * ss]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of P) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const n = P.length;
    const cw = orient(P) > 0; // 绕序决定用哪一侧的半平面交
    for (let py = Math.floor(minY); py < Math.ceil(maxY) + 1; py++) {
      for (let px = Math.floor(minX); px < Math.ceil(maxX) + 1; px++) {
        const fx = px + 0.5, fy = py + 0.5;
        let inside = true;
        for (let i = 0; i < n; i++) {
          const a = P[i], b = P[(i + 1) % n];
          const cr = (b[0] - a[0]) * (fy - a[1]) - (b[1] - a[1]) * (fx - a[0]);
          if (cw ? cr < 0 : cr > 0) { inside = false; break; }
        }
        if (inside) this.over(px, py, col);
      }
    }
  }

  // 5×7 点阵字（等宽块状，和界面那副 mono 同一口气）。不引系统字体 ⇒ 跨机器同字节。
  text(str, x, y, cell, col, { tracking = 0.4, right = false } = {}) {
    const s = String(str).toUpperCase();
    const adv = cell * (5 + tracking) * (s.length - 1 || 0) + cell * 5;
    let cx = right ? x - adv : x;
    for (const ch of s) {
      const g = FONT[ch];
      if (g) {
        for (let r = 0; r < 7; r++) {
          for (let c = 0; c < 5; c++) {
            if (g[r][c] === '1') this.rect(cx + c * cell, y + r * cell, cell + cell * 0.02, cell + cell * 0.02, col);
          }
        }
      }
      cx += cell * (5 + tracking);
    }
    return cx;
  }

  textWidth(str, cell, tracking = 0.4) {
    const s = String(str).toUpperCase();
    return cell * 5 + cell * (5 + tracking) * Math.max(0, s.length - 1);
  }

  // 周期性纸纹：整数频率正弦和 ⇒ 上下左右边界严格接得上（可平铺）。
  // 只做亮度调制（±amp），不引入色相噪声——盘面上 #213040 这类被取样点认死的色
  // 不会被推走，纹理只住在 CSS 层与图标底子上。
  paper([ca, cb], amp = 0.16, freqs = [1, 2, 3, 5, 8], seed = 7) {
    const { SW, SH, ss } = this;
    const PH = freqs.map((f, i) => ((seed * 37 + i * 61) % 360) * (Math.PI / 180));
    const norm = freqs.reduce((a, f, i) => a + 1.6 / (i + 1), 0);
    for (let py = 0; py < SH; py++) {
      const v = py / SH;
      const grad = mix(ca, cb, v);
      for (let px = 0; px < SW; px++) {
        const u = px / SW;
        let s = 0;
        for (let k = 0; k < freqs.length; k++) {
          const a = 1.6 / (k + 1);
          s += a * Math.sin(2 * Math.PI * (freqs[k] * u + freqs[k] * 0.37 * v + PH[k]));
          s += a * 0.6 * Math.sin(2 * Math.PI * (freqs[k] * 0.61 * u + freqs[k] * v + PH[k] * 1.7));
        }
        const m = 1 + (s / norm) * amp * 2;
        // buf 的量纲：rgb 通道存 0..255 的**预乘**值，alpha 通道存 0..1（over/fill 都是这套）。
        // 这里写成 alpha=255 的话，toRGBA 解预乘会把颜色除以 255，两张不同底色的纹理
        // 一起被压成同一个纯黑方块（实测：改之前 paper-256 与 field-256 的 sha256 逐字相同）。
        const i = (py * SW + px) * 4;
        const a = 1;
        this.buf[i] = clamp255(grad[0] * m) * a;
        this.buf[i + 1] = clamp255(grad[1] * m) * a;
        this.buf[i + 2] = clamp255(grad[2] * m) * a;
        this.buf[i + 3] = a;
      }
    }
  }

  toRGBA() {
    const { w, h, ss, SW, SH, buf } = this;
    const out = Buffer.alloc(w * h * 4);
    const n = ss * ss;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < ss; sy++) {
          const row = ((y * ss + sy) * SW + x * ss) * 4;
          for (let sx = 0; sx < ss; sx++) {
            const i = row + sx * 4;
            r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
          }
        }
        r /= n; g /= n; b /= n; a /= n;
        const o = (y * w + x) * 4;
        if (a <= 1e-5) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
        out[o] = clamp255(r / a);
        out[o + 1] = clamp255(g / a);
        out[o + 2] = clamp255(b / a);
        out[o + 3] = clamp255(a * 255);
      }
    }
    return out;
  }
}

function inRound(fx, fy, w, h, r) {
  if (fx < 0 || fy < 0 || fx > w || fy > h) return false;
  if (r <= 0) return true;
  const inX = fx >= r && fx <= w - r;
  const inY = fy >= r && fy <= h - r;
  if (inX || inY) return true;
  const cx = Math.min(Math.max(fx, r), w - r);
  const cy = Math.min(Math.max(fy, r), h - r);
  return (fx - cx) ** 2 + (fy - cy) ** 2 <= r * r;
}

function distSeg(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2)) : 0;
  return Math.hypot(px - (a[0] + vx * t), py - (a[1] + vy * t));
}

function orient(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/* ───────── 5×7 点阵（A–Z / 0–9 / 分隔符）───────── */
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/* ───────── 母题：4×4 格心上的「一条不自交正交环 + 黑格 + 箭头线索」─────────
 * 这一张不是乱线：环只走格心且不自交；黑格之间不正交相邻；箭头格 (2,2) 写 LEFT 1，
 * 它向左那根射线（(2,1),(2,0)）上恰好一个黑格——就是 (2,1) 那颗。四条规则在图标上就成立。
 */
const GRID = 4;
const LOOP_RCS = [[0, 1], [0, 2], [1, 2], [1, 3], [3, 3], [3, 0], [1, 0], [1, 1]];
const BLACK_RCS = [[2, 1]];
const CLUES = [{ rc: [2, 2], dir: 'LEFT', n: 1 }];

function drawMotif(cv, opts = {}) {
  const {
    radius = cv.w * 0.22,
    paperAmp = 0.16,
    bleed = false,
    grid = true,
    glow = true,
  } = opts;
  const S = Math.min(cv.w, cv.h);
  const pad = S * (bleed ? 0.14 : 0.1);
  const cell = (S - pad * 2) / GRID;
  const ctr = (r, c) => [pad + cell * (c + 0.5), pad + cell * (r + 0.5)];

  cv.paper([C.bgTop, C.bgBottom], paperAmp, [1, 2, 3, 5, 8], 7);

  if (grid) {
    const lw = Math.max(1, cell * 0.035);
    for (let i = 1; i < GRID; i++) {
      const p = pad + cell * i;
      cv.polyline([[p, pad], [p, S - pad]], lw, rgba(C.line, 0.85));
      cv.polyline([[pad, p], [S - pad, p]], lw, rgba(C.line, 0.85));
    }
  }

  const pts = LOOP_RCS.map(([r, c]) => ctr(r, c));
  const lw = cell * 0.4;
  if (glow) {
    // 不用「宽光晕」：琥珀以低透明度压在深藏青上必然得到一圈卡其色脏边（实测就是那样），
    // 而且盘面上的环线本来就是平涂的——图标与画布得说同一种渲染语言。
    // 换成：一层向右下偏移的暗投影 + 一圈紧贴的奶白描边 + 平涂主线。
    const sh = lw * 0.1;
    cv.polyline(pts.map(([x, y]) => [x + sh, y + sh]), lw * 1.16, rgba(C.blackCell, 0.5), { closed: true });
    cv.polyline(pts, lw * 1.2, rgba(C.accentEdge, 1), { closed: true });
  }
  cv.polyline(pts, lw, rgba(C.accent, 1), { closed: true });
  // 高光：同一条线窄一号、左上偏 1/4 格宽——环线读起来是「管」而不是贴纸
  const off = lw * 0.22;
  cv.polyline(pts.map(([x, y]) => [x - off * 0.6, y - off]), lw * 0.3, rgba(C.accentEdge, 0.55), { closed: true });

  for (const [r, c] of BLACK_RCS) {
    const [x, y] = ctr(r, c);
    const s = cell * 0.76;
    cv.roundRect(x - s / 2, y - s / 2, s, s, cell * 0.1, rgba(C.blackCell, 1));
    cv.strokeRoundRect(x - s / 2, y - s / 2, s, s, cell * 0.1, Math.max(1, cell * 0.045), rgba(C.blackCellRing, 0.9));
  }

  for (const cl of CLUES) {
    const [r, c] = cl.rc;
    const [x, y] = ctr(r, c);
    const s = cell * 0.9;
    cv.roundRect(x - s / 2, y - s / 2, s, s, cell * 0.12, rgba(C.clueTile, 1));
    const v = { LEFT: [-1, 0], RIGHT: [1, 0], UP: [0, -1], DOWN: [0, 1] }[cl.dir];
    const perp = [-v[1], v[0]];
    const t = s * 0.3;
    const tip = [x + v[0] * s * 0.42, y + v[1] * s * 0.42];
    cv.polygon([
      tip,
      [tip[0] - v[0] * t + perp[0] * t * 0.62, tip[1] - v[1] * t + perp[1] * t * 0.62],
      [tip[0] - v[0] * t - perp[0] * t * 0.62, tip[1] - v[1] * t - perp[1] * t * 0.62],
    ], rgba(C.clueArrow, 1));
    const fs = s * 0.13;
    const numX = x - v[0] * s * 0.1;
    cv.text(String(cl.n), numX - fs * 2.5, y - fs * 3.5, fs, rgba(C.ink, 1), { tracking: 0 });
  }

  if (!bleed) {
    cv.strokeRoundRect(1, 1, S - 2, S - 2, radius, Math.max(1, S * 0.006), rgba(C.lineHeavy, 0.55));
  }
  return cv;
}

/* ───────── PNG 编码（手写 chunk）───────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgbaBuf) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 每行 filter=none：压缩交给 zlib
    rgbaBuf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rows = [];
function emit(dir, file, w, h, rgbaBuf) {
  const png = encodePng(w, h, rgbaBuf);
  writeFileSync(join(dir, file), png);
  rows.push(`${file.padEnd(26)} ${String(w).padStart(4)}×${String(h).padEnd(4)} ${String(png.length).padStart(7)}B ${createHash('sha256').update(png).digest('hex').slice(0, 12)}`);
}

const ssFor = (size) => (size >= 1024 ? 2 : size >= 512 ? 3 : size >= 180 ? 4 : size >= 48 ? 5 : 6);

// 图标：每个尺寸各画一次（母题在任意尺寸都是同一批归一化形状）
const ICONS = [
  ['icon-1024.png', 1024],
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['icon-96.png', 96],
  ['icon-64.png', 64],
  ['icon-48.png', 48],
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
];
for (const [file, size] of ICONS) {
  const cv = new Canvas(size, size, ssFor(size));
  drawMotif(cv);
  emit(DIRS.icons, file, size, size, cv.toRGBA());
}
// maskable：铺满整幅无圆角、四周留 14% 出血（系统会自己裁形状，安全区里必须是完整图形）
{
  const cv = new Canvas(512, 512, 3);
  drawMotif(cv, { bleed: true, glow: false, radius: 0 });
  emit(DIRS.icons, 'icon-maskable-512.png', 512, 512, cv.toRGBA());
}

// 纹理（CSS 层用）：256² 可平铺纸纹。canvas 的取样点一张都不读它。
{
  const cv = new Canvas(256, 256, 4);
  cv.paper([C.surface, C.surfaceLift], 0.09, [1, 2, 3, 5, 8], 11);
  emit(DIRS.textures, 'paper-256.png', 256, 256, cv.toRGBA());
}
{
  const cv = new Canvas(256, 256, 4);
  cv.paper([C.field, C.field], 0.055, [2, 3, 5, 7, 11], 3);
  emit(DIRS.textures, 'field-256.png', 256, 256, cv.toRGBA());
}

/* 精灵图标：界面里那四支笔 + HUD 三个开关。一套语言（同线宽、同圆头、同内边距），
 * 色取盘面同一批令牌 ⇒ 图例与按钮之间不需要第二次翻译。 */
function drawGlyph(name, size) {
  const cv = new Canvas(size, size, ssFor(size));
  const u = size; // 归一化 0..1 → 像素
  const P = (pts) => pts.map(([x, y]) => [x * u, y * u]);
  const L = (n) => Math.max(1.2, n * u);
  const box = [[0.22, 0.22], [0.78, 0.22], [0.78, 0.78], [0.22, 0.78]];
  switch (name) {
    case 'loop':
      cv.polyline(P(box), L(0.13), rgba(C.accent, 1), { closed: true });
      cv.polyline(P([[0.34, 0.22], [0.66, 0.22]]), L(0.045), rgba(C.accentEdge, 0.75));
      break;
    case 'black':
      cv.roundRect(0.24 * u, 0.24 * u, 0.52 * u, 0.52 * u, 0.06 * u, rgba(C.blackCell, 1));
      cv.strokeRoundRect(0.24 * u, 0.24 * u, 0.52 * u, 0.52 * u, 0.06 * u, L(0.045), rgba(C.blackCellRing, 0.95));
      break;
    case 'cut':
      cv.polyline(P([[0.28, 0.28], [0.72, 0.72]]), L(0.1), rgba(C.cutMark, 1));
      cv.polyline(P([[0.28, 0.72], [0.72, 0.28]]), L(0.1), rgba(C.cutMark, 1));
      break;
    case 'erase':
      cv.polyline(P([[0.24, 0.72], [0.58, 0.72], [0.74, 0.44], [0.4, 0.28], [0.24, 0.72]]), L(0.075), rgba(C.ink, 0.9), { closed: true });
      cv.polyline(P([[0.4, 0.28], [0.58, 0.72]]), L(0.055), rgba(C.lineHeavy, 0.9));
      cv.polyline(P([[0.2, 0.86], [0.8, 0.86]]), L(0.05), rgba(C.lineHeavy, 0.55));
      break;
    case 'pause':
      cv.roundRect(0.3 * u, 0.24 * u, 0.13 * u, 0.52 * u, 0.04 * u, rgba(C.info, 1));
      cv.roundRect(0.57 * u, 0.24 * u, 0.13 * u, 0.52 * u, 0.04 * u, rgba(C.info, 1));
      break;
    case 'play':
      cv.polygon(P([[0.3, 0.2], [0.3, 0.8], [0.78, 0.5]]), rgba(C.success, 1));
      break;
    case 'sound-on':
      cv.polygon(P([[0.2, 0.42], [0.34, 0.42], [0.5, 0.26], [0.5, 0.74], [0.34, 0.58], [0.2, 0.58]]), rgba(C.accentEdge, 1));
      cv.polyline(P([[0.62, 0.36], [0.72, 0.5], [0.62, 0.64]]), L(0.07), rgba(C.accent, 1));
      cv.polyline(P([[0.74, 0.28], [0.88, 0.5], [0.74, 0.72]]), L(0.06), rgba(C.accent, 0.8));
      break;
    case 'sound-off':
      cv.polygon(P([[0.18, 0.42], [0.32, 0.42], [0.46, 0.28], [0.46, 0.72], [0.32, 0.58], [0.18, 0.58]]), rgba(C.lineHeavy, 0.9));
      cv.polyline(P([[0.6, 0.38], [0.82, 0.62]]), L(0.075), rgba(C.badRing, 1));
      cv.polyline(P([[0.6, 0.62], [0.82, 0.38]]), L(0.075), rgba(C.badRing, 1));
      break;
    case 'full':
      for (const [sx, sy] of [[0.24, 0.24, 1, 1], [0.76, 0.24, -1, 1], [0.24, 0.76, 1, -1], [0.76, 0.76, -1, -1]]) {
        cv.polyline(P([[sx, sy + 0.2 * sy_(-1, sy)], [sx, sy], [sx + 0.2 * sx_(sx), sy]]), L(0.085), rgba(C.info, 1));
      }
      break;
    default: throw new Error('未知图标 ' + name);
  }
  return cv.toRGBA();
}
// 四角括号的方向系数（0.24 那一角要向 0.76 方向长）
const sx_ = (sx) => (sx < 0.5 ? 1 : -1);
const sy_ = (_, sy) => (sy < 0.5 ? 1 : -1);

const GLYPHS = ['loop', 'black', 'cut', 'erase', 'pause', 'play', 'sound-on', 'sound-off', 'full'];
for (const g of GLYPHS) {
  for (const s of [48, 32]) emit(DIRS.sprites, `${g}-${s}.png`, s, s, drawGlyph(g, s));
}

/* 社交卡 1200×630：左边字（点阵，不引系统字体）、右边一整张能解的盘。 */
{
  const W = 1200, H = 630, ss = 2;
  const cv = new Canvas(W, H, ss);
  cv.paper([C.bgTop, C.bgBottom], 0.13, [1, 2, 3, 5], 5);
  const MARGIN = 72;
  const inner = new Canvas(Math.round(H * 0.74), Math.round(H * 0.74), 3);
  drawMotif(inner, { radius: inner.w * 0.1, paperAmp: 0.18 });
  const inRGB = inner.toRGBA();
  // 贴图：母题按亚像素 1:1 落在**右侧**（同 ss，无需重采样）。左栏留给字，两栏不相交。
  const ox = Math.round((W - MARGIN - inner.w) * ss);
  const oy = Math.round(((H - inner.h) / 2) * ss);
  for (let py = 0; py < inner.h; py++) {
    for (let px = 0; px < inner.w; px++) {
      const i = (py * inner.w + px) * 4;
      const a = inRGB[i + 3] / 255;
      if (a <= 0) continue;
      const col = [inRGB[i], inRGB[i + 1], inRGB[i + 2], a];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) cv.over(ox + px * ss + sx, oy + py * ss + sy, col);
    }
  }
  const LX = MARGIN;
  const titleCell = 13;
  const titleW = cv.textWidth('YAJILIN', titleCell, 0.5);
  cv.text('YAJILIN', LX, 190, titleCell, rgba(C.ink, 1), { tracking: 0.5 });
  cv.polyline([[LX, 300], [LX + titleW, 300]], 3, rgba(C.accent, 0.6));
  cv.text('LOOP BLACK CLUE', LX, 326, 6.2, rgba(C.accent, 0.96), { tracking: 0.55 });
  cv.text('EVERY BOARD SHIPS PROVED UNIQUE', LX, 396, 3.4, rgba(C.lineHeavy, 0.95), { tracking: 0.5 });
  cv.text('NO-Guess PENCIL SOLVER P1-P10', LX, 432, 3.4, rgba(C.pencilMark, 0.9), { tracking: 0.5 });
  cv.text('6X6 8X8 10X10', LX, 468, 3.4, rgba(C.info, 0.8), { tracking: 0.5 });
  emit(DIRS.social, 'og.png', W, H, cv.toRGBA());
}

console.log(rows.join('\n'));
console.log(`共 ${rows.length} 张 PNG ← assets/gen/make_art.mjs（母题=玩法，色=js/theme.js 的 Palette）`);
