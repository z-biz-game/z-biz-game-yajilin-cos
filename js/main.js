// 接线：DOM、指针、键盘、时钟、存档，以及验收 harness 驱动的 window.yajilin 那层门面。
//
// window.yajilin.engine 挂的就是页面自己 import 的那张模块图（不是为测试另抄一份），所以
// 门禁在浏览器里绿一次，等于玩家那侧的出题器/推理机同时绿一次。
//
// 这里没有一条 Yajilin 规则：落笔写进 ui/game.js 的两张笔表，赢不赢问 engine/model.js 的
// verify()，画什么由 render/board.js 读同一批数字。「提示」也不在这里判断任何事——它只是问
// engine/pencil.js 的事件流水要下一条被迫的结论，再交给 Game 的公开入口，和玩家自己拖的一笔
// 是同一条路。唯一留在这层的判断是「指针这一下落在哪一格 / 压着哪一条边」，
// 而那也要经 view.hitCell / view.hitEdge → 引擎 counter.js prepare() 的那张邻接表。
import { Palette, Space, applyThemeVars, setReduceMotion } from './theme.js';
import { Store } from './store.js';
import { makeQuestion, parseSize, SIZES, TIERS } from './ui/puzzle.js';
import { Game, RULE_TEXT, RULES, E_ON, E_OFF, E_UNK, BLACK, UNK, UP, RIGHT, DOWN, LEFT } from './ui/game.js';
import { BoardView } from './render/board.js';
// 引擎原样透传给门面（页面加载的就是这张模块图本身，不是为测试另抄的一份）
import { verify } from './engine/model.js';
import { pencil, ROLE, EDGE } from './engine/pencil.js';
import { shipBoard, makePencilBoard, pSet, pDig, DEFAULT_LOOP_FRACS, DEFAULT_MAX_ATTEMPTS } from './engine/generate.js';
import { countSolutions, materialize, prepare } from './engine/counter.js';
import { Board, DIRS } from './engine/grid.js';
import { hashSeed, mulberry32, makeRng } from './engine/rng.js';

const VERSION = '0.1.0';
const DEFAULT_SIZE = '6x6';
// 「换一局」自己 mint 的 seed 出不了盘时可以再敲一颗；调用方给了明确 seed 就**不许**偷偷换
//（门禁与存档靠的就是「同一个 seed 同一张盘」）。封顶 = 试这么多颗，全失败就照直说。
const MINT_TRIES = 8;
const $ = (id) => document.getElementById(id);

applyThemeVars();
setReduceMotion(Store.setting('reduceMotion') === true);

const canvas = $('board');
const wrap = $('board-wrap');
const veil = $('win-veil');
const stateLine = $('state-line');
const srCell = $('sr-cell');
const sizeSelect = $('size-select');
const verifyLine = $('verify-line');

const view = new BoardView(canvas);
let game = null;
// 四支笔，对着引擎的取值表：画环=E_ON、涂黑=BLACK、排除叉=E_OFF、擦掉=E_UNK/UNK。
// 「排除叉」是一支真的笔，不是「擦掉」的别名：它把一条边写成 E_OFF，画出来是一个小叉。
let mode = 'loop';
const PENS = { loop: E_ON, black: BLACK, cut: E_OFF, erase: E_UNK };
let drag = null;
let cursor = -1;
let anchor = -1;
let won = false;
let hintNote = null;
let noteMoves = -1;

// ── 时钟 ────────────────────────────────────────────────────────────────
let startedAt = 0;
let baseElapsed = 0;
const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
function startClock() {
  if (!startedAt) startedAt = Date.now();
}
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(() => {
  $('stat-time').textContent = fmt(clock());
}, 500);

// ── seed ────────────────────────────────────────────────────────────────
// 「换一局」必须真的换一局，而且这个 seed **不许从日期来**：日期当默认 seed 等于一整天发同一张盘，
// 而页面上写着「seed xxxx」——那是在替界面说谎。所以随机只发生在**选 seed**这一步，
// 生成器内部一点随机都不许有（shipBoard 是 seed 的纯函数）。
let seedCounter = 0;
function mintSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  seedCounter++;
  return `y${seedCounter.toString(36)}-${hex}`;
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function avail() {
  const w = Math.max(280, wrap.clientWidth || 520);
  const h = Math.max(280, Math.min(w, window.innerHeight - 230));
  return { w, h };
}

function render() {
  if (!game) return;
  const preview = [];
  if (anchor >= 0 && cursor >= 0 && anchor !== cursor) {
    const d = view.dirFromTo(anchor, cursor);
    if (d >= 0) preview.push([anchor, d]);
  }
  view.draw(game, { preview, cursor, won });
  paintStats();
}

function paintStats() {
  const segs = game.loopEdges();
  const offs = game.offEdges();
  const blacks = game.blackCells();
  const bad = game.badCells();
  const ends = game.endpoints();
  $('stat-seed').textContent = `seed ${game.seed}`;
  $('stat-time').textContent = fmt(clock());
  $('stat-clues').textContent = String(game.clues);
  $('stat-black').textContent = String(blacks.length);
  $('stat-segs').textContent = String(segs.length);
  $('stat-cuts').textContent = String(offs.length);
  $('stat-ends').textContent = String(ends.length);
  const badEl = $('stat-bad');
  badEl.textContent = String(bad.length);
  badEl.classList.toggle('bad', bad.length > 0);
  $('stat-moves').textContent = String(game.moves);
  $('stat-pencil').textContent = `${game.ghost.size}/${game.ladder.length}`;
  const v = game.status();
  const vEl = $('stat-verify');
  vEl.textContent = v.ok ? '通过' : `${v.count} 处不对`;
  vEl.classList.toggle('good', v.ok);
  vEl.classList.toggle('bad', !v.ok && segs.length + offs.length + blacks.length > 0);
  verifyLine.textContent = v.ok ? 'verify() → []（判胜就这一处）' : `verify() → ${v.errs[0]}`;
  paintPencilTable();
  if (!won) {
    stateLine.className = 'state-line' + (bad.length ? ' bad' : '');
    stateLine.textContent = bad.length
      ? `${bad.length} 格引出了 3 条以上的环段——那里不可能接成一条环。引擎第一句：${v.errs[0] || ''}`
      : segs.length + offs.length + blacks.length === 0
        ? '拖拽相邻两格连环段；「涂黑」那支笔点一格就上黑格；右键落在哪条边上就把那条边画成排除叉。箭头格是题面，改不动。'
        : `环段 ${segs.length}、黑格 ${blacks.length}、排除 ${offs.length}，${ends.length} 个没接上的端点。引擎说：${v.errs[0] || '全部对上'}`;
  }
  // 提示说过的那句话盖在进度播报之上：它是「刚刚发生的那件事」，而进度行每一帧都能重算出来。
  // 过期条件是步数变了（或者这局已经赢了），不是这里现编一个计时器。
  if (hintNote && !won && game.moves === noteMoves) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = hintNote;
  } else {
    hintNote = null;
    noteMoves = -1;
  }
}

// 铅笔台：引擎 pencil() 对**题面**跑出来的每条规则命中次数。UI 一个都不自己数。
function paintPencilTable() {
  const host = $('pencil-list');
  if (!host.children.length) {
    for (const r of RULES) {
      const li = document.createElement('li');
      li.dataset.rule = r;
      const b = document.createElement('b');
      b.textContent = r;
      const s = document.createElement('span');
      li.appendChild(b);
      li.appendChild(s);
      host.appendChild(li);
    }
  }
  for (const li of host.children) {
    li.querySelector('span').textContent = String(game.ladderFired[li.dataset.rule] ?? 0);
  }
}

// ── 判胜：唯一的入口是引擎的 verify，UI 不给自己记账 ─────────────────────
function checkWin() {
  const v = game.status();
  if (!v.ok) {
    // 撤一步之后盘不再成立，胜利卡片就该下来：赢是 verify() 此刻说的话，不是once‑and‑for‑all 的徽章
    if (won) {
      won = false;
      veil.hidden = true;
      render();
    }
    return false;
  }
  if (won) return true;
  won = true;
  veil.hidden = false;
  $('win-meta').textContent = `环段 ${game.loopEdges().length} 条 · 黑格 ${game.blackCells().length} 个 · 箭头 ${game.clues} 条 · ${game.moves} 步 · ${fmt(clock())}`;
  stateLine.className = 'state-line good';
  stateLine.textContent = 'verify() 判定通过：每条箭头数齐、黑格不相邻、一条环盖住了所有不是箭头也不是黑格的格。';
  Store.recordSolve(clock(), game.moves);
  Store.clearResume();
  render();
  return true;
}

// ── 提示：引擎的下一条被迫结论，落笔仍然只经 Game 的公开入口 ──────────────────
// 关键不在「有个按钮」，而在**它和玩家自己画的是同一个写入者**：pencil() 的事件流水只给一条结论，
// Game.hint() 把它经 setEdge/setRole 写下去。于是提示落的每一笔都进撤销栈、在 moves 上记一步，
// 玩家撤得掉、门禁数得出。反过来，只要有一句结论绕过 Game 直接写笔表，那一步就不在账上。
function hint() {
  if (!game || won) return null;
  startClock();
  const mv = game.moves;
  const out = game.hint();
  if (out.kind === 'done') {
    hintNote = '铅笔流水上的结论已经都在盘上了（这条路径推完就是这道题的解）。再按不落新东西——剩下的那格是答案。';
    noteMoves = mv;
    render();
    return { kind: 'done', moved: false };
  }
  if (out.kind === 'conflict') {
    // 玩家在这一处已经写了相反的一态：铅笔不肯再往前推。该撤哪一笔是玩家自己的判断。
    hintNote = `盘上自己打脸了（${out.ev.rule}）：铅笔要说的那一条，你已经写成了相反的一态。提示这一步什么都不画 —— 先撤掉那笔再说。`;
    noteMoves = mv;
    render();
    return { kind: 'conflict', ev: out.ev, moved: false };
  }
  if (out.kind === 'noop') {
    hintNote = `提示这次没落下去：引擎给的第 ${out.nx.index} 条结论，Game 拒收（出盘或已经这样了）。再按一次。`;
    noteMoves = mv;
    render();
    return { kind: 'noop', moved: false };
  }
  const ev = out.ev;
  hintNote = `${RULE_TEXT[ev.rule] || ev.rule} —— ${ev.kind === 'role' ? '涂黑那一格' : ev.v === E_ON ? '连上那条边' : '排除那条边'}`;
  noteMoves = game.moves;
  render();
  checkWin();
  persist();
  return { kind: out.kind, ev, rec: out.rec, moved: true };
}

function hideVeil() {
  veil.hidden = true;
}

// ── 开局 ────────────────────────────────────────────────────────────────
let busy = false;
async function generate(seed, sizeKey) {
  busy = true;
  $('btn-new').disabled = true;
  $('btn-new').textContent = '生成中…';
  stateLine.className = 'state-line';
  stateLine.textContent = '正在出题：铅笔要零猜测推得完、计数器要说唯一、箭头要逐条数得过——三道门都过了才发给你。';
  // 出题是同步的（本台机器实测 6×6 几毫秒、12×12 几百毫秒），让出一帧好让「生成中」真的看得见
  await new Promise((r) => setTimeout(r, 0));
  const p = makeQuestion(seed, sizeKey);
  busy = false;
  $('btn-new').disabled = false;
  $('btn-new').textContent = '换一局';
  return p;
}

async function newGame({ seed = null, sizeKey = game ? game.sizeKey : DEFAULT_SIZE, marks = null, moves = 0, elapsedMs = 0, resumeFrom = null } = {}) {
  const callerSeed = seed !== null && seed !== undefined;
  let p = null;
  let tries = 0;
  const start = callerSeed ? String(seed) : mintSeed();
  for (let k = 0; k < (callerSeed ? 1 : MINT_TRIES); k++) {
    tries++;
    // 自己 mint 的时候每敲一颗都换一个（第一颗出不了盘，第二颗必须真的是另一颗）
    const s = !callerSeed && k > 0 ? mintSeed() : start;
    p = await generate(s, sizeKey);
    if (p.ok) break;
  }
  if (!p || !p.ok) {
    stateLine.className = 'state-line bad';
    stateLine.textContent = `这个 seed 出不了盘（${p ? p.status : '?'}，试了 ${tries} 颗）：再按一次换一局。`;
    return null;
  }
  game = new Game(p);
  game.clues = p.clues;
  // 续局的判据不是「有没有这份存档」，而是「存档里那张盘和现在重画出来的是不是同一张」：
  // 存档存的正是 seed，出货流水线一改版，同一个 seed 就是另一张盘，旧笔迹贴上去等于在玩家
  // 没做过的题上续命。Store.resume(指纹) 对不上会返回 null 并作废存档。
  const resume = resumeFrom ? Store.resume(p.fingerprint) : null;
  const carry = resume ? { marks: resume.marks, moves: resume.moves, elapsedMs: resume.elapsedMs } : { marks, moves, elapsedMs };
  // 存档的串长度必须正好对上这张盘的格数+边数——对不上就不搬（尺寸换过、串被截断都算）。
  // 步数只在笔迹真的搬过来之后才跟着搬：盘是空的却说「这局走了 12 步」又是另一句谎话。
  const want = game.n + game.edgeCount();
  if (typeof carry.marks === 'string' && carry.marks.length === want) game.decode(carry.marks, carry.moves);
  hintNote = null;
  noteMoves = -1;
  won = false;
  hideVeil();
  cursor = -1;
  anchor = -1;
  baseElapsed = carry.elapsedMs || 0;
  startedAt = Date.now();
  relayout();
  render();
  persist();
  if (tries > 1) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = `前 ${tries - 1} 颗 seed 撞上流水线封顶（NO_BOARD），这一张是第 ${tries} 颗出的：${p.stats.attempts} 次 attempt。`;
  }
  // 作废的那份存档要当着玩家说清楚：这一局是新的，不是他那一局。
  // 写在 persist() 之后，因为 persist 已经把这张新盘存下去了，玩家下一次刷新就是正常续局。
  if (resumeFrom && !resume) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = '这一局的存档与现在重画出来的题面对不上（存档存的是 seed，出题流水线改版后同一个 seed 是另一张盘）：旧笔迹没有搬过来，这一局重新开始。';
  }
  return game;
}

function relayout() {
  if (!game) return;
  const a = avail();
  view.resize(game, a.w, a.h);
}

function persist() {
  if (!game || won) return;
  Store.saveResume(game, clock());
}

function setMode(next) {
  // 判「这个笔名认不认」用 in，不用取值真假：擦掉那支笔的 kind 就是 E_UNK=0，
  // 写成 PENS[next] ? next : 'loop' 会把「擦掉」当成没认出来、悄悄退回画环。
  mode = next in PENS ? next : 'loop';
  for (const id of ['loop', 'black', 'cut', 'erase']) {
    $(`btn-mode-${id}`).setAttribute('aria-pressed', String(mode === id));
  }
  canvas.style.cursor = mode === 'black' ? 'cell' : 'crosshair';
}

// ── 指针 ────────────────────────────────────────────────────────────────
// 拖拽走的是「相邻格心」：每一段都问 view 要方向，view 再问引擎的邻接表。
// 不相邻的两格（甩太快）只会挪笔，不会凭空长出一条斜边。
canvas.addEventListener('pointerdown', (ev) => {
  if (!game) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  ev.preventDefault();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有真的 pointerId：下面的 move/up 仍然按 clientX/Y 走同一条路 */
  }
  startClock();
  if (ev.button === 2) {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.toggleCut(hit.cell, hit.d); // 不在手势里：setEdge 自己就是一组
    render();
    checkWin();
    persist();
    return;
  }
  game.beginGesture();
  drag = { cells: [cell] };
  cursor = cell;
  if (mode === 'loop') {
    // 起点那一格还没有「上一条」，所以先只把笔放下去；拖到相邻格才连边
  } else if (mode === 'black') {
    game.setRole(cell, BLACK);
  } else if (mode === 'cut') {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.setEdge(hit.cell, hit.d, E_OFF);
  } else if (mode === 'erase') {
    game.eraseAt(cell);
  }
  render();
});

canvas.addEventListener('pointermove', (ev) => {
  if (!game || !drag) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  const last = drag.cells[drag.cells.length - 1];
  if (cell === last) return;
  if (mode === 'erase') {
    game.eraseAt(cell);
    drag.cells.push(cell);
    cursor = cell;
    render();
    return;
  }
  if (mode === 'black') {
    game.setRole(cell, BLACK);
    drag.cells.push(cell);
    cursor = cell;
    render();
    return;
  }
  const d = view.dirFromTo(last, cell);
  if (d < 0) {
    // 不相邻：只挪笔，不连线（斜着甩出去不该凭空长出一条边）
    drag.cells = [cell];
    cursor = cell;
    return;
  }
  drag.cells.push(cell);
  game.setEdge(last, d, mode === 'cut' ? E_OFF : E_ON);
  cursor = cell;
  render();
});

async function endDrag() {
  if (!drag) return;
  drag = null;
  game.endGesture();
  render();
  await checkWin();
  persist();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ── 键盘 ────────────────────────────────────────────────────────────────
window.addEventListener('keydown', async (ev) => {
  if (!game) return;
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const k = ev.key;
  const w = game.w;
  const h = game.h;
  const move = (dr, dc) => {
    if (cursor < 0) cursor = 0;
    const r = Math.min(h - 1, Math.max(0, Math.floor(cursor / w) + dr));
    const c = Math.min(w - 1, Math.max(0, (cursor % w) + dc));
    cursor = r * w + c;
    anchor = -1;
    srCell.textContent = game.cellReport(cursor);
  };
  if (k === 'ArrowUp') move(-1, 0);
  else if (k === 'ArrowDown') move(1, 0);
  else if (k === 'ArrowLeft') move(0, -1);
  else if (k === 'ArrowRight') move(0, 1);
  else if (k === 'Enter' || k === ' ') {
    ev.preventDefault();
    startClock();
    if (cursor < 0) cursor = 0;
    if (anchor < 0) {
      anchor = cursor;
      srCell.textContent = `锚在第 ${Math.floor(cursor / w) + 1} 行第 ${cursor % w + 1} 列`;
    } else if (anchor !== cursor) {
      const d = view.dirFromTo(anchor, cursor);
      game.beginGesture();
      if (d >= 0) {
        if (mode === 'loop') game.setEdge(anchor, d, E_ON);
        else if (mode === 'cut') game.setEdge(anchor, d, E_OFF);
        else if (mode === 'black') game.setRole(cursor, BLACK);
        else game.eraseAt(cursor);
      } else if (mode === 'black') {
        game.setRole(cursor, BLACK);
      }
      game.endGesture();
      anchor = cursor;
      render();
      await checkWin();
      persist();
    }
  } else if (k === 'Escape') {
    anchor = -1;
    hideVeil();
  } else if (k === 'b' || k === 'B') {
    startClock();
    game.toggleBlack(cursor < 0 ? 0 : cursor);
    render();
    await checkWin();
    persist();
  } else if (k === 'Backspace' || k === 'Delete') {
    ev.preventDefault();
    startClock();
    game.eraseAt(cursor < 0 ? 0 : cursor);
    render();
    await checkWin();
    persist();
  } else if (k === 'z' || k === 'Z') {
    game.undo();
    render();
    await checkWin();
    persist();
  } else if (k === 'h' || k === 'H') {
    hint();
  } else if (k === 'e' || k === 'E') {
    const order = ['loop', 'black', 'cut', 'erase'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
    srCell.textContent = `画笔：${mode}`;
  } else if (k === 'n' || k === 'N') {
    await newGame({});
    return;
  } else return;
  render();
});

// ── 按钮 ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => newGame({}));
$('btn-again').addEventListener('click', () => newGame({}));
$('btn-close-veil').addEventListener('click', () => hideVeil());
$('btn-hint').addEventListener('click', () => hint());
$('btn-undo').addEventListener('click', async () => {
  if (!game) return;
  game.undo();
  render();
  await checkWin();
  persist();
});
$('btn-clear').addEventListener('click', () => {
  if (!game) return;
  game.clearAll();
  won = false;
  hideVeil();
  render();
  persist();
});
for (const id of ['loop', 'black', 'cut', 'erase']) {
  $(`btn-mode-${id}`).addEventListener('click', () => setMode(id));
}
$('btn-motion').addEventListener('click', (ev) => {
  const next = !(ev.currentTarget.getAttribute('aria-pressed') === 'true');
  ev.currentTarget.setAttribute('aria-pressed', String(next));
  ev.currentTarget.textContent = next ? '动效 减' : '动效 全';
  setReduceMotion(next);
  Store.setSetting('reduceMotion', next);
});
$('btn-reset').addEventListener('click', () => {
  Store.reset();
  newGame({});
});

for (const t of TIERS) {
  const o = document.createElement('option');
  o.value = t.key;
  o.textContent = `${t.key}（${t.w}×${t.h}）`;
  sizeSelect.appendChild(o);
}
sizeSelect.value = DEFAULT_SIZE;
sizeSelect.addEventListener('change', async () => {
  parseSize(sizeSelect.value);
  // 尺寸一换就是新一局：不同 w×h 的格数与边数不同，旧存档的笔迹没法搬过去
  await newGame({ sizeKey: sizeSelect.value });
});

window.addEventListener('resize', () => {
  relayout();
  render();
});
window.addEventListener('pagehide', persist);

// ── 门面 ────────────────────────────────────────────────────────────────
window.yajilin = {
  version: VERSION,
  state: 'booting',
  engine: {
    makeQuestion, parseSize, SIZES, TIERS, Game, RULE_TEXT, RULES,
    // 引擎原样透传：门禁在页面里读到的 verify/pencil/countSolutions 就是玩家这条路加载的同一份模块
    verify, pencil, shipBoard, makePencilBoard, pSet, pDig, countSolutions, materialize, prepare,
    Board, DIRS, hashSeed, mulberry32, makeRng, ROLE, EDGE,
    DEFAULT_LOOP_FRACS, DEFAULT_MAX_ATTEMPTS,
    E_ON, E_OFF, E_UNK, BLACK, UNK, UP, RIGHT, DOWN, LEFT,
  },
  view,
  get game() {
    return game;
  },
  get won() {
    return won;
  },
  get mode() {
    return mode;
  },
  setMode,
  hint,
  newGame,
  mintSeed,
  checkWin,
  render,
  relayout,
  hideVeil,
  store: Store,
  palette: Palette,
  space: Space,
};

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  setMode('loop');
  // 先只看「有没有一份形状正确的存档」，笔迹/步数不在这里搬：newGame 要用存档里的 seed 重画出盘，
  // 再拿那张盘的真实指纹向 Store.resume(指纹) 对一次账（对不上就作废存档、开新局并说给玩家听）。
  const pending = Store.pendingResume();
  let started = null;
  if (pending) started = await newGame({ seed: pending.seed, sizeKey: pending.sizeKey, resumeFrom: pending });
  if (!started) await newGame({});
  window.yajilin.state = 'ready';
})();
