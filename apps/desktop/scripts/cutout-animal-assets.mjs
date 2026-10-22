/**
 * 动物形象资产：抠图 + 裁切 + 缩放（构建期跑一次）。
 *
 * 输入：AI 生成的「纯白底」动物 3D 渲染图（1K PNG/JPG），放在 raw 目录下。
 * 输出：透明背景的 WebP（512px），写进 apps/desktop/assets/animals/。
 *
 * 为什么用 Electron 而不是纯 Node：本机没有 sharp / jimp 这类图像库，而 Chromium
 * 自带完整的 Canvas 2D —— 读像素、抠图、缩放、编码 WebP 全都能做，**不新增任何
 * npm 依赖**（verify:deps 是硬门禁）。
 *
 * 四步：
 * 1. **抠图**：白底 + 柔和投影，用「只抠与画面边缘连通的近白像素」的做法。直接按
 *    亮度抠会把眼睛高光、白毛一起抠穿；连通性判断能保住主体内部的白色。抠完做
 *    一次去污染（unpremultiply），否则边缘会留一圈灰影。
 * 2. **裁掉胸口**：构图是「头 + 胸」，胸被画成了圆的底部。从下往上扫，第一次出现
 *    「上面比下面窄」的那一行就是圆弧顶点（头与胸的分界），裁到那儿就只剩一颗
 *    头——头像本来也只需要头。找不到（长耳的兔子是方胸）就退回到裁 25%。
 * 3. **统一变换**：同一只动物的**三张脸必须用同一套缩放与对齐**。三张图各自
 *    算的话，主体在画面里的位置与大小都不一样，运行时从正面换到侧脸，整只动物
 *    会「跳」一下——这是最扎眼的破绽，比画质差更难受。所以：先各自量出「主体到
 *    圆心的距离」，取**三张里最紧的那个**当统一缩放，再把三张的主体都对到圆心。
 * 4. **缩到圆里**：头像盘是圆的，整只动物必须完整落在圆内。距离用**分位数**而
 *    不是最大值——耳尖那几根毛刺是最远的几个像素，却会把整只动物压小（头在圆里
 *    只占一半，缩略图上根本认不出是只狐狸）。
 *
 * 用法：electron scripts/cutout-animal-assets.mjs [raw 目录]
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const rawDir = resolve(process.argv[2] ?? join(desktop, 'assets', 'animals-raw'))
const outDir = join(desktop, 'assets', 'animals')

/** 同一只动物的三张脸（顺序固定：正面 / 左 / 右）。 */
const VIEWS = ['front', 'left', 'right']
/** 动物种类。 */
const KINDS = ['fox', 'rabbit', 'bear', 'panda', 'mouse', 'dog']

/**
 * 脸。
 *
 * - GROUP：同一个头部的几种脸，**必须用同一套缩放与对齐**（正面、左 3/4、右
 *   3/4、微笑、眨眼）。换脸时主体不许缩、不许移——各自算一套的话，切换时整只
 *   动物会"跳"一下。
 * - SOLO：挥手的构图不同（头肩、举爪），单独算自己的缩放与居中。
 */
const GROUP = ['front', 'left', 'right', 'smile', 'blink']
const SOLO = ['wave']

/** 在页面里跑的抠图实现（用 string 注入，避免 file:// 的 module CORS 问题）。 */
const CUTOUT = `
/**
 * 抠一张：去白底 → 裁胸口 → 量出主体的位置与「能进圆的最大缩放」。
 * 返回的是**未缩放**的原图与几何量，缩放由 cutAll 统一决定。
 */
async function cutOne(fileBase64) {
  const bin = atob(fileBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const bmp = await createImageBitmap(new Blob([bytes]))
  const w = bmp.width
  const h = bmp.height
  const cv = new OffscreenCanvas(w, h)
  const ctx = cv.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const n = w * h

  // 1) 近白候选（低饱和 + 高亮度）
  const cand = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const r = d[o], g = d[o + 1], b = d[o + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mn > 214 && mx - mn < 26) cand[i] = 1
  }

  // 2) 从画面边界 BFS，只标记与边缘连通的背景
  const bg = new Uint8Array(n)
  const stack = []
  const push = (x, y) => {
    const i = y * w + x
    if (cand[i] && !bg[i]) { bg[i] = 1; stack.push(i) }
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w
    const y = (i / w) | 0
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }

  // 3) 硬 alpha + 去污染（把背景白从边缘像素里减掉，否则留灰影）
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (bg[i]) { d[o + 3] = 0; continue }
    let edge = 0
    const x = i % w, y = (i / w) | 0
    if (x > 0 && bg[i - 1]) edge++
    if (x < w - 1 && bg[i + 1]) edge++
    if (y > 0 && bg[i - w]) edge++
    if (y < h - 1 && bg[i + w]) edge++
    if (edge === 0) continue
    const a = 1 - edge / 4
    for (let k = 0; k < 3; k++) {
      d[o + k] = Math.max(0, Math.min(255, Math.round((d[o + k] - (1 - a) * 255) / a)))
    }
    d[o + 3] = Math.round(a * 255)
  }
  ctx.putImageData(img, 0, 0)

  // 4) 每行的宽度
  const rowWidth = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let lo = -1
    let hi = -1
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (lo < 0) lo = x
        hi = x
      }
    }
    rowWidth[y] = hi < 0 ? 0 : hi - lo + 1
  }

  // 5) 主体包围盒
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    if (rowWidth[y] === 0) continue
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; break }
    }
    for (let x = w - 1; x >= 0; x--) {
      if (d[(y * w + x) * 4 + 3] > 24) { if (x > maxX) maxX = x; break }
    }
    if (minY === h) minY = y
    maxY = y
  }
  if (maxX < 0) throw new Error('抠完什么都没有')

  // 6) 裁掉胸口：找圆弧顶点
  let peak = h - 1
  for (let y = h - 2; y >= 0; y--) {
    if (rowWidth[y] < rowWidth[y + 1]) { peak = y + 1; break }
  }
  const cutY = peak > h * 0.9 ? Math.round(h * 0.75) : Math.min(h - 1, peak + Math.round((peak - minY) * 0.05))
  maxY = Math.min(maxY, cutY)

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02)
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1

  // 7) 主体像素的**重心**（alpha 加权）与到重心的距离分位数。
  //    用重心而不是包围盒中心：毛发分布不均，重心落在脸的比重心落在"耳朵到下巴
  //    的中点"更准；而且重心对齐时，像素到盘心的距离**随缩放线性变化**，能精确
  //    求解统一缩放系数（用包围盒中心则不行，量出来的距离不是它在盘里的实际距离）。
  const BUCKETS = 256
  const maxDist = Math.hypot(cw, ch) / 2
  const hist = new Int32Array(BUCKETS)
  let opaque = 0
  let sumX = 0
  let sumY = 0
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = d[(y * w + x) * 4 + 3]
      if (a <= 24) continue
      opaque++
      sumX += x
      sumY += y
    }
  }
  if (opaque === 0) throw new Error('抠完什么都没有')
  const gx = sumX / opaque
  const gy = sumY / opaque
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (d[(y * w + x) * 4 + 3] <= 24) continue
      const r = Math.hypot(x - gx, y - gy)
      hist[Math.min(BUCKETS - 1, Math.floor((r / maxDist) * BUCKETS))]++
    }
  }
  let acc = 0
  let far = maxDist
  for (let i = BUCKETS - 1; i >= 0; i--) {
    acc += hist[i]
    if (acc >= opaque * 0.02) { far = ((i + 1) / BUCKETS) * maxDist; break }
  }

  return { cv, minX, minY, cw, ch, gx, gy, far }
}

/**
 * 把一张按给定缩放画到 512 盘上：**重心** → 盘心。
 *
 * 重心对齐时，像素到盘心的距离 = 它到重心的距离 × 缩放，所以统一缩放系数可以
 * 精确算出来：三张脸用同一个系数，换脸时主体既不缩也不移。
 */
function place(item, scale, outSize) {
  const out = new OffscreenCanvas(outSize, outSize)
  const ctx = out.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  const dw = item.cw * scale
  const dh = item.ch * scale
  const x = outSize / 2 + (item.minX - item.gx) * scale
  const y = outSize / 2 + (item.minY - item.gy) * scale
  ctx.drawImage(item.cv, item.minX, item.minY, item.cw, item.ch, x, y, dw, dh)
  return out
}

/** 编码成 WebP 的 base64。 */
async function encode(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
  const ab = await blob.arrayBuffer()
  let s = ''
  const u8 = new Uint8Array(ab)
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH))
  }
  return btoa(s)
}

/**
 * 处理同一只动物的三张脸：**重心对齐**，各自按自己的轮廓撑满盘。
 *
 * 为什么不是「三张用同一个缩放系数」：那样宽脸的狗会被尖耳的狐狸拖小一截
 * （实测差 23%），一排头像里大小不齐。而各自撑满的话，三张在盘里**都是满的**，
 * 视觉大小天然一致；重心对齐又保证换脸时主体不移动。
 *
 * @param files 三张原图（正面 / 左 / 右）的 base64
 * @param outSize 输出边长
 * @param quality WebP 质量
 * @param fill 主体在盘里占的比例（0.96 留 4% 给 3D 倾斜的透视放大）
 */
async function cutAll(files, outSize, quality, fill) {
  const items = []
  for (const b64 of files) items.push(await cutOne(b64))
  const limit = (outSize / 2) * fill
  const outs = []
  const scales = []
  for (const it of items) {
    // 重心对齐时，像素到盘心的距离 = 到重心的距离 × 缩放
    const scale = limit / it.far
    scales.push(scale)
    outs.push(await encode(place(it, scale, outSize), quality))
  }
  return { outs, scales, far: items.map((it) => Math.round(it.far)) }
}
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })
  await win.loadURL('data:text/html,<html><body></body></html>')
  await win.webContents.executeJavaScript(CUTOUT)

  mkdirSync(outDir, { recursive: true })
  for (const kind of KINDS) {
    const find = (face) => {
      const found = readdirSync(rawDir).find((name) => {
        return name.startsWith(`${kind}-${face}.`)
      })
      if (found === undefined) throw new Error(`缺 ${kind}-${face}`)
      return found
    }
    // 同一头部的那几张脸：统一缩放 + 重心对齐，换脸时主体不缩不移。
    const groupNames = GROUP.map(find)
    const groupFiles = groupNames.map((name) => readFileSync(join(rawDir, name)).toString('base64'))
    // 质量 0.78：512px 的头像上看不出 0.86 与 0.78 的差别，但体积差三成
    const group = await win.webContents.executeJavaScript(`cutAll(${JSON.stringify(groupFiles)}, 512, 0.78, 0.96)`)
    GROUP.forEach((face, index) => {
      const out = join(outDir, `${kind}-${face}.webp`)
      writeFileSync(out, Buffer.from(group.outs[index], 'base64'))
    })
    // 挥手：构图不同（头肩 + 举爪），单独算自己的缩放与居中。
    const soloNames = SOLO.map(find)
    const soloFiles = soloNames.map((name) => readFileSync(join(rawDir, name)).toString('base64'))
    const solo = await win.webContents.executeJavaScript(`cutAll(${JSON.stringify(soloFiles)}, 512, 0.78, 0.96)`)
    SOLO.forEach((face, index) => {
      const out = join(outDir, `${kind}-${face}.webp`)
      writeFileSync(out, Buffer.from(solo.outs[index], 'base64'))
    })
    console.log(
      `[cutout] ${kind} 头部组缩放 ${group.scales.map((s) => Math.round(s * 100)).join('/')}% far=${group.far.join('/')} · 挥手 ${Math.round(solo.scales[0] * 100)}%`,
    )
  }
  console.log(`[cutout] 共 ${KINDS.length * VIEWS.length} 张 → ${outDir}`)
  app.quit()
})
