#!/usr/bin/env bash
# 一把梭的门禁：Node 那几条腿 → 起服 → 真 Chrome + 真指针跑八场 → 截图 → 两种 URL 形态
# → 部署名单的反证 → 移动形态 → 结论。生命周期归这个脚本所有：它起服务器、用自己的
# --user-data-dir 拉 Chrome、跑场景、把两个都收掉；任何一条断言红就得是非零，而且报得出红在哪一条。
#
#   bash tools/verify.sh                              # 全跑（含 node 那几条腿，几分钟）
#   SKIP_UNIT=1 bash tools/verify.sh                  # 只跑浏览器那几条腿
#   SCENARIOS="boot render" bash tools/verify.sh      # 换场景表（调试用；CI 用默认那张）
#   SHOTS=0 bash tools/verify.sh                      # 不落截图
#   MOBILE=0 bash tools/verify.sh                     # 跳过移动形态那条腿
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-yajilin-cos/ bash tools/verify.sh
#
# 判据一律在 tools/scenarios.js（它只认三种证据：DOM 矩形与文本、画布像素、真指针读数）；
# 这里只管生命周期，一条判据都不放进本文件——放进来就变成脚本自己给自己打分。
#
# 为什么 -e 与 run() 同时在：-e 让「起服、拉 Chrome、等 DevTools」这类前置步骤一红就停
# （后面每一步都建在它上面，继续跑只会多产出一屏假象）；run() 让**测试步骤**的红先记下来
# 再往下跑，因为一次 CI 里能一次看见几条红，就少一轮「修一条再推一次」。
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
REPO=z-biz-game-yajilin-cos

# 端口对：5326 = 根形态（npm start / 腿2），5327 = Pages 前缀形态（腿3/4）。
# 这两个数与 server.cjs 的 DEFAULT_PORT/PREFIX_PORT、package.json 的 dev 脚本、
# tools/playtest.cjs 的默认值必须是同一批数。漂了的代价不是「连不上」而是「连上别人家的」：
# 那条 ALL GREEN 读的是隔壁仓的 DOM，一条都不会红。
HTTP=${HTTP_PORT:-5326}
PHTTP=${PREFIX_PORT:-5327}
PORT=${CDP_PORT:-9378}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
MW=${MOBILE_W:-390}
MH=${MOBILE_H:-844}
MDPR=${MOBILE_DPR:-3}

# 临时物在 macOS 上落在 workspace 根、带 _tmp- 前缀：/tmp 会在会话中途被清掉，而「Chrome 的
# 用户数据目录被清了」读起来像浏览器崩了，不像门禁自己把证物删了。Linux（CI 那一侧）要的相反，
# 它要短：SingletonSocket 是 Unix domain socket，全路径上限 108 字节，workspace 根一进去就顶穿。
export TMPDIR=$([ "$(uname -s)" = Darwin ] && printf '%s' "$HERE/_tmp-mk" || printf '%s' /tmp)
mkdir -p "$TMPDIR"
LOGD="$HERE/_tmp-verify"
mkdir -p "$LOGD"
SUM="$LOGD/summary.tsv"
: >"$SUM"

CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w1 127.0.0.1 "$1" 2>/dev/null
  else
    return 1
  fi
}

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
LIVE=https://z-biz-game.github.io/$REPO/
# 预检：这几个号必须是空的。$BASE 只说「有个东西在 5326 上」，不说它是不是本仓的；
# 占了号的那位要是还留着一个 headless Chrome，门禁就会在别人家的 DOM 上变绿。
if [ "$LOCAL" = 1 ]; then
  for p in $HTTP $PHTTP $PORT; do
    if port_busy "$p"; then
      echo "port $p is already listening — refusing to guess whose DOM this is (free it or set HTTP_PORT/PREFIX_PORT/CDP_PORT)" >&2
      exit 2
    fi
  done
fi

FAILED=0
note() { printf '::%s::%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r\n' | cut -c1-500)"; }
run() { # run <名字> <命令…>：测试步骤的红记进 FAILED，但不中断后面的腿
  local name=$1
  shift
  if "$@"; then
    echo "  ok  $name"
  else
    echo "  FAIL ${name}（见上面那段）" >&2
    FAILED=1
    note fail "$name 没过"
  fi
}

# ── 场景结果的解析：几条、红在哪条、外加四个证人（vw / dpr / timeOrigin / baseURI）──
PARSER=$(cat <<'PY'
import json, sys
name, leg, summary = sys.argv[1], sys.argv[2], sys.argv[3]
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT LINE（playtest 没跑到出口，见同名 console 日志）')
    sys.exit(1)
try:
    d = json.loads(raw.splitlines()[-1])
except Exception:
    print('  UNPARSED:', raw[:300])
    sys.exit(1)
rows = d.get('rows', [])
for r in rows:
    if not r['pass']:
        print('  FAIL %s << %s' % (r['test'], str(r['detail'])[:220]))
if not rows:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green')
    sys.exit(1)
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
print('  [%s] %-8s %d checks, %d failed  %s' % (leg, name, len(rows), d['fail'], extra))
def col(key):
    v = d.get(key)
    return '' if v is None else str(v)
with open(summary, 'a', encoding='utf-8') as f:
    f.write('\t'.join([leg, name, str(len(rows)), str(d['fail']),
                       col('vw'), col('dprWin'), col('timeOrigin'), col('base')]) + '\n')
sys.exit(1 if d['fail'] else 0)
PY
)

# 证人读回。四个参数都是「这条腿自己该长什么样」，不是场景里的判据：
#   min_vw   桌面腿的下限（防止整条腿悄悄落在手机宽度上）
#   exact_vw / exact_dpr  移动腿必须精确等于覆写值——覆写没生效的话这条腿就是桌面重跑
#   base_must            前缀腿要求 document.baseURI 里真的带着 /<repo>/
# timeOrigin：boot 在同一条腿里跑两次，第二次必须严格变大。片段导航（BASE#expect= 那种
# 同文档跳转）连 JS 上下文都不换，会被这一条当场抓到。
WITNESS=$(cat <<'PY'
import sys
leg, min_vw, exact_vw, exact_dpr, base_must, summary = sys.argv[1:7]
rows = [l.rstrip('\n').split('\t') for l in open(summary, encoding='utf-8') if l.strip()]
mine = [r for r in rows if r[0] == leg]
if not mine:
    print('  FAIL 证人一条都没有（腿 %s 没跑过场景？）' % leg)
    sys.exit(1)
bad = []
vw, dpr, base = mine[0][4], mine[0][5], mine[0][7]
if min_vw and (not vw or int(float(vw)) < int(min_vw)):
    bad.append('innerWidth=%s 不足 %s（这条腿的视口不是桌面的）' % (vw, min_vw))
if exact_vw and vw != exact_vw:
    bad.append('innerWidth=%s 不等于覆写的 %s：CDP 覆写没生效＝桌面断言冒充移动断言' % (vw, exact_vw))
if exact_dpr and dpr != exact_dpr:
    bad.append('devicePixelRatio=%s 不等于覆写的 %s' % (dpr, exact_dpr))
if base_must and base_must not in base:
    bad.append('document.baseURI=%s 里没有 %s（页面根本没在前缀下加载）' % (base, base_must))
tos = [float(r[6]) for r in mine if r[1] == 'boot' and r[6]]
if len(tos) >= 2 and not tos[1] > tos[0]:
    bad.append('boot 连跑两次的 timeOrigin 没变大（%s → %s）：那是同文档跳转，不是重载' % (tos[0], tos[1]))
print('  证人[%s]: vw=%s dpr=%s base=%s boot重载=%s' % (
    leg, vw, dpr, base,
    ('%s→%s 严格变大' % (tos[0], tos[1])) if len(tos) >= 2 else '只跑了一次'))
for b in bad:
    print('  FAIL ' + b)
sys.exit(1 if bad else 0)
PY
)

URL_FOR_LEG=$BASE
LEG_MOBILE=0
scen() { # scen <腿名> <场景名>
  local leg=$1
  local s=$2
  local log="$LOGD/$leg-$s.console.log"
  echo "=== [$leg] $s ==="
  BASE_URL="$URL_FOR_LEG" CDP_PORT=$PORT MOBILE=$LEG_MOBILE MOBILE_W=$MW MOBILE_H=$MH MOBILE_DPR=$MDPR \
    node tools/playtest.cjs scenario "$s" 2>"$log" | tail -1 | sed 's/^RESULT //' |
    python3 -c "$PARSER" "$s" "$leg" "$SUM"
}

shot() { # shot <腿名> <场景名>：只有这一场是绿的才落盘（红盘的截图不是证据）
  if [ "${SHOTS:-1}" = 1 ]; then
    BASE_URL="$URL_FOR_LEG" CDP_PORT=$PORT MOBILE=$LEG_MOBILE MOBILE_W=$MW MOBILE_H=$MH MOBILE_DPR=$MDPR \
      node tools/playtest.cjs shot "tools/shots/$1-$2.png" </dev/null >/dev/null 2>&1 || echo "  截图没落盘（$1-$2）" >&2
  fi
}

SPID=0
PSPID=0
CPID=0
UDD=""
PROOT=""
CDP_UP=0
stop_server() {
  if [ "${1:-0}" != 0 ]; then kill "$1" 2>/dev/null || true; fi
}
cleanup() {
  stop_server "$SPID"
  stop_server "$PSPID"
  if [ "$CPID" != 0 ]; then kill "$CPID" 2>/dev/null || true; fi
  if [ -n "$UDD" ]; then rm -rf "$UDD" 2>/dev/null || true; fi   # 收尾时 Chrome 的子进程可能还在写：残留只占盘
  if [ -n "$PROOT" ]; then rm -rf "$PROOT"; fi
  return 0
}
trap cleanup EXIT
# 看门狗把 fd 重定向掉：后台子进程会继承本脚本的 stdout，在管道里会把写端一直攥着。
( sleep "${WD_TIMEOUT:-1800}"; cleanup ) </dev/null >/dev/null 2>&1 &
WD=$!
disown

start_chrome() { # 每条腿一个全新的 mktemp profile：同源 localStorage 是会串味的
  if [ "$CDP_UP" = 1 ]; then
    if [ "$CPID" != 0 ]; then kill "$CPID" 2>/dev/null || true; fi
    if [ -n "$UDD" ]; then for t in 1 2 3 4 5 6; do rm -rf "$UDD" 2>/dev/null && break; sleep 0.25; done; [ -e "$UDD" ] && echo "  note 上一腿的 profile 没删净（${UDD}）：Chrome 的子进程还在收尾。本腿仍是全新的一条（:211 的 mktemp 给的是新路径），残留只占盘、不动判据" || true; fi
  fi
  # -p 把新目录钉在 ${TMPDIR}（上面那条按平台选：macOS 是本仓的 _tmp-mk，Linux 是 /tmp——那里
  # 短路径是硬要求）：macOS 的 mktemp 不给 -p 时会落去 /var/folders，系统会中途把它清了。
  UDD=$(mktemp -d -p "$TMPDIR")
  # 不加 --use-gl=angle --use-angle=swiftshader：软件光栅会吃满每一核，而且没有 CDP 客户端时
  # Chrome 不会自己退。
  "$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir="$UDD" \
    --window-size=900,980 --no-first-run --no-default-browser-check about:blank \
    >"$LOGD/chrome-$(basename "$UDD").log" 2>&1 &
  CPID=$!
  disown
  CDP_UP=1
  # 全新的 --user-data-dir 绑 DevTools 比热 profile 慢，所以等端点而不是等固定秒数。
  for i in $(seq 1 120); do
    curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || { echo "devtools never bound on :$PORT —— 下面三段是这一红的现场证据：Chrome 版本 / 我拉起的那个进程还活着没 / 它自己的 stderr" >&2; echo "chrome --version: $("$CHROME" --version 2>&1 || echo '<连 --version 都跑不动>')" >&2; echo "CPID=$CPID alive=$([ -n "$(ps -p $CPID -o pid= 2>/dev/null)" ] && echo yes || echo no)（0=这条腿还没 own 过进程）" >&2; sed -n '1,60p' "$LOGD/chrome-$(basename "$UDD").log" >&2 || echo "读不到 $LOGD/chrome-$(basename "$UDD").log" >&2; exit 3; }
  local bv
  bv=$(curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" | tr -d '\n' | grep -o '"Browser"[[:space:]]*:[[:space:]]*"[^"]*"' || echo '<no browser string>')
  # 这条 Chrome 也必须是我自己刚拉起来的那一个：--user-data-dir 是新造的临时目录。
  echo "chrome: :$PORT ${bv} profile=$UDD"
}

quiet_leg() { # quiet_leg <腿名>：控制台里但凡有 [EXCEPTION]/[log:error]，这一趟就不算干净。
  # 404 与未捕获异常都不会让任何一条断言变红——它们只会让玩家看到一张没有样式的盘。
  local leg=$1
  local n
  n=$(grep -h -E '\[EXCEPTION\]|\[log:error\]' "$LOGD/$leg-"*.console.log 2>/dev/null | wc -l | tr -d ' ' || true)
  echo "  $leg 腿的控制台异常/错误行数：${n:-0}"
  [ "${n:-0}" = 0 ]
}

# ── 腿 1：语法闸 + 六套 suite + golden 对账 + 剂量表 ──────────────────────────────
if [ "${SKIP_UNIT:-0}" = 1 ]; then
  echo "=== 腿1 unit：SKIP_UNIT=1，跳过（浏览器那几条腿照样跑）==="
else
  echo "=== 腿1 unit：node tools/check.mjs（node --check 语法闸 + 禁 token 源闸 + 六套 + golden + 剂量表）==="
  UNIT_LOG=$LOGD/unit.log
  UEXIT=0
  node tools/check.mjs >"$UNIT_LOG" 2>&1 || UEXIT=$?
  grep -E '^(RESULT|DOSE|⚠|✗)' "$UNIT_LOG" | sed 's/^/  /' || true
  run "node 门禁：六套齐、零红、退出码 0" env UEXIT=$UEXIT UNIT_LOG="$UNIT_LOG" python3 -c "
import os, re, sys
tot = fails = 0
names = []
for line in open(os.environ['UNIT_LOG'], encoding='utf-8'):
    m = re.match(r'RESULT (\S+) ok=(\w+) checks=(\d+) fails=(\d+)', line.strip())
    if m:
        names.append(m.group(1))
        if m.group(1) != 'check':
            tot += int(m.group(3))
            fails += int(m.group(4)) + (0 if m.group(2) == 'true' else 1)
print('  node 侧：%d 行 RESULT（%s），合计 %d 条断言，红 %d 条，退出码 %s' % (
    len(names), ' '.join(names), tot, fails, os.environ['UEXIT']))
# 套数不足 = 当场红。少跑一套是这一族门禁最常见的腐化方式：某套改了名、某套崩在 import 之前，
# 剩下的照样绿，而出口码还是 0。
need = ['rule-test', 'pencil-test', 'counter-test', 'golden-write', 'golden-test', 'generator-probe']
missing = [n for n in need if n not in names]
for x in missing:
    print('  FAIL 缺 RESULT 行：' + x)
if os.environ['UEXIT'] != '0':
    print('  FAIL check.mjs 退出码不是 0')
sys.exit(0 if (not missing and fails == 0 and tot > 0 and os.environ['UEXIT'] == '0') else 1)
"
fi

if [ "$LOCAL" = 1 ]; then
  echo "=== 起服：$HTTP 根形态 ==="
  node "$HERE/server.cjs" "$HTTP" >"$LOGD/server-root.log" 2>&1 &
  SPID=$!
  disown
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# 身份证据：$BASE 上有东西 ≠ 上面是本仓。标题里既要有「矢仓林」也要有 Yajilin。
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at ${BASE}（见 $LOGD/server-root.log）" >&2; exit 2 ;; esac
echo "$SERVED" | grep -q 矢仓林 || { echo "$BASE 不是矢仓林（title 里没有「矢仓林」）" >&2; exit 2; }
echo "$SERVED" | grep -qi yajilin || { echo "$BASE 不是矢仓林（title 里没有 Yajilin）" >&2; exit 2; }
echo "identity: $(echo "$SERVED" | grep -o '<title>[^<]*</title>' | head -1) @ $BASE"

DEFAULT_SCEN="boot boot render play marks resume wrong win hint"
: "${SCENARIOS:=$DEFAULT_SCEN}"

# ── 腿 2：根形态 http://127.0.0.1:5326/ ──────────────────────────────────────────
if [ "$LOCAL" = 1 ]; then
  echo "=== 腿2 root：真 Chrome + 真指针（${BASE}）==="
  URL_FOR_LEG=$BASE
  LEG_MOBILE=0
  start_chrome
  for s in $SCENARIOS; do
    if run "[$s]" scen root "$s"; then
      shot root "$s"
    fi
  done
  run "重载证人（root）" python3 -c "$WITNESS" root 700 '' '' '' "$SUM"
  run "root 腿控制台零异常" quiet_leg root
  echo "  shots: $(ls tools/shots/root-*.png 2>/dev/null | tr '\n' ' ')"
fi

# ── 腿 3：Pages 前缀形态 http://127.0.0.1:5327/z-biz-game-yajilin-cos/ ────────────
# 兄弟仓红过一次：本地只测根形态、全绿，Pages 上的站点 404。原因是 Pages 把部署目录挂在
# /<仓库名>/ 下面，页面里但凡有一个写死的 href="/css/game.css" 就只在带前缀的那份上死。
# 所以这条腿不是重复劳动，它测的是根形态那条腿**测不到**的那一段。
if [ "$LOCAL" = 1 ]; then
  echo "=== 腿3 prefix：Pages 的前缀形态（按 pages.yml 的部署名单搭一棵替身根）==="
  PROOT=$(mktemp -d -p "$TMPDIR")
  mkdir -p "$PROOT/$REPO"
  # 替身根只从**那一份清单**生成：pages.yml 与本仓部署集闸调的都是 tools/assemble-site.sh，这条腿也调它。
  # 这四行以前是手抄的 ln -s（index.html / css / js）——PWA 轮给页面接上 manifest.webmanifest、sw.js、icons/
  # 之后，前缀腿就在替身根里 404 自己刚接线的那一份，而腿 2 读的是仓库根，根形态永远看不见这种缺。
  bash "$HERE/tools/assemble-site.sh" "$PROOT/$REPO"
  node "$HERE/server.cjs" "$PHTTP" "$PROOT" >"$LOGD/server-prefix.log" 2>&1 &
  PSPID=$!
  disown
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$PHTTP/$REPO/" >/dev/null 2>&1 && break
    sleep 0.25
  done
  URL_FOR_LEG="http://127.0.0.1:$PHTTP/$REPO/"
  start_chrome
  for s in $SCENARIOS; do
    if run "[prefix:$s]" scen prefix "$s"; then
      shot prefix "$s"
    fi
  done
  run "重载证人（prefix）" python3 -c "$WITNESS" prefix 700 '' '' "/$REPO/" "$SUM"
  run "prefix 腿控制台零异常" quiet_leg prefix
  echo "  shots: $(ls tools/shots/prefix-*.png 2>/dev/null | tr '\n' ' ')"

  # ── 腿 4：部署名单的反证 ── tools/、*.md、答案文件在这棵根下必须够不到 ──────────
  # 名单（pages.yml:36-42）只 cp index.html + css/ + js/，所以 tools/golden.mjs（每张出货盘
  # 的认证解）与 tools/reference.mjs（暴力枚举器）根本不该被服务出去：公网上的答案既是剧透
  # 也是作弊小抄，还会让「被测的字节就是出货的字节」这句话不可证伪。
  echo "=== 腿4 deploy-list：替身根下 tools/、*.md、答案文件必须 404，名单内的必须 200 ==="
  MISS_LIST=$(find tools -type f | sort)
  MISS_LIST="$MISS_LIST $(for f in *.md package.json server.cjs .github/workflows/ci.yml .github/workflows/pages.yml; do [ -e "$f" ] && printf '%s ' "$f"; done)"
  run "部署名单外的都 404、名单内的都 200" env REPO="$REPO" PHTTP="$PHTTP" MISS_LIST="$MISS_LIST" python3 -c "
import os, subprocess, sys
miss = os.environ['MISS_LIST'].split()
repo = os.environ['REPO']
port = os.environ['PHTTP']

def code(path):
    url = 'http://127.0.0.1:%s/%s/%s' % (port, repo, path.lstrip('/'))
    out = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5', url],
                         capture_output=True, text=True).stdout.strip()
    return out

res = [(p, code(p)) for p in miss]
bad = [(p, c) for p, c in res if c != '404']
for p, c in bad:
    print('  FAIL %s 返回 HTTP %s —— 名单漏了东西（答案或门禁被服务出去了）' % (p, c))
# 反向也要成：名单里那三样必须 200，否则上面那一串 404 只是因为整棵树都在 404。
hit = [p for p in ['index.html', 'css/game.css', 'js/main.js', 'js/engine/model.js', 'js/render/board.js']
       if code(p) != '200']
for p in hit:
    print('  FAIL 名单内的 %s 返回 HTTP %s' % (p, code(p)))
print('  够不到 %d 条（tools/ 全部 %d 个文件 + 仓库根的 *.md/package.json/工作流）；名单内 200 %d 条' % (
    len(miss) - len(bad), len([p for p in miss if p.startswith('tools/')]), 5 - len(hit)))
sys.exit(0 if (not bad and not hit and len(miss) >= 10) else 1)
"
  rm -rf "$PROOT/$REPO"  # css/ 与 js/ 是 assemble-site.sh 拷出来的真目录：rm -f 对目录 exit 1，而本脚本是 set -e，清场那句能把腿5 整条掐死
  rmdir "$PROOT" 2>/dev/null || true
  PROOT=""
  stop_server "$PSPID"
  PSPID=0
fi

# ── 腿 5：移动形态（默认 390×844 @ dpr 3）───────────────────────────────────────
# 覆写只活在本会话的 CDP 调用里：MOBILE=1 时 playtest.cjs 在同一次 attach 内先设
# Emulation.setDeviceMetricsOverride，再把读回的 innerWidth/dpr 打到 stderr（EMULATION 那行）。
# 另起一个进程去设覆写 = 这条腿退化成桌面断言重跑一遍的假绿。
# 这条腿只跑与形状有关的三场（boot 的可达性表、render 的取样几何、play 的真指针拖拽），
# 证人读的是**这三场自己报的** vw/dpr：与桌面腿一样就说明覆写没生效。
if [ "$LOCAL" = 1 ] && [ "${MOBILE:-1}" = 1 ]; then
  echo "=== 腿5 mobile：${MW}×${MH} @ dpr${MDPR} 的 CDP 覆写（本会话内）==="
  URL_FOR_LEG=$BASE
  LEG_MOBILE=1
  start_chrome
  for s in ${MOBILE_SCENARIOS:-boot render play}; do
    if run "[mobile:$s]" scen mobile "$s"; then
      shot mobile "$s"
    fi
  done
  run "移动证人" python3 -c "$WITNESS" mobile '' "$MW" "$MDPR" '' "$SUM"
  run "mobile 腿控制台零异常" quiet_leg mobile
  echo "  shots: $(ls tools/shots/mobile-*.png 2>/dev/null | tr '\n' ' ')"
  LEG_MOBILE=0
fi

# ── 腿 6：线上站点（要网络，所以由调用方决定跑不跑）─────────────────────────────
LIVELEG=0
case "$BASE" in "$LIVE"*) LIVELEG=1 ;; esac
if [ "$LIVELEG" = 1 ]; then
  echo "=== 腿6 live：这一跑打的就是线上站点 $BASE ==="
  echo "  上面那些场景读的是 Pages 真部署过的那份字节；腿3/4 那棵本地替身根替代不了这一条。"
  for miss in "${LIVE}tools/golden.mjs" "${LIVE}tools/reference.mjs" "${LIVE}tools/scenarios.js" "${LIVE}tools/verify.sh" "${LIVE}README.md" "${LIVE}DESIGN.md" "${LIVE}server.cjs" "${LIVE}package.json"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$miss" 2>/dev/null || echo 000)
    if [ "$code" = 404 ]; then
      echo "  ok  线上够不到 $miss"
    else
      echo "  FAIL 线上 $miss 返回 HTTP $code —— pages.yml 的名单漏了东西" >&2
      FAILED=1
      note fail "线上 $miss 竟然可达（${code}）"
    fi
  done
elif [ "$LOCAL" = 1 ]; then
  echo "=== 腿6 live：这一跑没打 ==="
  echo "  这一跑是本机形态（腿2 根 + 腿3 前缀 + 腿4 名单 + 腿5 移动）。线上那一趟单独跑，网络另算："
  echo "    BASE_URL=$LIVE bash tools/verify.sh"
else
  echo "=== 腿6 live：BASE_URL=$BASE 既不是本机根也不是线上（腿3/4/5 按 LOCAL=0 跳过）==="
fi

# ── 汇总：把每条腿的几条断言、几条红、证人读数并成一张表 ─────────────────────────
echo "=== 汇总（${SUM}）==="
python3 -c "
import sys
rows = [l.rstrip('\n').split('\t') for l in open('$SUM', encoding='utf-8') if l.strip()]
by = {}
for r in rows:
    by.setdefault(r[0], []).append(r)
tot = fails = 0
for leg, rs in by.items():
    checks = sum(int(r[2]) for r in rs)
    f = sum(int(r[3]) for r in rs)
    tot += checks
    fails += f
    print('  %-7s %d 场 %4d 条断言 红 %d%s' % (leg, len(rs), checks, f, '  ← 有红' if f else ''))
print('  合计 %d 条浏览器断言，红 %d 条' % (tot, fails))
bad = []
# 一条都不许是空的：场景名写错、__ng 没装上、RESULT 行被截断，都会表现成「0 条断言、0 条红」。
for r in rows:
    if int(r[2]) == 0:
        bad.append('%s/%s 零断言' % (r[0], r[1]))
known = {'boot', 'render', 'play', 'marks', 'resume', 'wrong', 'win', 'hint'}
for r in rows:
    if r[1] not in known:
        bad.append('不认识的场景名 %s/%s（场景表漂了还是 __ng 少了一个？）' % (r[0], r[1]))
# 根形态与前缀形态这两条腿都必须含那八场；少了就是「浏览器闸只跑了一遍却被写成两遍」。
for leg in ('root', 'prefix'):
    rs = by.get(leg, [])
    if rs:
        got = {r[1] for r in rs}
        for need in ('boot', 'render', 'play', 'marks', 'resume', 'wrong', 'win', 'hint'):
            if need not in got:
                bad.append('%s 腿没跑 %s 场' % (leg, need))
    else:
        bad.append('缺 %s 腿的场景记录' % leg)
if fails or bad or tot < 60:
    for b in bad:
        print('  FAIL ' + b)
    sys.exit(1)
" || { echo "  FAIL 浏览器腿汇总不达标" >&2; FAILED=1; }
kill "$WD" 2>/dev/null || true
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
