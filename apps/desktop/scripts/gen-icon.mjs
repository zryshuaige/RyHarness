/**
 * 生成多尺寸 PNG + icon.ico：琥珀 squircle 渐变底 + Fluent Emoji 猫脸（modern，
 * MIT license，资产见 assets/fluent-emoji/）。Fluent Emoji 是矢量——比旧版
 * 手绘剪影精致得多。
 *   pnpm --filter @ryagent/desktop gen:icon
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '../assets')
const outDir = assets

// squircle 底板（超椭圆近似）+ 135° 琥珀渐变
const SQUIRCLE =
  'M512 32 C742 32 992 172 992 512 C992 852 742 992 512 992 C282 992 32 852 32 512 C32 172 282 32 512 32 Z'
const plate = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#FBBF24"/><stop offset="100%" stop-color="#D97706"/>
  </linearGradient></defs>
  <path fill="url(#bg)" d="${SQUIRCLE}"/>
</svg>`)

// Fluent Emoji 猫脸：白色圆底托（Fluent 自带透明底），直接叠在琥珀板上
const catSvg = readFileSync(join(assets, 'fluent-emoji', 'cat-face.svg'), 'utf8')
// 收进 78% 安全区
const cat = Buffer.from(
  catSvg
    .replace('<svg ', '<svg x="113" y="113" width="798" height="798" ')
    .replace('viewBox="0 0 32 32"', 'viewBox="0 0 32 32"'),
)

const master = await sharp(plate)
  .composite([{ input: cat }])
  .png()
  .toBuffer()
writeFileSync(join(outDir, 'icon-master-fluent.png'), master)
console.log('[icon] master composed (fluent cat face)')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = []
for (const size of SIZES) {
  const buffer = await sharp(master).resize(size, size).png().toBuffer()
  writeFileSync(join(outDir, `icon-${size}.png`), buffer)
  pngs.push({ size, buffer })
  console.log(`[icon] icon-${size}.png`)
}

const ico = await pngToIco(
  pngs
    .filter((p) => {
      return [16, 24, 32, 48, 256].includes(p.size)
    })
    .map((p) => {
      return p.buffer
    }),
)
writeFileSync(join(outDir, 'icon.ico'), ico)
console.log('[icon] icon.ico')
