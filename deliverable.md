# 交付报告 · z-biz-game-yajilin-cos

本轮：并线（`4b10eb0` = merge `e03ffe0` + `89316ea`）把这一仓接成了**整局不可玩**，外加一批闸的测量盲区。
下面按「先修能玩的、再修量得准的」两段记。

---

## 一、整局不可玩：三处并线断裂（全部由并线引入，本地线自己那版 `02adbaa` 是能玩的）

**1. ESM 导出被同名文件顶掉 ⇒ main.js 整份不加载**
`js/main.js` 走 ESM 导入 `import { swRegistration } from './sw-register.js'`，但并线把 `js/sw-register.js`
判给了远端侧的**经典脚本**版（无 export）⇒ 浏览器报
`SyntaxError: The requested module './sw-register.js' does not provide an export named 'swRegistration'`
⇒ main.js 整份不加载 ⇒ 页面只剩壳。
- 修法：恢复本地侧 `02adbaa` 的 ESM 版（`export function registerServiceWorker()` + `export const swRegistration = …`），
  并删掉 `index.html` 里那条经典 `<script src="js/sw-register.js">`（ESM 的 export 在经典脚本里同样是 SyntaxError）。
- 佐证：合并后的 `tools/sw-test.mjs` 本来就按 **ESM 形状**跑 `js/sw-register.js` ⇒ 闸要的是 ESM，并线把实现换成了经典脚本。

**2. 顶栏 HUD 两代契约混搭 ⇒ 按钮 id 对不上**
本地侧 HUD 是「图标 + 文字」结构（`swap()` 要求按钮里有 `.lb` 与 `.ic`），带 `btn-pause` / `btn-mute` / `btn-full`；
远端侧 HUD 是纯文字三颗（`btn-pause` / `btn-motion` / `btn-fullscreen`）。并线取了两边各一半：
`index.html` 用远端侧三颗，`js/main.js` 用本地侧 `swap()` 与 `btn-mute` / `btn-full` ⇒
`swap()` 的 `querySelector('.lb')` 得 null（TypeError），`$('btn-mute')` / `$('btn-full')` 得 null（TypeError）。
- 修法（**并集，不删功能**）：
  - 顶栏 `.top-actions` 保持三颗（闸的名册把顺序、条数、id 全钉死）：`btn-pause` 恢复成「图标 + 文字」，
    `btn-motion` / `btn-fullscreen` 保持纯文字（它们由另一套实现写 `textContent`，纯文字才不会被抹掉图标）。
  - 面板新增一行 `.settings`，放回 `btn-mute`（音效）与 `btn-full`（全屏）——本地侧 HUD 契约要的这两颗，
    都不进顶栏（进了顶栏名册就变了）。

**3. 同一个功能两套实现 ⇒ 双开关 / 恒真**
- `btn-pause` 挂了两个 click：一个 `setPaused(!paused)`（`paused` 是函数，当布尔值恒为真 ⇒ 永远是「解暂停」）、
  一个 `setPaused(!paused())`（正确）⇒ 删掉错的那个。
- 全屏有两套：`paintFullUi`/`toggleFullscreen`（本地侧）与 `bindFullscreen` IIFE（远端侧）。
  ⇒ 合成**一套**实现（能力取并集：ms 前缀、拒绝时给一句人话理由、Esc 退出后标签跟事实走），
    两个入口共用同一个状态源；F 键原本接两遍（main.js 的 keydown + IIFE 的 keydown），只留 main.js 那份。
- 门面 `window.yajilin` 里 `get paused()` 写了两遍：后一份 `return paused`（返回函数，恒真）把前一份
  `return paused()`（返回布尔）盖掉了 ⇒ 删掉后一份。同名的 `setPaused` 重复键一并清掉。
- 远端侧还留着一个**从没被调用过的** `paintPause()`：它把 `paused` 当布尔值用（按钮恒显示「继续」、
  `aria-pressed` 恒为 true），而且 `btn.textContent = …` 会把按钮里的图标与文字标签一起抹掉 ⇒ 删除，
  并把它那段注释挂到真正在跑的 `setPaused` 上（注释按现在的实现重写：冻结靠 `clock()` 里的 `(pausedAt || Date.now())`）。

---

## 二、量得准：闸的三处测量盲区（断言文本未动，判得更严，不是更松）

**1. 纹理的 url 解析错了基址 ⇒ 这条腿此前必然红**
`tools/scenarios.js` 从 CSSOM 取到的是**未解析**的相对 url（`../assets/textures/x.png`），
原实现拿**文档**基址去 `img.src` ⇒ 那个 `..` 把 `/<仓库名>/` 前缀吃掉 ⇒ 前缀形态下每张纹理都 404；
而 `got.every((t) => t.u.startsWith(baseTex))` 又拿相对串去比绝对 URL ⇒ 永远不成立。
另外 Chrome 对**多层** `background-image` 序列化时**不加引号**（`url(…)`），原正则只认 `url("…")`
⇒ 「html, body」那层「纸纹 + 渐变」的多层背景被整条漏掉 ⇒ 「两张纹理」永远只数出一张。
- 修法：按**这张样式表自己的地址**解析（`new URL(raw, sheet.href)`），并同时认带引号与不带引号两种写法。
  断言那一行一个字没改；改完之后它真的在量两张纹理（`paper-256` 与 `field-256`，各 256×256、都在本仓前缀下）。

**2. `responseStatus === 0` 被当成「资源坏了」⇒ 第二趟必然假红**
被 Service Worker 的 **Cache API** 接管的那一次请求，浏览器没有网络响应可记，状态码就记成 0
（资源是**真的取到了**，`Response.status` 还是原码）。本仓会踩到：暂停按钮换图标那张 `play-48.png`
是 SW 接管之后才被要的，第二趟（重载证人那一趟）它就在 SW 的缓存里了 ⇒ 状态码 0 ⇒ 假红。
- 修法：状态码读不到的那几条**单独再发一次**请求（`cache: 'no-store'`，绕开缓存直连网络）把**真实**状态码读回来：
  真缺文件仍然是 404、真 500 仍然是 500 ⇒ 这条腿比原来更严。

**3. 部署集自测的刀口写死了一行字**
`tools/deploy-set-selftest.mjs` 的 X1 刀口写死 `'for d in icons assets; do'`；本轮清单改成
「源:去处」对照表之后，这一刀就打在空处、X1 静默失灵 ⇒ 改成**从仓里现取**那行位图循环（含它的循环变量名）。

---

## 三、部署名单：真产物比名单宽（Pages 上会把出题器源码发出去）

`tools/assemble-site.sh` 原来整目录拷 `assets/` ⇒ `assets/gen/make_art.mjs`（美术资产生成器源码）被带进产物；
而 `tools/verify.sh` 的腿 4 恰恰断言「`assets/gen/*` 必须 404」——**替身根里没有，真产物里有**，那条腿一直绿着。
- 修法：清单改成逐份点名（顶层 `icons/` + `assets/{icons,textures,sprites}` + `assets/og.png`），`assets/gen/` 不进产物。
- 同步：`tools/verify.sh` 的前缀替身根补上顶层 `icons/`（manifest 与 index.html 引的就是 `icons/…`，
  少了它前缀形态下三张图标静默 404），腿 4 的 WANT 名单改成真路径。

---

## 四、实数钉的重钉（**钉的是实数，强度不变**）

- `tools/deploy-set.mjs`：`EXPECT_CHECKS` 39 → **48**、`EXPECT_ROWS` 58 → **67**（页面补回三张 HUD 精灵图 + og 尺寸元信息）。
- `tools/docs-test.mjs`：续引夹具里指向 check.mjs 的那个行号（124 → 130）与指向 main.js 的那个（69 → 401），
  阳性对照那条也一样（69 → 401）——那两行必须真的含 `got` / `setPaused`，锚点腿才有东西可查。
- 文档里 40+ 处 `文件:行号` 锚点按内容逐条重定位（并线改了行数，文档没跟上）。
- 口径订正：`SUITES` 已是**十二套**（并线把远端侧新增的六套并了进来），而 `tools/verify.sh` 与
  `.github/workflows/ci.yml` 的两处 `need` 名单与「六套」标签还停在六/七条 ⇒ 标签与名单一并补成十二条
  （否则 CI 那边数行只认七套，少跑五套照样绿）；两份文档里的实数（套件数、逐套条数、聚合数、语法门文件数、
  浏览器各腿条数）同步对齐。

---

## 五、顺带修掉的两个真缺陷（闸原本就红，不是本轮引入）

1. **「存档作废」那句话活不过一帧**：`newGame` 把「这一局的存档与现在重画出来的题面对不上…」写进状态行，
   而 `render()` 每一帧都会把状态行重算成进度播报 ⇒ 下一帧（16ms 后）就被抹掉，玩家根本看不见，
   闸也就读不到「当着玩家说清楚为什么」。⇒ 改走 `hintNote` 那条现成的通道（有明确过期条件：步数变了才让位）。
2. **动效的 rng 不随重置归位**：门禁那三档帧率对拍比的是「同一簇粒子在三种帧率下的积分」，
   而 `fxReset()` 只清了粒子、没清随机序列 ⇒ 第二档拿到的就是另一串随机 ⇒ 真话被判成假话。
   ⇒ `fxReset()` 现在把 rng 一起拨回这一局的 seed 起点（`fxRngBase`）。

---

## 六、需人接手（闸钉死、改不动）

**`btn-full` 与 `btn-fullscreen` 两个 id 都在，且都得是真按钮。**
闸两边都点名：`tools/scenarios.js` 的 boot 场点 `btn-full` 并断言它的 `aria-pressed` 等于 `fullscreenElement` 的事实；
`tools/behavior-test.mjs` 断言 `index.html` 里存在 `id="btn-full"` 且点它触发 `documentElement.requestFullscreen`；
而 pause 场的顶栏名册把 `.top-actions` 钉成恰好 `btn-pause,btn-motion,btn-fullscreen` ⇒ `btn-full` **不能**进顶栏。
⇒ 本轮把 `btn-full` 放进面板的设置行，与顶栏那颗 `btn-fullscreen` **共用同一个状态源**
（按一次只发生一次全屏，不是两个开关）。代价是玩家能看到两颗「全屏」——
若要收成一颗，只能改闸的断言（那属于「改判据」，本轮不动）。

---

## 七、验收读数（本轮现量）

- `node tools/check.mjs`：**12 套 + 聚合 = 13 行 RESULT、合计 1282 条断言、聚合 check 198 条、红 0、退出码 0**
  （rule 48 / pencil 435 / counter 71 / golden-write 7 / golden-test 156 / generator-probe 24 /
  store 65 / frame-rate 12 / behavior 67 / keyboard 96 / asset 268 / sw 33；文档腿 24 项）。
- `bash tools/verify.sh`：**ALL GREEN，退出码 0**；浏览器 **root 10 场 175 条 / prefix 10 场 175 条 /
  mobile 3 场 64 条，合计 414 条断言，红 0**，三腿控制台零异常。
- `node tools/deploy-set.mjs`：**48 条引用、67 行、失败 0 项**；
  `node tools/deploy-set-selftest.mjs`：**rc=0**（每一刀都按预期发力、阴性对照按预期不发力）。
- 逐场：boot 36 / render 14 / play 14 / marks 15 / resume 8 / wrong 7 / win 8 / hint 14 / pause 23；
  两条桌面腿逐场条数逐条相同，`fs` 都读到 `entered`。
