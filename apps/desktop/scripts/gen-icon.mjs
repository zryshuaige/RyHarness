/**
 * 生成 RyAgent 全部图形资产（可重复运行）：
 *   pnpm --filter @ryagent/desktop gen:icon
 *
 * 唯一主角是 assets/brand/ 下的几何橘猫（纯矢量，本项目原创）：琥珀渐变
 * squircle 底板 + 极简圆头三角耳猫。历史版本曾用微软 Fluent Emoji 猫脸当
 * 软件图标（第三方贴纸感、与品牌橘不一致），现已全部改为本仓库母版。
 *
 * 产物：
 * - icon.svg            彩色母版（底板 + 猫）
 * - icon-{16..1024}.png 全尺寸位图
 * - icon.ico            Windows 图标（16/24/32/48/256）
 * - icon-mono.svg/.png  单色剪影（深色背景 / 托盘 / 文档用）
 * - favicon.svg/.png    浏览器标签页
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '../assets')
const brand = join(assets, 'brand')

// 64×64 设计网格：底板 2..62，猫头 r15.2 居中 (32,35.5)。
const SQUIRCLE =
  'M32 2 C46.375 2 62 10.75 62 32 C62 53.25 46.375 62 32 62 C17.625 62 2 53.25 2 32 C2 10.75 17.625 2 32 2 Z'
const CREAM = '#FFFDF8'
const INK = '#4a2e1a'

/** 猫头 + 双耳轮廓（不含五官），单色剪影版复用。 */
const HEAD =
  '<circle cx="32" cy="35.5" r="15.2"/>' +
  '<path d="M24 26.4 L17 10.4 L34 22 Z"/>' +
  '<path d="M40 26.4 L47 9 L30 21.8 Z"/>'

const faceIdle = readFileSync(join(brand, 'cat-face.svg'), 'utf8').trim()

const GRADIENT =
  '<defs><linearGradient id="ryagent-plate" x1="0%" y1="0%" x2="100%" y2="100%">' +
  '<stop offset="0%" stop-color="#FBBF24"/><stop offset="100%" stop-color="#D97706"/>' +
  '</linearGradient></defs>'

/**
 * 母版里的 class 只服务于应用内主题样式（ink / inkf / face 都是给渲染层 CSS 用的
 * 钩子，静态产物里没有对应的样式表）。逐个改写成静态属性：ink 变成写死的描边色，
 * 其余直接剥掉——漏一个就会把无意义的 class 泄漏进 icon.svg。
 */
const stripClasses = (svg) => {
  return svg
    .replaceAll('class="ink" ', `stroke="${INK}" `)
    .replaceAll('class="inkf" ', '')
    .replaceAll('class="face" ', '')
}

/** 彩色母版：琥珀 squircle + 几何猫脸。 */
const iconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64" role="img" aria-label="RyAgent">` +
  GRADIENT +
  `<path fill="url(#ryagent-plate)" d="${SQUIRCLE}"/>` +
  stripClasses(faceIdle) +
  `</svg>`

/** 单色剪影：只有猫头轮廓，透明底（深色背景/托盘/文档）。 */
const monoSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64" role="img" aria-label="RyAgent">` +
  `<g fill="${CREAM}">${HEAD}</g>` +
  `<g fill="${INK}">` +
  `<circle cx="26.7" cy="35.2" r="2.25"/><circle cx="37.3" cy="35.2" r="2.25"/>` +
  `<path d="M29.9 39.8 L32 42.9 L34.1 39.8 Z"/>` +
  `</g>` +
  `<path d="M27.1 43.9 q4.9 4.4 9.8 0" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round"/>` +
  `</svg>`

/** favicon：同母版，额外给出显式背景（小尺寸下边缘更稳）。 */
const faviconSvg = iconSvg.replace('<svg ', '<svg shape-rendering="geometricPrecision" ')

// 母版随时会加新的主题钩子，class 一旦漏进静态产物就没人会注意到，直到图标显示错。
for (const [name, svg] of [
  ['icon.svg', iconSvg],
  ['favicon.svg', faviconSvg],
  ['icon-mono.svg', monoSvg],
]) {
  if (svg.includes('class="')) throw new Error(`[icon] ${name} 残留 class 钩子，静态产物不应带 class`)
}

writeFileSync(join(brand, 'icon.svg'), `${iconSvg}\n`)
writeFileSync(join(brand, 'icon-mono.svg'), `${monoSvg}\n`)
writeFileSync(join(brand, 'favicon.svg'), `${faviconSvg}\n`)
console.log('[icon] brand/icon.svg, brand/icon-mono.svg, brand/favicon.svg')

const render = async (svg, size) => {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
}

const master = await sharp(Buffer.from(iconSvg)).resize(1024, 1024).png().toBuffer()
writeFileSync(join(assets, 'icon-1024.png'), master)

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = []
for (const size of SIZES) {
  const buffer = size === 1024 ? master : await render(iconSvg, size)
  writeFileSync(join(assets, `icon-${size}.png`), buffer)
  pngs.push({ size, buffer })
}
console.log(`[icon] icon-{${SIZES.join(',')}}.png`)

const ico = await pngToIco(
  pngs
    .filter((p) => {
      return [16, 24, 32, 48, 256].includes(p.size)
    })
    .map((p) => {
      return p.buffer
    }),
)
writeFileSync(join(assets, 'icon.ico'), ico)
console.log('[icon] icon.ico')

for (const size of [32, 128, 512]) {
  writeFileSync(join(assets, `favicon-${size}.png`), await render(faviconSvg, size))
}
for (const size of [32, 128, 512]) {
  writeFileSync(join(assets, `icon-mono-${size}.png`), await render(monoSvg, size))
}
console.log('[icon] favicon-*.png, icon-mono-*.png')

// 旧的第三方 Emoji 合成母版与手绘领结猫母版已废弃，清掉避免继续被误用。
for (const stale of ['icon-master-fluent.png', 'icon-master.svg']) {
  rmSync(join(assets, stale), { force: true })
}
