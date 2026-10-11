/**
 * 从 assets/icon-master.svg 生成多尺寸 PNG + icon.ico（sharp + png-to-ico）。
 *   pnpm --filter @ryagent/desktop gen:icon
 */
import sharp from 'sharp'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const here = dirname(fileURLToPath(import.meta.url))
const master = join(here, '../assets/icon-master.svg')
const outDir = join(here, '../assets')

const svg = readFileSync(master)

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = []
for (const size of SIZES) {
  const buffer = await sharp(svg).resize(size, size).png().toBuffer()
  writeFileSync(join(outDir, `icon-${size}.png`), buffer)
  pngs.push({ size, buffer })
  console.log(`[icon] icon-${size}.png`)
}

const ico = await pngToIco(pngs.filter((p) => { return [16, 24, 32, 48, 256].includes(p.size) }).map((p) => { return p.buffer }))
writeFileSync(join(outDir, 'icon.ico'), ico)
console.log('[icon] icon.ico')
