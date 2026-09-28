// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。八场：
// boot / render / play / marks / resume / wrong / win / hint（verify.sh 里 marks→resume 是成对的，
// hint 排最后：它会赢一局，而赢会 clearResume，排在前面就把 resume 那场的存档吃掉了）。
//
// 这个仓最容易出的事故恰好是「引擎里对、屏幕上错」：箭头画反方向、格线只在注释里没真的画、
// 胜利卡片 display:grid 盖掉 [hidden] 还在吃点击、铅笔把答案提前画在盘上。所以这里只认三种证据：
// **DOM 的矩形、画布的像素、真指针事件打进去之后的读数**。`.hidden` 说的是代码想干什么，
// 一个 rect 和一个像素才是玩家拿到了什么。
//
// 两批坐标绝不能混：
//   · getImageData 要的是**画布本地 CSS 坐标 × dpr**，一律由 view.cellRect / segRect / markPoint /
//     clueTilePoint / clueArrowPoint / ringPoint / ghostPoint 产出（draw 用的就是同一批数）。
//     拿 client 坐标去喂，会量到整个盘宽之外的面板底色上，然后「量」出一个绿。
//   · PointerEvent / elementFromPoint 要的是 client 坐标，所以走 clientOf()（加了 getBoundingClientRect 偏移）。
//
// 判胜一律走引擎：verify(yajilin.game.board()) 的返回值与面板上那个数（#stat-verify）必须说同一句话。
// 场景不读 drag/won 这类内部旗标来决定红绿灯；唯一读的答案是 puzzle.solution，那是**harness 才拿得到**的
// 认证解，用来决定「鼠标该拖过哪几格」，用完之后断言的全是画面与引擎的判决。
((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `得到 ${got}，想要 ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 注入得比 app 的模块执行还早，所以这两个收集器能抓到启动期的异常
  const errs = [];
  w.addEventListener('error', (e) => errs.push(`${e.message} @ ${e.filename || ''}:${e.lineno || 0}`));
  w.addEventListener('unhandledrejection', (e) => errs.push(`rejection: ${e && e.reason}`));
  w.__yajilinErrs = errs;

  const A = () => w.yajilin;
  const E = () => w.yajilin.engine;
  const P = () => w.yajilin.palette;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const num = (sel) => Number(text(sel) || '0');

  const rgb = (hex) => {
    const h = String(hex).replace('#', '');
    const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  // near = 四个通道（含 alpha 位）全在 tol 之内；far = 至少一个通道超出 tol。二者不是互为反面：
  // 断言「这里画的是 X」用 near，断言「这里画的不是 Y」用 far，需要两者都说清的时候就都写。
  const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const far = (a, b, tol = 12) => a.some((v, i) => Math.abs(v - b[i]) > tol);
  const minChan = (a, b) => Math.min(...a.map((v, i) => Math.abs(v - b[i])));
  const show3 = (a) => `[${a[0]},${a[1]},${a[2]}]`;

  // ---- 画布本地坐标取样（CSS 像素 × dpr）------------------------------------
  function sample(lx, ly) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(lx * d), Math.round(ly * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  const cellMid = (cell) => {
    const r = A().view.cellRect(cell);
    return { x: r.cx, y: r.cy };
  };
  const segMid = (cell, d) => {
    const r = A().view.segRect(cell, d);
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  };
  // 叉的中心：由视图自己报它画在哪（draw 用的就是同一个 markPoint）。自己按「两格心中点」
  // 再算一遍的话，画法一改这条断言还会在旧位置上绿着。
  const markMid = (cell, d) => {
    const m = A().view.markPoint(cell, d);
    return m ? { x: m.x, y: m.y } : null;
  };
  // 整块画布的颜色直方图（按量化后的桶计数）。它是「盘上到底有多少这种颜色」的证据：
  // 单点取样证明不了「没有」，直方图能——泄漏的答案、不该出现的环线、画歪一格的箭头都靠它现形。
  // ⚠ 只数 alpha≥200 的像素：clearRect 之后圆角卡片边缘是**半透明近黑**，读起来就是黑格色
  // （#05070D）。把它算进「空白盘上黑格像素=0」那条断言，就是在数抗锯齿的碎片。
  function histogram(tol = 10) {
    const v = A().view;
    const img = v.ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data;
    const buckets = new Map();
    let opaque = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < 200) continue;
      opaque++;
      const key = `${Math.round(img[i] / tol) * tol},${Math.round(img[i + 1] / tol) * tol},${Math.round(img[i + 2] / tol) * tol}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const countNear = (hex) => {
      const [r, g, b] = rgb(hex);
      let n = 0;
      for (const [key, c] of buckets) {
        const [kr, kg, kb] = key.split(',').map(Number);
        if (Math.abs(kr - r) <= tol && Math.abs(kg - g) <= tol && Math.abs(kb - b) <= tol) n += c;
      }
      return n;
    };
    return { total: opaque, distinct: buckets.size, countNear };
  }

  // 一格方框内有多少个「接近这个颜色」的不透明像素（数字在不在瓦片上，用它取证）。
  function countInRect(cell, want, tol = 12) {
    const v = A().view;
    const d = v.geo.dpr;
    const r = v.cellRect(cell);
    const x0 = Math.round(r.x * d), y0 = Math.round(r.y * d);
    const wd = Math.max(1, Math.round(r.w * d)), hd = Math.max(1, Math.round(r.h * d));
    const img = v.ctx.getImageData(x0, y0, wd, hd).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < 200) continue;
      if (Math.abs(img[i] - want[0]) <= tol && Math.abs(img[i + 1] - want[1]) <= tol && Math.abs(img[i + 2] - want[2]) <= tol) n++;
    }
    return n;
  }

  // 「盘上每一个叉色的像素是从哪儿来的」：画叉只会画在边中点上（两格的公共边界），
  // 所以凡是叉色的像素落在**箭头格内部且离最近格边 >4px**，它就只可能是数字的抗锯齿边。
  // 这条把「直方数不清叉」的缺口补成了一个正向不变量，而不是把断言删掉。
  function cutPixelProvenance(g, v, cutRgb, tol = 10) {
    const d = v.geo.dpr;
    const img = v.ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data;
    const bad = [];
    let total = 0;
    for (let py = 0; py < v.canvas.height; py++) {
      for (let px = 0; px < v.canvas.width; px++) {
        const i = (py * v.canvas.width + px) * 4;
        if (img[i + 3] < 200) continue;
        if (!(Math.abs(img[i] - cutRgb[0]) <= tol && Math.abs(img[i + 1] - cutRgb[1]) <= tol && Math.abs(img[i + 2] - cutRgb[2]) <= tol)) continue;
        total++;
        if (bad.length >= 8) continue;
        const lx = px / d, ly = py / d; // 画布本地 CSS 坐标
        const gx = (lx - v.geo.x) / v.geo.cell, gy = (ly - v.geo.y) / v.geo.cell;
        if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) { bad.push(`(${px},${py}) 盘外`); continue; }
        const cell = (gy | 0) * g.w + (gx | 0);
        const dx = Math.min(gx % 1, 1 - (gx % 1)) * v.geo.cell;
        const dy = Math.min(gy % 1, 1 - (gy % 1)) * v.geo.cell;
        const edgeDist = Math.min(dx, dy) * d; // 换算成设备像素，与取样精度同尺度
        if (!g.isClue(cell) || edgeDist <= 4) {
          bad.push(`(${px},${py}) cell=${cell}${g.isClue(cell) ? '(箭头格)' : ''} 离格边 ${edgeDist.toFixed(1)}px`);
        }
      }
    }
    return { total, bad };
  }

  // ---- 真指针（client 坐标）--------------------------------------------------
  function clientOf(lx, ly) {
    const b = A().view.canvas.getBoundingClientRect();
    return { x: b.left + lx, y: b.top + ly };
  }
  const ptOf = (cell) => {
    const m = cellMid(cell);
    return clientOf(m.x, m.y);
  };
  function pointer(type, x, y, button = 0) {
    A().view.canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      })
    );
  }
  // 真拖拽：按下 → 逐格 move → 抬起。相邻与否由 view.dirFromTo 在页面里判断，这里不替它判。
  async function dragPath(cells, button = 0) {
    const a = ptOf(cells[0]);
    pointer('pointerdown', a.x, a.y, button);
    await wait(10);
    for (let i = 1; i < cells.length; i++) {
      const p = ptOf(cells[i]);
      pointer('pointermove', p.x, p.y, button);
      await wait(6);
    }
    const z = ptOf(cells[cells.length - 1]);
    pointer('pointerup', z.x, z.y, button);
    await wait(40);
  }
  // 一次一格按下再抬起（涂黑笔/擦掉笔的点选）
  async function clickCell(cell, button = 0) {
    const p = ptOf(cell);
    pointer('pointerdown', p.x, p.y, button);
    await wait(8);
    pointer('pointerup', p.x, p.y, button);
    await wait(30);
  }
  // 右键落在一条边的中点上：真指针事件，坐标换算成 client 再打。
  async function rightClickEdge(cell, d) {
    const m = markMid(cell, d);
    const p = clientOf(m.x, m.y);
    pointer('pointerdown', p.x, p.y, 2);
    await wait(8);
    pointer('pointerup', p.x, p.y, 2);
    await wait(30);
  }
  // 一格某一侧的那半张脸：指针落在这一半，命中的就是这一条边（view.hitEdge 的主轴规则）。
  // 0.26 cell 离格心足够远（|dx|>|dy| 稳定成立），又还在格内（0.5 之内）。
  const HALF = 0.26;
  function halfOf(cell, d) {
    const r = A().view.cellRect(cell);
    const off = r.size * HALF;
    if (d === E().RIGHT) return { x: r.cx + off, y: r.cy };
    if (d === E().LEFT) return { x: r.cx - off, y: r.cy };
    if (d === E().DOWN) return { x: r.cx, y: r.cy + off };
    return { x: r.cx, y: r.cy - off };
  }

  // ---- 答案→指针路线（harness 专用；产品代码里没有任何一处读 solution）--------
  // 把认证解的边集走成**有序环**：只经引擎导出的邻接关系（prepare().nb），不自己算坐标。
  function cycleOrder(solution, nb) {
    const adj = new Map();
    for (const e of solution.edges) {
      const [a, b] = e.split(':').map(Number);
      (adj.get(a) || adj.set(a, []).get(a)).push(b);
      (adj.get(b) || adj.set(b, []).get(b)).push(a);
    }
    const start = [...adj.keys()].sort((x, y) => x - y)[0];
    if (start === undefined) return [];
    const out = [start];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard <= solution.n * 2; guard++) {
      const nexts = (adj.get(cur) || []).filter((x) => x !== prev);
      if (!nexts.length) break;
      prev = cur;
      cur = nexts[0];
      if (cur === start) return out;
      out.push(cur);
    }
    return null; // 走不回起点：这批边不是一条单环（harness 自己就错了，场景会大声红）
  }
  // 单位正方形翻面：环上取**一个 2×2 方格的两条对边** (a-b)、(c-d)，拆掉它们、补上另外两条对边
  // (b-c)、(d-a)。四个顶点仍然每格 2 度，黑格/箭头格/射线/覆盖一格都不动，
  // 唯一坏掉的是「一条单环」——环被拆成两条各自闭合的环。这就是「局部全对、全局不成立」的样本。
  // ⚠ 补成 (a-c)、(b-d) 的那种接法只会得到**另一条**单环（顶点集没变、仍是简单多边形），
  // 那是这道题的第二个解而不是错题，与计数器认证的唯一解矛盾——所以这里找的不是它。
  // 网格图里唯一的 4-环就是单位正方形，因此 a,b,c,d 必须铺满一个方格；两段各 ≥4 格才各自成环。
  function twoOptSplit(order, nb) {
    const n = order.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 4; j <= n - 4; j++) {
        const a = order[i], b = order[i + 1], c = order[j], d = order[j + 1];
        if (new Set([a, b, c, d]).size !== 4) continue;
        const dBC = nb[b].indexOf(c), dDA = nb[d].indexOf(a);
        if (dBC < 0 || dDA < 0) continue; // 要补的那两条不是邻边 ⇒ 接不上
        // 要补的两条不能已经是环上的边（否则是空转）。环边只有 (order[k], order[k+1]) 与回边
        // (order[n-1], order[0])：(b,c)=(i+1,j) 是环边要 j=i+2，被 j>=i+4 挡掉；
        // (d,a)=(j+1,i) 是环边要么 j+1=i（不可能），要么是回边 ⇒ j=n-1 且 i=0，被 j<=n-4 挡掉。
        // 两段弧长也各自 ≥4 条边（j-i-1≥3、n-j≥4），加一条边后各自成 ≥4 边的环，不是悬边。
        const iAB = nb[a].indexOf(b), iCD = nb[c].indexOf(d);
        if (iAB < 0 || iCD < 0) continue;
        return { drop: [[a, iAB], [c, iCD]], add: [[b, dBC], [d, dDA]], cells: { a, b, c, d } };
      }
    }
    return null;
  }

  // 两条开放链：把环边集去掉 drop 那两条边之后逐条走到底（指针只能沿相邻格走）。
  // 翻对了应当正好得到 2 条链，每条两个 1 度端点、端点就是 add 的那两对；对不上就是 harness
  // 自己错了，大声红。
  // ⚠ drop/add 里记的是 [格, 方向下标]（引擎的边就这么表示），不是 [格, 格]：
  // 键必须先用 nb 把方向翻译回对面那格，否则 removed 里全是 bogus 键、一条边都拆不掉，
  // 走出来的就是一条 0 端点的闭环而不是两条链（这一版就在这里红过一次）。
  function chains(order, drop, nb) {
    const key = (x, d) => {
      const y = nb[x][d];
      return `${Math.min(x, y)}:${Math.max(x, y)}`;
    };
    const removed = new Set(drop.map(([x, d]) => key(x, d)));
    const adj = new Map();
    const link = (x, y) => {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push(y);
    };
    for (let i = 0; i < order.length; i++) {
      const x = order[i], y = order[(i + 1) % order.length];
      const key = `${Math.min(x, y)}:${Math.max(x, y)}`;
      if (removed.has(key)) continue;
      link(x, y);
      link(y, x);
    }
    const seen = new Set();
    const out = [];
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const node = [...adj.keys()].find((k) => !seen.has(k) && adj.get(k).length === 1) || start;
      const chain = [node];
      seen.add(node);
      let prev = -1;
      let cur = node;
      for (;;) {
        const next = (adj.get(cur) || []).find((x) => x !== prev && !seen.has(x));
        if (next === undefined) break;
        prev = cur;
        cur = next;
        chain.push(cur);
        seen.add(cur);
      }
      out.push(chain);
    }
    return out;
  }

  const GATE_KEY = 'yajilin.gate.marks'; // app 从不读这个键（它只认 yajilin.save.v1）

  // 控件分两批：开局就能看到的，与只有赢之后才存在的（胜利卡片里那两个）。
  const ALWAYS_IDS = ['size-select', 'btn-mode-loop', 'btn-mode-black', 'btn-mode-cut', 'btn-mode-erase',
    'btn-hint', 'btn-undo', 'btn-clear', 'btn-new', 'btn-reset', 'btn-motion',
    'board', 'state-line', 'verify-line', 'pencil-list', 'stat-seed', 'stat-verify', 'stat-pencil'];
  const WIN_IDS = ['btn-again', 'btn-close-veil', 'win-meta'];

  // 玩家点得到吗？只看三件看得见的事实：矩形有没有面积、中心点上 elementFromPoint 落回谁、
  // computed 样式有没有把它藏起来或关掉 pointer。滚进视口之后才量——量一个在屏幕外的按钮不算证据。
  function reachable(ids) {
    const bad = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { bad.push(`${id}:不存在`); continue; }
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 8 || r.height < 8) { bad.push(`${id}:零矩形 ${Math.round(r.width)}×${Math.round(r.height)}`); continue; }
      if (cs.pointerEvents === 'none' || cs.visibility === 'hidden' || cs.display === 'none') {
        bad.push(`${id}:不可达 ${cs.display}/${cs.visibility}/${cs.pointerEvents}`);
        continue;
      }
      if (!(r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1)) {
        bad.push(`${id}:出视口 [${Math.round(r.left)},${Math.round(r.top)}]`);
        continue;
      }
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (!(hit && (hit === el || el.contains(hit) || hit.contains(el)))) {
        bad.push(`${id}:中心被 ${hit && (hit.id || hit.tagName)} 挡住`);
      }
    }
    return bad;
  }
  const setExpect = (obj) => { try { localStorage.setItem(GATE_KEY, JSON.stringify(obj)); } catch { /* 隐私模式：场景会大声红 */ } };
  const getExpect = () => { try { return JSON.parse(localStorage.getItem(GATE_KEY) || 'null'); } catch { return null; } };

  const ng = {};
  // ── 1. boot：页面真的是一张能玩的盘，而不是一句「有个 app」──────────────────
  ng.boot = async () => {
    const a = A();
    for (let i = 0; i < 60 && (!a.game || a.state !== 'ready'); i++) await wait(50);
    ck('boot: window.yajilin 起来了且 state=ready（启动期一条异常都没有）', a && a.game && a.state === 'ready', `state=${a && a.state}`);
    ck('boot: 加载与首帧没有未捕获异常/未处理 rejection', errs.length === 0, errs.slice(0, 3).join(' | '));
    const g = a.game;
    if (!g) return report({ fatal: 'no game' });

    // 最容易自己骗自己的断言就是「canvas 存在」。要的是：它有面积、它在自己的容器里、
    // 它的后备缓冲等于 CSS 尺寸 × dpr（差一个像素，取样点就落在画布外面）。
    const v = a.view;
    const cr = v.canvas.getBoundingClientRect();
    const wr = document.getElementById('board-wrap').getBoundingClientRect();
    ck('boot: 画布有真实面积且装在 #board-wrap 里',
      cr.width > 60 && cr.height > 60 && cr.left >= wr.left - 1 && cr.top >= wr.top - 1 && cr.right <= wr.right + 1 && cr.bottom <= wr.bottom + 1,
      `canvas=${Math.round(cr.width)}×${Math.round(cr.height)}@[${Math.round(cr.left)},${Math.round(cr.top)}] wrap=${Math.round(wr.width)}×${Math.round(wr.height)}@[${Math.round(wr.left)},${Math.round(wr.top)}]`);
    const k = v.geo.cell;
    eq('boot: CSS 宽 = cell×w + 2×pad（布局自洽，格数与边长不是各说各话）', Math.round(cr.width), k * g.w + v.geo.pad * 2);
    eq('boot: CSS 高 = cell×h + 2×pad', Math.round(cr.height), k * g.h + v.geo.pad * 2);
    eq('boot: 后备缓冲宽 = CSS 宽 × dpr', v.canvas.width, Math.round(cr.width * v.geo.dpr));
    eq('boot: 后备缓冲高 = CSS 高 × dpr', v.canvas.height, Math.round(cr.height * v.geo.dpr));

    const h = histogram();
    ck('boot: 画布不是空的一片（distinct>8 且有场底色）', h.distinct > 8 && h.countNear(P().field) > 100,
      `distinct=${h.distinct} fieldPx=${h.countNear(P().field)}/${h.total}`);

    // 胜利卡片必须是**几何上不存在**：display:none + 零矩形 + 不吃 pointer。
    // 只读 .hidden 属性的话，CSS 里一句 #win-veil{display:grid} 就能让它盖在盘上还在收点击。
    const veil = document.getElementById('win-veil');
    const vs = getComputedStyle(veil);
    const vr = veil.getBoundingClientRect();
    const mid = clientOf(cr.width / 2, cr.height / 2);
    const topEl = document.elementFromPoint(Math.round(mid.x), Math.round(mid.y));
    ck('boot: 开局时胜利卡片几何上不存在且不吞点击（computed display:none、零矩形、盘心 elementFromPoint 就是 canvas）',
      vs.display === 'none' && vr.width === 0 && vr.height === 0 && veil.hidden === true && topEl === v.canvas,
      `display=${vs.display} rect=${Math.round(vr.width)}×${Math.round(vr.height)} hidden=${veil.hidden} elementFromPoint=${topEl && (topEl.id || topEl.tagName)}`);

    // 「我说能点的都真能点」：每个控件的矩形非空、可达、且中心点上 elementFromPoint 落回它自己。
    // ⚠ 分成两批：#btn-again / #btn-close-veil 住在胜利卡片里，开局时那个容器 display:none，
    // 它们**本该**是零矩形。把它们混进这张表只会得到一条永真的红；真正的可达性在 win 场景里、
    // 卡片真的盖上来之后量。
    const blocked = reachable(ALWAYS_IDS);
    ck(`boot: ${ALWAYS_IDS.length} 个常显控件的 hit box 全都可达（矩形非空 + 中心点 elementFromPoint 落回自己）`, blocked.length === 0, blocked.slice(0, 5).join(' | '));
    const veilOnly = reachable(WIN_IDS);
    ck('boot: 卡片里那两个按钮此刻确实不可达（零矩形——它们是「没赢就没有这张卡片」的证据，不是漏测）',
      veilOnly.length === WIN_IDS.length && veilOnly.every((s) => s.includes('零矩形')), veilOnly.join(' | '));

    // 四支笔：真 click，读 DOM 上的 aria-pressed（玩家看得见的就是它）
    const pressed = () => ['loop', 'black', 'cut', 'erase'].map((m) => document.getElementById(`btn-mode-${m}`).getAttribute('aria-pressed')).join('/');
    const penBad = [];
    for (const m of ['black', 'cut', 'erase', 'loop']) {
      document.getElementById(`btn-mode-${m}`).click();
      await wait(20);
      const want = ['loop', 'black', 'cut', 'erase'].map((x) => String(x === m)).join('/');
      if (pressed() !== want) penBad.push(`${m}:aria=${pressed()}`);
    }
    ck('boot: 四支笔点得到、aria-pressed 只亮被点的那一支（擦掉笔取值是 0，判据用 in 不是真假）',
      penBad.length === 0 && a.mode === 'loop', penBad.join(' | '));

    // 页内动态 import 走 document.baseURI：前缀腿里写死 '/js/...' 就是 404，而 404 只在控制台里响一声。
    const imp = await import(new URL('js/engine/model.js', document.baseURI).href).catch((e) => ({ err: e.message }));
    ck('boot: 页内动态 import 用 document.baseURI 解析得到引擎（且就是页面加载的那一份模块图）',
      typeof imp.verify === 'function' && imp.verify === E().verify,
      `baseURI=${document.baseURI} import=${typeof imp.verify} 同一份=${imp.verify === E().verify} err=${imp.err || ''}`);

    // seed 的可复现性必须是真的：同一个 seed 两次出货逐字节同一张盘。
    const q1 = E().makeQuestion('gate-fixed-6', '6x6');
    const q2 = E().makeQuestion('gate-fixed-6', '6x6');
    const clueStr = (q) => [...q.question.clue.entries()].sort((x, y) => x[0] - y[0]).map(([i, c]) => `${i}:${c.dir}:${c.n}`).join(',');
    ck('boot: 同一个 seed 出同一张盘（指纹与逐条箭头都对得上——「seed xxxx」那句才不是谎话）',
      q1.ok && q2.ok && q1.fingerprint === q2.fingerprint && clueStr(q1) === clueStr(q2),
      `${q1.fingerprint} vs ${q2.fingerprint}；箭头 ${clueStr(q1).slice(0, 60)}`);
    const shownSeed = text('#stat-seed');
    // 「默认 seed 不是按日期算的」这句话在浏览器里只有两种证法：同一次加载里连铸三颗必须颗颗不同
    // （日期当 seed 的话一整天都该给出同一颗），而且计数器那一段单调递增（`换一局` 的自增是
    // seed 的前缀，后缀是每次现取的字节日志）。源码侧的门禁在 tools/check.mjs（mintSeed 体内零 Date）。
    const mints = [a.mintSeed(), a.mintSeed(), a.mintSeed()];
    const numOf = (s) => parseInt(s.slice(1, s.indexOf('-')), 36);
    ck('boot: 连铸三颗 seed 颗颗不同、前缀单调递增（默认 seed 里没有时间；换一局是 seed+k 自增）',
      mints.every((s) => /^y[0-9a-z]+-[0-9a-f]{12}$/.test(s)) && new Set(mints).size === 3 &&
        numOf(mints[0]) < numOf(mints[1]) && numOf(mints[1]) < numOf(mints[2]),
      mints.join(' '));
    ck('boot: 状态行里的 seed 就是这一局的 seed（「seed xxxx」不是另铸一颗来展示的）',
      shownSeed === `seed ${g.seed}`, `#stat-seed="${shownSeed}" seed=${g.seed}`);
    eq('boot: 面板箭头数 = 题面 clue 条数（UI 没自己数一套）', text('#stat-clues'), String(g.question.clue.size));
    ck('boot: 页面自己写了存档（seed/尺寸/笔迹都在里面，刷新才谈得上续局）',
      !!localStorage.getItem('yajilin.save.v1'), `keys=${Object.keys(localStorage).join(',')}`);
    // 菜单的形状是承诺，不是实现细节：下拉里能选到的必须逐字等于引擎里 inMenu 的那几档。
    // 它两头都挡——挡"引擎降了档而界面还留着"（玩家点到的是一个拿不到货的承诺），也挡"界面自己多列一档"。
    // 条数只卡下界（≥3 档）：往上加档是产品变好，往下缩才是该红的。
    const optKeys = [...$('#size-select').options].map((o) => o.value);
    ck('boot: 尺寸下拉的档位 = 引擎 TIERS 里 inMenu 的那几档（菜单是承诺，界面不自己多列、也不少列）',
      JSON.stringify(optKeys) === JSON.stringify(a.engine.TIERS.filter((t) => t.inMenu).map((t) => t.key)) &&
        JSON.stringify(optKeys) === JSON.stringify(a.engine.SIZES) && optKeys.length >= 3,
      `下拉=${optKeys.join('/')} 引擎=${a.engine.TIERS.filter((t) => t.inMenu).map((t) => t.key).join('/')} SIZES=${a.engine.SIZES.join('/')}`);

    // 子资源必须真的拿到 2xx/3xx：前缀腿最容易出的事故是页面里写死一个绝对路径
    // （"/css/game.css"）——DOM 照样在、只有样式丢了，而且那声 404 只在控制台里响一下。
    // resource timing 的 responseStatus 是浏览器自己记的账，比「看直方图猜样式在不在」硬。
    const res = performance.getEntriesByType('resource');
    const badRes = res.filter((e) => !(e.responseStatus >= 200 && e.responseStatus < 400));
    ck('boot: 每一个子资源都真的 2xx/3xx（responseStatus 逐条读回；写死的根路径在前缀腿就死在这条）',
      res.length >= 2 && badRes.length === 0,
      `${res.length} 条资源：${badRes.slice(0, 4).map((e) => `${e.responseStatus}<-${e.name.split('/').slice(-2).join('/')}`).join(' ') || '全通'}`);

    // timeOrigin 是「这一趟真的换过文档」的证人：verify.sh 在同一条腿里把 boot 连跑两次，
    // 第二次的 timeOrigin 必须严格大于第一次——片段导航（同文档跳转）在这里会被当场抓到。
    // 它只进 report 的 extras（给脚本读），不进 localStorage：交棒给 resume 的那份期望值是
    // marks 那一场的活（见 ng.marks 末尾的 setExpect），boot 往里写只会把交棒内容顶掉。
    return report({
      // 视口证人：verify.sh 的移动腿读的是**这一场自己报的** vw/vh/dpr，不是桌面的读数。
      // 桌面腿与移动腿的 vw 若一样，那条 Emulation 就没生效（覆写只活在本会话的调用里）。
      vw: innerWidth, vh: innerHeight, dprWin: devicePixelRatio,
      base: document.baseURI,
      timeOrigin: performance.timeOrigin,
      resources: res.length,
      seed: g.seed,
      size: `${g.w}×${g.h}`,
      cell: k,
      dpr: v.geo.dpr,
      distinct: h.distinct,
      clues: g.question.clue.size,
      ladder: g.ladder.length,
    });
  };

  // ── 2. render：画面上每一格/每一条边读起来就是引擎说的那个态 ────────────────
  // 这一场管三件事：①几何自洽（取样点 = draw 用过的点，命中 = 同一个点反着算回来）；
  // ②没落笔的盘子上一件答案都不许出现（直方图数得出「零条环线、零个黑格、零个叉」）；
  // ③箭头**方向**逐格取证——沿 dir 那一点是箭头色，另三个方向还是瓦片色。
  ng.render = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-render-8', sizeKey: '8x8' });
    await wait(60);
    if (!g) { ck('render: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const v = a.view;
    const E_ = E();
    const C = {
      field: rgb(P().field), grid: rgb(P().gridLine), tile: rgb(P().clueTile),
      arrow: rgb(P().clueArrow), accent: rgb(P().accent), cut: rgb(P().cutMark),
      black: rgb(P().blackCell), pencil: rgb(P().pencilMark), ink: rgb(P().ink), bad: rgb(P().badRing),
    };

    // ①几何：每一格的中心点经 client 坐标绕一圈必须回到这一格
    const miss = [];
    for (let cell = 0; cell < g.n; cell++) {
      const p = ptOf(cell);
      if (v.hitCell(p.x, p.y) !== cell) miss.push(`${cell}→${v.hitCell(p.x, p.y)}`);
    }
    ck(`render: ${g.n} 个格心经真 client 坐标反查全部命中本格（画对了、点偏一格的事故在这里现形）`, miss.length === 0, miss.slice(0, 6).join(' '));

    // 取样点必须是 draw 用过的那批数：markPoint 与 segRect 中点、两格中心的中点三者要重合
    const geoBad = [];
    for (let cell = 0; cell < g.n; cell++) {
      for (const d of [E_.RIGHT, E_.DOWN]) {
        const nb = g.neighbor(cell, d);
        if (nb < 0) continue;
        const m = v.markPoint(cell, d), r = v.segRect(cell, d), ca = v.centerOf(cell), cb = v.centerOf(nb);
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
        if (Math.abs(m.x - mx) > 0.01 || Math.abs(m.y - my) > 0.01) geoBad.push(`m${cell}:${d}`);
        if (Math.abs(r.x + r.w / 2 - mx) > 0.01 || Math.abs(r.y + r.h / 2 - my) > 0.01) geoBad.push(`s${cell}:${d}`);
        // 主轴规则：落在这半张脸上，命中的就是这一条边
        const half = halfOf(cell, d);
        const he = v.hitEdge(clientOf(half.x, half.y).x, clientOf(half.x, half.y).y);
        if (!he || he.cell !== cell || he.d !== d) geoBad.push(`hit${cell}:${d}=${he ? he.cell + '/' + he.d : 'null'}`);
      }
    }
    ck('render: 叉中心=环线包围盒中点=两格中心中点；半格指针命中的就是那条边（三处取样口径一致）',
      geoBad.length === 0, geoBad.slice(0, 6).join(' '));

    // 出盘的方向：那里没有边，hitEdge 必须给 null（不然后果是「在界外画出一条环」）
    const outBad = [];
    for (let cell = 0; cell < g.n; cell++) {
      for (let d = 0; d < 4; d++) {
        if (g.neighbor(cell, d) >= 0) continue;
        const hp = clientOf(halfOf(cell, d).x, halfOf(cell, d).y);
        if (v.hitEdge(hp.x, hp.y) !== null) outBad.push(`${cell}:${d}`);
      }
    }
    const corner = clientOf(4, 4);
    ck('render: 界外的方向点返回 null，盘外的像素也点不到格（hitCell=-1）',
      outBad.length === 0 && v.hitCell(corner.x, corner.y) === -1, `out=${outBad.slice(0, 4).join(' ')} corner=${v.hitCell(corner.x, corner.y)}`);

    // ②没落笔的盘子：格心/边中点分别应当读到 场底 / 格线。
    // 箭头格的**正中心**是数字住的地方（ink 或其抗锯齿边），不是瓦片——所以瓦片色在
    // view.clueTilePoint（斜角）取证，数字在「这一格的方框里有没有 ink 像素」取证。
    const px = [];
    const noInk = [];
    for (let cell = 0; cell < g.n; cell++) {
      const c = v.cellRect(cell);
      const p = sample(c.cx, c.cy);
      if (g.isClue(cell)) {
        // 瓦片取证走 view.clueTilePoint 自己报的那个点，不在这里另乘一份 0.33：
        // 令牌一改、断言还守在旧位置上绿着，就是这一族门禁最擅长伪造的那种绿。
        const tp = v.clueTilePoint(cell);
        if (!near(sample(tp.x, tp.y), C.tile)) px.push(`tile${cell}=${show3(sample(tp.x, tp.y))}`);
        // 中心这一点必须「不是场底也不是黑格」：它是题面格，玩家怎么画都不该把它洗成底色
        if (near(p, C.field) || near(p, C.black)) px.push(`tile中心${cell}=${show3(p)}`);
        if (countInRect(cell, C.ink, 12) < 20) noInk.push(`${cell}(inkPx=${countInRect(cell, C.ink, 12)})`);
      } else if (!near(p, C.field)) px.push(`field${cell}=${show3(p)}`);
    }
    ck(`render: ${g.n} 个格心的颜色就是角色表说的颜色（箭头格=瓦片上有数字、其余=场底，一格都不许偏）`,
      px.length === 0 && noInk.length === 0, [px.slice(0, 5).join(' '), noInk.slice(0, 5).join(' ')].join(' | '));

    const segPx = [];
    for (let cell = 0; cell < g.n; cell++) {
      for (const d of [E_.RIGHT, E_.DOWN, E_.LEFT, E_.UP]) {
        if (g.neighbor(cell, d) < 0) continue;
        const m = v.markPoint(cell, d);
        const p = sample(m.x, m.y);
        if (!near(p, C.grid)) segPx.push(`${cell}:${d}=${show3(p)}`);
      }
    }
    ck(`render: ${g.edgeCount()} 条边的中点全都读格线色（没落笔=格线，这是 colorOfEdge(E_UNK) 兑现的地方）`,
      segPx.length === 0, segPx.slice(0, 6).join(' '));

    // ③箭头方向：逐条箭头按引擎给的 dir 取证，另外三个方向必须还是瓦片色。
    // 取样半径从 view 自己的读数推出来（它离格心多远就是多远），不在测试里另抄一份令牌数，
    // 否则画法一改、断言还在旧位置上绿着。
    const AXS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // 与引擎 DIRS 同序：上右下左
    const dirBad = [];
    const dirSeen = {};
    for (const [cell, cl] of g.question.clue) {
      dirSeen[cl.dir] = (dirSeen[cl.dir] || 0) + 1;
      const p0 = v.clueArrowPoint(cell);
      const p = sample(p0.x, p0.y);
      if (!near(p, C.arrow)) dirBad.push(`${cell}:dir${cl.dir} 箭头点=${show3(p)} 想要 ${show3(C.arrow)}`);
      const c = v.centerOf(cell);
      const off = Math.hypot(p0.x - c.x, p0.y - c.y);
      for (let other = 0; other < 4; other++) {
        if (other === cl.dir) continue;
        const pp = sample(c.x + AXS[other][0] * off, c.y + AXS[other][1] * off);
        if (!near(pp, C.tile)) dirBad.push(`${cell}:dir${cl.dir} 的${other}侧=${show3(pp)} 想要瓦片 ${show3(C.tile)}`);
      }
    }
    ck(`render: ${g.question.clue.size} 条箭头逐条按 dir 画出方向（沿 dir 是箭头色，另三侧还是瓦片色）`,
      dirBad.length === 0, dirBad.slice(0, 4).join(' | '));
    ck('render: 这张盘把四个方向都 witness 到了（少一个方向就是那条断言没被检验过）',
      [0, 1, 2, 3].every((d) => dirSeen[d] > 0), JSON.stringify(dirSeen));

    // ④没有答案泄漏。环线/铅笔/黑格用**整块画布的直方图**数到 0；叉色不能这么数：
    // 数字的抗锯齿边（ink #F2F5FB 压在瓦片 #3D6EA8 上，约 35% 处）正好经过 #8298C4 附近，
    // 实测这张 8×8 空白盘有 64 个这样的像素。所以叉的证据换成两条更强的：
    //   (a) 每一条边的中点都离叉色远（画叉的唯一位置就是边中点）；
    //   (b) 全画布凡是叉色的像素都必须待在**箭头格内部离格边 >4px** 的地方——
    //       也就是说它们是数字的边，不是画在格线上的叉。
    const h = histogram();
    eq('render: 空白盘的琥珀（环线色）像素数 = 0（认证解没偷偷画在盘上）', h.countNear(P().accent), 0);
    ck('render: 空白盘的黑格像素数 = 0（alpha<200 的抗锯齿边已排除在计数外）',
      h.countNear(P().blackCell) === 0, `blackPx=${h.countNear(P().blackCell)} opaque=${h.total}`);
    eq('render: 空白盘的铅笔色像素数 = 0（提示没按下去之前一条都不许出现）', h.countNear(P().pencilMark), 0);
    const cutOnEdge = [];
    for (let cell = 0; cell < g.n; cell++) {
      for (const d of [E_.RIGHT, E_.DOWN]) {
        if (g.neighbor(cell, d) < 0) continue;
        const m = v.markPoint(cell, d);
        const p = sample(m.x, m.y);
        if (!far(p, C.cut) || !far(p, C.accent)) cutOnEdge.push(`${cell}:${d}=${show3(p)}`);
      }
    }
    ck(`render: ${g.edgeCount()} 条边中点没有一条读成叉色或环线色（空白盘的「没落笔」是逐条边的证据）`,
      cutOnEdge.length === 0, cutOnEdge.slice(0, 6).join(' '));
    const stray = cutPixelProvenance(g, v, C.cut);
    ck(`render: 全画布 ${stray.total} 个叉色像素全部落在箭头格内部、离最近格边 >4px（它们是数字的抗锯齿边，不是画在格线上的叉）`,
      stray.bad.length === 0, `越界的 ${stray.bad.length} 个：${stray.bad.slice(0, 4).join(' | ')}`);
    ck('render: 数字真的画出来了（每个箭头格框内都有成规模 ink 像素）', noInk.length === 0 && h.countNear(P().ink) > 300,
      `inkPx=${h.countNear(P().ink)} 缺数字的格=${noInk.slice(0, 4).join(' ')}`);

    // 逐通道最小间距按**取样点家族**列：只有同一个点上可能同时出现的颜色才需要互相拉开 ≥25
    // （theme.js 文件头那条纪律在这里落地；场底与格线永远不撞在同一个点上，把它们算进同一组是假要求）。
    const FAMILIES = {
      cellCenter: ['field', 'black', 'accent'], // 玩家没落笔/涂黑/环段穿过格心
      edgeMid: ['grid', 'accent', 'cut'], // 没落笔=格线、环段、叉
      ringDiag: ['field', 'black', 'bad', 'pencil'], // 45° 斜角：底色、黑格方块、错误圈、铅笔方块角
      clueArrowAxis: ['tile', 'arrow', 'ink'], // 瓦片、箭头笔、数字墨
    };
    const pairs = [];
    const tight = [];
    for (const [fam, names] of Object.entries(FAMILIES)) {
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const m = minChan(C[names[i]], C[names[j]]);
          pairs.push(`${fam}:${names[i]}~${names[j]}=${m}`);
          if (m < 25) tight.push(`${fam} ${names[i]}~${names[j]}=${m}`);
        }
      }
    }
    ck('render: 每个取样点家族里的色对逐通道都拉开 ≥25（纪律按点家族落地，不是按全表两两）',
      tight.length === 0, tight.join(' '));

    a.store.clearResume();
    return report({
      size: `${g.w}×${g.h}`, cell: v.geo.cell, dpr: v.geo.dpr, clues: g.question.clue.size,
      dirs: dirSeen, opaque: h.total, distinct: h.distinct, inkPx: h.countNear(P().ink),
      minChan: pairs,
    });
  };

  // 找格子的辅助：门禁要的是「某一格不是箭头格」这种条件，不是答案。
  function findCell(g, pred) {
    for (let cell = 0; cell < g.n; cell++) if (pred(cell)) return cell;
    return -1;
  }
  const sortedEdges = (arr) => [...arr].sort().join(' ');

  // ── 3. play：真指针拖出来的环段，就是引擎接受的那一批边 ────────────────────
  // 这一场只问「笔」与「画面」：一笔拖拽 = 一条撤销组 = 一步；画出来的边集逐条与认证解对齐；
  // 而**判胜仍然是 verify() 说了算**——此刻黑格还没涂，所以它必须说不成立，并且说不成立的原因
  // 是「这一格既不在环上也不是黑格/线索」（UI 不许替玩家把没画的格补成灰格）。
  ng.play = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-play-6', sizeKey: '6x6' });
    await wait(60);
    if (!g) { ck('play: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const E_ = E();
    const v = a.view;
    const C = { accent: rgb(P().accent), grid: rgb(P().gridLine), field: rgb(P().field) };

    // 认证解→有序环（只有 harness 读 solution；用途仅限于「鼠标该经过哪几格」）
    const order = cycleOrder(g.puzzle.solution, g.nb);
    ck('play: 认证解的边集能走成一条有序单环（harness 自己先自证，否则后面的指针路线没有意义）',
      !!order && order.length === g.puzzle.solution.loop.size,
      order ? `环长 ${order.length}，loop 集 ${g.puzzle.solution.loop.size}` : '走不回起点');
    if (!order) return report({});

    eq('play: 开局步数 = 0（面板与 Game 同时说没动过）', `${g.moves}/${text('#stat-moves')}`, '0/0');
    // 一笔把整圈拖完（回到起点那一下就是最后一条边）
    await dragPath([...order, order[0]]);
    a.render();

    const wantSet = sortedEdges(g.puzzle.solution.edges);
    eq('play: 拖出来的边集与认证解逐条相同（E_ON 住在哪一侧都不许差一条）', sortedEdges(g.loopEdges()), wantSet);

    // 像素：每一条解边中点都是琥珀；一条都没画的边仍是格线。
    // 「这一条画没画」只问 g.loopEdges()（面板那个数与 verify() 的输入都从它来），不去摸内部笔表。
    const onSet = new Set(g.loopEdges());
    const px = [];
    for (let cell = 0; cell < g.n; cell++) {
      for (const d of [E_.RIGHT, E_.DOWN]) {
        const nb = g.neighbor(cell, d);
        if (nb < 0) continue;
        const m = v.markPoint(cell, d);
        const p = sample(m.x, m.y);
        const on = onSet.has(E_.Board.ek(cell, nb));
        if (on ? !near(p, C.accent) : !near(p, C.grid)) px.push(`${cell}:${d}=${show3(p)} 期望${on ? '琥珀' : '格线'}`);
      }
    }
    ck(`play: ${g.edgeCount()} 条边中点的颜色与刚拖出来的笔迹一一对应（画在环上的=琥珀，没画的=格线）`,
      px.length === 0, px.slice(0, 6).join(' '));

    const h = histogram();
    eq('play: 面板环段数 = 认证解边数', text('#stat-segs'), String(g.puzzle.solution.edges.size));
    ck('play: 整圈接得上的证据：端点数 = 0、度数异常 = 0', `${text('#stat-ends')}/${text('#stat-bad')}` === '0/0',
      `ends=${text('#stat-ends')} bad=${text('#stat-bad')}`);
    ck('play: 一笔拖拽 = 一步（撤销组按手势算，不按写了几条边算）', `${g.moves}/${text('#stat-moves')}`, '1/1');
    ck(`play: 画布上有成规模琥珀像素（${h.countNear(P().accent)} 个），且没有一处凭空多出来的黑`,
      h.countNear(P().accent) > 200 && h.countNear(P().blackCell) === 0,
      `accent=${h.countNear(P().accent)} black=${h.countNear(P().blackCell)}`);

    // 此刻黑格一个都没涂：verify() 必须判不成立，而原因是「没声明」不是「UI 补了灰格」
    const st = g.status();
    ck('play: 只画环不涂黑时引擎判不成立，且原因里有「这一格既不在环上也不是黑格/线索」（UI 不替玩家补灰）',
      st.ok === false && st.errs.length > 0 && st.errs.some((e) => /既不在环上也不是黑格/.test(e)),
      `${st.errs.length} 条：${st.errs.slice(0, 3).join(' / ')}`);
    eq('play: 面板那个数就是 verify() 的条数（不是 UI 自己另算一套）', text('#stat-verify'), `${st.errs.length} 处不对`);
    ck('play: 引擎的第一句话原样出现在 #verify-line 上', text('#verify-line').includes(st.errs[0]),
      `"${text('#verify-line')}"`);

    // 甩太快/斜着甩：不相邻的两格只能挪笔，不许凭空长出一条斜边
    await a.newGame({ seed: 'gate-play-6', sizeKey: '6x6' });
    await wait(40);
    const diagA = 0, diagB = g.w + 1; // (0,0) → (1,1)：斜着
    await dragPath([diagA, diagB]);
    a.render();
    eq('play: 斜着甩出去不长出边（不相邻只挪笔），也不记步数',
      `${A().game.loopEdges().length}/${A().game.moves}`, '0/0');

    // 撤销一笔：回到空白盘，琥珀像素归零（撤销是真的反写，不是画个白块盖住）
    const g2 = A().game;
    await a.newGame({ seed: 'gate-play-6', sizeKey: '6x6' });
    await wait(40);
    const g3 = A().game;
    await dragPath([...order, order[0]]);
    document.getElementById('btn-undo').click();
    await wait(60);
    const h2 = histogram();
    ck('play: 撤销那一笔之后环段归零、琥珀像素归零、面板读数跟着回去',
      g3.loopEdges().length === 0 && text('#stat-segs') === '0' && h2.countNear(P().accent) === 0 && g3.moves === 2,
      `segs=${g3.loopEdges().length} panel=${text('#stat-segs')} accentPx=${h2.countNear(P().accent)} moves=${g3.moves}`);
    ck('play: 撤销之后每一条边又读回格线色（三态真的反写回 E_UNK）', (() => {
      for (let cell = 0; cell < g3.n; cell++) {
        for (const d of [E_.RIGHT, E_.DOWN]) {
          if (g3.neighbor(cell, d) < 0) continue;
          const m = v.markPoint(cell, d);
          if (!near(sample(m.x, m.y), C.grid)) return false;
        }
      }
      return true;
    })(), '撤销后仍有非格线色的边中点');
    void C.field;
    a.store.clearResume();
    return report({
      order: order.length, edges: g.puzzle.solution.edges.size, clues: g.question.clue.size,
      accentPx: h.countNear(P().accent), errs: st.errs.length, firstErr: st.errs[0],
    });
  };

  // ── 4. marks：四支笔各画各的、撤销按手势算、键盘读数对得上 ──────────────────
  // 这一场管「笔」的三态互斥与两条被 README 写进承诺的路径：涂黑笔点两下是开关、
  // 拖过的那一格是涂上不是翻面。判据全落在像素与 DOM 读数上，不摸 drag/cursor 这类内部旗标。
  ng.marks = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-marks-6', sizeKey: '6x6' });
    await wait(60);
    if (!g) { ck('marks: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const v = a.view;
    const E_ = E();
    const C = {
      field: rgb(P().field), grid: rgb(P().gridLine), black: rgb(P().blackCell),
      accent: rgb(P().accent), cut: rgb(P().cutMark), bad: rgb(P().badRing),
    };
    const midOf = (cell) => { const m = cellMid(cell); return sample(m.x, m.y); };
    const plain = (pred) => findCell(g, (cell) => !g.isClue(cell) && pred(cell));
    const pen = (m) => document.getElementById(`btn-mode-${m}`).click();

    // 1) 涂黑笔：点一下上黑（黑格方块是** inset 的方块**，不是整格刷黑）
    const bk = plain((cell) => g.degree(cell) === 0);
    pen('black');
    await clickCell(bk);
    const hBlack = histogram();
    const justOutside = sample(cellMid(bk).x, cellMid(bk).y - v.geo.cell * 0.45);
    ck('marks: 涂黑笔点一下=一格黑、一笔一步、面板与像素同时跟上，方块外仍是场底',
      g.role[bk] === E_.BLACK && near(midOf(bk), C.black) && far(justOutside, C.black) &&
        hBlack.countNear(P().blackCell) > 50 && text('#stat-black') === '1' && g.moves === 1,
      `role=${g.role[bk]} 中心=${show3(midOf(bk))} 方块外=${show3(justOutside)} blackPx=${hBlack.countNear(P().blackCell)} panel=${text('#stat-black')} moves=${g.moves}`);
    ck('marks: 黑格的描边取样点还在方块上（view.blackFacePoint 不许漂到格外）',
      far(sample(v.blackFacePoint(bk).x, v.blackFacePoint(bk).y), C.field),
      `facePoint=${show3(sample(v.blackFacePoint(bk).x, v.blackFacePoint(bk).y))} 想要不是场底`);

    // 2) 同一格再点一下把它清掉（main.js 的 toggleBlack 就靠这两条成对）
    await clickCell(bk);
    const hClear = histogram();
    ck('marks: 同一格点第二下把黑格清掉（涂黑笔是开关不是单向阀），第二下照样记一步',
      g.role[bk] === E_.UNK && near(midOf(bk), C.field) && hClear.countNear(P().blackCell) === 0 &&
        text('#stat-black') === '0' && g.moves === 2,
      `role=${g.role[bk]} 中心=${show3(midOf(bk))} blackPx=${hClear.countNear(P().blackCell)} panel=${text('#stat-black')} moves=${g.moves}`);

    // 3) 拖过的那一格是「涂上」不是「翻面」：一笔绕回同一格不许把它擦掉
    const p1 = findCell(g, (cell) => !g.isClue(cell) && g.role[cell] === E_.UNK && g.degree(cell) === 0 &&
      g.neighbor(cell, E_.RIGHT) >= 0 && !g.isClue(g.neighbor(cell, E_.RIGHT)));
    const p2 = g.neighbor(p1, E_.RIGHT);
    await dragPath([p1, p2, p1]); // 出去再绕回来，同一格被走第二遍
    ck('marks: 一笔里绕回已经涂过的格是涂上不是翻面（拖拽不会把黑格擦成随机开关）',
      g.role[p1] === E_.BLACK && g.role[p2] === E_.BLACK && near(midOf(p1), C.black) && near(midOf(p2), C.black) && g.moves === 3,
      `p1=${g.role[p1]} p2=${g.role[p2]} moves=${g.moves}`);
    pen('erase');
    await clickCell(p1);
    await clickCell(p2);
    ck('marks: 擦掉笔把黑格与四条边一起清干净（一格都不留）',
      g.role[p1] === E_.UNK && g.role[p2] === E_.UNK && g.blackCells().length === 0 && text('#stat-black') === '0',
      `p1=${g.role[p1]} p2=${g.role[p2]} blacks=${g.blackCells().length}`);

    // 4) 右键落叉 / 再点擦回（三态互斥：叉不许读成格线，也不许读成环）
    const ec = findCell(g, (cell) => g.neighbor(cell, E_.RIGHT) >= 0 && !g.isClue(g.neighbor(cell, E_.RIGHT)));
    await rightClickEdge(ec, E_.RIGHT);
    const mCut = markMid(ec, E_.RIGHT);
    ck('marks: 右键落在边中点=排除叉，像素读叉色、面板计数跟着走',
      g.ed[ec][E_.RIGHT] === E_.E_OFF && near(sample(mCut.x, mCut.y), C.cut) && text('#stat-cuts') === '1',
      `ed=${g.ed[ec][E_.RIGHT]} 色=${show3(sample(mCut.x, mCut.y))} cuts=${text('#stat-cuts')}`);
    await rightClickEdge(ec, E_.RIGHT);
    ck('marks: 同一条边再右键一次擦回没落笔（叉在「叉」和「没画」之间来回）',
      g.ed[ec][E_.RIGHT] === E_.E_UNK && near(sample(mCut.x, mCut.y), C.grid) && text('#stat-cuts') === '0',
      `ed=${g.ed[ec][E_.RIGHT]} 色=${show3(sample(mCut.x, mCut.y))} cuts=${text('#stat-cuts')}`);

    // 5) 环段被右键改成叉：E_ON 那一侧不许「两个色都画」
    pen('loop');
    await dragPath([ec, g.neighbor(ec, E_.RIGHT)]);
    const mOn = markMid(ec, E_.RIGHT);
    const onOk = near(sample(mOn.x, mOn.y), C.accent);
    await rightClickEdge(ec, E_.RIGHT);
    ck('marks: 已经连上的边被右键一步改成排除叉（琥珀立刻变叉色，三态互斥不是叠着画）',
      onOk && g.ed[ec][E_.RIGHT] === E_.E_OFF && far(sample(mOn.x, mOn.y), C.accent) && near(sample(mOn.x, mOn.y), C.cut),
      `画环时=${show3(sample(mOn.x, mOn.y))} 改叉后=${show3(sample(mOn.x, mOn.y))}`);
    document.getElementById('btn-clear').click();
    await wait(60);
    const hCleared = histogram();
    ck('marks: 全清之后盘上什么都不剩（环段/黑格/叉三项读数与像素同时归零）',
      g.loopEdges().length === 0 && g.blackCells().length === 0 && g.offEdges().length === 0 &&
        hCleared.countNear(P().accent) === 0 && hCleared.countNear(P().blackCell) === 0 && text('#stat-segs') === '0',
      `segs=${g.loopEdges().length} black=${g.blackCells().length} cuts=${g.offEdges().length} accentPx=${hCleared.countNear(P().accent)}`);

    // 6) 度数异常那一格的错误圈：造一个 3 度格（两笔拖出来，第二笔另起一个手势）
    // ⚠ hub 必须不是箭头格：箭头瓦片画在最上面（draw 的第 7 层），盖住 0.42 格的错误圈，
    //    那时候 ringPoint 读到的是瓦片色而不是 badRing——断言会红，但红的原因是取样点被压住了。
    const hub = findCell(g, (cell) => !g.isClue(cell) && g.neighbor(cell, E_.LEFT) >= 0 && g.neighbor(cell, E_.RIGHT) >= 0 && g.neighbor(cell, E_.UP) >= 0);
    const lft = g.neighbor(hub, E_.LEFT), rgt = g.neighbor(hub, E_.RIGHT), upw = g.neighbor(hub, E_.UP);
    await dragPath([lft, hub, rgt]);
    await dragPath([upw, hub]);
    const rp = v.ringPoint(hub);
    ck('marks: 三度那一格画出错误圈（ringPoint 读 badRing、面板数得出 1 格异常、且不是环线色）',
      g.degree(hub) === 3 && g.badCells().indexOf(hub) >= 0 && text('#stat-bad') === '1' &&
        near(sample(rp.x, rp.y), C.bad) && far(sample(rp.x, rp.y), C.accent),
      `deg=${g.degree(hub)} bad=${g.badCells().join(',')} panel=${text('#stat-bad')} ring=${show3(sample(rp.x, rp.y))}`);
    document.getElementById('btn-clear').click();
    await wait(60);

    // 7) 键盘：先把焦点钉在画布上，再按 index.html 那行 keyhint 承诺的键。
    //    光标位置不靠「按了几下」推断：方向键在边界是**夹住**的，所以先顶到左上角、
    //    再按行列数走过去，落点由 #sr-cell 那句话读出并核对——读数抖不抖，看这句证人。
    const cv = v.canvas;
    cv.focus();
    const key = (k) => cv.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const kbTop = (n) => { for (let i = 0; i < n; i++) key('ArrowUp'); };
    kbTop(g.h);
    for (let i = 0; i < g.w; i++) key('ArrowLeft');
    await wait(20);
    ck('marks: 键盘路径先钉住焦点，且方向键在左上角夹住（sr-cell 报第 1 行第 1 列）',
      document.activeElement === cv && /第 1 行第 1 列/.test(text('#sr-cell')),
      `activeElement=${document.activeElement && document.activeElement.id} sr="${text('#sr-cell')}"`);
    const kb = findCell(g, (cell) => !g.isClue(cell) && g.role[cell] === E_.UNK && g.degree(cell) === 0 && cell !== 0);
    const kbR = Math.floor(kb / g.w);
    const kbC = kb % g.w;
    for (let i = 0; i < kbR; i++) key('ArrowDown');
    for (let i = 0; i < kbC; i++) key('ArrowRight');
    await wait(20);
    const kbTxt = text('#sr-cell');
    ck('marks: 方向键把光标带到指定那一格并把这句话念对了（键盘与笔表说的是同一格）',
      kb >= 0 && kbTxt.includes(`第 ${kbR + 1} 行第 ${kbC + 1} 列`) && /没落笔/.test(kbTxt) && cellFromReport(kbTxt, g) === kb,
      `想去=第${kbR + 1}行第${kbC + 1}列(格${kb}) sr="${kbTxt}"`);
    const mv0 = g.moves;
    key('b');
    await wait(30);
    const bTxt = text('#sr-cell');
    const bRole = g.role[kb];
    key('z');
    await wait(40);
    ck('marks: B 键涂黑光标格、Z 键撤掉的就是这一笔（笔表、无障碍读数、步数三处同时改口）',
      bRole === E_.BLACK && /黑格/.test(bTxt) && g.role[kb] === E_.UNK && /没落笔/.test(text('#sr-cell')) && g.moves === mv0 + 2,
      `B 之后=${bRole}/"${bTxt.slice(0, 26)}" Z 之后=${g.role[kb]}/"${text('#sr-cell').slice(0, 26)}" moves=${g.moves}（想要 ${mv0}+2）`);
    const modeBefore = a.mode;
    key('e');
    await wait(20);
    ck('marks: E 键换到下一支笔，aria-pressed 与 a.mode 同时改口（键盘与按钮是同一条路）',
      modeBefore === 'loop' && a.mode === 'black' &&
        document.getElementById('btn-mode-black').getAttribute('aria-pressed') === 'true' &&
        document.getElementById('btn-mode-loop').getAttribute('aria-pressed') === 'false',
      `前=${modeBefore} 后=${a.mode} pressed=${document.getElementById('btn-mode-black').getAttribute('aria-pressed')}`);
    document.getElementById('btn-mode-loop').click();
    await wait(20);

    // 交棒给 resume 场：同一颗 seed 上重新出盘，用真指针画一段真的环 + 两格黑，
    // 然后把期望值留在 localStorage 的那个闸专用键里（产品代码从不读它）。
    await a.newGame({ seed: 'gate-marks-6', sizeKey: '6x6' });
    await wait(60);
    const g2 = a.game;
    const order2 = cycleOrder(g2.puzzle.solution, g2.nb);
    ck('marks: 收尾这一盘也走得出有序单环（交棒给 resume 的笔迹是真的拖出来的）',
      !!order2 && order2.length >= 8, order2 ? `环长 ${order2.length}` : '走不回起点');
    if (!order2) return report({ fatal: 'no-order2' });
    pen('loop');
    await dragPath(order2.slice(0, Math.min(8, order2.length)));
    pen('black');
    const blacks2 = [...g2.puzzle.solution.black].slice(0, 2);
    for (const cell of blacks2) await clickCell(cell);
    setExpect({
      href: location.href,
      seed: g2.seed, fp: g2.puzzle.fingerprint, sizeKey: g2.sizeKey,
      marks: g2.encode(), moves: g2.moves, segs: g2.loopEdges().length,
      blacks: g2.blackCells().length, timeOrigin: performance.timeOrigin,
      loop: g2.loopEdges().slice(), blackList: g2.blackCells().slice(),
    });
    return report({
      hub, kb, blackPx: hBlack.countNear(P().blackCell), moves: a.game.moves,
      carried: a.game.loopEdges().length, seed: a.game.seed,
    });
  };

  // 把 #sr-cell 那句人话读回格号（键盘那一段只有这句话可看）
  function cellFromReport(t, g) {
    const m = /第 (\d+) 行第 (\d+) 列/.exec(t);
    if (!m) return -1;
    const cell = (Number(m[1]) - 1) * g.w + (Number(m[2]) - 1);
    return cell < g.n ? cell : -1;
  }

  // ── 5. resume：真导航之后，存档里那一局还在不在 ─────────────────────────────
  // 这一场**不画任何一笔**：它只读「页面自己重新加载之后拿到了什么」。
  // 上一场 marks 收尾时把期望值写进 localStorage 的 yajilin.gate.marks（产品代码从不读这个键），
  // playtest 每场都先 Page.navigate(BASE_URL) —— 那是换文档的真导航，不是 location.hash 的同文档跳转。
  // timeOrigin 就是这件事的证人：续上的那一局如果 timeOrigin 没变，文档根本没换过，
  // 所谓「刷新还在」就是闸自己对自己。
  ng.resume = async () => {
    const a = A();
    const want = getExpect();
    if (!want) { ck('resume: 上一场（marks）留下的期望值在读（闸不许对空气打绿）', false, 'localStorage 里没有 yajilin.gate.marks'); return report({}); }
    for (let i = 0; i < 60 && (!a.game || a.state !== 'ready'); i++) await wait(50);
    const g = a.game;
    if (!g) { ck('resume: 重新加载之后出得了盘', false, `state=${a.state}`); return report({}); }
    const v = a.view;
    const C = { accent: rgb(P().accent), grid: rgb(P().gridLine), black: rgb(P().blackCell), field: rgb(P().field) };

    // 证人先立起来：文档真的被换掉了（timeOrigin 变大），而地址还是那一个。
    // 同文档跳转（location.hash / #expect=）不换 JS 上下文，timeOrigin 一动不动——
    // 用它冒充「刷新过了」，这一场就变成闸自己对自己。
    ck('resume: 这是一次真重载（timeOrigin 变大、href 与上一场报的同一个），不是同文档跳转续的局',
      performance.timeOrigin > want.timeOrigin && location.href === want.href,
      `timeOrigin ${want.timeOrigin} → ${performance.timeOrigin}；href ${want.href} vs ${location.href}`);
    ck('resume: 续上的就是上一局那道题（同 seed 同指纹，不是重铸一颗 seed 开新的）',
      g.seed === want.seed && g.puzzle.fingerprint === want.fp && g.sizeKey === want.sizeKey,
      `seed=${g.seed}/${want.seed} fp=${g.puzzle.fingerprint}/${want.fp} size=${g.sizeKey}/${want.sizeKey}`);
    ck('resume: 笔迹逐字符搬回来了（encode 串、环段数、黑格数、步数四项同时对上）',
      g.encode() === want.marks && g.loopEdges().length === want.segs && g.blackCells().length === want.blacks && g.moves === want.moves,
      `marks 同=${g.encode() === want.marks} segs=${g.loopEdges().length}/${want.segs} black=${g.blackCells().length}/${want.blacks} moves=${g.moves}/${want.moves}`);
    ck('resume: 面板读数跟着回来了（「这局还没动过」在这里说不出口）',
      text('#stat-segs') === String(want.segs) && text('#stat-black') === String(want.blacks) && text('#stat-moves') === String(want.moves),
      `segs=${text('#stat-segs')} black=${text('#stat-black')} moves=${text('#stat-moves')}`);

    const badLoop = [];
    for (const e of want.loop) {
      const [x, y] = e.split(':').map(Number);
      const d = g.dirTo(x, y);
      if (d < 0) { badLoop.push(`无向边${e}`); continue; }
      const m = v.markPoint(x, d);
      if (!near(sample(m.x, m.y), C.accent)) badLoop.push(`${e}=${show3(sample(m.x, m.y))}`);
    }
    ck('resume: 每一条存回来的环段都还画在盘上（像素逐条取证，不是只信那串字符）',
      badLoop.length === 0 && g.loopEdges().length > 0, badLoop.slice(0, 5).join(' '));
    const badBlack = [];
    for (const cell of want.blackList) {
      const m = cellMid(cell);
      if (!near(sample(m.x, m.y), C.black)) badBlack.push(`${cell}=${show3(sample(m.x, m.y))}`);
    }
    ck('resume: 每一格存回来的黑格都还画在盘上', badBlack.length === 0 && want.blackList.length > 0, badBlack.join(' '));
    const untouched = findCell(g, (cell) => g.degree(cell) === 0 && g.role[cell] === 0);
    if (untouched >= 0) {
      const m = cellMid(untouched);
      ck('resume: 没存到的那一格仍是场底（搬笔迹不是把整盘刷一遍色）',
        near(sample(m.x, m.y), C.field), `格 ${untouched}=${show3(sample(m.x, m.y))}`);
    }

    // 存档作废那一条路：指纹对不上就不许搬旧笔迹。走的是 boot 用的同一个入口
    // （newGame 里 Store.resume(这张盘的真实指纹)），读的是玩家看得到的那句话说。
    const forged = { seed: want.seed, sizeKey: want.sizeKey, marks: want.marks, moves: want.moves, elapsedMs: 1000, w: g.w, h: g.h, fingerprint: 'deadbeef:999' };
    a.store.data.resume = forged;
    a.store.save();
    const g3 = await a.newGame({ seed: want.seed, sizeKey: want.sizeKey, resumeFrom: forged });
    await wait(60);
    ck('resume: 指纹对不上时旧笔迹一格都不搬、步数归零，并且当着玩家说清楚为什么',
      !!g3 && g3.encode() !== want.marks && g3.loopEdges().length === 0 && g3.moves === 0 &&
        /对不上/.test(text('#state-line')),
      `搬了=${g3 ? g3.loopEdges().length : 'no'} moves=${g3 ? g3.moves : 'no'} 行="${text('#state-line').slice(0, 60)}"`);
    a.store.clearResume();
    return report({
      seed: g.seed, carried: want.segs, moves: want.moves,
      before: want.timeOrigin, after: performance.timeOrigin,
    });
  };

  // ── 6. wrong：画满了、每格两度、箭头全数对，仍然没赢 ────────────────────────
  // 矢仓林最容易骗人的就是这一类：所有局部读数都好看，环却是两条。
  // 这里把认证解的单环按单位正方形翻面拆成两条，再把黑格照认证解涂满 ——
  // 于是 端点数=0、度数异常=0、覆盖完整、射线逐条数得过，而 verify() 只说一句「不是单一环」。
  ng.wrong = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-wrong-6', sizeKey: '6x6' });
    await wait(60);
    if (!g) { ck('wrong: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const E_ = E();
    const v = a.view;
    const C = { accent: rgb(P().accent), grid: rgb(P().gridLine), cut: rgb(P().cutMark) };
    const order = cycleOrder(g.puzzle.solution, g.nb);
    if (!order) { ck('wrong: 认证解能走成有序单环', false, '走不回起点'); return report({}); }
    const sp = twoOptSplit(order, g.nb);
    ck('wrong: 这张盘上找得到一段可翻的 2×2（找不到就大声红，不 skip、不放宽）',
      !!sp, `环长 ${order.length}，翻不出两段`);
    if (!sp) return report({ fatal: 'no-split' });
    const ch = chains(order, sp.drop, g.nb);
    const endsOf = (arr) => [arr[0], arr[arr.length - 1]];
    const addKeys = sp.add.map(([x, d]) => [x, g.neighbor(x, d)]).map(([x, y]) => `${Math.min(x, y)}:${Math.max(x, y)}`).sort();
    const chKeys = ch.map((c) => endsOf(c)).map(([x, y]) => `${Math.min(x, y)}:${Math.max(x, y)}`).sort();
    ck('wrong: 拆掉两条对边之后正好两条开放链，端点就是那两对要补的邻边（harness 先自证）',
      ch.length === 2 && addKeys.join(' ') === chKeys.join(' '), `链 ${chKeys.join(' ')} 要补 ${addKeys.join(' ')}`);
    if (ch.length !== 2) return report({ fatal: 'chains' });

    for (const c of ch) await dragPath(c);
    for (const [x, d] of sp.add) await dragPath([x, g.neighbor(x, d)]);
    document.getElementById('btn-mode-black').click();
    for (const cell of [...g.puzzle.solution.black]) await clickCell(cell);
    a.render();
    await wait(40);

    const st = g.status();
    const h = histogram();
    ck('wrong: 局部读数全都好看（端点 0、度数异常 0、环段数等于认证解边数、黑格涂满）',
      g.endpoints().length === 0 && g.badCells().length === 0 &&
        g.loopEdges().length === g.puzzle.solution.edges.size && g.blackCells().length === g.puzzle.solution.black.size &&
        text('#stat-ends') === '0' && text('#stat-bad') === '0' && h.countNear(P().blackCell) > 50,
      `ends=${g.endpoints().length} bad=${g.badCells().length} segs=${g.loopEdges().length}/${g.puzzle.solution.edges.size} black=${g.blackCells().length}/${g.puzzle.solution.black.size}`);
    ck('wrong: 每条箭头在这一盘上都数得对（verify 的抱怨里一条「线索」都不许有）',
      st.errs.every((e) => !/线索/.test(e)), st.errs.slice(0, 3).join(' / '));
    ck('wrong: 引擎只看出一句话——环只覆盖了半张盘（不是单一环）',
      st.ok === false && st.errs.length === 1 && /不是单一环/.test(st.errs[0]),
      `${st.errs.length} 条：${st.errs.slice(0, 2).join(' / ')}`);
    ck('wrong: 界面没有替玩家把这盘认成赢（胜利卡片仍然几何上不存在，面板说 1 处不对）',
      document.getElementById('win-veil').hidden === true && getComputedStyle(document.getElementById('win-veil')).display === 'none' &&
        text('#stat-verify') === '1 处不对' && text('#verify-line').includes(st.errs[0]),
      `引擎说=${text('#stat-verify')} 行="${text('#verify-line')}" won=${a.won}`);
    // 断掉的那两条边中点读的是格线（不是叉也不是环）：这一盘「没连上」的位置在画面上看得出来
    const gapBad = [];
    for (const [x, d] of sp.drop) {
      const m = v.markPoint(x, d);
      if (!m) { gapBad.push(`无${x}:${d}`); continue; }
      if (!near(sample(m.x, m.y), C.grid)) gapBad.push(`${x}:${d}=${show3(sample(m.x, m.y))}`);
    }
    ck('wrong: 被翻断的那两条边在盘上读回格线（画面没说谎：那里确实没连）', gapBad.length === 0, gapBad.join(' '));
    a.store.clearResume();
    return report({
      split: sp.cells, errs: st.errs, segs: g.loopEdges().length, blacks: g.blackCells().length,
      moves: g.moves, opaque: h.total,
    });
  };

  // ── 7. win：整盘按认证解画完，赢是 verify() 说的，卡片是几何上存在的 ──────────
  ng.win = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-win-6', sizeKey: '6x6' });
    await wait(60);
    if (!g) { ck('win: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const v = a.view;
    const order = cycleOrder(g.puzzle.solution, g.nb);
    if (!order) { ck('win: 认证解能走成有序单环', false, '走不回起点'); return report({}); }
    const veil = document.getElementById('win-veil');
    ck('win: 落笔之前卡片几何上不存在', getComputedStyle(veil).display === 'none' && veil.hidden === true,
      `display=${getComputedStyle(veil).display} hidden=${veil.hidden}`);

    document.getElementById('btn-mode-loop').click();
    await dragPath([...order, order[0]]);
    document.getElementById('btn-mode-black').click();
    const blacks = [...g.puzzle.solution.black];
    for (const cell of blacks) await clickCell(cell);
    await wait(60);

    const st = g.status();
    const vs = getComputedStyle(veil);
    const vr = veil.getBoundingClientRect();
    const midc = clientOf(v.canvas.getBoundingClientRect().width / 2, v.canvas.getBoundingClientRect().height / 2);
    const topEl = document.elementFromPoint(Math.round(midc.x), Math.round(midc.y));
    ck('win: 画满之后引擎判通过（环段/黑格/箭头三项都齐，verify() 返回空数组）',
      st.ok === true && st.errs.length === 0 && text('#stat-verify') === '通过' &&
        text('#verify-line') === 'verify() → []（判胜就这一处）',
      `${st.errs.length} 条：${st.errs.slice(0, 2).join(' / ')} 面板=${text('#stat-verify')}`);
    ck('win: 胜利卡片是真的在那儿（display 不是 none、矩形有面积、盘心 elementFromPoint 落进卡片里）',
      vs.display !== 'none' && vr.width > 60 && vr.height > 40 && !!topEl && (topEl === veil || veil.contains(topEl)),
      `display=${vs.display} rect=${Math.round(vr.width)}×${Math.round(vr.height)} 盘心=${topEl && (topEl.id || topEl.tagName)}`);
    const meta = text('#win-meta');
    ck('win: 卡片上那串数是引擎的账（环段数/黑格数/箭头数逐条对回认证解，不是文案）',
      meta.includes(`环段 ${g.puzzle.solution.edges.size} 条`) && meta.includes(`黑格 ${blacks.length} 个`) &&
        meta.includes(`箭头 ${g.clues} 条`) && /^\d\d:\d\d$/.test(meta.slice(-5)),
      `"${meta}"`);
    const blocked = reachable(WIN_IDS);
    ck('win: 卡片里那三个控件此刻真的点得到（开局时它们是零矩形，这一场才是它们的可达性证据）',
      blocked.length === 0, blocked.slice(0, 4).join(' | '));
    ck('win: 赢了就把续局存档作废（localStorage 里 resume=null，刷新不许接着做已经做完的那盘）',
      (() => {
        try { const raw = JSON.parse(localStorage.getItem('yajilin.save.v1') || 'null'); return !!raw && raw.resume === null; } catch { return false; }
      })(),
      `resume=${JSON.stringify((JSON.parse(localStorage.getItem('yajilin.save.v1') || '{}')).resume)}`);

    document.getElementById('btn-close-veil').click();
    await wait(40);
    ck('win: 「就看不动」把卡片收掉，盘还在（卡片 display 回到 none）',
      getComputedStyle(veil).display === 'none' && veil.hidden === true && g.status().ok === true,
      `display=${getComputedStyle(veil).display}`);

    // 赢不是 once-and-for-all 的徽章：撤一步之后盘不再成立，卡片必须自己下来。
    document.getElementById('btn-undo').click();
    await wait(60);
    ck('win: 撤掉最后一笔之后引擎改口，卡片跟着下来（胜利是 verify 此刻说的话）',
      g.status().ok === false && getComputedStyle(veil).display === 'none' && a.won === false &&
        text('#stat-verify') !== '通过',
      `ok=${g.status().ok} display=${getComputedStyle(veil).display} won=${a.won} 面板=${text('#stat-verify')}`);
    a.store.clearResume();
    return report({ segs: g.puzzle.solution.edges.size, blacks: blacks.length, clues: g.clues, moves: g.moves, meta });
  };

  // ── 8. hint：提示的每一笔都过 Game，推完就是这一盘的解 ───────────────────────
  // 排在最后：它会把整盘推完，而赢会 clearResume——排在前面的话 resume 那场就没存档可接了。
  ng.hint = async () => {
    const a = A();
    const g = await a.newGame({ seed: 'gate-hint-6', sizeKey: '6x6' });
    await wait(60);
    if (!g) { ck('hint: 出得了盘', false, 'newGame 返回空'); return report({}); }
    const v = a.view;
    const E_ = E();
    const C = { pencil: rgb(P().pencilMark), accent: rgb(P().accent), cut: rgb(P().cutMark), grid: rgb(P().gridLine), field: rgb(P().field), black: rgb(P().blackCell) };
    const total = g.ladder.length;
    ck('hint: 这张盘的铅笔流水非空（一条结论都没有的话后面三条断言全是空的）', total > 0, `ladder=${total}`);

    // ── 冲突这一支要正面构造，不许靠「这张盘第一条结论正好能反写」碰运气 ────────
    // 能反写的只有边：role 那一支的笔表里只有 没落笔/黑格 两态（ui/game.js:163 的 setRole 拒收
    // LOOP/CLUE），把它擦回没落笔，nextLadder 读出来是 open 而不是 conflict，拿它测冲突只会测到假红。
    // edge 且结论是「连上」（E_ON）的用叉笔反写成 E_OFF 最干净：结论既然要连，两端必是环格不是箭头格。
    // （结论是「断开」的那种要反写成 E_ON，可铅笔判它该断的边常常就贴着箭头格，Game 当场拒收，
    // 测到的是拒收而不是冲突——所以这里只找 E_ON 那一条，找不到就大声红。）
    const flipIndex = g.ladder.findIndex((ev) => ev.kind === 'edge' && ev.v === E_.E_ON);
    ck('hint: 流水里找得到一条能用真指针反写的结论（找不到就大声红，不 skip、不放宽）',
      flipIndex >= 0, `流水 ${total} 条里没有一条 edge 且 E_ON`);
    if (flipIndex < 0) return report({ total, fatal: 'no-flip' });

    // 每按一次都过 btn-hint 的真 click（页面里那个监听就是 main.js 的 hint()）：
    // 一次按下去必须恰好落一笔（ghost +1）、记一步（moves +1），而且状态行念的是引擎那条规则的原文。
    const pressBad = [];
    const seenRules = new Set(); // 现场念过的那条规则（ev.rule），最后一场断言拿它对着铅笔台的计数
    let pressed = 0;
    async function pressOnce() {
      const nx = g.nextLadder();
      if (!nx.ev) { pressBad.push('流水已空还按'); return null; }
      const ghost0 = g.ghost.size;
      const moves0 = g.moves;
      document.getElementById('btn-hint').click();
      await wait(14);
      pressed++;
      const sentence = a.engine.RULE_TEXT[nx.ev.rule] || nx.ev.rule;
      const line = a.won ? '' : text('#state-line'); // 最后那一按就把这局推赢了，那句换成判胜语
      if (g.ghost.size === ghost0 + 1 && g.moves === moves0 + 1 && (!line || line.includes(sentence))) seenRules.add(nx.ev.rule);
      else pressBad.push(`第 ${nx.index} 条(${nx.ev.rule})：ghost+${g.ghost.size - ghost0} 步+${g.moves - moves0} 行="${a.won ? '(已赢)' : line.slice(0, 54)}"`);
      return nx;
    }

    for (let k = 0; k < flipIndex && !a.won && !pressBad.length; k++) await pressOnce();
    ck(`hint: 反写之前那 ${flipIndex} 次按提示，每次都落一笔、记一步，状态行念的就是引擎那条规则的原文`,
      pressBad.length === 0 && pressed === flipIndex, `${pressed} 次里出的问题：${pressBad.slice(0, 3).join(' / ')}`);
    if (pressBad.length) return report({ total, pressed, fatal: 'press', pressBad: pressBad.slice(0, 4) });

    const target = g.nextLadder();
    ck('hint: 按到的这一条就是流水里那条能反写的（index 对得上才是同一处，不是隔壁那条）',
      target.index === flipIndex && target.state === 'open' && target.ev.v === E_.E_ON,
      `index=${target.index} 想要=${flipIndex} 态=${target.state} 值=${target.ev && target.ev.v}`);

    // 玩家用真指针在这一处写成相反的断（E_ON → E_OFF），提示这一步就不许再往前落笔
    await rightClickEdge(target.ev.i, target.ev.d);
    const cGhost = g.ghost.size;
    const cMoves = g.moves;
    document.getElementById('btn-hint').click();
    await wait(30);
    const cLine = text('#state-line');
    ck('hint: 玩家在同一处写反时提示不落笔、步数不动，并把冲突原话说出来、点名是哪条规则',
      g.ghost.size === cGhost && g.moves === cMoves && /打脸/.test(cLine) && cLine.includes(target.ev.rule),
      `ghost=${g.ghost.size}/${cGhost} 步=${g.moves}/${cMoves} 行="${cLine.slice(0, 76)}"`);

    // 撤掉那一笔反写（叉 → 没落笔），提示接着要在同一处把结论落下去：冲突不是一按就废
    await rightClickEdge(target.ev.i, target.ev.d);
    await pressOnce();
    ck('hint: 撤掉那笔反写之后提示接着在同一处落了笔（ghost 回到 +1，冲突那一步没把流水卡死）',
      pressBad.length === 0 && g.ghost.size === cGhost + 1,
      `ghost=${g.ghost.size}/${cGhost + 1} ${pressBad.slice(-1).join(' ')}`);

    for (let k = 0; k < total + 8 && !a.won && !pressBad.length; k++) await pressOnce();
    const st = g.status();
    ck('hint: 反写之后一路推到底的每一次按提示也是各落一笔、记一步、念引擎那条规则的原文（全程没有一次空按）',
      pressBad.length === 0 && pressed === total,
      `${pressed}/${total} 次：${pressBad.slice(0, 3).join(' / ')}`);
    ck('hint: 一路推到底之后引擎判通过（铅笔流水推完就是这道题的解，UI 一步都没替玩家补）',
      st.ok === true && a.won === true && text('#stat-verify') === '通过',
      `${st.errs.length} 条：${st.errs.slice(0, 3).join(' / ')} won=${a.won}`);
    ck('hint: 提示落的每一笔都进了撤销栈并各记一步（ghost 满盘、面板 total/total、步数 = total 次按 + 那两下反写）',
      g.ghost.size === total && text('#stat-pencil') === `${total}/${total}` && g.moves === total + 2,
      `ghost=${g.ghost.size}/${total} 面板=${text('#stat-pencil')} 步=${g.moves}（想要 ${total}+2） 按=${pressed}`);
    // 铅笔层画在盘上是描边、与玩家自己的笔迹两种色：取样点由 view.ghostPoint 报出来
    const ghostKeys = [...g.ghost.keys()].slice(0, 6);
    const gbad = [];
    for (const key of ghostKeys) {
      let p;
      if (key[0] === 'c') {
        const cell = Number(key.slice(1));
        p = v.ghostPoint(cell);
      } else {
        const [x, y] = key.split(':').map(Number);
        const d = g.dirTo(x, y);
        p = d >= 0 ? v.ghostPoint(x, d) : null;
      }
      if (!p) { gbad.push(`${key}:取样点给不出`); continue; }
      const px = sample(p.x, p.y);
      if (!near(px, C.pencil)) gbad.push(`${key}=${show3(px)}`);
    }
    ck('hint: 铅笔记号真的画在盘上、且是铅笔色不是玩家色（ghostPoint 逐条取证，最多六条）',
      gbad.length === 0 && ghostKeys.length > 0, gbad.slice(0, 4).join(' '));
    const lineTxt = text('#state-line');
    ck('hint: 推完那一刻状态行交回给引擎的判胜语（提示那句话的过期条件是「赢了或步数变了」，不是自己掐表）',
      lineTxt.includes('verify() 判定通过') && text('#verify-line') === 'verify() → []（判胜就这一处）',
      `行="${lineTxt.slice(0, 70)}" verify="${text('#verify-line').slice(0, 44)}"`);
    const fired = Object.entries(g.ladderFired).filter(([, n]) => n > 0).length;
    const noText = Object.keys(g.ladderFired).filter((r) => typeof a.engine.RULE_TEXT[r] !== 'string' || a.engine.RULE_TEXT[r].length <= 8);
    // 面板那 10 行是引擎对**题面**的账（P1/P3 只推出「这一格是环格」，笔表里没有这一态，
    // ui/game.js:163 的 setRole 直接拒收 LOOP，所以它们被流水筛掉了、玩家看不到那一句）。
    // 所以这里对的不是「命中过的规则都被念过」，而是两件更硬的事：
    // ① 流水里出现过的规则集合 == 现场真念过的集合（一条都不许多、一条都不许少）；
    // ② 每条规则在流水里的条数不许超过面板上的命中数（面板要是少报，这里就会红）。
    const ladderRules = [...new Set(g.ladder.map((ev) => ev.rule))].sort().join(',');
    const seenSorted = [...seenRules].sort().join(',');
    const ladderCount = {};
    for (const ev of g.ladder) ladderCount[ev.rule] = (ladderCount[ev.rule] || 0) + 1;
    const overCount = Object.entries(ladderCount)
      .filter(([r, n]) => (g.ladderFired[r] || 0) < n)
      .map(([r, n]) => `${r}:流水${n}条>面板${g.ladderFired[r] || 0}次`);
    ck('hint: 流水里有的规则现场全念过、现场念过的流水里全都有，且每条都有 RULE_TEXT 原文',
      noText.length === 0 && ladderRules === seenSorted && seenRules.size > 0,
      `缺原文=${noText.join(',') || '无'} 流水规则=${ladderRules} 念过=${seenSorted}`);
    ck('hint: 铅笔台报的命中次数不小于流水里该规则的条数（面板不是装饰，它报的账要罩得住玩家看到的每一句）',
      overCount.length === 0 && fired > 0, `${overCount.join(' ')} fired 规则数=${fired}`);
    const rowsNow = [...document.getElementById('pencil-list').children]
      .map((li) => [li.dataset.rule, (li.querySelector('b') || {}).textContent, (li.querySelector('span') || {}).textContent]);
    const panelBad = rowsNow.filter(([d, b, s]) => d !== b || String(g.ladderFired[d] ?? 0) !== s);
    ck('hint: 铅笔台每一行的规则名与次数都逐行等于引擎那份账（UI 一个都不自己数，行数就是 RULES 的行数）',
      rowsNow.length === a.engine.RULES.length && panelBad.length === 0,
      `${panelBad.slice(0, 3).map(([d, b, s]) => `${d}:标签${b}/读数${s}/引擎${g.ladderFired[d] ?? 0}`).join(' ')} 行数=${rowsNow.length}`);
    a.store.clearResume();
    return report({
      total, pressed, flipIndex, ladderSolved: g.ladderSolved, fired,
      rules: seenSorted, unseenFired: Object.entries(g.ladderFired)
        .filter(([, n]) => n > 0).map(([r]) => r).filter((r) => !seenRules.has(r)).join(','),
      moves: g.moves, errs: st.errs.length,
    });
  };

  w.__ng = ng;
})(window);
