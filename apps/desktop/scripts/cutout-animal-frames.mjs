/**
 * 动物动画帧表 → 精灵图（构建期跑一次）。
 *
 * 输入：`assets/animals-raw/frames/<set>-<state>.jpg`（4×4 帧表，AI 生成）
 * 输出：`assets/animals/frames/<set>-<state>.webp`（1024×1024，每格 256px，透明底）
 *
 * ## 为什么输出**一张精灵图**而不是 16 个文件
 *
 * 一次对话里会同时有若干个助理在动，每个都要播 16 帧。16 个文件就是 16 个请求；
 * 一张精灵图是 1 个请求，浏览器只解码一次，播放时切 `background-position`——
 * 帧与帧之间不会因为某一张没到而错帧。
 *
 * ## 四步
 *
 * 1. **切格**：4×4 等分。实测模型画的内容确实落在各自的四分之一里（每帧内容约
 *    470px，格子 512px，四周各留一点白），所以等分切是准的。
 * 2. **抠图**：白底转透明。不能用「按亮度抠」——兔子的白毛、熊猫的白眼圈、熊的奶白
 *    嘴筒都会被抠穿。做法与 `cutout-animal-assets.mjs` 一致：**只抠与画面边缘连通的
 *    近白像素**，主体内部的白保住；边缘做一次去污染，否则会留一圈灰影。
 *    耳朵与头之间那块被围住的底也要抠掉——它是背景，不是白毛。
 * 3. **裁掉键盘**：打字与说话的画面里有一整排键盘，它比头还宽。按全身取景会把头
 *    压成小小一团，40px 的头像上根本认不出是谁。裁掉键盘之后，画面回到「头 + 胸口
 *    + 爪子」。
 * 4. **统一比例与落位**：16 帧必须用**同一个缩放**、**同一个落位**。
 *
 *    这一步此前错过一次，值得写清楚：缩放与落位必须**用同一套基准**。当时缩放按
 *    「头部半径」算、落位按「头部中心」算——头被放到格子正中，爪子与键盘就被挤出
 *    格子，画面上只剩一颗悬在中间的狗头。现在统一按**主体包围盒**：缩放让包围盒的
 *    较大一边占满格子，落位让包围盒中心落在格子中心。两者自洽，主体必然整幅在格子里。
 *
 * 用法：node scripts/cutout-animal-frames.mjs
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const rawDir = join(desktop, 'assets', 'animals-raw', 'frames')
const outDir = join(desktop, 'assets', 'animals', 'frames')

/** 帧表：4 列 4 行。 */
const COLS = 4
const ROWS = 4
/** 每格的输出边长（px）。 */
const CELL = 256

/**
 * 每套形象的取景比例：主体在格子里占多大。
 *
 * - 立体动物（3D 卡通）与立绘（写实毛发）：按主体包围盒的较大一边算，头约格子的
 *   45%——与静态立绘「头占圆里六成」接近。
 * - 品牌徽标：方形徽标铺满整格，再由头像的圆形外壳裁圆，与静态那版一致。
 */
const SETS = {
  an3d: 0.96,
  portrait: 0.94,
  brand: 1,
}

/**
 * 每种状态的**裁切**：主体高度里保留多少（从头顶往下量）。
 *
 * 打字的画面底部是一整排键盘。裁到 0.93：爪子正好留全，键盘只剩一条边——
 * 那一条奶油色的边反而说明「它坐在桌前」，比裁得干干净净更说得清。
 */
const CROP = {
  typing: 0.93,
  thinking: 1,
  talking: 0.93,
}

/** 近白候选：低饱和 + 高亮度。 */
function isBackgroundCandidate(r, g, b) {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return mn > 214 && mx - mn < 26
}

/**
 * 白底转透明。
 *
 * 两步：
 *
 * 1. **与边缘连通的近白像素** = 背景（主流程，和 cutout-animal-assets.mjs 一样）。
 * 2. **被主体围住的近白空洞**：耳朵与头之间那一小块白底就是这种——它不与画面边缘
 *    连通，边缘连通法抠不到，会在头上留一条白带（截图里一眼就能看见）。
 *    判定它是不是背景靠三条：亮度与面板底色接近（差 < 24）、内部够平（标准差 < 10）。
 *    毛是彩色的、脸上那块白毛有纹理，两条都过不了——所以白毛不会被误抠。
 *
 * @param rgb 原始 RGB 像素（就地做去污染）
 * @param width - 宽
 * @param height - 高
 * @returns alpha 通道（Uint8Array，长度 = width*height）
 */
function cutoutAlpha(rgb, width, height) {
  const n = width * height
  const cand = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 3
    if (isBackgroundCandidate(rgb[o], rgb[o + 1], rgb[o + 2])) cand[i] = 1
  }
  // 从画面边界 BFS：只标记与边缘连通的背景
  const bg = new Uint8Array(n)
  const stack = []
  const push = (x, y) => {
    const i = y * width + x
    if (cand[i] === 1 && bg[i] === 0) {
      bg[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (stack.length > 0) {
    const i = stack.pop()
    const x = i % width
    const y = (i / width) | 0
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(i - width)
    if (y < height - 1) push(i + width)
  }

  // 面板底色：取四边像素的平均亮度（就是那块白底）
  let edgeSum = 0
  let edgeCount = 0
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const o = (y * width + x) * 3
      edgeSum += (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3
      edgeCount++
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      const o = (y * width + x) * 3
      edgeSum += (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3
      edgeCount++
    }
  }
  const edgeMean = edgeCount === 0 ? 255 : edgeSum / edgeCount

  // 找被围住的近白空洞（连通块里没碰到画面的）
  const seen = new Uint8Array(n)
  const holeStack = []
  for (let start = 0; start < n; start++) {
    if (cand[start] === 0 || seen[start] === 1) continue
    const pixels = []
    let touches = false
    holeStack.length = 0
    holeStack.push(start)
    seen[start] = 1
    while (holeStack.length > 0) {
      const i = holeStack.pop()
      pixels.push(i)
      const x = i % width
      const y = (i / width) | 0
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true
      const add = (j) => {
        if (cand[j] === 1 && seen[j] === 0) {
          seen[j] = 1
          holeStack.push(j)
        }
      }
      if (x > 0) add(i - 1)
      if (x < width - 1) add(i + 1)
      if (y > 0) add(i - width)
      if (y < height - 1) add(i + width)
    }
    if (touches) {
      // 与边缘连通：已经是背景
      for (const i of pixels) bg[i] = 1
      continue
    }
    // 封闭的近白块：算亮度与方差
    let sum = 0
    let sumSq = 0
    for (const i of pixels) {
      const o = i * 3
      const lum = (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3
      sum += lum
      sumSq += lum * lum
    }
    const mean = sum / pixels.length
    const std = Math.sqrt(Math.max(0, sumSq / pixels.length - mean * mean))
    if (Math.abs(mean - edgeMean) < 24 && std < 10) {
      for (const i of pixels) bg[i] = 1
    }
  }

  // alpha：背景 0，内部 255，边缘按邻居数做软过渡；同时把背景白从边缘像素里减掉
  const alpha = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (bg[i] === 1) continue
    const x = i % width
    const y = (i / width) | 0
    let edge = 0
    if (x > 0 && bg[i - 1] === 1) edge++
    if (x < width - 1 && bg[i + 1] === 1) edge++
    if (y > 0 && bg[i - width] === 1) edge++
    if (y < height - 1 && bg[i + width] === 1) edge++
    if (edge === 0) {
      alpha[i] = 255
      continue
    }
    const a = 1 - edge / 4
    alpha[i] = Math.round(a * 255)
    const o = i * 3
    for (let k = 0; k < 3; k++) {
      rgb[o + k] = Math.max(0, Math.min(255, Math.round((rgb[o + k] - (1 - a) * 255) / a)))
    }
  }
  return alpha
}

/**
 * 找出**贯穿整张帧表**的黑色分隔线。
 *
 * 模型在格子之间画了一道细黑线。它落在切格的边界上，于是被当成主体：包围盒被撑到
 * 整格大小（511px），缩放按整格算，主体在格子里就只剩一小块；那条线还会跟着进到
 * 精灵图里，变成一圈黑框。
 *
 * 判据是「一条线」而不是「一块暗」：某一行（或某一列）里有一段**连续**的暗像素，
 * 长度超过半张图——那才是线。狗身上的阴影、瞳孔都不成段。
 *
 * 必须在**整张图**上找：线横跨两格，单独看一格，它只是边界上的一小段。
 *
 * @param rgb 整张帧表的原始像素
 * @param width - 宽
 * @param height - 高
 * @returns 掩码：1 = 这像素是分隔线
 */
function findSeparatorLines(rgb, width, height) {
  const mask = new Uint8Array(width * height)
  const at = (x, y) => (y * width + x) * 3
  const isDark = (x, y) => {
    const o = at(x, y)
    return Math.min(rgb[o], rgb[o + 1], rgb[o + 2]) < 110
  }
  /** 把一条线所占的那几行/几列标出来（线有 4~8px 厚，且边缘有抗锯齿）。 */
  const mark = (horizontal, index) => {
    for (let d = -3; d <= 3; d++) {
      const k = index + d
      if (k < 0 || k >= (horizontal ? height : width)) continue
      for (let t = 0; t < (horizontal ? width : height); t++) {
        const x = horizontal ? t : k
        const y = horizontal ? k : t
        const o = at(x, y)
        // 连线附近的非白像素一起标掉：线的抗锯齿边缘是灰的，漏掉会留一像素的黑边
        if (Math.min(rgb[o], rgb[o + 1], rgb[o + 2]) < 245) mask[y * width + x] = 1
      }
    }
  }
  for (let y = 0; y < height; y++) {
    let run = 0
    for (let x = 0; x < width; x++) {
      if (isDark(x, y)) {
        run++
        if (run > width * 0.5) mark(true, y)
      } else {
        run = 0
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0
    for (let y = 0; y < height; y++) {
      if (isDark(x, y)) {
        run++
        if (run > height * 0.5) mark(false, x)
      } else {
        run = 0
      }
    }
  }
  return mask
}

/**
 * 一格的主体几何。
 *
 * @param alpha - alpha 通道
 * @param width - 宽
 * @param height - 高
 * @param crop - 主体高度里保留多少（1 = 全留）
 * @returns 主体包围盒
 */
function geometry(alpha, width, height, crop) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 24) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('这一格抠完什么都没有')
  // 裁掉底部（键盘）
  const cutY = Math.round(minY + (maxY - minY) * crop)
  if (cutY < maxY) {
    for (let y = cutY + 1; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        alpha[y * width + x] = 0
      }
    }
    maxY = cutY
  }
  // 主体是否被格子边切到了（切到了说明这一帧没被完整切下来）
  const clipped = minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2
  return { minX, minY, maxX, maxY, clipped }
}

/** 中位数。 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

if (!existsSync(rawDir)) {
  throw new Error(`没有帧表目录：${rawDir}`)
}
const manifestPath = join(rawDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  throw new Error(`没有 manifest：${manifestPath}（先跑 gen-animal-frames.mjs）`)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

mkdirSync(outDir, { recursive: true })

for (const [key, entry] of Object.entries(manifest)) {
  const source = join(rawDir, entry.file)
  if (!existsSync(source)) {
    console.warn(`[frames] 跳过（缺源图）：${key}`)
    continue
  }
  const state = key.slice(key.lastIndexOf('-') + 1)
  const set = key.slice(0, key.lastIndexOf('-'))
  const fill = set.startsWith('an3d-') ? SETS.an3d : set === 'brand' ? SETS.brand : SETS.portrait
  const crop = CROP[state] ?? 1

  const sheet = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const sw = sheet.info.width
  const sh = sheet.info.height
  const cellW = Math.floor(sw / COLS)
  const cellH = Math.floor(sh / ROWS)
  const lines = findSeparatorLines(sheet.data, sw, sh)

  // 1) 切格 + 抠图 + 取景几何
  const cells = []
  let clippedCount = 0
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const left = col * cellW
      const top = row * cellH
      const width = col === COLS - 1 ? sw - left : cellW
      const height = row === ROWS - 1 ? sh - top : cellH
      const part = await sharp(sheet.data, { raw: { width: sw, height: sh, channels: 3 } })
        .extract({ left, top, width, height })
        .raw()
        .toBuffer()
      const rgb = Buffer.from(part)
      // 把这一格范围内属于分隔线的像素刷白（掩码是在整张图上算的）
      for (let ly = 0; ly < height; ly++) {
        for (let lx = 0; lx < width; lx++) {
          if (lines[(top + ly) * sw + (left + lx)] === 1) {
            const o = (ly * width + lx) * 3
            rgb[o] = 255
            rgb[o + 1] = 255
            rgb[o + 2] = 255
          }
        }
      }
      const alpha = cutoutAlpha(rgb, width, height)
      const geo = geometry(alpha, width, height, crop)
      if (geo.clipped) clippedCount++
      cells.push({ rgb, alpha, width, height, geo })
    }
  }

  // 2) 统一缩放与落位（同一套基准：主体包围盒）
  const refCx = median(cells.map((c) => (c.geo.minX + c.geo.maxX) / 2))
  const refCy = median(cells.map((c) => (c.geo.minY + c.geo.maxY) / 2))
  const refSize = median(cells.map((c) => Math.max(c.geo.maxX - c.geo.minX, c.geo.maxY - c.geo.minY)))
  const scale = (CELL * fill) / Math.max(1, refSize)

  // 3) 逐帧落位，拼成一张精灵图
  const sheetW = CELL * COLS
  const sheetH = CELL * ROWS
  const out = Buffer.alloc(sheetW * sheetH * 4)
  for (let index = 0; index < cells.length; index++) {
    const { rgb, alpha, width, height } = cells[index]
    const dw = Math.round(width * scale)
    const dh = Math.round(height * scale)
    const x = Math.round(CELL / 2 - refCx * scale)
    const y = Math.round(CELL / 2 - refCy * scale)
    const cellX = (index % COLS) * CELL
    const cellY = Math.floor(index / COLS) * CELL
    for (let sy = 0; sy < dh; sy++) {
      const srcY = Math.min(height - 1, Math.floor(sy / scale))
      const dstY = cellY + y + sy
      if (dstY < 0 || dstY >= sheetH) continue
      for (let sx = 0; sx < dw; sx++) {
        const srcX = Math.min(width - 1, Math.floor(sx / scale))
        const dstX = cellX + x + sx
        if (dstX < 0 || dstX >= sheetW) continue
        const s = (srcY * width + srcX) * 3
        const a = alpha[srcY * width + srcX]
        if (a === 0) continue
        const d = (dstY * sheetW + dstX) * 4
        out[d] = rgb[s]
        out[d + 1] = rgb[s + 1]
        out[d + 2] = rgb[s + 2]
        out[d + 3] = a
      }
    }
  }

  const target = join(outDir, `${key}.webp`)
  await sharp(out, { raw: { width: sheetW, height: sheetH, channels: 4 } })
    .webp({ quality: 82, effort: 6 })
    .toFile(target)
  const size = (await sharp(target).metadata()).size ?? 0
  console.log(
    `[frames] ${key} → ${(size / 1024).toFixed(0)}KB  缩放 ${(scale * 100).toFixed(0)}%  主体 ${refSize.toFixed(0)}px${clippedCount > 0 ? `  ⚠ ${clippedCount} 格被切到边` : ''}`,
  )
}
console.log(`[frames] 精灵图 → ${outDir}`)
