# DESIGN · 矢仓林 Yajilin

这个文件讲**为什么长成这样**：哪几个自由度决定了这一族能不能出货，门禁为什么是这个形状，
以及哪些东西属于「证人」而不是「梯级」。

所有数字都是本轮复跑读回的，不是引用别人的预跑。跑法与逐样本分布见 `README.md` 第三节；
本轮机器 Darwin 25.6.0 arm64、15 核，主测量跑在 `load1 = 3.39 ~ 4.28` 之间。

---

## 一、这一族成立靠的是三个自由度，不是第十条规则

引擎里的铅笔规则有 10 条（`js/engine/pencil.js:25`），但**加规则不解决出货率**。
真正决定「零猜测能不能推到底」的是下面三个可动的旋钮。

### 自由度 1：箭头方向由铅笔挑，而不是随机挑

原始采样器给每颗环外格随机挑一个方向（`js/engine/model.js:112-117`，那行随机是
`js/engine/model.js:114`）。这一步产出的题面**几乎推不动**——本轮做了一组只换这一个变量的
对照：同一批 seed、同样密度、同样 `ATTEMPTS`，只是**不**外接 `pSet`，直接对
`generate()` 交回的盘跑铅笔，看能不能全解：

| 档位 | 随机箭头方向：铅笔全解 | 外接 `pSet` 之后（同一批盘） | 全解那些盘的推导步数 |
|---|---|---|---|
| 6×6 | 2 / 16 | 16 / 16 | [57 60] |
| 8×8 | 2 / 16 | 16 / 16 | [102 109] |
| 10×10 | **0 / 16** | 16 / 16 | — |
| 12×12 | **0 / 16** | 16 / 16 | — |

`pSet` 那一列就是 `README.md` 第三节表的出货率（`js/engine/generate.js:150` 只放行
`PENCIL_SOLVED`）。也就是说：**同一批解，换一种挑方向的方式，从 0/16 变成 16/16。**
这就是为什么 `js/engine/model.js:86-89` 要把「随机方向只是搜索起点，没有任何一张盘带着它出货」
写成显式披露——读代码的人若只看 `generate()`，会以为题面就是随机方向那种题面。

`pSet` 的做法（`js/engine/generate.js:72-93`）：每轮跑一遍铅笔，从它**还没推定的格子**里造候选动作
（换方向 / 撤箭头改黑格 / 黑格改箭头，`js/engine/generate.js:45-67`），
逐个动作 apply → 跑铅笔 → undo，留下「推进最多、箭头最少」的那个（评分 `js/engine/generate.js:42`，
比较 `js/engine/generate.js:85-87`）。合法性由构造保证：箭头只能落在环外的格上（环不动 ⇒ 解仍成立），
箭头转回黑格要求它不挨着任何黑格（`js/engine/generate.js:57-58`）。
一个动作如果让铅笔报出自相矛盾，它连候选都不算（`js/engine/generate.js:84`）。

### 自由度 2：`loopFrac`（环密度）是主开关

本轮第二个单变量扫：固定 `ATTEMPTS=10`、`N=10`，只把 `loopFracs` 从出货三值换成密集三值。
逐样本都打出来，因为聚合数会说谎：

| 档位 | FRACS | 出货 | 逐样本墙钟 ms | 废因 |
|---|---|---|---|---|
| 6×6 | 0.45 / 0.5 / 0.55 | **10 / 10** | [0 0 0 0 0 0 0 1 1 3] | PLATEAU 11 |
| 6×6 | 0.6 / 0.63 / 0.66 | 8 / 10 | [1 1 1 2 3 4 5 5 8 10] | PLATEAU 45 |
| 12×12 | 0.45 / 0.5 / 0.55 | **2 / 10** | [94 144 168 178 182 248 255 263 265 279] | PLATEAU 87 |
| 12×12 | 0.6 / 0.63 / 0.66 | **0 / 10** | [315 345 374 385 404 436 457 473 487 540] | PLATEAU 100 |

两件事一起看才得出「主开关」这句话：

- 密度往**上**调，12×12 直接归零（0/10），而且失败的墙钟反而更长（436 ms vs 248 ms 的中位）——
  它不是「便宜地失败」，是拿着更多的时间什么都没换回来；
- 12×12 在**出货密度**上、只把 `ATTEMPTS` 从 60 砍到 10，也只剩 2/10。
  也就是说「密度」与「换盘次数」是两个独立旋钮，出货靠的是**低密度 × 高重试**这一组合
  （`js/engine/generate.js:27-28`：`DEFAULT_LOOP_FRACS = [0.45, 0.5, 0.55]`、`DEFAULT_MAX_ATTEMPTS = 60`）。

环短一点 ⇒ 环外格多 ⇒ 能当箭头的格子多 ⇒ 射线级联才点得着。这条因果在源码里以
「默认值 0.62 只是探针原样默认、不是出货密度」的形式被拦住，免得谁把默认值改回去
（`js/engine/model.js:90-91`、`js/engine/model.js:92` 的形参默认）。

### 自由度 3：`candLimit` / `maxRounds` 决定贪心看得多远

`pSet` 每轮只从前 `candLimit`（默认 12）个未定格里造动作（`js/engine/generate.js:49`），
最多走 `maxRounds`（默认 60）轮（`js/engine/generate.js:30`、`js/engine/generate.js:74`）。
这两个数不是「性能参数」，它们是**题面能不能被推开的搜索宽度**：本轮 12×12 出货盘的
`rounds` med 9 / max 16 就落在这个宽度里，而失败盘的废因清一色是 `PLATEAU`
——也就是「在这个候选视野内再也找不到能推进的动作」（`js/engine/generate.js:89`），
而不是 `ROUND_LIMIT`（60 轮用完）。三档出货盘的废因账本本轮是
PLATEAU 12 / 38 / 111 / 361，`UNSOUND_PENCIL`、`ROUND_LIMIT`、`COUNTER`、`BAD`、`NO_CYCLE` 全部 0
（`js/engine/generate.js:146-157` 是这些状态唯一可能被记进去的地方）。

---

## 二、答案必须来自计数器，不能来自出题器

出题器（`generate` + `pSet` + `pDig`）自己一路在跟 `board.black`，但补箭头/挖箭头都会改格子角色，
那份账**跟不上**。这不是假想事故：`js/engine/generate.js:12-16` 记的是修复前实测
「8×8 出货盘 0/6、6×6 1/6 的自带解连 `verify()` 都过不了，而唯一性闸门全是绿的」。

于是出货流水线最后三步是硬规定的顺序：

1. 用**独立**的穷举计数器认证唯一性：`countSolutions(b, { limit: Infinity, budgetNodes: 5_000_000, collect: 1 })`，
   `count !== 1 || stopped || !sols.length` ⇒ 整盘作废（`js/engine/generate.js:155-157`）；
2. 把计数器那张解 `materialize()` 出来，再跑一次 `verify()`，不绿就作废
   （`js/engine/generate.js:158-159`，`js/engine/counter.js:146-158`）；
3. 用计数器那张**覆盖**盘上的 `black/loop/edges`，然后才返回
   （`js/engine/generate.js:160-163`，注释里点名这一步就是坑 2 的修复）。

这条顺序在门禁那一侧有正面断言：出货盘（覆盖之后的那份）必须过整盘 `verify()`、
每格恰好一种角色、三种角色都出现（退化盘不许出货）——`tools/rule-test.mjs:143-157`，
本轮读数 `出货盘 6x6：2/2 过整盘 verify()`、`出货盘 8x8：2/2 过整盘 verify()`。

顺带一条同族的写法纪律：**回滚一律走「记录旧值」的日志栈，不许手写逆操作**
（`js/engine/counter.js:55-56`、`js/engine/pencil.js` 的动作 `undo` 闭包
`js/engine/generate.js:55-62`）。理由写在 `js/engine/counter.js:5`——
逆操作写错是**静默的**，它会绿着错。

---

## 三、门禁的形状：六道静态/逻辑门 + 六条浏览器腿

### node 侧：静态门跑在逻辑门前面，最后再数一次行数

`tools/check.mjs` 的顺序是有理由的，三段依次是：

1. **语法门**：`node --check` 扫 `js/` 与 `tools/` 下每个 `.js/.mjs/.cjs`
   （`tools/check.mjs:39-46`，本轮 25 个文件——tools/ 下新增的 balance 与 ceiling 也在扫描范围内）；
2. **禁词源闸**：6 个引擎文件 × 7 个禁词（`process.env` / `Math.random` / `Date.now|new Date` /
   `performance.now` / `require(` / `node:` 导入两种写法），**注释外**零命中
   （`tools/check.mjs:53-70`，本轮读成「6 个引擎文件 × 7 个禁词，注释外零命中」）；
3. **seed 源闸**：读 `js/main.js` 源码，要求 `mintSeed()` 体内出现
   `crypto.getRandomValues` 与 `seedCounter++`，且不得出现任何时间源，
   连 `seedCounter` 的**初值**也要过同一批禁词；最后还要求「换一局」「再来一局」两颗按钮
   真的都走到 `newGame({})`（`tools/check.mjs:72-103`，本轮读成「mintSeed 体内 7 行，零时间源；初值="0"」）。

为什么要跑在逻辑门前面，`tools/check.mjs:4-6` 给了答案：引擎里混进一个 `process.env` 或
`Math.random`，逻辑测试**当天**还是全绿（node 恰好有那个环境变量、或随机数恰好站在正确答案那边），
红的是三个月后的部署站点或另一台机器。同理，「默认 seed 不许按日期算」这句话**不能**用
「跑一遍看 seed 长什么样」来证——同一天连铸两颗也会因自增而各不相同，日期当 seed 反而看不出来，
所以只能读源码（`tools/check.mjs:72-77`）。

4. **六套 suite**：rule / pencil / counter / golden-write(`--check`) / golden / generator-probe
   （`tools/check.mjs:17-24`），本轮逐套 48 / 435 / 71 / 7 / 156 / 24，聚合 131（语法门 25 个文件），红 0
   （聚合里除了「六套齐 + 逐行格式」还有下面第 6 条那 27 项边界断言）；
   口径提醒：`tools/check.mjs:17-24` 的 `SUITES` 数组与 `tools/verify.sh:265` 的 `need` 列表都是六条，
   `tools/verify.sh:245` 那行 echo 也念「六套」。
   曾经有四行**注释**写着「五套 / five suites」（`tools/verify.sh:241`、`.github/workflows/ci.yml:13`、
   `:15`、`:131`），当时逐行改成「六套 / six suites」，行数一根没动。
   ⚠ 后来加 balance 那条 step 时**动了** `ci.yml` 的行数（148 → 175 行，插入点在原 87 行之后），
   所以 `:13`、`:15`、`:26-42`、`:62-64`、`:65-87` 这几处照旧有效，而原 `:104`（`SKIP_UNIT` 那两行注释）
   漂到 `:131`、原 `:111-121`（浏览器侧数场数那步）漂到 `:138-148`——本文两处都已跟着改并逐条 grep 回真名。
   核对过历史：这四行不是后来漂走的——引入六条 `SUITES` 的那颗提交（`65602f7`）里，
   `ci.yml` 就已经写着「five suites」，`verify.sh` 晚些写成时又抄了同一句旧话（`git show 65602f7:tools/check.mjs`
   的 `SUITES` 已是六条，`git show 65602f7:.github/workflows/ci.yml` 第 14 行是 five suites）。
   值得记下来的区别是：判据本身（数组、`need` 列表、`got.length === SUITES.length` 那条等式）
   从头到尾没变少过，坏的只是注释——所以这一处不是「门松了」，是「门上贴的标签错了」。
   本轮以实跑的 7 行 RESULT（六套 + 聚合）为准。
5. **数 RESULT 行数**：每套自己那行 `RESULT <name> ok=… checks=… fails=…` 原样再念一遍
   （`tools/check.mjs:118-122`），并且 `got.length === SUITES.length`（`tools/check.mjs:124`）。
   为什么行数要单独数：`tools/check.mjs:8-9`——套件被改名、被漏跑、spawn 失败但退出码没传上来，
   这三种都表现为「绿了，但少跑了一套」。CI 那一侧**再独立数一遍**
   （`.github/workflows/ci.yml:65-87`，缺行即红），理由是「check.mjs 内部也断言六套全到，
   但那是被测者自己数的」（`.github/workflows/ci.yml:62-64`）；
6. **分层闸**：两条 grep 把「`js/` 不许 import `tools/`」「运行时产物不许提到 `tools/` 下的任何门禁文件」
   钉死（`.github/workflows/ci.yml:26-42`，`tools/check.mjs:126-143` 用**同一个正则**在本地再跑一遍）。
   这不是洁癖：`tools/golden.mjs` 冻结的是每张出货盘的
   **认证解**，一旦它进了 Pages 产物，答案就在公网上，而「被测的字节就是出货的字节」这句话
   立刻不可证伪。
   这一条为什么现在有两处：本仓第一次推上去时 CI 就是红在这条上（step
   `runtime bundle references nothing under tools/`），命中 4 处引擎**注释**里的
   `tools/generator-probe.mjs` / `tools/check.mjs` 字样，而当时本地六套全绿——
   「本地绿」与「CI 绿」根本不是同一件事，因为这两条 grep 原先只有 CI 有。
   修法是把门搬到本地（不是把 CI 那条放宽）：注释改指 DESIGN 的对应小节，
   正则与 CI 逐字一致，同样**不分注释**（grep 不知道哪段是注释，所以门也不假装知道）。
   本轮读成「边界门：13 个运行时文件 × 2 条 grep，零命中」。

### CI 侧多出来的那一条：balance 是 step，不是第七套

`tools/balance.mjs` 按档量出货路径的墙钟，把 `budgetMs = max(10, ceil(p95 × 4 / 10) × 10)` 与
band `[max(1, floor(med × 0.4)), max(lo + 1, ceil(p95 × 1.6))]` **现算**出来当门判
（B1 定价 / B2 band / B3 stopped 与 nodes / B4 满额出货与零猜测 / B5 单颗摘除极小 / B6 菜单档绝对值线 /
B6b 菜单形状（防降级），本轮 checks=38 fails=0）。两个式子逐字抄兄弟仓的代码，不抄注释：
`../z-biz-game-hidato-cos/tools/balance.mjs:96-100`、`../z-biz-game-zebra-cos/tools/balance.mjs:182-186`
（那里判的是 p95，不是单次 max）。

它为什么以**独立 step** 进 CI（`.github/workflows/ci.yml:89-114`）而不进 `SUITES`：
`SUITES` 加一条就是「七套」，`tools/check.mjs:17-24` 的数组、`tools/verify.sh:265` 的 `need` 列表、
`tools/verify.sh:245` 那行 echo、上面第 4 条整段「六套」的账、CI 里数行那份 `need`
（`.github/workflows/ci.yml:76`）全要跟着改。这一族刚在「标签写着五套、判据跑的是六套」上红过一次
（第 4 条记着全过程），所以本轮把改动面压成「一个 step + 一句 RESULT 判定」，六套这个数一根手指都没碰。
收的判据只有一条：拿到 `RESULT balance` 行，且 `ok=true`、`fails=0`、`checks>0`。

`tools/ceiling.mjs`（`npm run ceiling`）**不进 CI**——它是量天花板的，不是门，
写进 CI 就变成每天重测一次结论（这条分工照 `../z-biz-game-triplets-cos/.github/workflows/ci.yml:52-59`）。
它量的是档外，读数是 §七 那张表的出处。

### 浏览器侧：六条腿各断言什么

`tools/verify.sh` 只管生命周期，**一条判据都不在这个文件里**
（`tools/verify.sh:13-14`：判据一律在 `tools/scenarios.js`；放进来就变成脚本自己给自己打分）。

| 腿 | 断言什么 | 本轮读数 | 出处 |
|---|---|---|---|
| 1 unit | 上面那六套 + 三道静态门 | 7 行 RESULT、741 条断言、红 0、退出码 0 | `tools/verify.sh:241-271` |
| 2 root | 根形态 `http://127.0.0.1:5326/` 上八场真指针 | 9 场 120 条断言 红 0 | `tools/verify.sh:295-308` |
| 3 prefix | Pages 前缀形态（替身根由 symlink 按部署名单搭） | 9 场 120 条 红 0 | `tools/verify.sh:311-339` |
| 4 deploy-list | 名单外的必须 404、名单内的必须 200 | 39 条 404 + 5 条 200 | `tools/verify.sh:341-372` |
| 5 mobile | 390×844 @ dpr3 的 **CDP 会话内**覆写 | 3 场 48 条 红 0 | `tools/verify.sh:380-399` |
| 6 live | 线上真部署那份字节（要网络） | 本轮没打 | `tools/verify.sh:402-424` |
| 汇总 | 腿×场的并表 + 地板判定 | 合计 288 条浏览器断言 红 0，ALL GREEN | `tools/verify.sh:443-465` |

八场的逐场条数（root，本轮）：boot 20 / render 14 / play 14 / marks 15 / resume 8 / wrong 7 / win 8 / hint 14。
`root` 是 **9 场**而不是 8 场，因为场景表写的是 `boot boot render play marks resume wrong win hint`
（`tools/verify.sh:292`）——boot 在同一条腿里连跑两次，第二次的 `performance.timeOrigin` 必须
**严格大于**第一次（`tools/verify.sh:150-152`、`tools/scenarios.js:457-458`）。
这一条专门抓「片段导航冒充重载」：`BASE#expect=` 那种同文档跳转连 JS 上下文都不换，
读数照样「对」，但玩家从来没有真的重载过页面。
`mobile` 只跑与形状有关的三场（boot / render / play，`tools/verify.sh:391`），
20 + 14 + 14 = 48，与本轮读数吻合。

### 为什么 prefix 形态必须单测（这一族付过学费的那一条）

`tools/verify.sh:312-314` 记着事故本身：**同组织另一个仓本地只测根形态、全绿，
Pages 上线的站点 404。** 原因是 Pages 把部署目录挂在 `/<仓库名>/` 下面，
页面里但凡有一个写死的 `href="/css/game.css"`，就只在带前缀的那一份上死。
所以这条腿不是重复劳动，它测的是根形态那条腿**测不到**的那一段。

这条腿的可信度取决于替身根是不是按真名单搭的：它用 symlink 只挂 `index.html`、`css/`、`js/`
三样（`tools/verify.sh:316-323`），与 `.github/workflows/pages.yml:44-45` 的 `cp` 逐条对齐，
并由 `.github/workflows/pages.yml:50` 那一步在产物侧反向核对「名单外的文件不许进 `_site`」。
`index.html:5-7` 把「不写 `<base>`、资源全走相对路径」写成显式约定，
浏览器侧则由 boot 场逐条读回每个子资源的 `responseStatus`
（`tools/scenarios.js:453`）——写死的根路径在前缀腿就是死在这条断言上，而不是死在人工报修。

第 4 条腿是第 3 条腿的**反证**：光有「前缀下页面能打开」还不够，必须同时证明
`tools/`、仓库根的 `*.md`、`package.json`、工作流文件在这棵根下**够不到**
（本轮 39 条 404：`tools/` 那 33 个文件里含闸自己落的 shots，所以这一格会随复跑变，口径见 README 第六节），并且反向要求名单内 5 条真的 200
（`tools/verify.sh:353-372`）——没有后半句，那一串 404 只是因为整棵树都在 404。

汇总腿的地板（`tools/verify.sh:443-461`）同样是为「假绿」写的：
零断言的场景直接红、场景名不在那张八场集合里红（场景表漂了或 `__ng` 少装一个都会这样）、
`root` 与 `prefix` 两条腿**都必须含那八场**（少了就是「浏览器闸只跑了一遍却被写成两遍」）、
总断言数 `< 60` 也红。CI 那一侧再按 `{'root': 9, 'prefix': 9, 'mobile': 3}` 数一遍场数
（`.github/workflows/ci.yml:138-148`）。

还有两条容易漏的「不是断言的断言」：每条腿的控制台里但凡出现 `[EXCEPTION]` 或 `[log:error]`
这一趟就不算干净（`tools/verify.sh:236-243`，本轮三条腿各 0 行），因为 404 与未捕获异常
不会让任何一条断言变红，它只会让玩家看到一张没有样式的盘；每条腿起一个**全新的**
`--user-data-dir`（`tools/verify.sh:205-212`），否则同源 `localStorage` 会串味——
`resume` 场读到的可能是上一条腿留下的存档。

### CI 那一红现在自己会说话（改的是看得见，不是判据）

浏览器那条腿第一次推上 GitHub 时红过两回（`rerun-failed-jobs` 也算一回），两回都是同一句
`devtools never bound on :9378`、退出码 3——可红房里读不出**为什么**：Chrome 自己的 stderr 落在
`$LOGD/chrome-*.log`（`tools/verify.sh:214-216`），而 `_tmp-*` 整条被 `.gitignore:8` 挡在产物门外，
artifact 只收了截图。于是那一红的全部信息量就是"没绑上"三个字，等于没法判是 runner 拉不起 Chrome、
端口被占、还是本机那条 120×0.5 s 的等待不够。

修法只有"把现场证据引出来"，一条判据都没动（这条腿该红还是红，红了也不会因为多打了几行就变绿）：

- `tools/verify.sh:225` 的失败分支现在连打三段：`"$CHROME" --version`、`CPID` 那个进程还活着没、
  它自己 stderr 的前 60 行；读不到日志文件时明说读不到，而不是静默。
  这一格是**行内替换**，`verify.sh` 仍是 468 行——上面那张腿表引用的 `:236-243 / :265 / :443-465`
  一根没漂（行号是证据，插一行就漂一批）。
- `.github/workflows/ci.yml` 末尾追加一条**非门**的 artifact step（`yajilin-verify-logs`，收 `verify.log`
  与 `_tmp-verify/`）。它 `if-no-files-found: ignore` 是故意的：证据缺失不该制造第二根红，
  红不红由上面那两步判。同样是末尾追加，`.github/workflows/ci.yml` 的
  `:13 / :15 / :26-42 / :62-64 / :65-87 / :76 / :89-114 / :138-148`
  那些被引用的行号都在插入点之前。

### 那一红读了自己的日志，一句话报出根因（runner 上 profile 路径顶穿 socket 上限）

上一节那三段现场证据在第二次红时真的被读出来了。CI 的 `verify.log` 里躺着：

```
FATAL:process_singleton_posix.cc:313] Socket path too long:
/home/runner/work/z-biz-game-yajilin-cos/z-biz-game-yajilin-cos/_tmp-mk/com.google.Chrome.1TYGLP/SingletonSocket
CPID=2380 alive=no
```

`--user-data-dir` 里的 `SingletonSocket` 是一个 **Unix domain socket**，全路径上限 108 字节；
runner 的 workspace 根本身就 76 字节，再加 `_tmp-mk/tmp.XXXXXXXXXX/SingletonSocket` 一定顶穿。
更难看的是那条 fallback：Chrome 嫌路径长，就在**系统的 temp 目录**里新建一个
`com.google.Chrome.XXXXXX` 再试一次——而我把 `TMPDIR` 指进了 `$HERE/_tmp-mk`，于是 fallback
落在同一条长路径上，第二次还是超长，直接 `FATAL` 自杀（`CPID alive=no` 就是这么来的，
跟"runner 拉不起 Chrome"或"端口被占"都没关系，那条 120×0.5 s 的等待也没资格被怀疑）。

修法是 `tools/verify.sh:36-39` 把 temp 根按平台分开：Darwin 仍用 `$HERE/_tmp-mk`（本机 `/tmp`
会被中途清掉，那是这条注释存在的原始理由），非 Darwin 用 `/tmp`（CI runner 不会中途清，
而短路径在那里是硬要求）。`tools/verify.sh:209-210` 的注释跟着改口，`:211` 那句
`UDD=$(mktemp -d -p "$TMPDIR")` 一字未动——它现在在 Linux 上自然拿到 `/tmp/tmp.XXXXXXXXXX`，
socket 全路径 40 字节上下。**判据一根没动**：本机复跑 `bash tools/verify.sh` 在那一趟是
283 条浏览器断言、红 0、ALL GREEN（菜单那轮之后同一趟读成 288，见上面那张腿表），三条腿的 profile 依旧各是新造的（本轮实测
`_tmp-mk/tmp.K0dB54CqwS` / `tmp.aV2XnWPahq` / `tmp.pP5rYI6o1L`），四行改动全是行内替换、
`verify.sh` 仍是 468 行，上面那张腿表与 `:236-243 / :265 / :443-465` 一根没漂。

这一类的账要一次算清：`grep -rln 'export TMPDIR' */tools/verify.sh` 在本 workspace 的
53 份 `verify.sh` 里只命中这一份——其余各仓的 profile 都是裸 `mktemp -d`（落 `/tmp`）或
`mktemp -d -t <前缀>`，天然短。也就是说这个缺陷不是家族病，是我上一轮为了"证物别被系统清掉"
把 TMPDIR 收进仓里时**只在 macOS 上验过**带出来的，所以修也只在这一个仓修。
教训写在这里而不是只写在 commit 里：一条只在本机验过的路径策略，到了另一种机器上就是一条
新的红，而它红的地方（浏览器腿）恰好是最不像"路径问题"的地方。

### 第二红：socket 那一关过了，runner 立刻露出它一直藏着的下一件事

同一个 commit 的 runner 日志（run 36463860182 / browser job 109068885757）先给了好消息：
`chrome: :9378 "Browser": "Chrome/153.0.8010.52" profile=/tmp/tmp.1BkQFQKgIG` —— 短路径生效，
root 腿九场 118 条断言全过（那一趟的读数；菜单那轮之后是 120）。然后一句 `rm: cannot remove '/tmp/tmp.1BkQFQKgIG/Default':
Directory not empty` 把整趟带停，`prefix 腿跑了 0 场`、`mobile 腿跑了 0 场`。

根因是两条各自合理的东西撞在一起：`start_chrome` 换 profile 前要先删上一条腿的
（`tools/verify.sh:205-208`），那里 `kill "$CPID"` 只保证父进程收到信号，Chrome 的
crashpad/zygote 子进程还在往 `Default/` 里收尾；`rm -rf` 一边 `readdir` 一边有文件被创建，
POSIX 给的正是 `ENOTEMPTY`。本机不炸是因为 macOS 上 Chrome 退出得更干脆。**真正把这条腿打死的是
`tools/verify.sh:19` 的 `set -euo pipefail`**：一条"删不干净"的清理语句按 shell 的规则就是非零，
非零就退出——于是它越过了"清理失败不该影响判据"这条界线。

修法两处，都在原行内改（`verify.sh` 仍 468 行，`:211 / :214-216 / :220-224 / :225` 一个没漂）：
`:207` 变成"最多重试 6 次、每次隔 0.25 s，之后若还有残留就打一行 `note`，绝不退出"；
`:194` 的 `cleanup` 同理加 `|| true`。这里要说清**为什么删不净不削弱承诺**：这一腿的"全新
profile"是由 `:211` 的 `mktemp -d` 给一个新路径来担保的，不是由"上一个目录被删掉了"担保的，
残留只占 runner 那块临时盘。把这条写下来是因为它正好是会被顺手写成 `exit` 的那种地方——
用一个判据之外的失败去红，比用一个判据之内的失败去绿更糟。

顺带记一笔这一红能读出来的原因：`tools/verify.sh:443-465` 那条汇总地板规定"每条腿的场数
必须等于场景表里该有的场数、零断言的场直接红"。0 场就是被它点名的（`prefix 腿跑了 0 场，应有 9 场`），
而不是被"退出码非零"这种含糊话糊过去的。地板门这轮第二次付账（第一次是上面那三段现场证据）。

---

## 四、证人不等于梯级：P10 与 `allReachable(-1)`

`P10-cut-vertex`（环不能被掐断）在**全部 64 张出货盘上命中 0 次**（本轮逐档实测
P10:0 / P10:0 / P10:0 / P10:0，见 `README.md` 第三节的规则命中口径）。
它的真实职责是**健全性证人**：`js/engine/pencil.js:215` 那条
「必上环的格已经分家（前面的推导不兼容）」的矛盾分支一触发，就说明前面某条规则推错了——
证人说话的方式是「揭穿」，不是「推进」。

区分这两类东西，靠的是把它写成一条**会变的红线**，而不是一句注释：

- 剂量表把「P10 命中盘数」断言成 `=== 0`（`tools/generator-probe.mjs:82`），
  注释点名「它不是难度梯级，别把它算进『用到的规则数』」；
- 铅笔单测里有一个 P10 专项，用一张**实证无解**的 6×4 箭头墙正面证明它能发火
  （`tools/pencil-test.mjs:217-225`），再扫 20 张出货盘要求证人分支 0 次触发、
  发火 0 张（`tools/pencil-test.mjs:229-238`）；
- `README.md` 第三节那张表里的「用到规则条数」因此**不含** P10，
  这条排除是源码自己要求的（`js/engine/pencil.js:17-19`）。

同一套区分用在别处：`capped` 是正常出口（「数到 2 个就收工」），`stopped` 才是缺陷
（`js/engine/counter.js:139-141`）；`stuck`（铅笔没解完、没跑计数）与 `over`
（真跑了计数但预算耗尽）是两个账本字段，不许合成一个（`js/engine/generate.js:96-99`）。
把证人当梯级、把缺陷当出口，都是同一类谎。

---

## 五、这一族的红线：红了只能变强，不能变宽

下面四条红线都属于「变宽就等于把门禁关掉」那一类，所以它们的写法一律是
**等式或零**，不是阈值：

| 红线 | 写法 | 出处 |
|---|---|---|
| 每档必须满额出货 | `recs.length === N`（不是 `>= N * 0.9`） | `tools/generator-probe.mjs:78` |
| 铅笔矛盾 / 推错角色 / 挖完不全解 都必须是 0 盘 | `contra === 0`、`badRole === 0`、`stillBad === 0` | `tools/generator-probe.mjs:79-81` |
| 每一次删除复核都必须在预算内数完 | `stoppedSeen === 0` | `tools/generator-probe.mjs:83` |
| P10 命中盘数必须仍是 0 | `hits['P10-cut-vertex'] === 0` | `tools/generator-probe.mjs:82` |

另有两条「只许变严」的机制值得点名：

- **规则名字符串是承重墙。** `RULES` 那 10 个字符串本身被写成断言
  （`tools/pencil-test.mjs:140-142`），改名或换序 = 历史读数全部作废 = 当场红。
  剂量表按**名字**统计命中盘数（`tools/generator-probe.mjs:73-74`），
  UI 的规则台座也用同一批字符串当 key（`js/ui/game.js:34-35`）。
- **golden 快照的两种模式在源码层分开。** `write-golden.mjs` 被 import 时只暴露
  `produceRecord` / `FIXES`，只有 `--check` 或显式冻结才写盘（`tools/write-golden.mjs:76` 那道
  `IS_MAIN` 护栏、`tools/write-golden.mjs:119` 的分派）。这一条是修出来的：曾经
  `golden-test` 一边判红、一边把快照写回去（`1c671a6` 提交前的空 import 挡块），
  等于被测者自己改标准答案。本轮 `golden-write` 读数是
  `ok=true checks=7 fails=0（--check：冻结快照与活引擎逐字一致，全程只读）`。

**本轮没有为了让文档好看而改动任何一条判据。** 找到的几处「代码/门禁的散文与事实不符」
一律原样列出，交给上游处理（见下一节）。

---

## 六、测量口径：墙钟只当观测值，负载必须同框

`js/engine/*` 一个环境变量都不读，也不碰 `Math.random` / 时钟（由
`tools/check.mjs:53-70` 那扇门在源码层打死）。于是**测量口径只能属于调用方**：
`tools/generator-probe.mjs:19-23` 用 `N` / `ATTEMPTS` / `FRACS` / `SIZES` 四个环境变量把口径
显式传给引擎，默认值就是那张剂量表（`N=16 ATTEMPTS=60 FRACS=0.45,0.5,0.55 SIZES=6x6,8x8,10x10,12x12`）。

墙钟的处理纪律有两条，都写在源码里：

1. 起跑与收尾**各打一次** `os.loadavg()`，并把机器型号与核数一起打出来
   （`tools/generator-probe.mjs:45`、`tools/generator-probe.mjs:107`），
   收尾那行直接注上「墙钟是这趟负载下的观测值，不是最坏值」；
2. 每个统计量旁边附**逐样本分布**（`tools/generator-probe.mjs:86-97` 打的 med/p95/max 之外，
   本轮另在 workspace 根的临时脚本里把 16 个样本逐个列出）。理由见 `README.md` 第三节：
   12×12 的 med 与 p95 差 2 倍不是抖动，是 `attempts` 从 1 涨到 55 的必然结果。

本轮的实证：同一批盘（同一批 tag，`js/engine/generate.js:145`）在四次独立运行里
**确定性量逐字相同**（nodes 90/298、212/1349、344/6474、1623/4250；箭头 med 11/19/30/44；
12×12 那 16 颗的逐样本 attempts `[1 1 4 4 16 16 17 25 25 25 26 35 40 43 44 55]` 与
逐样本箭头 `[40 41 … 48]` 每次都逐项相同），而 12×12 的 p95 在这四趟里读成
1248 / 1254 / 1266 / 1342 ms（起跑负载 3.95 / 2.74 / 3.07 / 4.79），8×8 读成 39~43 ms。
所以文档里凡是引用墙钟的地方都写成「本轮观测」，不写成上界。
（`tools/generator-probe.mjs:12` 那句「同一段代码在 load 30 的机器上能慢 30% 以上」
是这一族的经验，本轮负载 3~4、没有复现过 load 30，所以 `README.md` 只报观测值、不换算成最坏值。）

还有**另一台机器**，它的性质和上面那四趟不同：CI runner（2 核 ubuntu-latest，load1 0.82）
在同一批 seed 上把 12×12 读成 p95 2985 ms、把 10×10 读成 458 ms（run `36463860182`）。
这一趟不是「负载更高所以更慢」能解释掉的——负载比本机低、核数少一半，而它是**产品边界**的证据：
一个跑在 Pages 上的游戏不能按我这台 15 核机器的秒数来承诺等待时间。由此产生的降级写在 §七。

---

## 七、档外那一格：菜单顶档回到 10×10，12×12 留在表里

### 决定与它的账

`TIERS` 有四行，菜单只有三行（`js/engine/generate.js:35-40`）：12×12 于 2026-09-29 降出菜单
（`inMenu: false`），顶档回到 10×10。起因是 B6 那条**绝对值**线（菜单档 p95 ≤ 2000 ms，
`tools/balance.mjs:47-51`）在 CI 上红了。同一批 seed、同一套默认值、同一个判据，两台机器两种下场：

| 档 | 本机 med / p95（15 核，load1 2.74~4.79） | CI runner med / p95（2 核 ubuntu-latest，load1 0.82） | 线内？ |
|---|---|---|---|
| 6×6 | 1 / 7 | 4 / 25 | ✓ |
| 8×8 | 7 / 43 | 22 / 76 | ✓ |
| 10×10 | 49 / 208 | 111 / 458 | ✓ 两边都在线内 |
| 12×12 | 620 / 1254 | 1419 / **2985** | ✗ 本机线内、runner 线外 |

本机那列是本轮 `node tools/generator-probe.mjs` 那一趟（同一批 seed 四次复跑的 p95 是
1248 / 1254 / 1266 / 1342 ms，线内但离 2000 只剩一线）；runner 那列出自 run `36463860182` 的 node job
（109068886304，就是 `tools/balance.mjs` 那条独立 step）。这两列不是同一把尺子的两次读数，
是**同一句承诺在两台机器上的两种命运**：产品是发布到 Pages 上的，玩家那台机器我不认识。

当时桌前有四个选择，前三个都记在这里，因为它们都是下一次复跑就能推翻的谎：

1. **把 2000 ms 换成"按本机同趟参照归一的倍数"**——需求卡第一节明确要「给绝对值，不给倍数」；
   而且一条会随机器变宽的线不是门，是化妆。否。
2. **让 B6 一直红着，等流水线变快**——长期红的 CI 就是把"红"变成背景噪音，下次真出事没人看。否。
3. **先去优化 12×12 的生成路径**——那是另一轮工程（换环策略、`candLimit`、挖线索顺序都在动），
   用它当这次改菜单的理由，等于承诺一个还没量出来的东西。否。
4. **把 12×12 请出菜单**——玩家选不到 ⇒ 这句话不再是对玩家的承诺 ⇒ B6 判的那三档在两台机器上
   都在自己钉的线内。它不动任何一条判据、不动任何一个数，动的只是"卖什么"。做了。

### 降级自己也要有代价：B6b 是防降级门

「缩产品让门变绿」是一条谁都会走的下坡路，所以这次的代价写在判据里而不是文档里：
`tools/balance.mjs:206-211` 的 B6b 断言**菜单顶档面积不得小于 10×10**，红句照直说
「再往下缩就是拿降级躲门：要缩得先改这一行与需求卡，并把 README/DESIGN 那两张梯级表一起改」。
它的方向是单调的：往菜单里加档不红（那是产品变好，加完还得过 B6），往下缩才红。
12×12 也没有从测量里消失——`tools/balance.mjs:213-215` 每轮照打一行档外读数
（本轮 12×12：p95 1266 ms、表定 budgetMs 4780 ms、出货 16/16），只是不当门用。

### 存档不打折：`parseSize` 为什么还认 12×12

菜单是「新开一局能选什么」的边界，不是「这台机器上存在过的盘」的边界。玩家存档里可能已经有一局
12×12：把 `parseSize` 夹回菜单三档的话界面会说谎——seed 还是那颗、盘却变成 6×6，
旧笔迹全被指纹对账丢掉（这段理由就写在 `js/ui/puzzle.js:19-24` 的注释里）。
所以「菜单」与「引擎表」是两个东西：`js/ui/puzzle.js:17` 的 `SIZES` 只含 `inMenu` 的那几档，
`js/main.js:530-537` 只渲染前者，而 boot 场把这条边界钉成浏览器断言——下拉里的档位必须逐字等于
`TIERS.filter(inMenu)`、且不少于 3 档（`tools/scenarios.js:439-446`）。这条断言是双向的：
引擎降了档而界面还留着 ⇒ 红（玩家点到一句拿不到货的承诺）；界面自己多列一档 ⇒ 也红。

### 档外的两档：14×14 / 16×16

`js/engine/generate.js:35-40` 那张表里没有它们，`tools/ceiling.mjs` 也不靠 `TIERS` 拿尺寸——
它自己写死了一对档外尺寸（`tools/ceiling.mjs:30`）和四颗**写死的** seed（`cl-<档>-0..3`，不由日期派生），出货默认值一字不改
（`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`，`js/engine/generate.js:27-28`）。
上一版那批数出自仓外的桌面筛探针，clone 出来重跑不了，所以下面这张表换了出处：
表里钉的是 `RECORD`（`tools/ceiling.mjs:53-56`），C1 每轮拿实测值去对**出货 seed、attempts、
PLATEAU 累计**（确定量，逐颗对死）与逐样本墙钟（×[0.4, 3]，只抓量级）。本轮重跑读成：

| 档位 | 出货 | 本轮逐样本墙钟 ms | 钉住的表值 ms | attempts | 累计废因 |
|---|---|---|---|---|---|
| 14×14 | **0 / 4** | [3442 3131 3157 3407] | [3229 2983 3072 3131] | 颗颗 60/60（撞封顶） | PLATEAU 240 |
| 16×16 | **0 / 4** | [4694 5540 5252 5772] | [4462 5283 5076 5546] | 颗颗 60/60（撞封顶） | PLATEAU 240 |

三件事一起成立才叫「越线」，本轮三件都成立：**出不了货**（0/4，八颗 seed 全部撞满 60 次换盘）；
**墙钟进到秒级**（八颗全部越过房子口径 2000 ms，`tools/ceiling.mjs:33-40` 那两行绝对值就是按这个判的）；
**参照批仍在线内**（同一趟现量的菜单顶档 10×10 六颗 seed ⇒ C3a 打印的 p95 384 ms ≤ 2000 ms）。

**唯一废因仍然只有 PLATEAU**（`pSet` 推不到全解，`js/engine/generate.js:150`），
`COUNTER` 一次都没出现——也就是说这两档**根本没走到认证计数那一步**
（`js/engine/generate.js:155`）。上一版的说法是「三张出货盘的 nodes 1272 / 4695 / 6010，
仍远小于 `CERT_BUDGET_NODES = 5_000_000`」（`js/engine/generate.js:32`）；
这一版更干净：卡住档位的是自由度 1 与 2，DP 那一侧连出场机会都没有。
⇒ C2 那条判据（废因不许出现 PLATEAU 以外的东西、认证计数不许 stopped）本轮为绿。

菜单三档的降级路径是**已经写进产品**的那一条：撞满 `maxAttempts=60` ⇒ `shipBoard` 如实返回
`NO_BOARD`（`js/engine/generate.js:171-174`），界面最多再敲 8 颗自己 mint 的 seed
（`js/main.js:26-28`、`js/main.js:254-264`），全失败就把 `NO_BOARD` 与试了几颗照直说出来
（`js/main.js:261-264`），并且明确「调用方给了明确 seed 时不许偷偷换」
（`js/ui/puzzle.js:32-35`）。本轮菜单三档观测到的最坏 attempts 是 6 / 11 / 32（6×6→10×10），
一次都没撞穿封顶——**这条路径不是「保证出得了盘」**，`README.md` 也因此没把它写成承诺。

---

## 八、门禁覆盖不到的地方（也就是本文件不许越界说的话）

- **手感与美术**：浏览器闸只有三种证据——DOM 矩形与文本、画布像素、真指针读数
  （`tools/scenarios.js:5-8`）。它能证「画出来了 / 点得到 / 说的和判的一致」，
  证不了「好用」。`tools/shots/*.png` 是给人看的旁证，**不参与判定**
  （只有绿的场才落盘：`tools/verify.sh:174-179`）。
- **线索最少**：`pDig` 是四趟贪心 + 前置过滤，本轮每盘进入复核的箭头 med 只有 1–2 条，
  多数箭头从未被计数器正面拒绝过（`js/engine/generate.js:103`、`js/engine/generate.js:112`、
  `js/engine/generate.js:121`）。极小只在「单颗摘除」的意义上成立。
- **跨引擎可比的分数**：全仓唯一的 `score` 是 `pSet` 内部的贪心键
  （`js/engine/generate.js:42`），没有任何一处把它当难度或成绩输出。
- **线上形态**：腿 6 本轮没打（要网络），`tools/verify.sh:402-424` 写明它读的是 Pages
  真部署过的那份字节，本地那棵替身根替代不了这一条。
- **最坏情况**：本轮 64 张出货盘 0 次「60 试全废」只说明这一批没撞封顶，
  不构造成「最坏 1.2 秒」这种承诺。
- **源码注释里的仓外路径**：`js/engine/*.js` 的注释里有 8 处 `_tmp-yajilin-*.mjs:行号`（`tools/counter-test.mjs:3`、
  `tools/reference.mjs:2` 另有 2 处，同样在仓外），另有
  `js/engine/grid.js:4` 提到「需求卡」。这些指的是**桌面筛选期的探针**和这一仓的立项卡，两者都
  没随仓发布（探针留在工作区根，且被 `.gitignore:8` 的 `_tmp-*` 规则挡在门外）。所以它们是
  **溯源记录**，不是 clone 之后点得开的链接——Clone 出来的仓里读不到，也不该读到。
  反过来，本仓自己那条规矩只约束文档：README/DESIGN 里每一处 `文件:行号` 都指本仓的文件，
  本轮用 `_tmp-cite-check.mjs`（仓外探针，同上）对两份文档逐条解析过：279 处引用，
  文件不存在的 0 处、行号越界的 0 处。
