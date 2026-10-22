/**
 * 主题在第一帧之前落定：React 挂载前的那一瞬不再闪一次浅色。
 *
 * 为什么是外部文件而不是内联 <script>：CSP 的 script-src 已经收紧到 'self'
 * （内联脚本必须配 'unsafe-inline' 或 nonce，两者都没有——nonce 得由响应头
 * 逐次生成，而这里的页面是磁盘上的静态产物）。这段逻辑此前一直内联在
 * index.html 里，理由是「scripts/inline-dist.mjs 把产物全内联进单文件」，
 * 而那个脚本早就不存在了——现在是回环 HTTP 伺服 + 保留分片，外部文件完全
 * 可用，把 script-src 收回去的前提也就成立了。
 *
 * 必须是**经典脚本**（不是 module）且不带 defer/async：module 与 defer 都要
 * 等文档解析完才执行，那时第一帧可能已经画出来了，浅色闪屏就又回来了。
 * 放在 <head> 里同步执行，才能赶在 React 挂载与 splash 淡出之前把
 * data-theme 定下来。
 *
 * 存储键与取值口径必须与 renderer/src/App.tsx 的 loadTheme 一致。
 */
;(function () {
  var t = null
  try {
    t = localStorage.getItem('ryharness-theme')
  } catch (e) {
    t = null
  }
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = t === 'dark' || t === 'light' ? t : dark ? 'dark' : 'light'
})()
