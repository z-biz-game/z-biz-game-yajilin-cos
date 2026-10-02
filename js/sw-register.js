// SW 注册。单独一个文件、单独一条 import，是为了让「装不上」这件事不可能是游戏起不来的原因。
//
// 三条纪律：
//  1) 全程 try/catch，且**不抛**。file:// 下 navigator.serviceWorker 存在但 register 一定失败
//     （SecurityError），双击 index.html 玩的人不该在控制台里看到一条未捕获异常——那会被
//     读成「游戏坏了」，而它只是「这个协议下不能装」。
//  2) 只在安全上下文里注册：https，或 http://localhost / 127.0.0.1（本机门禁与 npm start 走这条）。
//     其它 http（比如裸 IP 的局域网机器）上 SW 本来就装不了，不试第二下。
//  3) 注册路径按 document.baseURI 解析，不写死 '/sw.js'：GitHub Pages 把站点挂在 /<仓库名>/ 下，
//     绝对路径会去域名根要文件（404），而 scope 也必须跟着这个目录走。
const doc = typeof document !== 'undefined' ? document : null;

function secureContext() {
  const loc = typeof location !== 'undefined' ? location : null;
  if (!loc) return false;
  if (loc.protocol === 'https:') return true;
  const host = loc.hostname;
  return loc.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1');
}

export function registerServiceWorker() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || !nav.serviceWorker || !doc) return Promise.resolve({ ok: false, why: 'no-serviceWorker' });
    if (!secureContext()) return Promise.resolve({ ok: false, why: 'insecure-context' });
    const url = new URL('sw.js', doc.baseURI || (doc.querySelector && doc.querySelector('script[src]') ? doc.querySelector('script[src]').src : undefined));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.resolve({ ok: false, why: 'unsupported-protocol' });
    // scope 显式指到页面所在目录：不写的话它默认取 sw.js 的所在目录，看着等价，
    // 但一旦有人把 sw.js 挪位置，缓存就会开始接管整站。
    return nav.serviceWorker.register(url.href, { scope: new URL('./', doc.baseURI || url.href).href }).then(
      (reg) => ({ ok: true, reg }),
      (err) => ({ ok: false, why: String((err && err.name) || err) })
    );
  } catch (err) {
    // 连「解析 baseURI」这种最前置的步骤炸了也只留一条 why：游戏必须继续起来。
    return Promise.resolve({ ok: false, why: String((err && err.name) || err) });
  }
}

// 注册失败不影响玩法，所以这一句的结果只留给排障读（window.yajilin.sw）。
export const swRegistration = registerServiceWorker();
