# 矢仓林 · Yajilin（无灰格读法）

黑格与单环的零猜测推理。盘面每一格**恰好**是三种角色之一（箭头线索 / 黑格 / 环格），
一条不自交的正交环盖住所有「既不是黑格也不是箭头格」的格子——本变体**没有灰格**，
漏掉一格就是错。出货的每一盘都由两条彼此独立的通道各判一次：不回溯的铅笔求解器（P1–P10）
从空盘推到全解，穷举计数器以 `limit=Infinity` 数出「恰好一个解」，
而盘上最终那份答案用的是**计数器那张**，不是出题器自己跟的那张
（`js/engine/generate.js:12-16`、`js/engine/generate.js:158-161`）。

这个文件只写**本轮复跑量出来的事实**。每一个数字后面挂 `文件:行号`；
量不到的事一律进「不承诺」那一节，不写成承诺。

---

## 一、跑起来

零运行时依赖：`package.json` 全文 37 行，顶层键只有
`name` / `version` / `description` / `type` / `private` / `scripts` / `keywords` / `author` / `license`
——没有 `dependencies`，也没有 `devDependencies`（`scripts` 块在 `package.json:7-21`），
不需要 `npm install`。

| 命令 | 做什么 | 出处 |
|---|---|---|
| `npm start` | 本机静态服务，端口 5326（根形态） | `package.json:8`、`server.cjs:64` |
| `npm test` | node 侧总门：语法闸 + 禁词源闸 + seed 源闸 + 六套 suite | `package.json:10`、`tools/check.mjs:1-2` |
| `npm run probe` | 只跑剂量表（成本与选择性的观测） | `package.json:17`、`tools/generator-probe.mjs:19-23` |
| `npm run balance` | 平衡闸：按档量出货墙钟，现算 `budgetMs` / band 并当门判（CI 里有它自己那一步） | `package.json:18`、`tools/balance.mjs:1-18` |
| `npm run ceiling` | 档外天花板：14×14 / 16×16 各四颗固定 seed，与本文 §五 那张表对账。**不进 CI** | `package.json:19`、`tools/ceiling.mjs:1-18` |
| `npm run verify` | 全闸：node 腿 + 真 Chrome + 真指针的六条腿 | `package.json:20`、`tools/verify.sh:1-2` |

端口 5326 / 5327 / 9378 是一批数，写死在 `server.cjs:64-65`、`tools/verify.sh:28-30`、
`tools/playtest.cjs:32`。这三个号漂移的代价不是「连不上」而是「连上别人家的盘」，
所以 `tools/verify.sh:71-77` 在起跑前逐个做空号预检，占了号就直接 `exit 2`。

---

## 二、玩法：四条规则，逐条能从源码指出

规则的**真值审计器**只有一个：`verify(b)`，返回错误数组，空数组就是合法盘。
UI 判胜走的就是它，没有第二套判定（`js/ui/game.js:8-9`、`js/ui/game.js:306-309`、
`js/main.js:166-187`）。

| # | 规则 | 源码对应处 | 违反时 `verify()` 说的话 |
|---|---|---|---|
| 1 | 每格恰好三种角色之一：箭头格 / 黑格 / 环格 | `js/engine/model.js:13-17`（三种角色计数 `roles`） | ★ `cell 0 既不在环上也不是黑格/线索`（`js/engine/model.js:16`）、`cell 0 同时是多种角色`（`js/engine/model.js:15`） |
| 2 | 全部环格连成**一条**不自交的正交环，且盖住所有非黑非箭头格 | 边端点必须在环上 `js/engine/model.js:20-25`；每个环格度数恰为 2 `js/engine/model.js:26-29`；沿环走一遍并核对覆盖数 `js/engine/model.js:31-46` | ★ `环只覆盖 14/20 格（不是单一环）`（`js/engine/model.js:45`）、`环格 5 度数 1≠2`（`js/engine/model.js:28`）、`环在 12 处自交`（`js/engine/model.js:41`） |
| 3 | 任意两个黑格不得共边（黑格**可以**贴着箭头格） | `js/engine/model.js:18` | `黑格相邻 3-4`（`js/engine/model.js:18`） |
| 4 | 箭头 `(格, 方向, N)`：该方向射线（不含自己，一直到盘边）上的黑格数恰好 N | `js/engine/model.js:47-51`；射线 `js/engine/grid.js:35-39`；方向表 `js/engine/grid.js:10-15` | `线索 7(left,0) 实数 2`（`js/engine/model.js:50`） |

★ 标出的两句是本轮浏览器闸里**逐字读回**的原句（`play` 场的 `firstErr` 与 `wrong` 场的
`errs[0]`，见第六节）；其余几句是模板形状——格号、方向名与实际数出来的个数由
`js/engine/model.js` 那几行在运行时填进去，本轮没有对应盘出现。

第三条的「黑格允许贴着箭头格」是**写死成断言的**，不是默认如此：
`tools/rule-test.mjs:71-74` 正面要求示范盘里出现「黑格挨着箭头格」并且 `verify()` 全绿。
理由写在 `tools/rule-test.mjs:8-9`——将来谁顺手加一条「黑格不许挨箭头」的约束，
会把整档难度梯子悄悄推倒，而没有任何一条测试会因此变红。

玩家侧的三条动作（画环段 / 涂黑 / 画排除叉）与「提示」共用同一个写入者：
`js/ui/game.js:329-340` 落笔仍然只经 `setEdge/setRole`，所以提示的每一笔都进撤销栈、
在 `moves` 上记一步（`js/ui/game.js:141`、`js/ui/game.js:177-178`）。
「环上格」不在玩家的笔表里，它是从画下的边推出来的（`js/ui/game.js:5-6`、
`js/ui/game.js:292-304`），所以 UI 不可能在「我标了它在环上」和「环根本没连到它」之间各说一套。

---

## 三、菜单档位表：三档进菜单，第四档量着但不给选

下拉框列的是 `TIERS` 里 `inMenu: true` 的那三档（6×6 / 8×8 / 10×10），一处定义三处用
（`js/engine/generate.js:35-40` → `js/ui/puzzle.js:17` → `js/main.js:530-537`），默认 6×6
（`js/main.js:25`、`js/main.js:537`）。**12×12 仍在这张表里被剂量表与平衡闸逐轮量着，只是从菜单摘掉了**：
新开不了，但玩家存档里那一局照旧续得上（`js/ui/puzzle.js:21-24` 的 `parseSize` 按整张 `TIERS` 解析）。
为什么摘、代价是什么、以后想塞回来要动哪几行——都在 DESIGN 第七节，本节只报读数。

### 本轮读数

口径：`N=16`、`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`，全部走出货默认值
（`js/engine/generate.js:27-32`、`tools/generator-probe.mjs:19-23`）。
机器 Darwin 25.6.0 arm64、15 核；`vm.loadavg` 起跑 `2.74 / 3.08 / 2.37`、收尾 `3.07 / 3.14 / 2.40`。
**墙钟一列只当观测值**，理由见下面第三段。

| 档位 | 出货 | 墙钟 ms med/p95/max | 计数器 nodes med/max | 箭头 med [min–max] | 黑格 med | 环格 med/总格 | 铅笔轮 med/max | 推导步 med | 换盘尝试 med/max | PLATEAU 废盘数 | 用到规则条数 med |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 6×6 | 16/16 | 1 / 7 / 7 | 90 / 298 | 11 [9–13] | 8 | 16/36 | 5 / 8 | 54 | 1 / 6 | 12 | 7 [5–7] |
| 8×8 | 16/16 | 7 / 43 / 43 | 212 / 1349 | 19 [16–21] | 13 | 32/64 | 7 / 10 | 98 | 2 / 11 | 38 | 8 [7–8] |
| 10×10（菜单顶档） | 16/16 | 49 / 208 / 208 | 344 / 6474 | 30 [24–34] | 22 | 50/100 | 8 / 17 | 157 | 5 / 32 | 111 | 8 [7–9] |
| 12×12（档外，量着不卖） | 16/16 | 620 / 1254 / 1254 | 1623 / 4250 | 44 [40–48] | 32 | 66/144 | 9 / 16 | 219 | 25 / 55 | 361 | 8 [7–9] |

出处：出货率与红线判定 `tools/generator-probe.mjs:78`（`recs.length === N` 才算绿）；
墙钟/节点/箭头/尝试的打印口径 `tools/generator-probe.mjs:86-97`；
轮数与步数 `tools/generator-probe.mjs:102-106`；PLATEAU 账本来自
`js/engine/generate.js:150`（`pSet` 不是 `PENCIL_SOLVED` 就把该状态记进 `dead` 并换盘）。
「用到规则条数」是逐盘统计**至少发火一次**的规则条数（P10 全表 0 次，故不计入，
理由见 `js/engine/pencil.js:17-19`）。

### 三条必须一起读到的话

1. **聚合数会说谎，所以每档都附了逐样本分布。** 12×12 那 16 颗 seed 的换盘次数排序后是
   `[1 1 4 4 16 16 17 25 25 25 26 35 40 43 44 55]`（med 25 / max 55，上限 60），
   同一批的墙钟排序后是 `[16 37 74 85 455 474 527 643 646 726 779 926 1197 1286 1292 1342]` ms。
   中位数与 p95 之间的 2 倍差不是「性能抖动」，是**流水线在换环**
   （`js/engine/generate.js:144-145`：`attempt` 递增 ⇒ 重新 `generate()` 一条新环）——
   换环 ≤4 次的那四张落在 16~85 ms，换环 40 次以上的那四张落在 1197~1342 ms——
   两条尾巴是同一批 seed，只是各自排序后对在一起看；attempts 是确定量，复跑同批 tag 就能逐颗追回（墙钟不能）。
2. **确定性量在复跑里逐字相同**：nodes med/max `90/298`、`212/1349`、`344/6474`、`1623/4250`，
   箭头 med `11/19/30/44`，轮 med `5/7/8/9`，步 med `54/98/157/219`，PLATEAU `12/38/111/361`
   在本轮那三趟里逐字相同（`npm run check` 里跑的剂量表、单独跑的 `npm run probe`、workspace 根
   的分布脚本），并且与上一轮的读数也相同（同一批 seed、同一批 tag `pg-<档位>-<序号>`，
   `js/engine/generate.js:145`、`js/engine/model.js:92-93`）；逐样本的 attempts 与箭头分布
   （`[40 41 42 43 43 43 44 44 44 46 46 46 46 47 47 48]`）也逐项相同。
3. **墙钟不是。** 同一批 16 颗 seed、同一台机器，12×12 的 p95 在本轮四次复跑里读成
   1248 / 1254 / 1266 / 1342 ms，起跑负载分别是 3.95 / 2.74 / 3.07 / 4.79——
   所以本表只报观测值，不报上界，理由写进 `tools/generator-probe.mjs:12`
   与收尾那行负载打印 `tools/generator-probe.mjs:107`。
   **另一台机器是 CI runner**，它是这次降级的直接证人：run `36463860182` 的 node job
   （2 核 ubuntu-latest，load1 0.82）读到 6×6 `4/25`、8×8 `22/76`、10×10 `111/458`、
   12×12 `1419/2985` ms（med/p95）。同一条 2000 ms 的绝对值线（`tools/balance.mjs:67`），
   10×10 在两台机器上都在线内，12×12 在本机线内、在 runner 线外——线不变，那就只能改菜单。
   账与代价写在 DESIGN 第七节。

### 12×12 的题面比印刷题密，这是买「零猜测」的价（这一档现在在档外）

本轮实测 12×12 箭头 med 44、黑格 med 32 / 144 格（箭头占 30.6%），
逐样本箭头 `[40 41 42 43 43 43 44 44 44 46 46 46 46 47 47 48]`。
这是「铅笔零猜测能推完」换来的密度，**不要读成标准 Yajilin 印刷题密度**
（口径已在源码里披露：`js/engine/generate.js:17-19`）。密度与档位在数学上无关：
它仍是每一档的固有代价，只是 12×12 现在不卖给玩家，这一格留给存档续局与后续复测。

---

## 四、三条承诺

### 承诺 1：唯一解由**独立的**穷举计数器在预算内数过

出货前的最后一道计数是 `countSolutions(b, { limit: Infinity, budgetNodes: 5_000_000, collect: 1 })`，
`count !== 1` **或** `stopped === true` **或** 没收到解 ⇒ 整盘作废（`js/engine/generate.js:155-157`，
预算常量 `js/engine/generate.js:32`）。

关键在于 `stopped` 与 `capped` 是两个字段，不许合并成一句「≥N 解」：
`js/engine/counter.js:104` 在节点数超预算时置 `stopped` 并直接回传（`js/engine/counter.js:142`），
`js/engine/counter.js:112` 在解数达到 `limit` 时置 `capped`，两者语义在
`js/engine/counter.js:7-8` 写成红线、在 `js/engine/counter.js:139-141` 再解释一遍。
本轮 12×12 的最坏单盘计数节点是 4250，预算是 5 000 000，差三个数量级。

计数器本身是**另一台机器**：它按行主序枚举每个非线索格的角色（黑 / 环 + 环格的两侧形状），
连通性用「开放端计数」封住（`js/engine/counter.js:1-5`），
回滚一律走记录旧值的日志栈而不是手写逆操作（`js/engine/counter.js:55-56`）。
它自己还要被暴力枚举器对账：本轮 `5×5 比对：AGREE 12 MISMATCH 0 ZERO-BUT-SOLVABLE 0 SKIPPED 0`，
DP 节点 max 825，暴力+DP 墙钟 max 1 ms（判据 `tools/counter-test.mjs:60-63`，
打印口径 `tools/counter-test.mjs:84`，枚举器本体 `tools/reference.mjs`）。

`pDig` 里每一次「删一颗线索」的复核也必须在预算内数完，撞预算的那次删除不许被保留：
判定条件 `js/engine/generate.js:121`（`c && !c.stopped && p.solved && !p.contradiction && c.count === 1`），
账本拆成 `stuck`（没跑到计数）与 `over`（真跑了但预算耗尽）两个数
（`js/engine/generate.js:117-120`、`js/engine/generate.js:96-102`），
红线是本轮 `预算耗尽=0`（`tools/generator-probe.mjs:83`）。

### 承诺 2：铅笔**零猜测**能推到底

`pencil()` 的十条规则只做「人类一眼能看懂的排除」，绝不回溯、绝不猜
（`js/engine/pencil.js:2-12`，规则名表 `js/engine/pencil.js:25`，定点迭代 `js/engine/pencil.js:96`）。
出货要求的是**全解**：`pSet` 只有返回 `PENCIL_SOLVED` 才继续，
`PLATEAU` / `UNSOUND_PENCIL` / `ROUND_LIMIT` 三种状态一律记进废因并换盘
（`js/engine/generate.js:72-93` 的四个出口、`js/engine/generate.js:150`）。
挖完线索之后还要再跑一次铅笔，仍然必须全解才出货
（`js/engine/generate.js:162-163`，返回字段 `stillSolved`），
门禁那一侧的红线是「挖完线索后铅笔仍须全解 = 0 盘不合格」
（`tools/generator-probe.mjs:81`、`tools/rule-test.mjs:150`）。

「零猜测」是**有选择性的**门槛，不是白送的：本轮同一口径下被拒掉的盘数
（PLATEAU）是 12 / 38 / 111 / 361（6×6 → 12×12），也就是说 12×12 想出货平均要试 25 颗
环、最坏 55 颗（上限 60，`js/engine/generate.js:28`）。

铅笔的结论同时是「提示」的唯一来源，也是浏览器闸 `hint` 场的内容审计。
本轮 hint 场（seed `gate-hint-6`，6×6）实测：推导流水 36 条，按提示 36 次**每次都落一笔、各记一步**，
总步数 38（36 次按 + 2 下真指针反写），一路推到底之后 `status().ok === true`；
现场念过的规则集合是 P2/P4/P5/P6/P9，引擎另报 P1/P3 有命中但流水里没露脸，P8/P10 命中 0。
这一段量的四件事分别是「每次按都有新东西」「冲突那一步不落笔但点名是哪条规则」
「提示的笔进撤销栈」「面板读数逐行等于引擎那份账」
（`js/ui/game.js:314-340`、`js/main.js:193-211`、`tools/scenarios.js:1211-1217`、`tools/scenarios.js:1265-1267`）。

### 承诺 3：关于「每颗线索单颗摘除后不再唯一」——代码实际证到的是这些

这一条最容易写成谎，所以按代码原样摊开。

被保留的**每一次**摘除都必须同时过两条闸门：铅笔仍全解 ∧ 独立计数器仍说唯一
（`js/engine/generate.js:95`、`js/engine/generate.js:121`）。
`pDig` 对**全部**箭头逐个试（`js/engine/generate.js:107` 遍历 `board.clue.keys()`），
最多四趟（`js/engine/generate.js:103` 的 `passes = 4`）。

但「摘不掉」有**两种**原因，代码只区分了它们、没有把它们当成同一句话：

- 真跑了复核，发现不再唯一或铅笔不再全解 ⇒ 回滚（`js/engine/generate.js:122`）；
- **压根没跑复核**：这颗箭头改黑之后立刻撞上别的黑格（规则 3 直接违法），
  于是被前置过滤挡掉（`js/engine/generate.js:112`）。

本轮实测第二种情形是多数：每盘「改黑即撞黑格相邻」的箭头条数 med 11 / 18 / 28 / 43，
而该盘总箭头 med 是 11 / 19 / 30 / 44——也就是 6×6 有 11 条箭头里 med 11 条走的是这条
捷径，进入复核的 `tried` 只有 med 1 / 2 / 2 / 2（max 13），实际删掉的 med 是 0 / 0 / 0 / 0。

所以能承诺的形状是：**「留下来的每一颗箭头，要么被复核过且复核说摘掉就不行，
要么摘掉会让两个黑格共边」**。这就是「单颗摘除意义下的极小」，
它不等于「线索最少」，也不等于「每一颗都被计数器的复核正面拒绝过」。
账本字段：`removed / tried / over / stuck / unsound`（`js/engine/generate.js:104-130`，
出口 `js/engine/generate.js:130`）。

---

## 五、不承诺清单

| 不承诺 | 为什么（本轮实测/源码） | 出处 |
|---|---|---|
| **不承诺线索最少** | 极小只在「单颗摘除」的意义上成立，而且是四趟贪心；每盘进入复核的箭头 med 只有 1–2 条，多数箭头是被「改黑即撞黑格相邻」的前置过滤挡掉的，从未被计数器正面拒绝过。本轮 16 盘合计删掉 3 / 6 / 7 / 8 颗箭头。 | `js/engine/generate.js:103`、`js/engine/generate.js:112`、`js/engine/generate.js:121` |
| **不承诺界面手感与美术** | 浏览器闸只认三种证据：DOM 矩形与文本、画布像素、真指针事件读数。它证的是「玩家拿到了什么」，不是「好不好看」。`.hidden`、类名、注释里的意图一概不算证据。 | `tools/scenarios.js:6-9`、`tools/verify.sh:13-14` |
| **不承诺 `score` 可跨引擎/跨盘比较** | 本仓唯一的 `score` 是 `pSet` 内部给候选动作排序用的 `rolesDone*2 + edgesDone`，它只是一个贪心键，没有任何一处把它当难度、质量或成绩输出。 | `js/engine/generate.js:42`、`js/engine/generate.js:85-87` |
| **不承诺菜单外的档能出货** | 仓内复跑器 `tools/ceiling.mjs` 用**同一套出货默认值**（`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`，`js/engine/generate.js:27-28`）打四颗**写死的** seed（`cl-14x14-0..3`、`cl-16x16-0..3`，不由日期派生）：本轮 2026-09-29 实测 **14×14 出货 0/4、16×16 出货 0/4**，八颗 seed 把 60 次换盘机会全部撞满；逐样本墙钟 14×14 `[3442 3131 3157 3407]` ms、16×16 `[4694 5540 5252 5772]` ms（load1 3.21→3.57，15 核，node v26.8.1），**每一颗都越过房子口径 2000 ms**。唯一废因仍是 PLATEAU（两档各累计 240 次），`COUNTER` 出现 0 次——`pSet` 推不到全解（`js/engine/generate.js:150`）就 continue，压根走不到认证计数那一步（`js/engine/generate.js:155`），所以卡的不是 DP 成本。这两批观测值不写回代码：代码里钉的是 `RECORD` 那两张表（`tools/ceiling.mjs:54-55`，14×14 `[3229 2983 3072 3131]`、16×16 `[4462 5283 5076 5546]`），C1 每次拿实测值去对**量级**（×[0.4, 3]）而不是逐位相等——复跑器每轮重测，锚只用来抓「机器或流水线变了」。⚠ 更早一版这里写的是「14×14 出 3/4、16×16 出 1/4、那颗 attempts 59/60、墙钟 `[633 1745 2961 3379]`」：那批数出自**仓外**的桌面筛探针（另一段 seed 空间，clone 之后重跑不出来），换成仓内这四颗 seed 就是 0/4——结论方向没变（只会更硬），文档以仓内可复跑的那份为准。现在这三档都不在菜单里（`js/engine/generate.js:35-40`）。 | `tools/ceiling.mjs:45-56`、`tools/ceiling.mjs:110-135`、`js/engine/generate.js:28` |
| **不承诺 12×12 在任何机器上都在线内**（它就是因此被请出菜单的那一档） | 同一个 seed 空间、同一套默认值、同一个判据：本机四次复跑 p95 读成 1248 / 1254 / 1266 / 1342 ms（负载 2.74~4.79，15 核），线内；CI runner（2 核 ubuntu-latest，load1 0.82）读成 **p95 2985 ms**，线外（`tools/balance.mjs:67` 那条绝对值线不动）。菜单顶档因此回到 10×10：本机 p95 208 ms（剂量表那一趟）/ 201 ms（平衡闸那一趟）、runner 458 ms，两台机器都在线内。**降级不等于免责**：12×12 仍被剂量表与 `tools/balance.mjs` 逐轮量（写下这句那一轮 16/16 出货、p95 1266 ms 照旧打印；包络改完之后本机两趟读 1253 / 1394 ms，见 §五），只是 `inMenu: false` ⇒ 下拉框里选不到；而「缩菜单躲门」这件事本身被 B6b 钉住——菜单顶档面积不许小于 10×10（`tools/balance.mjs:226-231`），要再往下缩就得同时改判据、README 与 DESIGN 那两张梯级表。存档里已有的 12×12 那一局照旧续得上（`js/ui/puzzle.js:21-24`）。 | `js/engine/generate.js:35-40`、`tools/balance.mjs:63-67`、`tools/balance.mjs:218-235`、`tools/ceiling.mjs:33-37` |
| **不承诺 P10 是一条难度梯级** | 本轮 64 张出货盘上 P10 命中 0 盘（四档全 0），它的价值是健全性证人。这条被写成红线：命中盘数一旦不是 0 就直接红。 | `js/engine/pencil.js:17-19`、`tools/generator-probe.mjs:82` |
| **不承诺「同一个 seed 永远同一张盘」跨版本成立** | seed→盘 是纯函数（判定路径上没有随机数也没有时钟），但**流水线一改版同一个 seed 就是另一张盘**。存档靠题面指纹对账，对不上就作废旧笔迹并当面向玩家说明。 | `js/engine/generate.js:168-175`、`js/ui/puzzle.js:26-30`、`js/store.js:84-90`、`js/main.js:268-271`、`js/main.js:294-297` |
| **不承诺「最坏 1.2 秒」** | 16 样本里 0 次「60 试全废」只说明这一批没撞封顶，不说明封顶不会被撞。12×12 观测到的最坏 attempts 已经是 55/60（这一档现在在档外；菜单三档本轮最坏 6 / 11 / 32，离 60 还远）。界面侧的降级路径是「再敲一颗 seed」，最多 8 颗，全失败就照直说 `NO_BOARD`。 | `js/main.js:26-28`、`js/main.js:254-264`、`js/ui/puzzle.js:32-35` |

---

## 六、门禁形状（细节见 DESIGN.md）

`node tools/check.mjs` 本轮：7 行 RESULT、741 条断言、红 0。
逐套：rule 48 / pencil 435 / counter 71 / golden-write 7 / golden-test 156 / generator-probe 24，
聚合 check 131（本轮新增的两个工具也被语法门扫到，23 → 25 个文件；套件表 `tools/check.mjs:17-24`，行数与格式判定 `tools/check.mjs:106-124`，
外加产物边界那两条 grep 的 27 项 `tools/check.mjs:126-143`——它们与 CI 用同一个正则，
本仓第一次推上去时 CI 就是红在这一条上，而当时本地全绿）。

`node tools/balance.mjs` 本轮：`RESULT balance ok=true checks=42 fails=0`（16 张/档、
load1 3.22→3.42、node v26.8.1；换到包络口径后又复跑一趟，load1 5.30→9.05、同样 checks=42 fails=0）。它在 CI 里是 `check` job 的一条**独立 step**
（`.github/workflows/ci.yml:89-114`），**不是**第七套 suite：加进 `SUITES`
就得同时改 `tools/check.mjs:17-24`、`tools/verify.sh:265` 的 `need` 列表和上面那些「六套」注释。
它按档现算定价式 **`budgetMs = max(10, ceil(p95 × 4 / 10) × 10)`**（单位 ms，向上取整到 10 ms、地板 10 ms；
绝对值逐档打印，需求卡那条「不许用『中位×2』当基线」在这里落实——`med` 进不了这个式子），
band 用 **`[max(1, floor(med × 0.4)), max(lo + 1, ceil(p95 × 1.6))]`**；两个式子都抄自
兄弟仓的代码（`../z-biz-game-hidato-cos/tools/balance.mjs:96-100`、`../z-biz-game-zebra-cos/tools/balance.mjs:182-186`，
那里判的是 p95 而不是单次 max）。`tools/balance.mjs:36-57` 那张 MEASURED 表钉的是**四趟真实跑**的读数
（一台 laptop + CI runner 上的三趟，一格一趟、不合并），B1/B2 每轮拿实测值去对它的**包络**：
上界取四趟里最狠的那条 p95，下界取最快的那条 med。为什么不能只钉一台机器——同一笔 commit `e7db44f`
在 4 核 runner 上连跑两趟，6×6 的 p95 一个读 36 ms（B1 红）一个读 22 ms（B1 绿），中间一行代码没改；
最小档的墙钟里固定开销占大头（本机 med 1 ms、runner med 4–5 ms），拿 laptop 的绝对值判 runner 量的就不是代码
（12×12 那次降级就是这么来的，见上面承诺表与 DESIGN 第七节）。这条线从此**只增不减**：要挪线只能再添一趟带出处的读数
（哪台机器、哪一趟 run），不许改公式、不许删格：

| 档 | 钉住的 p95（ms，四趟：laptop / ci-a0 / ci-a1 / ci-a2） | 包络 budgetMs（ms） | 包络 band | 在菜单里？ |
|---|---|---|---|---|
| 6×6 | 6 / 25 / 36 / 22 | 150 | [1, 58] | ✓ |
| 8×8 | 38 / 76 / 73 / 95 | 380 | [2, 152] | ✓ |
| 10×10 | 188 / 458 / 470 / 367 | 1880 | [17, 752] | ✓ 顶档 |
| 12×12 | 1193 / 2985 / 2997 / 2346 | 11990 | [227, 4796] | ✗ 档外，仍逐轮量、仍打印 |

⚠ 四件事必须一起读：① N=16 时 p95 **就是**那批样本里的最狠一张（分位数口径沿用
`tools/generator-probe.mjs:26`，所以每一格的 max 都等于它的 p95），这张表偏保守而不是偏乐观；
② 包络把「机器差」从这条线里拿掉了，那「代码变慢」谁抓？——`tools/golden-test.mjs:71`：golden 把每条 seed 的
`stats`（attempts / nodes / rounds / removed / tried / over / passes / steps）连盘带账**逐字**比 JSON，
跨机器、跨引擎恒等，改规则、改计数器、改 RNG 都会在那儿红，不在这儿红；这条线的 4 倍余量因此是**机器类**的余量，
不是给流水线变慢留的口子。③ 本机改完之后复跑两趟，四档 p95 读成 6 / 40 / 197 / 1253 ms（load1 3.22→3.42）与
8 / 45 / 228 / 1394 ms（load1 5.30→9.05）——都是包络线下的观测值，写在这里是为了让下一轮能看见漂移，
不是新的线；B1 那条判据给的是 4 倍余量（`budgetMs` 本身就是包络 p95×4），不是逐位相等；④ **B6 现在只判 `TIERS[].inMenu`
那三档**（本轮最狠一档读 197 / 228 ms ≤ 2000 ms），而 B6b 反过来不许「把一档请出菜单」被当成过关手段：
菜单顶档面积不得小于 10×10，再往下缩就得同时改这一行的判据与 README/DESIGN 那两张梯级表
（`tools/balance.mjs:218-235`），12×12 那行则由 B6 的循环改成一行「档外」读数打印
（`tools/balance.mjs:233-235`）。
这张表现在**只活在 `tools/balance.mjs` 里**，没进 `js/engine/generate.js` 的档位表——
这一轮动档位表只动了 `inMenu` 这个开关（w/h 与出货默认值一根没改），浏览器闸照例整趟重跑了一遍
（条数是每一轮现量的，写在下面第六节那一趟的读数里，不在这里复述），
而且菜单形状本身成了 boot 场的一条新断言：下拉里能选到的必须逐字等于引擎 `TIERS` 里 `inMenu` 的那几档
（`tools/scenarios.js:447-454`）。

`npm run ceiling` **不进 CI**：它是量天花板的，不是门，写进 CI 就变成每天重测一次结论。
本轮 23 条断言、红 0：参照批（菜单顶档 10×10 六颗 seed）现量 p95 384 ms，14×14 / 16×16 仍 0/4 且
颗颗撞满 60 次换盘，八颗逐样本 3131~3407 / 4694~5772 ms，全部越过房子口径 2000 ms。

`bash tools/verify.sh` 本轮 ALL GREEN（退出码 0，日志 `_tmp-yajilin-verify-full-r3.log`；
这一趟跑在改完文件之后的树上，上面那些条数就是它打印的）：
334 条浏览器断言、红 0——
root 10 场 143 条、prefix 10 场 143 条、mobile 3 场 48 条；
九场逐场为 boot 20 / render 14 / play 14 / marks 15 / resume 8 / wrong 7 / win 8 / hint 14 / pause 23
（boot 在同一条腿里连跑两次，所以 10 场 = 这九场 + 第二次 boot）；
两条桌面腿的逐场条数**逐条相同**（pause 都是 23 条、`fs` 都读到 `entered`），这一格是本轮现量的，
不是「两趟都写了 ALL GREEN」；
部署名单腿 44 条 404（口径：`find tools -type f` 的 38 个 + 仓库根 6 个名单外文件；
`tools/` 那 38 个里含闸自己落的 21 张 shots，所以这一格会随复跑变，DESIGN 第七节记着这件事）
+ 名单内 5 条 200；三条腿的控制台异常行数各 0。
汇总门与「少一条腿就红」的地板在 `tools/verify.sh:443-465`。
上面那些 `_tmp-*` 名字是**本机的 scratch 台账**，不住在仓里（`.gitignore:8` 把 `_tmp-*` 整条挡在门外，
DESIGN 第七节写着这条口径）：写在这里是为了让读数有出处，而不是让读者去仓库里找它们。

### pause 场：顶栏那三颗按钮点下去要发生它们写着的那件事（本轮新增）

引擎里早就有一套真暂停（`js/main.js:69` 的 `setPaused`）和一个真全屏开关（`js/main.js:640` 的
`bindFullscreen`），顶栏上也真有 `#btn-pause` / `#btn-fullscreen` 两颗按钮——可是 `tools/scenarios.js`
里那张手写的常显控件名册有 `btn-motion`，偏偏没有这两颗，于是那八场场景一次都没点过它们。后果不是"少测两条"这么简单：
`js/main.js:311-312` 那句「换一局一定在走」的注释、`js/main.js:616` 那三行「—— 暂停：给闸台读的那张脸 ——」
（`get paused()` / `setPaused` / `simClock`）在整个仓里没有任何一处代码为它们担保。

这一场只读玩家拿得到的东西：按钮上的文字与 `aria-pressed`、`document.fullscreenElement`、
`#board-wrap` 的矩形与视口尺寸，加上 `simClock()` 那个正在推进的数（`paused` 只当第三个证人用）。
三句话有硬判据：

1. **暂停是真冻结**：700 ms 之后 Δ 恰好等于 0，不是"变慢了"。
2. **恢复的第一帧不倒灌**：跳幅上界 200 ms 是一个固定余量，不是速度预算——`setTimeout` 从不提前，
   机器慢只会让等待更长，把机器噪声算进跳幅就是在罚机器而不是罚代码。
3. **暂停中换一局，按钮与时钟不许各说各话**：这一条就是 `js/main.js:311-312` 那句注释的台架。

全屏那条腿读的是**焦点**：headless Chrome 里 `Element.requestFullscreen()` 要一次真实的用户激活，
而一个不在最上层的标签页 `document.hasFocus()` 是 false、会被直接拒——两种结局的断言条数不一样。
所以 `tools/playtest.cjs` 给 scenario 那一次求值带上 `userGesture`，并在求值前 `Page.bringToFront`；
进不去的那一支也不是空跑：按钮必须被禁用、`title` 必须是一句人话（`/主屏幕|不提供/`）、
而且不许假装按下。

七把刀 + 一颗阳性对照，跑在定稿树的**副本**上（`python3 _tmp-yajilin-pause-knife-r2.py`，
台账 `_tmp-yajilin-pause-knife-r2.log`，逐把都点名了它该弄红的判据）：

| 刀 | 破的那句承诺 | 结果 |
|---|---|---|
| control | 定稿树 | boot+pause 43 条、红 0 |
| K1 | 摘掉 `setPaused` 里停表那两行 | `暂停把时钟冻死` 红（`frozen` 读 703 ms） |
| K2 | 恢复时把 `startedAt` 往前挪 9 s | `恢复的第一帧不倒灌` 红（`jump` 读 9000） |
| K3 | 删掉全屏那颗的 `click` 监听 | `进不去全屏时给一句人话理由` 红（`fs` 落进 `unsupported` 支） |
| K4 | 把 `#btn-fullscreen` 改名 | boot 的名册 + pause 的四条一起红，5 条点名、**没有一条被崩掉** |
| K5 | 摘掉 `newGame` 的解暂停 | `暂停中换一局，新局一定在走` 红 |
| K6 | `aria-pressed` 写反 | 两条标签红 + 那条一致性红 |
| K7 | 把 `#btn-pause` 改名 | 5 条点名红；这一刀砸的其实不是判据而是整张页面 |

K7 是本轮的第二个发现：`js/main.js:549` 那句 `$('btn-pause').addEventListener(...)` 没有守卫，
空 id 会让 app 死在模块求值里、`window.yajilin` 从来没被赋值（`#btn-fullscreen` 那一颗是有守卫的，
`js/main.js:641` 找不到就直接不装）。这一刀第一次跑出来的不是点名红，而是 boot 场整场 THROW
（`Cannot read properties of undefined (reading 'game')`）——红落在异常文本上，读的人得去猜是哪条腿。
所以闸台自己补了两处：boot 的 `const a = A()` 改成 `A() || {}`，pause 的名册两条挪到需要 surface 的腿之前、
再加一条 `pause: 暂停那张脸在`。app 侧那句无守卫的 `addEventListener` **本轮没动**：改它要么让按钮静静消失、
要么改产品行为，都不属于补闸的范围，先把它记在这里。

同一轮里还有一件只有本机碰得到的事：`bash tools/verify.sh` 在 macOS 上跑到最后一句是
`=== FAILURES ABOVE ===`（腿 1-5 全绿）。`tools/deploy-set-selftest.mjs` 用 `os.tmpdir()` 造影子副本，
而 `tools/verify.sh:39` 在 Darwin 上把 `TMPDIR` 指到本仓的 `_tmp-mk/`，于是 `cpSync` 当场
`ERR_FS_CP_EINVAL`「Cannot copy <repo> to a subdirectory of self」。CI runner 的 `TMPDIR` 是 `/tmp`，
那一趟照过——这道 2026-10-04 落地的闸从没在这台机器上跑通过。账与修法在 DESIGN 第七节。

---

## 七、源码地图

```
index.html                 单 <canvas> 页面；所有资源相对路径（不写 <base>）
css/                       样式（Pages 名单内的三样之一）
js/engine/grid.js          方向表 + Board + ray()          ← 规则口径写在文件头
js/engine/model.js         verify()（真值审计器）+ generate()（原始采样器）
js/engine/rng.js           hashSeed（FNV-1a）+ mulberry32
js/engine/counter.js       穷举计数器：countSolutions / materialize
js/engine/pencil.js        P1–P10 不回溯求解器
js/engine/generate.js      出货流水线 pSet / pDig / makePencilBoard / shipBoard
js/ui/puzzle.js            题面适配器（不含一条规则）
js/ui/game.js              对局状态 + 判胜（只经 verify()）
js/render/board.js         画布：读同一批数字
js/store.js                localStorage 存档 + 指纹对账
js/main.js                 装配层：按钮、指针、时钟、seed
server.cjs                 零依赖静态服务（5326 / 5327）
tools/check.mjs            node 侧总门（静态门 + 六套 + RESULT 数行）
tools/{rule,pencil,counter,golden}-test.mjs  四套单测
tools/write-golden.mjs     冻结快照；--check 是只读对照
tools/generator-probe.mjs  剂量表 + 红线
tools/balance.mjs          平衡闸：出货墙钟定价（budgetMs / band），CI 里的独立 step
tools/ceiling.mjs          档外天花板：14×14 / 16×16 的复跑器（不进 CI）
tools/reference.mjs        暴力枚举器（计数器的第二台机器）
tools/verify.sh            六条腿的生命周期（一条判据都不在这里）
tools/scenarios.js         九场判据（只认 DOM 矩形 / 画布像素 / 真指针读数）
tools/playtest.cjs         裸 CDP 驱动（Node 22 全局 WebSocket/fetch）
```

出货目录里**不含** `tools/`：Pages 的名单只拷 `index.html`、`css/`、`js/`
（`.github/workflows/pages.yml:44-45`、`.github/workflows/pages.yml:50`），
而 `tools/golden.mjs` 冻结的是每张出货盘的认证解——它是答案，不许被服务出去
（`tools/golden.mjs:19`、`tools/verify.sh:341-344`）。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`39`）与这一次跑的断言条数（`57`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`39`、断言仍然 `57`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

