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
  // 矩形 2-opt：环上取两条**不相邻**的边 (a-b)、(c-d)，改成 (a-c)、(b-d)。
  // 顶点集一点没变 ⇒ 每个环格还是 2 度、黑格/箭头/射线全都照旧，唯一坏掉的是「一条单环」。
  // 这就是「完成但错」那一类：局部全都对，全局不成立。翻不出两段就说翻不出，不skip。
  function twoOptSplit(order, nb) {
    const n = order.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        const a = order[i], b = order[(i + 1) % n], c = order[j], d = order[(j + 1) % n];
        if (new Set([a, b, c, d]).size !== 4) continue;
        const dAB = nb[a].indexOf(b), dCD = nb[c].indexOf(d);
        const dAC = nb[a].indexOf(c), dBD = nb[b].indexOf(d);
        // 翻完必须真的断开：a-c 与 b-d 里但凡有一条就是原来那条边，那还是单环，不算「完成但错」
        if (dAB < 0 || dCD < 0 || dAC < 0 || dBD < 0) continue;
        if (dAC === dAB || dBD === dCD) continue;
        return { drop: [[a, dAB], [c, dCD]], add: [[a, dAC], [b, dBD]], cells: { a, b, c, d } };
      }
    }
    return null;
  }

  // 两条开放链：把环边集去掉 drop 那两条边之后逐条走到底（指针只能沿相邻格走）。
  // 2-opt 翻对了应当正好得到 2 条链，每条两个 1 度端点；对不上就是 harness 自己错了，大声红。
  function chains(order, drop) {
    const removed = new Set(drop.map(([x, y]) => `${Math.min(x, y)}:${Math.max(x, y)}`));
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
    'btn-hint', 'btn-undo', 'btn-clear', 'btn-new', 'btn-reset',
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
    ck('boot: 状态行里的 seed 就是这一局的 seed，且形状是现铸的随机 seed 不是日期',
      shownSeed === `seed ${g.seed}` && /^y[0-9a-z]+-[0-9a-f]{12}$/.test(g.seed),
      `#stat-seed="${shownSeed}" seed=${g.seed}`);
    eq('boot: 面板箭头数 = 题面 clue 条数（UI 没自己数一套）', text('#stat-clues'), String(g.question.clue.size));
    ck('boot: 页面自己写了存档（seed/尺寸/笔迹都在里面，刷新才谈得上续局）',
      !!localStorage.getItem('yajilin.save.v1'), `keys=${Object.keys(localStorage).join(',')}`);

    setExpect({ bootSeed: g.seed, bootFp: g.puzzle.fingerprint, bootTimeOrigin: performance.timeOrigin, bootHref: location.href });
    return report({
      base: document.baseURI,
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
        if (!near(sample(c.cx + c.size * 0.33, c.cy + c.size * 0.33), C.tile)) px.push(`tile${cell}`);
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

  w.__ng = ng;
})(window);
