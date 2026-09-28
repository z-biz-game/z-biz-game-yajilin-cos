// 随机数：32 位 FNV 哈希 + mulberry32。**从模型里搬出来的**，原来住在
// _tmp-yajilin-model.mjs:15-27，逐字符照搬（hashSeed 用 codePointAt，不是 charCodeAt——
// 换成 charCodeAt 会改哈希值，于是改所有 seed 画出的盘，剂量表就再也对不上了）。
//
// 本仓的随机数只有这一个入口，而且引擎里只许用它：
// 任何「内置随机数 / 当前时间 / 机器负载」都不许出现在判定路径上——出货盘要能在
// node 和 Chrome 里画出同一张盘（同组织已经因为「sort 比较器里抽随机数」得到过两侧不同的盘）。
// seed 重试序列 = `${tag}-a${attempt}`（见 generate.js），是 seed 的纯函数。

export function hashSeed(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 统一入口：吃任意 seed（数字或串），返回一个 [0,1) 的取数器。
export function makeRng(seed) {
  return mulberry32(hashSeed(seed));
}
