// 颜色、间距、动效、画布几何的唯一来源。样式表通过 applyThemeVars() 读这些值，
// js/render/board.js 读的是同一批对象，所以改一个令牌不可能只改到一边。
//
// ⚠ 下面标了「被门禁量的」的色组，取样点与工具链只认 view 给出的那几个点（cellCenter /
// edgeMid / clueTile / ringPoint / pencilPoint）。断言用的是「每个取样点**可能**出现的颜色
// 逐通道拉开 ≥25」这条纪律，不是「全表两两 ≥25」——场底色 #213040 与网格线 #0B1020 在同一个
// 取样点永远不会撞车（一个在格心、一个在格边），把它们算进同一条纪律就是假要求。
// 实测矩阵由 tools/scenarios.js 的 render 场景打印（tools/verify.sh 的输出里能读到）。
export const Palette = {
  bgTop: '#070A14',
  bgBottom: '#121A2C',
  surface: '#0F1526',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#6B7FA8',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // 盘底（玩家还没落笔的格）。被门禁量的取样点：格心。
  // ⚠ 蓝通道必须离琥珀 #FFC85C(92) 远一点：环段就压在**同一个格心**上，而这两色在 R/G 上差得远、
  // 真正吃紧的是 B。#213050 时代 field↔accent 逐通道只差 222/152/**12**（render 场景实测），
  // 「这条琥珀是不是画在格心上」全靠 B 一个通道说话。压到 #213040 之后是 222/152/28。
  // 同一批实测数：field↔blackCell 28/41/51、field↔badRing 222/140/28、field↔pencilMark 27/187/74。
  field: '#213040',
  // 格线只画在格的边界上，也就是「一条边的中点」正好压在它上面。
  gridLine: '#0B1020',

  // 箭头格（题面给定的，玩家改不动）。它是第三种格心颜色，与场底/黑格都拉开。
  // 箭头笔与数字**不能同色**：门禁要按「方向」取证，两个都是 #F2F5FB 的话，
  // 箭头点读到的可能是数字的墨，方向画反了也照样绿。这里与 clueTile 逐通道 47/86/130、
  // 与 ink 228/225/213（实测值见 render 场景打印的矩阵）。
  clueTile: '#3D6EA8',
  clueArrow: '#0E1626',

  // 琥珀 = 玩家的手：画出来的环段与选中的格都是它。
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // 玩家涂的黑格（引擎的 ROLE.BLACK）。
  blackCell: '#05070D',
  blackCellRing: '#6B7FA8',

  // 排除叉（引擎的 EDGE.E_OFF）：这条边**不在环上**。它既不能读成「什么都没画」（那是
  // gridLine 压在边中点上），也不能读成环（那是 accent）。
  cutMark: '#8298C4',

  // 铅笔层（引擎 pencil() 推出来的那条结论，玩家按「提示」才解锁）。它与玩家自己的笔迹
  // 必须是**两种颜色**：否则「我画的」和「铅笔替我落的」在盘上分不开，撤销也就无从谈起。
  // 与同一取样点上可能出现的颜色逐通道（本轮 render 场景实测）：accent 195/35/46、
  // cutMark 70/83/58、gridLine 49/219/106、field 27/187/74、blackCell 55/228/125、badRing 195/143/46。
  pencilMark: '#3CEB8A',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  errorSoft: 'rgba(255,92,122,0.16)',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 度数 ≠ 0/2 的格：环在这一格接不通。圈是形状证据，色是附加证据。
  // ⚠ 与 text 用的 --error(#FF5C7A) 故意差一点：铅笔方块的描边正巧压在 ringPoint 上
  // （方块角在 pencilArm×√2 的对角线上、错误圈在 badRingRadius），两者共用取样点，
  // 所以 badRing 与 pencilMark 必须**逐通道**分得开。
  // #FF5C7A 与 #3CEB8A 的蓝通道只差 16，改成 #FF5C5C 之后差 46。
  badRing: '#FF5C5C',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 8, cell: 4 };

export const Font = {
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

export const Motion = {
  tap: 150,
  base: 220,
  line: 260,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 画布几何令牌：门禁按这些数取样，所以 draw 与 *Rect/*Point 必须读同一批数。
export const Board = {
  cellMin: 30,
  cellMax: 74,
  pad: 16,
  loopWidth: 0.2, // 环线宽 = cell * 0.2（segRect 的厚度也用它，取样点因此跑不出线外）
  gridWidth: 0.035, // 格线宽 = cell * 0.035（下限 1.5px）：边中点的取样必落在它上面
  ringWidth: 0.1,
  badRingWidth: 0.085,
  badRingRadius: 0.42, // 错误圈半径（ringPoint 与 draw 共用这一个数）
  badSoftRadius: 0.46, // 错误底的半径
  cutArm: 0.115, // 排除叉：半臂长（沿 45°）
  cutWidth: 0.075, // 排除叉：线宽
  blackInset: 0.13, // 黑格方块 = cell * (1 - 2*0.13)
  clueInset: 0.04, // 箭头格的瓦片离格边多远
  clueFont: 0.44, // 数字字号 = cell * 0.44（居中，ink 色）
  clueTileSample: 0.33, // 瓦片取样点：沿 45° 斜角，避开居中的数字与沿轴的箭头
  // 箭头三角：尖端在 0.42 格、底边在 0.28 格（都沿引擎给的 dir）。取样点 0.35 落在三角形里、
  // 又在数字之外——两个字符的 ink 最远到 0.26 格（monospace 0.6em × 0.44 × 2 ÷ 2）。
  // 上一版把箭头画在 0.30 而取样在 0.32，正好读到的是**尖之外的瓦片色**：方向画反了也照样绿。
  clueArrowTip: 0.42,
  clueArrowHead: 0.14, // 尖到底边的长度（底边半宽 = 0.7 × 这个数）
  clueArrowSample: 0.35,
  pencilArm: 0.3, // 铅笔结论的记号尺寸 = cell * 0.3（格心方块 / 边中点圆圈）
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

let motionReduced = false;
export function setReduceMotion(v) {
  motionReduced = !!v;
}
export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
