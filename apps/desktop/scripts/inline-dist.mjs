/**
 * 把 renderer/dist 的外链 JS/CSS 内联进 index.html。
 * Electron 以 file:// 加载渲染层时，外部 module script 会被 CORS 拦截；
 * 内联 module script 可以正常执行（单文件产物，~250KB 可接受）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '../renderer/dist')
const htmlPath = join(dist, 'index.html')
let html = readFileSync(htmlPath, 'utf8')

const asset = (pattern) => {
  const match = readdirSync(join(dist, 'assets')).find((name) => {
    return pattern.test(name)
  })
  return match === undefined ? undefined : join(dist, 'assets', match)
}

const js = asset(/\.js$/)
const css = asset(/\.css$/)
if (js !== undefined) {
  const code = readFileSync(js, 'utf8')
  html = html.replace(/<script[^>]*type="module"[^>]*><\/script>/, () => {
    return `<script type="module">\n${code}\n</script>`
  })
}
if (css !== undefined) {
  const code = readFileSync(css, 'utf8')
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/, () => {
    return `<style>\n${code}\n</style>`
  })
}
writeFileSync(htmlPath, html)
console.log('[inline] index.html inlined:', js !== undefined, css !== undefined)
