// Canvas 渲染层。它读 Game 手里那两张笔表（role / ed）来画，自己不判断任何东西——
// 没有哪条边在这里被宣布「对」，也没有哪一格在这里被宣布「赢」——所以画面不可能和判胜用的
// verify() 打架。取值表用的是引擎导出的 ROLE / EDGE（pencil.js 文件尾就点名要轮 2 的画布按它上色）。
//
// 布局（格边长、盘面原点、DPR）也住在这里，因为 hitCell 必须回答「玩家点的那一下是哪一格」，
// 用的必须是 draw 刚刚用过的那批数。这两处分家就会出现「盘画对了、点击偏一格」的事故。
//
// 取样点全部由本文件给出去（cellRect / segRect / markPoint / clueTilePoint / clueArrowPoint /
// ringPoint / ghostPoint），draw 与门禁读的是同一批数：画法一改，测试跟着动，
// 不会出现「断言在旧位置上绿着、画面上早就换了地方」。
import { Palette, Board, Radius } from '../theme.js';
import { E_ON, E_OFF, BLACK, CLUE, UP, RIGHT, DOWN, LEFT } from '../ui/game.js';

const LOOP_DIRS = [RIGHT, DOWN]; // 每条无向边只从这两侧各画一次，免得重复描线

export function layoutFor(w, h, availW, availH) {
  const pad = Board.pad;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Board.cellMin, Math.min(Board.cellMax, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
    this.game = null;
  }

  // 后备缓冲按设备像素定尺寸，绘制调用全部留在 CSS 像素里：顶部一次 setTransform，
  // 就免得把这个文件里每个常数都乘二。
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr, pad: l.pad };
    this.game = game;
    return this.geo;
  }

  // ---- 几何读数（CSS 像素，画布本地）-------------------------------------------
  // 门禁取样只许用这几个函数产出的坐标，再乘 geo.dpr：page/client 坐标里带着画布自己的
  // getBoundingClientRect 偏移，喂给 getImageData 会量到整个盘宽之外的面板底色上。
  centerOf(cell) {
    const { cell: k, x, y } = this.geo;
    const w = this.game.w;
    return { x: (cell % w) * k + x + k / 2, y: ((cell / w) | 0) * k + y + k / 2 };
  }

  cellRect(cell) {
    const { cell: k, x, y } = this.geo;
    const w = this.game.w;
    const px = (cell % w) * k + x;
    const py = ((cell / w) | 0) * k + y;
    return { x: px, y: py, w: k, h: k, size: k, cx: px + k / 2, cy: py + k / 2 };
  }

  // 一条边的**包围盒**：中点 (x+w/2, y+h/2) 就是画笔经过的那一点，厚度取 lineWidth，
  // 所以环线粗细改了也不会让取样点跑出线外。
  segRect(cell, d) {
    const g = this.game;
    const nb = g.neighbor(cell, d);
    if (nb < 0) return null;
    const a = this.centerOf(cell);
    const b = this.centerOf(nb);
    const t = Math.max(2, this.geo.cell * Board.loopWidth);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    return {
      x: w > 0 ? x : x - t / 2,
      y: h > 0 ? y : y - t / 2,
      w: w > 0 ? w : t,
      h: h > 0 ? h : t,
      cell: nb,
      d,
    };
  }

  // 排除叉的画法（中心 + 半臂长 + 线宽）：中心就是这条边的中点，和 segRect 同一批数。
  markPoint(cell, d) {
    const g = this.game;
    const nb = g.neighbor(cell, d);
    if (nb < 0) return null;
    const a = this.centerOf(cell);
    const b = this.centerOf(nb);
    const k = this.geo.cell;
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      arm: Math.max(3, k * Board.cutArm),
      width: Math.max(1.5, k * Board.cutWidth),
    };
  }

  // 箭头格：瓦片上一个**必定是瓦片色**的点（斜角，避开居中的数字与沿轴的箭头）。
  clueTilePoint(cell) {
    const r = this.cellRect(cell);
    return { x: r.cx + r.size * Board.clueTileSample, y: r.cy + r.size * Board.clueTileSample };
  }

  // 箭头那一笔上的一点：沿引擎给的 dir 从格心伸出 Board.clueArrowSample 格。
  // 这个数必须落在 draw 画的那个三角形里（尖 0.42 / 底 0.28），方向画反了这个点就读瓦片色。
  clueArrowPoint(cell) {
    const g = this.game;
    const cl = g.clueAt(cell);
    if (!cl) return null;
    const k = this.geo.cell;
    const c = this.centerOf(cell);
    const off = k * Board.clueArrowSample;
    if (cl.dir === UP) return { x: c.x, y: c.y - off };
    if (cl.dir === DOWN) return { x: c.x, y: c.y + off };
    if (cl.dir === LEFT) return { x: c.x - off, y: c.y };
    return { x: c.x + off, y: c.y };
  }

  // 度数异常那一格的错误圈上的一点（45°，避开设在格心的黑格方块与沿轴的环线）。
  // 半径取 Board.badRingRadius（draw 画的圈用的就是这一个数）；铅笔方块的角在 pencilArm×√2，
  // 两者压在一起，所以 badRing 与 pencilMark 必须是**同一点位也分得开**的两种色（theme.js 的色组纪律）。
  ringPoint(cell) {
    const { cell: k } = this.geo;
    const c = this.centerOf(cell);
    const r = k * Board.badRingRadius * Math.SQRT1_2;
    return { x: c.x + r, y: c.y + r };
  }

  // 黑格方块的描边点（沿竖直轴、方块上边界）。draw 用的 inset 就是 Board.blackInset，
  // 门禁按这里给的点取色，不许在测试里再算一遍 inset——那也是「画法改了、断言还在旧位置绿着」的门。
  blackFacePoint(cell) {
    const c = this.centerOf(cell);
    const k = this.geo.cell;
    return { x: c.x, y: c.y - k * (0.5 - Board.blackInset) };
  }

  // 铅笔结论的记号点：黑格 = 方块描边上的点，环段 = 圆圈描边上的点。两处都是描边，
  // 记号中心留给底下的真实笔迹（玩家/铅笔落的值仍然按中心读）。
  ghostPoint(cell, d = -1) {
    const k = this.geo.cell;
    const rad = k * Board.pencilArm;
    if (d < 0) {
      const c = this.centerOf(cell);
      return { x: c.x - rad, y: c.y };
    }
    const m = this.markPoint(cell, d);
    if (!m) return null;
    const horiz = d === LEFT || d === RIGHT;
    return horiz ? { x: m.x, y: m.y - rad } : { x: m.x - rad, y: m.y };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return -1;
    return gy * g.w + gx;
  }

  // 指针的 client 坐标 → 这一格里**那一条边**：落在哪一半就动哪一条。
  // 主轴（|dx| 与 |dy| 谁大）决定横竖，符号决定朝哪。正好点在格心时 dx=dy=0 → 记作 RIGHT，
  // 是确定的、可测的。出盘的方向（那里根本没有边）返回 null，由调用方什么也不做。
  hitEdge(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return null;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return null;
    const hit = gy * g.w + gx;
    const dx = px - (gx * cell + cell / 2);
    const dy = py - (gy * cell + cell / 2);
    const d = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? RIGHT : LEFT) : (dy >= 0 ? DOWN : UP);
    return g.neighbor(hit, d) < 0 ? null : { cell: hit, d };
  }

  // 两格之间那条边的方向（不相邻返回 -1）——问引擎的邻接表，这里不算。
  dirFromTo(from, to) {
    const g = this.game;
    if (from < 0 || to < 0 || from === to) return -1;
    const d = g.dirTo(from, to);
    return d >= 0 && g.neighbor(from, d) === to ? d : -1;
  }

  draw(game, { preview = [], cursor = -1, won = false } = {}) {
    this.game = game;
    if (!this.geo.cell) return;
    const { ctx, geo } = this;
    const k = geo.cell;
    ctx.clearRect(0, 0, geo.w, geo.h);

    // 1) 卡片底 + 盘面底（「这一格什么都没画」的参照色）
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    const bx = geo.x - k * 0.5;
    const by = geo.y - k * 0.5;
    roundRect(ctx, bx, by, k * game.w + k, k * game.h + k, Radius.cell);
    ctx.fillStyle = Palette.field;
    ctx.fill();

    // 1b) 格线：只画在格的边界上，也就是「相邻两格中心的中点」正下方。
    // colorOfEdge 说「没落笔的边读 gridLine」、theme.js 说取样点纪律靠这条线，那就必须真的画出来：
    // 以前这里只有承诺没有笔画，未落笔的边中点量到的是 field——一条注释与画面分家的断言。
    ctx.save();
    roundRect(ctx, bx, by, k * game.w + k, k * game.h + k, Radius.cell);
    ctx.clip();
    ctx.strokeStyle = Palette.gridLine;
    ctx.lineWidth = Math.max(1.5, k * Board.gridWidth);
    ctx.beginPath();
    for (let c = 1; c < game.w; c++) {
      const px = geo.x + c * k;
      ctx.moveTo(px, by);
      ctx.lineTo(px, by + k * game.h + k);
    }
    for (let r = 1; r < game.h; r++) {
      const py = geo.y + r * k;
      ctx.moveTo(bx, py);
      ctx.lineTo(bx + k * game.w + k, py);
    }
    ctx.stroke();
    ctx.restore();

    // 2) 黑格（玩家涂的，含铅笔替玩家涂的那些——填充都是黑格色，铅笔的再加一圈描边）
    const inset = k * Board.blackInset;
    for (let cell = 0; cell < game.n; cell++) {
      if (game.role[cell] !== BLACK) continue;
      const c = this.centerOf(cell);
      const s = k - inset * 2;
      roundRect(ctx, c.x - s / 2, c.y - s / 2, s, s, Radius.cell);
      ctx.fillStyle = Palette.blackCell;
      ctx.fill();
      ctx.lineWidth = Math.max(1, k * 0.02);
      ctx.strokeStyle = Palette.blackCellRing;
      ctx.stroke();
    }

    // 3) 玩家画的环段（引擎的 E_ON 才画，这里不判断任何事）
    const lw = Math.max(2, k * Board.loopWidth);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Palette.accent;
    ctx.lineWidth = lw;
    for (let cell = 0; cell < game.n; cell++) {
      for (const d of LOOP_DIRS) {
        if (game.ed[cell][d] !== E_ON) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(game.neighbor(cell, d));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // 拖拽中的预览：同一个画法、半透明，松手才真的进状态
    if (preview.length) {
      ctx.globalAlpha = won ? 1 : 0.55;
      for (const [cell, d] of preview) {
        const nb = game.neighbor(cell, d);
        if (nb < 0) continue;
        const a = this.centerOf(cell);
        const b = this.centerOf(nb);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'butt';

    // 4) 排除叉（E_OFF）：边的中点上一个小叉。未落笔的边在这一层一条都不该出现。
    for (let cell = 0; cell < game.n; cell++) {
      for (const d of LOOP_DIRS) {
        if (game.ed[cell][d] !== E_OFF) continue;
        const m = this.markPoint(cell, d);
        if (!m) continue;
        ctx.strokeStyle = Palette.cutMark;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        const a = m.arm * Math.SQRT1_2;
        ctx.beginPath();
        ctx.moveTo(m.x - a, m.y - a);
        ctx.lineTo(m.x + a, m.y + a);
        ctx.moveTo(m.x - a, m.y + a);
        ctx.lineTo(m.x + a, m.y - a);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }

    // 5) 铅笔层：只在「这条结论确实是铅笔落的、而且没被玩家在同一处改掉」时出现。
    //    描边而不是填充：记号中心留给底下的真实笔迹，像素断言因此分得出「谁落的」。
    const rad = k * Board.pencilArm;
    ctx.strokeStyle = Palette.pencilMark;
    ctx.lineWidth = Math.max(1.5, k * 0.055);
    for (const [key, v] of game.ghost) {
      if (key[0] === 'c') {
        const cell = Number(key.slice(1));
        if (game.role[cell] !== v) continue;
        const c = this.centerOf(cell);
        ctx.beginPath();
        ctx.rect(c.x - rad, c.y - rad, rad * 2, rad * 2);
        ctx.stroke();
      } else {
        const [a, b] = key.split(':').map(Number);
        const d = game.dirTo(a, b);
        if (d < 0 || game.ed[a][d] !== v) continue;
        const m = this.markPoint(a, d);
        if (!m) continue;
        ctx.beginPath();
        ctx.arc(m.x, m.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 6) 度数异常的格：既不是 0 也不是 2，环在这一格接不通。圈是形状证据，色是附加证据。
    for (const cell of game.badCells()) {
      const c = this.centerOf(cell);
      ctx.fillStyle = Palette.errorSoft;
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * Board.badSoftRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = Palette.badRing;
      ctx.lineWidth = Math.max(2, k * Board.badRingWidth);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * Board.badRingRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 7) 箭头格：题面给定的，画在最上面（瓦片 + 数字 + 方向三角），任何笔迹都盖不住它。
    const font = Math.max(10, k * Board.clueFont);
    for (const [cell, cl] of game.question.clue) {
      const r = this.cellRect(cell);
      const c = this.centerOf(cell);
      const ins = k * Board.clueInset;
      roundRect(ctx, r.x + ins, r.y + ins, k - ins * 2, k - ins * 2, Radius.cell);
      ctx.fillStyle = Palette.clueTile;
      ctx.fill();
      ctx.fillStyle = Palette.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${font}px ${'ui-monospace, SFMono-Regular, Menlo, monospace'}`;
      ctx.fillText(String(cl.n), c.x, c.y + font * 0.04);
      const off = k * Board.clueArrowTip;
      const ah = Math.max(4, k * Board.clueArrowHead);
      ctx.fillStyle = Palette.clueArrow;
      ctx.beginPath();
      if (cl.dir === UP) {
        tri(ctx, c.x, c.y - off, ah, 0, -1);
      } else if (cl.dir === DOWN) {
        tri(ctx, c.x, c.y + off, ah, 0, 1);
      } else if (cl.dir === LEFT) {
        tri(ctx, c.x - off, c.y, ah, -1, 0);
      } else {
        tri(ctx, c.x + off, c.y, ah, 1, 0);
      }
      ctx.closePath();
      ctx.fill();
    }

    // 8) 键盘光标：虚线方框，指针玩家看不到它（sel 只在键盘操作时移动）
    if (cursor >= 0) {
      const r = this.cellRect(cursor);
      ctx.strokeStyle = Palette.info;
      ctx.lineWidth = Math.max(2, k * 0.06);
      ctx.setLineDash([Math.max(4, k * 0.2), Math.max(3, k * 0.14)]);
      roundRect(ctx, r.x + k * 0.06, r.y + k * 0.06, k - k * 0.12, k - k * 0.12, Radius.cell);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 给 harness 用：这一处此刻应当是什么颜色，由取色逻辑自己回答，免得测试里另抄一份调色板。
  colorOfEdge(cell, d) {
    const v = this.game.ed[cell][d];
    return v === E_ON ? Palette.accent : v === E_OFF ? Palette.cutMark : Palette.gridLine;
  }
  colorOfCell(cell) {
    const g = this.game;
    if (g.role[cell] === CLUE) return Palette.clueTile;
    return g.role[cell] === BLACK ? Palette.blackCell : Palette.field;
  }
  badColor() {
    return Palette.badRing;
  }
  pencilColor() {
    return Palette.pencilMark;
  }
}

function tri(ctx, x, y, h, ux, uy) {
  // 箭头尖在 (x,y)，底边垂直于 (ux,uy)
  const px = -uy;
  const py = ux;
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * h + px * h * 0.7, y - uy * h + py * h * 0.7);
  ctx.lineTo(x - ux * h - px * h * 0.7, y - uy * h - py * h * 0.7);
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
