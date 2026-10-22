// Service worker：离线可开 + 出问题时不会把旧字节钉死。
//
// 策略只有一条：**同源子资源一律网络优先，失败才退缓存**。
// 手工 VERSION 号 + cache-first 的写法在这个家族里踩过：改一版 index.html 而 SW 没换 cache 名，
// 或者换了 HTML 却没换 JS——玩家拿到「新页面配旧引擎」的鬼状态，而且因为缓存永不失效，
// 他刷十次还是那张。这里网络永远排在前面，所以出新 HTML 配新 JS 是默认行为；
// 缓存只在断网/5xx 时兜底（那正是它唯一该出场的时刻）。
//
// cache 名带 VERSION：改策略/改预缓存清单时把号往上抬，activate 里旧名字被清掉。
const VERSION = 'v3';
const CACHE = `yajilin-${VERSION}`;
// 预缓存 = 断网时还能开这一张盘所需的最小集合。位图不在里面：它掉了不影响能玩，
// 而把 76KB 的母图塞进首次安装会拖慢冷启动。
const PRECACHE = ['./', './index.html', './css/game.css', './manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
      .catch(() => undefined) // 预缓存失败不许让 install 红：那等于把玩家锁在旧版本上
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yajilin-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => {
  try {
    return new URL(url, self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
};

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || !sameOrigin(req.url)) return;
  ev.respondWith(
    fetch(req)
      .then((res) => {
        // 只存能存的：200/basic 之外（opaque、302、206）一律不写缓存
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: false }).then((hit) => {
          if (hit) return hit;
          // 导航请求断网且没缓存过：给一句人话，而不是 Chrome 那个「无法访问此网站」的冷页面
          if (req.mode === 'navigate') {
            return new Response('<!DOCTYPE html><meta charset="utf-8"><title>矢仓林 · 离线</title><p style="font:14px/1.6 system-ui;padding:24px;color:#F2F5FB;background:#070A14">这一局要重新出题，需要网络。连上之后再打开就行。</p>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return Response.error();
        })
      )
  );
});
