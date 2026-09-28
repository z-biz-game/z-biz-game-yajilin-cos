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
   （`tools/check.mjs:39-46`，本轮 23 个文件）；
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
   （`tools/check.mjs:17-24`），本轮逐套 48 / 435 / 71 / 7 / 156 / 24，聚合 102，红 0；
   口径提醒：`tools/check.mjs:17-24` 的 `SUITES` 数组与 `tools/verify.sh:265` 的 `need` 列表都是六条，
   `tools/verify.sh:245` 那行 echo 也念「六套」；而 `tools/verify.sh:241`、`.github/workflows/ci.yml:13`、
   `.github/workflows/ci.yml:15`、`.github/workflows/ci.yml:104` 这四行**注释**仍写着「五套 / five suites」。
   核对过历史：这四行不是后来漂走的——引入六条 `SUITES` 的那颗提交（`65602f7`）里，
   `ci.yml` 就已经写着「five suites」，`verify.sh` 晚些写成时又抄了同一句旧话（`git show 65602f7:tools/check.mjs`
   的 `SUITES` 已是六条，`git show 65602f7:.github/workflows/ci.yml` 第 14 行是 five suites）。
   判据本身（数组、`need` 列表、行数等式）从没变少，错的只是注释。本轮以实跑的 7 行 RESULT（六套 + 聚合）为准；
   注释与判据不符这件事已单独上报，没有为了让文档好看去动它。
5. **数 RESULT 行数**：每套自己那行 `RESULT <name> ok=… checks=… fails=…` 原样再念一遍
   （`tools/check.mjs:118-122`），并且 `got.length === SUITES.length`（`tools/check.mjs:124`）。
   为什么行数要单独数：`tools/check.mjs:8-9`——套件被改名、被漏跑、spawn 失败但退出码没传上来，
   这三种都表现为「绿了，但少跑了一套」。CI 那一侧**再独立数一遍**
   （`.github/workflows/ci.yml:65-87`，缺行即红），理由是「check.mjs 内部也断言六套全到，
   但那是被测者自己数的」（`.github/workflows/ci.yml:62-64`）；
6. **分层闸**：CI 里两条 grep 把「`js/` 不许 import `tools/`」「运行时产物不许引用 `tools/` 下的任何测试资产」
   钉死（`.github/workflows/ci.yml:26-42`）。这不是洁癖：`tools/golden.mjs` 冻结的是每张出货盘的
   **认证解**，一旦它进了 Pages 产物，答案就在公网上，而「被测的字节就是出货的字节」这句话
   立刻不可证伪。

### 浏览器侧：六条腿各断言什么

`tools/verify.sh` 只管生命周期，**一条判据都不在这个文件里**
（`tools/verify.sh:13-14`：判据一律在 `tools/scenarios.js`；放进来就变成脚本自己给自己打分）。

| 腿 | 断言什么 | 本轮读数 | 出处 |
|---|---|---|---|
| 1 unit | 上面那六套 + 三道静态门 | 7 行 RESULT、741 条断言、红 0、退出码 0 | `tools/verify.sh:241-271` |
| 2 root | 根形态 `http://127.0.0.1:5326/` 上八场真指针 | 9 场 118 条断言 红 0 | `tools/verify.sh:295-308` |
| 3 prefix | Pages 前缀形态（替身根由 symlink 按部署名单搭） | 9 场 118 条 红 0 | `tools/verify.sh:311-339` |
| 4 deploy-list | 名单外的必须 404、名单内的必须 200 | 35 条 404 + 5 条 200 | `tools/verify.sh:341-372` |
| 5 mobile | 390×844 @ dpr3 的 **CDP 会话内**覆写 | 3 场 47 条 红 0 | `tools/verify.sh:380-399` |
| 6 live | 线上真部署那份字节（要网络） | 本轮没打 | `tools/verify.sh:402-424` |
| 汇总 | 腿×场的并表 + 地板判定 | 合计 283 条浏览器断言 红 0，ALL GREEN | `tools/verify.sh:443-465` |

八场的逐场条数（root，本轮）：boot 19 / render 14 / play 14 / marks 15 / resume 8 / wrong 7 / win 8 / hint 14。
`root` 是 **9 场**而不是 8 场，因为场景表写的是 `boot boot render play marks resume wrong win hint`
（`tools/verify.sh:292`）——boot 在同一条腿里连跑两次，第二次的 `performance.timeOrigin` 必须
**严格大于**第一次（`tools/verify.sh:150-152`、`tools/scenarios.js:449-450`）。
这一条专门抓「片段导航冒充重载」：`BASE#expect=` 那种同文档跳转连 JS 上下文都不换，
读数照样「对」，但玩家从来没有真的重载过页面。
`mobile` 只跑与形状有关的三场（boot / render / play，`tools/verify.sh:391`），
19 + 14 + 14 = 47，与本轮读数吻合。

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
（`tools/scenarios.js:445`）——写死的根路径在前缀腿就是死在这条断言上，而不是死在人工报修。

第 4 条腿是第 3 条腿的**反证**：光有「前缀下页面能打开」还不够，必须同时证明
`tools/`、仓库根的 `*.md`、`package.json`、工作流文件在这棵根下**够不到**
（本轮 35 条 404），并且反向要求名单内 5 条真的 200
（`tools/verify.sh:353-372`）——没有后半句，那一串 404 只是因为整棵树都在 404。

汇总腿的地板（`tools/verify.sh:443-461`）同样是为「假绿」写的：
零断言的场景直接红、场景名不在那张八场集合里红（场景表漂了或 `__ng` 少装一个都会这样）、
`root` 与 `prefix` 两条腿**都必须含那八场**（少了就是「浏览器闸只跑了一遍却被写成两遍」）、
总断言数 `< 60` 也红。CI 那一侧再按 `{'root': 9, 'prefix': 9, 'mobile': 3}` 数一遍场数
（`.github/workflows/ci.yml:111-121`）。

还有两条容易漏的「不是断言的断言」：每条腿的控制台里但凡出现 `[EXCEPTION]` 或 `[log:error]`
这一趟就不算干净（`tools/verify.sh:236-243`，本轮三条腿各 0 行），因为 404 与未捕获异常
不会让任何一条断言变红，它只会让玩家看到一张没有样式的盘；每条腿起一个**全新的**
`--user-data-dir`（`tools/verify.sh:205-212`），否则同源 `localStorage` 会串味——
`resume` 场读到的可能是上一条腿留下的存档。

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

本轮的实证：同一批盘（同一批 tag，`js/engine/generate.js:145`）在三次独立运行里
**确定性量逐字相同**（nodes 90/298、212/1349、344/6474、1623/4250；箭头 med 11/19/30/44），
而 8×8 的 p95 读出 40 与 42 ms、12×12 读出 595/1248 与 619/1247 ms，负载分别是 3.39 与 3.95。
所以文档里凡是引用墙钟的地方都写成「本轮观测」，不写成上界。
（`tools/generator-probe.mjs:12` 那句「同一段代码在 load 30 的机器上能慢 30% 以上」
是这一族的经验，本轮负载 3~4、没有复现过 load 30，所以 `README.md` 只报观测值、不换算成最坏值。）

---

## 七、档外那一格：为什么菜单只到 12×12

`TIERS` 到 12×12 为止（`js/engine/generate.js:35-40`）。这不是审美决定，是本轮量出来的：
用**同一套**默认值（`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`）往档外打四颗 seed——

| 档位 | 出货 | 逐样本墙钟 ms | 出货那些盘的 attempts | 累计废因 |
|---|---|---|---|---|
| 14×14 | 3 / 4 | [633 1745 2961 3379] | [10 37 57] | PLATEAU 161 |
| 16×16 | 1 / 4 | [4757 4957 5019 5108] | [59]（封顶 60） | PLATEAU 238 |

三件事一起成立才叫「越线」：出不了货、出货的那些盘贴着封顶（16×16 那颗是 attempts 59/60）、
墙钟已经进到秒级。**唯一废因是 PLATEAU**（`pSet` 推不到全解，`js/engine/generate.js:89`），
不是计数器撞预算（14×14 三张的 nodes 是 1272 / 4695 / 6010，仍远小于
`CERT_BUDGET_NODES = 5_000_000`，`js/engine/generate.js:32`）——
所以卡住档位的仍是自由度 1 与 2，不是 DP 的成本。

档内的降级路径是**已经写进产品**的那一条：12×12 偶尔撞 `maxAttempts=60` ⇒
`shipBoard` 如实返回 `NO_BOARD`（`js/engine/generate.js:171-174`），界面最多再敲 8 颗自己 mint 的
seed（`js/main.js:26-28`、`js/main.js:254-264`），全失败就把 `NO_BOARD` 与试了几颗照直说出来
（`js/main.js:261-264`），并且明确「调用方给了明确 seed 时不许偷偷换」
（`js/ui/puzzle.js:30-33`）。**这条路径不是「保证出得了盘」**，`README.md` 也因此没把它写成承诺。

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
