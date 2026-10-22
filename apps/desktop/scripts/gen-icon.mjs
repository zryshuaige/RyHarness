/**
 * 从**位图母版**导出 RyHarness 的全部图形资产（可重复运行、完全离线，只读本仓库内的文件）：
 *   pnpm --filter @ryharness/desktop gen:icon
 *
 * 母版是 assets/brand/mark.png：一只橘猫（大眼、微笑、两只前爪搭在底板边缘），坐在琥珀
 * 色圆角方形底板上，暖色调，与界面调性同源。项目自有资产，来源与授权见
 * apps/desktop/docs/brand/icon.md。
 *
 * 这里不再有矢量母版。此前是「几何 SVG 母版 → 逐档栅格化 + 小尺寸档光学补偿（加粗五官、
 * 删细节）」，那一整套补偿逻辑（tiers.json 的 tuning 表、渲染层 <Cat> 的 applyTier）
 * 随矢量母版一起作废：位图母版的五官本来就是实心的，没有可加粗也没有可删的图元。
 *
 * 每档都是**独立从母版栅格化**，不是从 1024 或从 256 降采样。降采样只会把上一档的
 * 结果再缩小一遍：母版的缩放核一旦在小尺寸上把五官糊掉，后面的降采样拿不回细节。
 *
 * ## 为什么九档全都取整幅、都扣圆角（实测依据，逐条在 docs/brand/icon.md 里）
 *
 * 曾经 24/32/48 三档裁到脸、满出血直角方块，其余档整幅加圆角。结果同一枚托盘图标在
 * 非 HiDPI 下是圆角、HiDPI 下是直角，同一枚 favicon 在 32 与 128 尺寸下形状不同。
 * 两条路二选一，实测都指向「取消裁脸」：
 *
 * 1. **给裁脸档也扣同一个圆角 → 必然削耳。** 半径 0.245·S 的圆角只保住裁窗顶边中间
 *    51% 宽的像素。母版上两只耳尖实测在 x≈234 与 x≈708（横向跨度 474px），要让它们
 *    都落进安全带需要 474 ≤ 0.51·S，即 S ≥ 929——母版边长只有 953，而窗还得再让出
 *    耳尖的纵向余量，实际只剩「整幅」这一档成立。换句话说「裁脸 + 圆角」不是风格选择，
 *    是几何上做不到。
 * 2. **不扣圆角 → 整幅档会丢掉底板的圆角轮廓。** 母版本身就是抠好的圆角底板，Windows
 *    任务栏/托盘与标签页 favicon 都是圆角更可识别，退成硬方块是把品牌资产做差。
 *
 * 所以：九档（含 favicon）一律整幅 + 同一个圆角遮罩，托盘的 16 档与 HiDPI 24 档从此
 * 是同一枚图的两次缩放，不再是两种零件。16px 的可读性另有一组实测数字支撑这个选择
 * （见 docs/brand/icon.md「16px 到底糊不糊」）。
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '../assets')
const brand = join(assets, 'brand')
const publicDir = join(here, '../renderer/public')

/** 母版文件名（assets/brand/ 下）。改母版只改这一处引用。 */
export const MASTER = 'mark.png'
/** 母版边长。母版是从原始素材裁到琥珀底板本体之后的无损重编码（见 docs/brand/icon.md）。 */
export const MASTER_SIZE = 953
/** 底板圆角半径（占边长比）。与母版自带的圆角一致，让派生档的角与母版对得上。 */
export const PLATE_RADIUS = 0.245

/**
 * 逐档策略表：只有尺寸，没有裁窗。九档取同一枚母版、同一套圆角，导出结果之间不可能
 * 出现「形状随尺寸变」的分叉（brand-tiers.test.ts 逐档比对母版缩放结果把它钉住）。
 */
export const TIERS = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

/**
 * 主进程按这张表取档位（electron/main.ts 的 ICON_TIER 是它的镜像）。
 * 托盘只有 16/24 两个物理尺寸，直接喂对应档位，不另做托盘专用资产：
 * 两档现在来自同一个裁窗，只差缩放，不会在同一个托盘里混出两种轮廓。
 */
export const WIRING = {
  tray: 'icon-16.png',
  trayHiDpi: 'icon-24.png',
  window: 'icon-256.png',
}

/**
 * 非 icon-NNN.png 的几份派生图：既是 assets/ 下的产物，也拷一份进 renderer/public/
 * （vite 把 public/ 原样拷进 dist 根目录，主进程以 /app 伺服，渲染层按 /app/<名> 取）。
 *
 * 用哪一档：标签页要小而清楚（32 档），2x 标签页与大图要用 128 档；应用内 <Cat> 与启动屏
 * 共用 256 档——104px 的欢迎页在 2x 屏上正好 1:1。
 */
export const DERIVED = {
  brand: { file: 'cat.png', size: 256 },
  favicon: { file: 'favicon-32.png', size: 32 },
  faviconLarge: { file: 'favicon-128.png', size: 128 },
}

/** renderer/public/ 下的文件名（index.html 与 <Cat> 按这套名字引用）。 */
export const PUBLIC = Object.fromEntries(
  Object.entries(DERIVED).map(([key, spec]) => {
    return [key, spec.file]
  }),
)

/** 圆角方形的 alpha 遮罩。母版之外的角是抠出来的，这一步保证派生档的角不会多出一圈白边。 */
function plateMask(size) {
  const radius = Math.round(size * PLATE_RADIUS)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
  return Buffer.from(svg)
}

/**
 * 母版必须是本脚本准备好的那一版：边长对上、带 alpha。母版被换成别的图（尺寸不同、
 * 或没抠角）时逐档导出仍然会「成功」，只是任务栏上多一圈白角——这里让它当场失败。
 */
async function readMaster() {
  const meta = await sharp(join(brand, MASTER)).metadata()
  if (meta.width !== MASTER_SIZE || meta.height !== MASTER_SIZE) {
    throw new Error(`${MASTER} 应为 ${MASTER_SIZE}×${MASTER_SIZE}，实际 ${meta.width}×${meta.height}`)
  }
  if (meta.hasAlpha !== true) throw new Error(`${MASTER} 必须带 alpha 通道（四角已抠圆）`)
}

/** 一档位图：母版独立缩放到该尺寸，再扣同一个圆角遮罩。九档走的是同一条路径。 */
async function render(size) {
  return await sharp(join(brand, MASTER))
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .composite([{ input: plateMask(size), blend: 'dest-in' }])
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer()
}

/** 分级契约：档位表、圆角与接线文件名，测试按这一份核对每个产物。 */
function manifest() {
  return {
    master: MASTER,
    masterSize: MASTER_SIZE,
    plateRadius: PLATE_RADIUS,
    ...WIRING,
    ...PUBLIC,
    icons: Object.fromEntries(
      TIERS.map((size) => {
        return [
          String(size),
          {
            file: `icon-${size}.png`,
            // 每档都从整幅母版缩放 + 扣圆角，没有裁窗，因此 mask 对九档一视同仁。
            masked: true,
          },
        ]
      }),
    ),
  }
}

async function main() {
  await readMaster()
  console.log(`[icon] 母版 ${MASTER} ${MASTER_SIZE}×${MASTER_SIZE}`)

  for (const size of TIERS) {
    writeFileSync(join(assets, `icon-${size}.png`), await render(size))
  }
  console.log(`[icon] icon-{${TIERS.join(',')}}.png`)

  // Windows 图标：任务栏、标题栏、Alt-Tab、资源管理器用的都是这一个文件。
  const icoSizes = [16, 24, 32, 48, 64, 256]
  const frames = []
  for (const size of icoSizes) {
    frames.push(await render(size))
  }
  writeFileSync(join(assets, 'icon.ico'), await pngToIco(frames))
  console.log(`[icon] icon.ico (${icoSizes.join('/')})`)

  writeFileSync(join(brand, 'tiers.json'), `${JSON.stringify(manifest(), null, 2)}\n`)
  console.log('[icon] brand/tiers.json')

  // 渲染层要能从主进程的 HTTP server 取到这些图（vite 把 public/ 原样拷进 dist 根目录）。
  mkdirSync(publicDir, { recursive: true })
  for (const spec of Object.values(DERIVED)) {
    writeFileSync(join(assets, spec.file), await render(spec.size))
    copyFileSync(join(assets, spec.file), join(publicDir, spec.file))
  }
  console.log(
    `[icon] renderer/public/{${Object.values(DERIVED)
      .map((spec) => spec.file)
      .join(',')}}`,
  )
}

// 被测试以模块方式导入时不要顺手把产物重写一遍。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
