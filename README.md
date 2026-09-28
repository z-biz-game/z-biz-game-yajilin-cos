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

零运行时依赖：`package.json` 全文 35 行，顶层键只有
`name` / `version` / `description` / `type` / `private` / `scripts` / `keywords` / `author` / `license`
——没有 `dependencies`，也没有 `devDependencies`（`scripts` 块在 `package.json:7-19`），
不需要 `npm install`。

| 命令 | 做什么 | 出处 |
|---|---|---|
| `npm start` | 本机静态服务，端口 5326（根形态） | `package.json:8`、`server.cjs:64` |
| `npm test` | node 侧总门：语法闸 + 禁词源闸 + seed 源闸 + 六套 suite | `package.json:10`、`tools/check.mjs:1-2` |
| `npm run probe` | 只跑剂量表（成本与选择性的观测） | `package.json:17`、`tools/generator-probe.mjs:19-23` |
| `npm run verify` | 全闸：node 腿 + 真 Chrome + 真指针的六条腿 | `package.json:18`、`tools/verify.sh:1-2` |

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

## 三、菜单档位表：这四档真发货，实测是这样

菜单里的下拉框就是引擎导出的那四档，一处定义两处用（`js/engine/generate.js:35-40` →
`js/ui/puzzle.js:17` → `js/main.js:529-533`），默认 6×6（`js/main.js:25`、`js/main.js:535`）。

### 本轮读数

口径：`N=16`、`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`，全部走出货默认值
（`js/engine/generate.js:27-32`、`tools/generator-probe.mjs:19-23`）。
机器 Darwin 25.6.0 arm64、15 核；`vm.loadavg` 起跑 `3.39 / 3.80 / 3.75`、收尾 `3.47 / 3.79 / 3.75`。
**墙钟一列只当观测值**，理由见下面第三段。

| 档位 | 出货 | 墙钟 ms med/p95/max | 计数器 nodes med/max | 箭头 med [min–max] | 黑格 med | 环格 med/总格 | 铅笔轮 med/max | 推导步 med | 换盘尝试 med/max | PLATEAU 废盘数 | 用到规则条数 med |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 6×6 | 16/16 | 1 / 7 / 7 | 90 / 298 | 11 [9–13] | 8 | 16/36 | 5 / 8 | 54 | 1 / 6 | 12 | 7 [5–7] |
| 8×8 | 16/16 | 7 / 40 / 40 | 212 / 1349 | 19 [16–21] | 13 | 32/64 | 7 / 10 | 98 | 2 / 11 | 38 | 8 [7–8] |
| 10×10 | 16/16 | 45 / 197 / 197 | 344 / 6474 | 30 [24–34] | 22 | 50/100 | 8 / 17 | 157 | 5 / 32 | 111 | 8 [7–9] |
| 12×12 | 16/16 | 595 / 1248 / 1248 | 1623 / 4250 | 44 [40–48] | 32 | 66/144 | 9 / 16 | 219 | 25 / 55 | 361 | 8 [7–9] |

出处：出货率与红线判定 `tools/generator-probe.mjs:78`（`recs.length === N` 才算绿）；
墙钟/节点/箭头/尝试的打印口径 `tools/generator-probe.mjs:86-97`；
轮数与步数 `tools/generator-probe.mjs:102-106`；PLATEAU 账本来自
`js/engine/generate.js:150`（`pSet` 不是 `PENCIL_SOLVED` 就把该状态记进 `dead` 并换盘）。
「用到规则条数」是逐盘统计**至少发火一次**的规则条数（P10 全表 0 次，故不计入，
理由见 `js/engine/pencil.js:17-19`）。

### 三条必须一起读到的话

1. **聚合数会说谎，所以每档都附了逐样本分布。** 12×12 的 16 个墙钟样本是
   `[12 25 67 80 364 420 489 581 595 668 708 855 1101 1132 1212 1248]`——
   前四颗 seed 十几到几十毫秒就出货，尾部 1.2 秒是因为撞了换盘重试
   （`attempts` 同一批是 `[1 1 4 4 16 16 17 25 25 25 26 35 40 43 44 55]`）。
   中位数与 p95 之间的 2 倍差不是「性能抖动」，是**流水线在换环**
   （`js/engine/generate.js:144-145`：`attempt` 递增 ⇒ 重新 `generate()` 一条新环）。
2. **确定性量在三次复跑里逐字相同**：nodes med/max `90/298`、`212/1349`、`344/6474`、
   `1623/4250`，箭头 med `11/19/30/44`，轮 med `5/7/8/9`，步 med `54/98/157/219`
   在 `node tools/check.mjs` 的那一趟、单独跑的 `npm run probe`、以及本轮自写的分布脚本
   三处完全一致（同一批 seed、同一批 tag `pg-<档位>-<序号>`，
   `js/engine/generate.js:145`、`js/engine/model.js:92-93`）。
3. **墙钟不是。** 同一批盘、同一台机器，两次跑出的 8×8 p95 是 40 ms 与 42 ms，
   12×12 是 595/1248 ms 与 619/1247 ms，而起跑负载分别是 3.39 与 3.95。
   所以本表只报观测值，不报上界，理由写进 `tools/generator-probe.mjs:12`
   与收尾那行负载打印 `tools/generator-probe.mjs:107`。

### 12×12 的题面比印刷题密，这是买「零猜测」的价

本轮实测 12×12 箭头 med 44、黑格 med 32 / 144 格（箭头占 30.6%），
逐样本箭头 `[40 41 42 43 43 43 44 44 44 46 46 46 46 47 47 48]`。
这是「铅笔零猜测能推完」换来的密度，**不要读成标准 Yajilin 印刷题密度**
（口径已在源码里披露：`js/engine/generate.js:17-19`）。

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
（`js/ui/game.js:314-340`、`js/main.js:193-211`、`tools/scenarios.js:1203-1209`、`tools/scenarios.js:1257-1259`）。

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
| **不承诺界面手感与美术** | 浏览器闸只认三种证据：DOM 矩形与文本、画布像素、真指针事件读数。它证的是「玩家拿到了什么」，不是「好不好看」。`.hidden`、类名、注释里的意图一概不算证据。 | `tools/scenarios.js:5-8`、`tools/verify.sh:13-14` |
| **不承诺 `score` 可跨引擎/跨盘比较** | 本仓唯一的 `score` 是 `pSet` 内部给候选动作排序用的 `rolesDone*2 + edgesDone`，它只是一个贪心键，没有任何一处把它当难度、质量或成绩输出。 | `js/engine/generate.js:42`、`js/engine/generate.js:85-87` |
| **不承诺菜单外的档能出货** | 用同一套出货默认值（`ATTEMPTS=60`、`FRACS=0.45/0.5/0.55`）实测：14×14 四颗 seed 出 3 颗，墙钟逐样本 `[633 1745 2961 3379]` ms、attempts `[10 37 57]`；16×16 四颗只出 1 颗，墙钟 `[4757 4957 5019 5108]` ms，那颗出货的 attempts 是 59/60——**已经贴着封顶**。失败的唯一废因是 PLATEAU（本轮 14×14 累计 161、16×16 累计 238 次），也就是 `pSet` 推不到全解，不是计数器撞预算。这两档不在菜单里（`js/engine/generate.js:35-40`）。 | `js/engine/generate.js:150`、`js/engine/generate.js:28` |
| **不承诺 12×12 的 p95 在没有争用的机器上也一样** | 本轮 12×12 p95 1248 ms 是 `load1 = 3.39~3.95`（15 核）下的观测值；同一批盘两次跑的 p95 相差 1 ms、med 相差 24 ms，说明墙钟对负载敏感。门禁本身就把负载和墙钟一起打印，并注明「不是最坏值」。 | `tools/generator-probe.mjs:45`、`tools/generator-probe.mjs:107`、`tools/generator-probe.mjs:12` |
| **不承诺 P10 是一条难度梯级** | 本轮 64 张出货盘上 P10 命中 0 盘（四档全 0），它的价值是健全性证人。这条被写成红线：命中盘数一旦不是 0 就直接红。 | `js/engine/pencil.js:17-19`、`tools/generator-probe.mjs:82` |
| **不承诺「同一个 seed 永远同一张盘」跨版本成立** | seed→盘 是纯函数（判定路径上没有随机数也没有时钟），但**流水线一改版同一个 seed 就是另一张盘**。存档靠题面指纹对账，对不上就作废旧笔迹并当面向玩家说明。 | `js/engine/generate.js:168-175`、`js/ui/puzzle.js:24-28`、`js/store.js:84-90`、`js/main.js:268-271`、`js/main.js:294-297` |
| **不承诺「最坏 1.2 秒」** | 16 样本里 0 次「60 试全废」只说明这一批没撞封顶，不说明封顶不会被撞。12×12 观测到的最坏 attempts 已经是 55/60。界面侧的降级路径是「再敲一颗 seed」，最多 8 颗，全失败就照直说 `NO_BOARD`。 | `js/main.js:26-28`、`js/main.js:254-264`、`js/ui/puzzle.js:30-33` |

---

## 六、门禁形状（细节见 DESIGN.md）

`node tools/check.mjs` 本轮：7 行 RESULT、741 条断言、红 0。
逐套：rule 48 / pencil 435 / counter 71 / golden-write 7 / golden-test 156 / generator-probe 24，
聚合 check 102（套件表 `tools/check.mjs:17-24`，行数与格式判定 `tools/check.mjs:106-124`）。

`bash tools/verify.sh` 本轮 ALL GREEN：283 条浏览器断言、红 0——
root 9 场 118 条、prefix 9 场 118 条、mobile 3 场 47 条；
八场逐场为 boot 19 / render 14 / play 14 / marks 15 / resume 8 / wrong 7 / win 8 / hint 14；
部署名单腿 35 条 404 + 名单内 5 条 200；三条腿的控制台异常行数各 0。
汇总门与「少一条腿就红」的地板在 `tools/verify.sh:443-465`。

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
tools/reference.mjs        暴力枚举器（计数器的第二台机器）
tools/verify.sh            六条腿的生命周期（一条判据都不在这里）
tools/scenarios.js         八场判据（只认 DOM 矩形 / 画布像素 / 真指针）
tools/playtest.cjs         裸 CDP 驱动（Node 22 全局 WebSocket/fetch）
```

出货目录里**不含** `tools/`：Pages 的名单只拷 `index.html`、`css/`、`js/`
（`.github/workflows/pages.yml:44-45`、`.github/workflows/pages.yml:50`），
而 `tools/golden.mjs` 冻结的是每张出货盘的认证解——它是答案，不许被服务出去
（`tools/golden.mjs:19`、`tools/verify.sh:341-344`）。
