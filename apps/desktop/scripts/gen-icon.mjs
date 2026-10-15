/**
 * 生成 RyAgent 全部图形资产（可重复运行）：
 *   pnpm --filter @ryagent/desktop gen:icon
 *
 * 唯一主角是 assets/brand/ 下的几何橘猫（纯矢量，本项目原创）：琥珀渐变
 * squircle 底板 + 圆头宽三角耳猫。历史版本曾用微软 Fluent Emoji 猫脸当
 * 软件图标（第三方贴纸感、与品牌橘不一致），现已全部改为本仓库母版。
 *
 * 尺寸分级（16/24/32/48/64/128/256）是导出的核心：每一档都是拿母版**独立**
 * 栅格化并按该尺寸做过光学补偿，不是拿 256 档降采样。同一份母版缩到 16px 时
 * 五官会一起糊掉（眼直径只剩 1.35px、嘴的描边不到半个像素），所以小尺寸档要
 * 加粗五官、必要时直接删掉细节（见 TIERS）。补偿只动半径/描边/取舍，坐标一律
 * 来自 assets/brand/cat-face.svg 这一个真源。
 *
 * 产物：
 * - icon.svg            彩色母版（底板 + 猫）
 * - icon-{16..256}.png  分级位图（逐档光学补偿）；icon-512/1024.png 走母版原样
 * - icon.ico            Windows 图标（16/24/32/48/256）
 * - icon-mono.svg/.png  单色版（深色底场景：深色标签页的 favicon）
 * - favicon.svg/.png    浏览器标签页
 * - tiers.json          分级契约（托盘/窗口各取哪一档 + 每档的补偿参数）
 * - renderer/public/    favicon 与单色版的可服务副本（vite 原样拷进 dist 根目录）
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '../assets')
const brand = join(assets, 'brand')
const publicDir = join(here, '../renderer/public')

// 64×64 设计网格：底板 2..62，猫头 r17 居中 (32,36)，耳尖 y≈10.4。
const SQUIRCLE =
  'M32 2 C46.375 2 62 10.75 62 32 C62 53.25 46.375 62 32 62 C17.625 62 2 53.25 2 32 C2 10.75 17.625 2 32 2 Z'
// 墨色要在这里写死成静态属性（渲染层才会翻主题），奶油脸底则由母版自带。
const INK = '#4a2e1a'
/**
 * 每档的光学补偿：`eye` 是眼睛半径、`mouth` 是嘴的描边宽（0 = 该尺寸下直接删掉，
 * 一条 0.5px 的线只是噪点）、`nose` 是鼻子放大倍数。
 *
 * 阈值按栅格化后的实际像素宽度定的：嘴宽 × size/64 ≥ 1px 才留得下（16px 档只有
 * 0.48px，删）；眼睛直径 × size/64 ≥ 1.5px 才看得见（16px 档母版值只有 1.35px，
 * 补到 1.7px）。≥48px 档母版值本身就够用，补偿退回 1:1。
 */
const TIERS = [
  { size: 16, eye: 3.4, mouth: 0, nose: 1 },
  { size: 24, eye: 3.1, mouth: 2.7, nose: 1.15 },
  { size: 32, eye: 2.9, mouth: 2.4, nose: 1 },
  { size: 48, eye: 2.8, mouth: 2.1, nose: 1 },
  { size: 64, eye: 2.7, mouth: 1.9, nose: 1 },
  { size: 128, eye: 2.7, mouth: 1.9, nose: 1 },
  { size: 256, eye: 2.7, mouth: 1.9, nose: 1 },
]

/** 母版原样导出的两档超大图（安装包封面、文档插图用）：这两档不补偿。 */
const PLAIN_SIZES = [512, 1024]

/** favicon 与应用图标同图，只多给一条 shape-rendering（小尺寸边缘更稳）。 */
const crisp = (svg) => {
  return svg.replace('<svg ', '<svg shape-rendering="geometricPrecision" ')
}

/** 母版里的 class 只服务于应用内主题样式（ink / inkf / face 都是给渲染层 CSS 用的
 * 钩子，静态产物里没有对应的样式表）。逐个改写成静态属性：ink 变成写死的描边色，
 * 其余直接剥掉——漏一个就会把无意义的 class 泄漏进 icon.svg。 */
const stripClasses = (svg) => {
  return svg
    .replaceAll('class="ink" ', `stroke="${INK}" `)
    .replaceAll('class="inkf" ', '')
    .replaceAll('class="face" ', '')
}

const SHELL =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64" role="img" aria-label="RyAgent">'
const GRADIENT =
  '<defs><linearGradient id="ryagent-plate" x1="0%" y1="0%" x2="100%" y2="100%">' +
  '<stop offset="0%" stop-color="#FBBF24"/><stop offset="100%" stop-color="#D97706"/>' +
  '</linearGradient></defs>'

const EYE = /(<circle class="inkf" cx="[\d.]+" cy="[\d.]+" r=")[\d.]+(")/g
const MOUTH = /\n?[ \t]*<path class="ink" [^>]*\/>\n?/
const MOUTH_STROKE = /style="stroke-width:[\d.]+"/
const NOSE = /<path class="inkf" d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z"/

/**
 * 按一档的补偿参数改写母版：只改半径、描边与取舍，不动任何坐标。模式没命中就抛错
 * ——正则悄悄失配等于这一档悄悄退回没补偿，图标看着「差不多」就没人会发现。
 */
function applyTier(master, tier) {
  const eyes = master.match(EYE)
  if (eyes === null || eyes.length !== 2) {
    throw new Error(`[icon] 母版里应有两颗眼，实际 ${String(eyes?.length ?? 0)}`)
  }
  // 用回调而不是 $1 拼接：替换文本形如 `$13.4` 会被当成第 13 个捕获组。
  let svg = master.replace(EYE, (_match, head, tail) => {
    return `${head}${tier.eye}${tail}`
  })
  if (tier.mouth === 0) {
    if (!MOUTH.test(svg)) throw new Error('[icon] 母版里没找到嘴，简化规则已失效')
    svg = svg.replace(MOUTH, '\n')
  } else {
    // 判据是「模式有没有命中」而不是「字符串有没有变」：≥64px 档的补偿值与母版
    // 同值，字符串本就不变，拿变化当命中会把大尺寸档全部误判成规则失效。
    if (!MOUTH_STROKE.test(svg)) throw new Error('[icon] 母版里没找到嘴的描边，加粗规则已失效')
    svg = svg.replace(MOUTH_STROKE, `style="stroke-width:${tier.mouth}"`)
  }
  if (tier.nose !== 1) {
    if (!NOSE.test(svg)) throw new Error('[icon] 母版里没找到鼻子，放大规则已失效')
    svg = svg.replace(NOSE, (node) => {
      return node.replace(' d=', ` transform="translate(32 41) scale(${tier.nose}) translate(-32 -41)" d=`)
    })
  }
  return svg
}

/**
 * 单色版直接从母版派生：把主题钩子换成写死的墨色描边，再补上渲染层那条
 * stroke-linecap；配色（奶油脸底 + 墨色五官）就是母版自带的两种颜色。
 * 早期版本在脚本里手抄了一份头与五官，母版一改就跟着跑偏——这里不许再抄。
 */
const monoFrom = (faceSvg) => {
  return faceSvg
    .replaceAll('class="ink" ', `stroke="${INK}" stroke-linecap="round" `)
    .replaceAll('class="inkf" ', '')
    .replaceAll('class="face" ', '')
    .replace('style="stroke-width:', 'stroke-width="')
}

/** 彩色母版：琥珀 squircle + 按档补偿过的几何橘猫脸。 */
const colorSvg = (faceSvg) => {
  return `${SHELL}${GRADIENT}<path fill="url(#ryagent-plate)" d="${SQUIRCLE}"/>${stripClasses(faceSvg)}</svg>`
}

/** 单色版：只有猫（连底板都不要），深色底上直接可用。 */
const monoSvg = (faceSvg) => {
  return `${SHELL}${monoFrom(faceSvg)}</svg>`
}

const render = async (svg, size) => {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
}

/** 取某一档的补偿参数（512/1024 走母版原样，不在表里）。 */
function tierOf(size) {
  const tier = TIERS.find((candidate) => {
    return candidate.size === size
  })
  if (tier === undefined) throw new Error(`[icon] ${size} 不在分级表里`)
  return tier
}

const faceIdle = readFileSync(join(brand, 'cat-face.svg'), 'utf8').trim()

async function main() {
  const iconSvg = colorSvg(faceIdle)
  const mono = monoSvg(faceIdle)
  const faviconSvg = crisp(iconSvg)
  // 母版随时会加新的主题钩子，class 一旦漏进静态产物就没人会注意到，直到图标显示错。
  for (const [name, svg] of [
    ['icon.svg', iconSvg],
    ['favicon.svg', faviconSvg],
    ['icon-mono.svg', mono],
  ]) {
    if (svg.includes('class="')) throw new Error(`[icon] ${name} 残留 class 钩子，静态产物不应带 class`)
    writeFileSync(join(brand, name), `${svg}\n`)
  }
  console.log('[icon] brand/icon.svg, brand/favicon.svg, brand/icon-mono.svg')

  // 分级导出：逐档独立栅格化，不共用 256 档那张位图。
  const pngs = []
  for (const tier of TIERS) {
    const tuned = applyTier(faceIdle, tier)
    const buffer = await render(colorSvg(tuned), tier.size)
    writeFileSync(join(assets, `icon-${tier.size}.png`), buffer)
    writeFileSync(join(assets, `icon-mono-${tier.size}.png`), await render(monoSvg(tuned), tier.size))
    pngs.push({ size: tier.size, buffer })
  }
  // 超大档走母版原样，不做任何补偿。
  for (const size of PLAIN_SIZES) {
    writeFileSync(join(assets, `icon-${size}.png`), await render(iconSvg, size))
    writeFileSync(join(assets, `icon-mono-${size}.png`), await render(mono, size))
  }
  console.log(`[icon] icon-{${[...TIERS.map((tier) => tier.size), ...PLAIN_SIZES].join(',')}}.png, icon-mono-*.png`)

  writeFileSync(
    join(assets, 'icon.ico'),
    await pngToIco(
      pngs
        .filter((png) => {
          return [16, 24, 32, 48, 256].includes(png.size)
        })
        .map((png) => {
          return png.buffer
        }),
    ),
  )
  console.log('[icon] icon.ico')

  writeFileSync(join(assets, 'favicon-32.png'), await render(crisp(colorSvg(applyTier(faceIdle, tierOf(32)))), 32))
  for (const size of [128, 512]) {
    writeFileSync(join(assets, `favicon-${size}.png`), await render(faviconSvg, size))
  }
  console.log('[icon] favicon-*.png')

  // 分级契约：主进程按这张表取托盘/窗口档位，测试按这张表核对每个产物与补偿参数。
  // 全是对象、没有数组：仓库的 biome 会把短数组压成一行，JSON.stringify 展开的
  // 数组与之对不上，产物就会每次生成都把 biome check 弄红。
  writeFileSync(
    join(brand, 'tiers.json'),
    `${JSON.stringify(
      {
        tray: 'icon-16.png',
        trayHiDpi: 'icon-24.png',
        window: 'icon-256.png',
        favicon: 'favicon.svg',
        faviconPng: 'favicon-32.png',
        mono: 'icon-mono.svg',
        tuning: Object.fromEntries(
          TIERS.map((tier) => {
            return [String(tier.size), { eye: tier.eye, mouth: tier.mouth, nose: tier.nose }]
          }),
        ),
      },
      null,
      2,
    )}\n`,
  )
  console.log('[icon] brand/tiers.json')

  // 网页端标签页要从主进程的 HTTP server 取到：vite 把 public/ 原样拷进 dist 根目录。
  mkdirSync(publicDir, { recursive: true })
  for (const [name, from] of [
    ['favicon.svg', join(brand, 'favicon.svg')],
    ['favicon-32.png', join(assets, 'favicon-32.png')],
    ['icon-mono.svg', join(brand, 'icon-mono.svg')],
  ]) {
    writeFileSync(join(publicDir, name), readFileSync(from))
  }
  console.log('[icon] renderer/public/{favicon.svg,favicon-32.png,icon-mono.svg}')

  // 旧的第三方 Emoji 合成母版与手绘领结猫母版已废弃，清掉避免继续被误用。
  for (const stale of ['icon-master-fluent.png', 'icon-master.svg']) {
    rmSync(join(assets, stale), { force: true })
  }
}

await main()
