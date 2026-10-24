/**
 * 供应商品牌标识：SVG → 256px PNG（品牌色满幅 + 白色标识居中）。
 *
 *   node apps/desktop/scripts/gen-provider-logos.mjs
 *
 * ## 为什么需要它
 *
 * 标识会过期：2026-10 时 OpenAI 那一格还是"品牌绿底 + 白 O"的首字母方块（当时
 * Simple Icons 确实没收录），智谱用的根本不是智谱的标识——一屏排开认不出是哪家。
 * 换成真标识时，源 SVG 得有人去取、去光栅化；这个脚本就是那一步，重复可用。
 *
 * ## 规格（与既有 13 张一致）
 *
 * - 256×256，**品牌色铺满**（圆角由界面上的 CSS 裁，图片本身是方的）
 * - 白色标识居中，trim 掉透明边后统一到 168px——各家图标在 24×24 的 viewBox 里
 *   留白不一样，不 trim 的话同一个尺寸下有的显得大有的显得小
 *
 * ## 源从哪来
 *
 * - [Simple Icons](https://simpleicons.org)（CC0）：`https://cdn.simpleicons.org/<slug>`
 * - [LobeHub Icons](https://lobehub.com/icons)（MIT）：
 *   `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/<slug>.svg`
 *
 * 源文件**不入库**：它们是第三方图形，入库就多一份分发物、多一份署名义务，而 PNG
 * 才是应用真正用的东西。脚本每次现取现转，取到的 SVG 缓存在临时目录，重跑不必再下一遍。
 *
 * ## 为什么 density 必设
 *
 * 这些图标的 viewBox 只有 24×24，librsvg 默认就按 24px 渲染再放大，结果是一坨糊的。
 * density=1536 时它按 24×1536/72 = 512px 渲染，放大后边缘是干净的。
 *
 * ## 用法
 *
 * 换一家标识：改下面的 {@link PROVIDERS} 表（slug + 品牌色），然后跑这个脚本。
 */

import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
/** 输出的 PNG 目录（随源码入库，因此是分发物的一部分，NOTICE 里有署名）。 */
const OUT_DIR = join(here, '..', 'assets', 'providers')
/** 取到的源 SVG 缓存在临时目录，不入库。 */
const CACHE_DIR = join(tmpdir(), 'ryharness-provider-logos')

/** 标识在 256 画布里的边长（px）。 */
const GLYPH = 168
/** librsvg 的渲染密度：24×1536/72 = 512px，放大后边缘干净。 */
const DENSITY = 1536

/** 源在哪：Simple Icons（CC0）与 LobeHub Icons（MIT）的单色 svg。 */
const SOURCES = {
  simpleicons: (slug) => `https://cdn.simpleicons.org/${slug}`,
  lobehub: (slug) => `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${slug}.svg`,
}

/**
 * 要重跑的那几家。
 *
 * 键 = 输出的 png 名；值 = 源（哪套 CDN + slug）与品牌色（各家官网主色）。
 * 已经入库且没问题的那些不在表里——这个脚本只负责"换"与"补"，不负责"全量重生成"。
 */
const PROVIDERS = {
  // 官方六瓣结标识（此前是"绿底 + 白 O"的首字母方块）。
  openai: { source: 'lobehub', slug: 'openai', brand: '#10A37F' },
  // 智谱的分子节点标识（此前用的那张不是智谱的标识）。
  zhipu: { source: 'lobehub', slug: 'zhipu', brand: '#2E6AE6' },
}

/** 取源 SVG（带缓存与重试）。 */
async function fetchSvg(source, slug) {
  const file = join(CACHE_DIR, `${source}-${slug}.svg`)
  if (existsSync(file)) return readFileSync(file, 'utf8')
  const url = SOURCES[source](slug)
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!response.ok) throw new Error(`${url} → ${response.status}`)
      const text = await response.text()
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(file, text, 'utf8')
      return text
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error(`取不到源 svg：${url}（${String(lastError)}）`)
}

/**
 * 光栅化一张：品牌色满幅 + 白色标识居中。
 * @param name - 输出的 png 名（不含扩展名）
 * @param svgRaw - 源 SVG 文本
 * @param brand - 品牌色
 */
async function render(name, svgRaw, brand) {
  // 显式把 currentColor 换成白色：SVG 内部的 fill 写在文件里，外层改不动，
  // 而 currentColor 在这里解析成黑——铺到品牌底上就是一块黑图形。
  const svg = svgRaw.replace(/fill="currentColor"/g, 'fill="#FFFFFF"')
  const trimmed = await sharp(Buffer.from(svg, 'utf8'), { density: DENSITY })
    .trim({ threshold: 1 })
    .resize(GLYPH, GLYPH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const meta = await sharp(trimmed).metadata()
  const size = Math.min(meta.width ?? GLYPH, meta.height ?? GLYPH)
  const out = await sharp({
    create: { width: 256, height: 256, channels: 4, background: brand },
  })
    .composite([{ input: trimmed, top: Math.round((256 - size) / 2), left: Math.round((256 - size) / 2) }])
    .png()
    .toBuffer()
  writeFileSync(join(OUT_DIR, `${name}.png`), out)
  console.log(`[gen] ${name}.png  ${out.length} 字节  标识 ${size}px`)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, spec] of Object.entries(PROVIDERS)) {
  const svg = await fetchSvg(spec.source, spec.slug)
  await render(name, svg, spec.brand)
}
