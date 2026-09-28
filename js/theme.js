// 颜色、间距、动效、画布几何的唯一来源。样式表通过 applyThemeVars() 读这些值，
// js/render/board.js 读的是同一批对象，所以改一个令牌不可能只改到一边。
//
// ⚠ 下面标了「被门禁量的」的色组，取样点与工具链只认 view 给出的那几个点（cellCenter /
// edgeMid / clueTile / ringPoint / pencilPoint）。断言用的是「每个取样点**可能**出现的颜色
// 逐通道拉开 ≥25」这条纪律，不是「全表两两 ≥25」——场底色 #213050 与网格线 #0B1020 在同一个
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

  // 盘底（玩家还没落笔的格）。被门禁量的取样点：格心。与黑格 #05070D 逐通道 28/41/67。
  field: '#213050',
  // 格线只画在格的边界上，也就是「一条边的中点」正好压在它上面。
  gridLine: '#0B1020',

  // 箭头格（题面给定的，玩家改不动）。它是第三种格心颜色，与场底/黑格都拉开。
  clueTile: '#3D6EA8',
  clueArrow: '#F2F5FB',

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
  // 与同取样点上可能出现的颜色逐通道：accent 35/35/46、cutMark 58/83/58、gridLine 49/219/92、
  // field 28/187/58、blackCell 55/228/125。
  pencilMark: '#3CEB8A',

  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  errorSoft: 'rgba(255,92,122,0.16)',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 度数 ≠ 0/2 的格：环在这一格接不通。圈是形状证据，色是附加证据。
  badRing: '#FF5C7A',
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
  ringWidth: 0.1,
  badRingWidth: 0.085,
  cutArm: 0.115, // 排除叉：半臂长（沿 45°）
  cutWidth: 0.075, // 排除叉：线宽
  blackInset: 0.13, // 黑格方块 = cell * (1 - 2*0.13)
  clueInset: 0.04, // 箭头格的瓦片离格边多远
  clueFont: 0.44, // 数字字号 = cell * 0.44
  clueArrow: 0.3, // 箭头杆长 = cell * 0.3
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
