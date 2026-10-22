/**
 * 立绘归一化管线：把「一张 1024×1024 的方图」变成「三档圆形透明底 WebP」。
 *
 * 为什么需要它：立绘此前是四条各写各的路径产出的——底色有琥珀 / 饱和蓝 / 紫蓝三种，
 * 构图有脸部特写 / 全身带道具 / 头戴贝雷帽三种，渲染有 3D 与平面剪影两种，同屏就是
 * 四套语言。统一到「一只暖琥珀底的圆、主体胸像占圆约三分之二」之后，它们才像一家人。
 *
 * 三档的分工：
 * - 256：资料页与 40–96px 的头像
 * - 64：列表小头像
 * - 24：接力链（20px）与群九宫格内格（22–24px）——**这是新增的一档**。此前最小档是
 *   64，浏览器把它缩到 20px 时，柴犬（全身 + 写字板）直接缩成一团蓝色色斑。
 *
 * 底色统一的方式是**逐通道平移**（out = in + (target - plate)），不是重上色：
 * 平移保留全部明暗结构与描边，主体不会被二次调色；四张图的底色本来就只差十几个
 * RGB 单位，平移之后落在同一个暖琥珀上。
 *
 * 取景框由 calibrate-portraits.mjs 标定得出（它跑的是同一条管线，量的是同一批像素），
 * 标定依据是「主体面积 / 圆面积」落在指定区间——这条比例是验收项，不是手感。
 *
 * 用法（从 apps/desktop 目录跑）：
 *   node scripts/gen-portraits.mjs [sourceDir]
 * 源图放在仓库根的 src/ 下（cat / dog / fox / mask 四张方图），产物落在
 * apps/desktop/assets/portraits/。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * 统一底色：四张立绘共用的暖琥珀**洗底**。
 *
 * 为什么是洗底而不是饱和的 amber-500：饱和琥珀与柴犬的芝麻色皮毛几乎同色，
 * 测出来色距只有个位数——那样的底板在 20px 档上会把狗糊成一个色块，而且
 * 「主体占圆面积」这条验收指标也量不准（主体与底板分不开）。浅一档的暖奶油
 * 与所有四个主体都拉得开：猫的橘、狗的褐、狐的银灰、剪影的深棕都压得住。
 */
export const PLATE = { r: 252, g: 236, b: 204 }

/**
 * 判定「这是底板不是主体」的色距阈值。
 *
 * 洗底很浅（接近奶油白），而主体里有奶白色的高光（柴犬的胸口、灰狐的围脖）。
 * 阈值太大就会把高光算成底板、主体面积量不准；太小则底板自身的抗锯齿边缘
 * 会被算成主体。40 落在两者之间：底板内部的抖动在 10 以内，主体高光与底板
 * 的距离在 60 以上。
 */
export const PLATE_TOLERANCE = 40

/** 三档的像素尺寸。 */
export const TIERS = [24, 64, 256]

/**
 * 每张立绘的取景框（源图 1024×1024 里的像素坐标，x0,y0,x1,y1）。
 *
 * bust 档是头肩构图（64 与 256 档），head 档是脸部特写（24 档）。
 * bust 档的 64 与 256 **各有一个框**：64 档不是 256 档的缩放版（它是重新采样的
 * 产物），两个尺寸上的抗锯齿与色距判定不完全一致，同一个框量出的主体比例会差
 * 百分之一二——一档一个框才落在验收带内。
 *
 * 取景框由 calibrate-portraits.mjs 标定：主体面积 / 圆面积落在指定区间
 * （bust 0.62–0.70，head 0.70–0.95），跑的是同一条管线，量的是同一批像素。
 */
export const FRAMING = {
  cat: {
    bust256: { x0: 134, y0: 92, x1: 890, y1: 848 },
    bust64: { x0: 130, y0: 88, x1: 894, y1: 852 },
    head: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
  },
  dog: {
    bust256: { x0: 104, y0: 112, x1: 920, y1: 928 },
    bust64: { x0: 102, y0: 110, x1: 922, y1: 930 },
    head: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
  },
  fox: {
    bust256: { x0: 132, y0: 90, x1: 892, y1: 850 },
    bust64: { x0: 134, y0: 92, x1: 890, y1: 848 },
    head: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
  },
  mask: {
    bust256: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
    bust64: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
    head: { x0: 34, y0: 0, x1: 990, y1: 956 },
  },
}

export const KEYS = Object.keys(FRAMING)

/** 目标目录（相对 apps/desktop）。 */
const OUT_DIR = 'assets/portraits'

/**
 * 圆形遮罩：一块与画布同尺寸的 SVG，中心实、边缘实、中间镂空——用 alpha 通道
 * 乘上去，四角就透明了。r 取画布的一半减 0.5，让圆**相切**于四边（再多一个像素
 * 就会在四角留下一圈发丝级的白边，20px 档上它会变成一圈灰环）。
 */
function circleMask(size) {
  const r = size / 2 - 0.5
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#fff"/></svg>`,
  )
}

/**
 * 把一块方图归一化成「圆底 + 主体居中」。
 *
 * 步骤：取景 → 缩放到目标边长 → 底色平移到 PLATE → 乘圆形遮罩。
 * 主体是带着自己的底进来的（源图本来就在圆里），所以这里不做抠图，只保证
 * 「底色统一 + 形状是圆 + 主体位置正确」。
 */
export async function normalize(source, box, size) {
  const cropped = await sharp(source)
    .extract({ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 })
    .toBuffer()
  const { data, info } = await sharp(cropped).raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: c } = info

  // 底板色 = 画面里占比最大的颜色（底板是面积最大的一块）。
  const counts = new Map()
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * c
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const plate = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number)

  // 逐通道平移到统一底色
  const shift = [PLATE.r - plate[0], PLATE.g - plate[1], PLATE.b - plate[2]]
  const shifted = Buffer.from(data)
  for (let i = 0; i < shifted.length; i += c) {
    for (let k = 0; k < 3; k++) {
      shifted[i + k] = Math.max(0, Math.min(255, shifted[i + k] + shift[k]))
    }
  }

  return sharp(shifted, { raw: { width: w, height: h, channels: c } })
    .resize(size, size, { fit: 'cover' })
    .composite([{ input: circleMask(size), blend: 'dest-in' }])
    .webp({ quality: 88, effort: 6 })
    .toBuffer()
}

/** 一档立绘文件。 */
export function outPath(key, size) {
  return join(OUT_DIR, `${key}-${size}.webp`)
}

/**
 * 产物的「主体面积 / 圆面积」。
 *
 * 这是立绘的验收口径：主体（非底板色像素）占圆盘面积的比例。头肩构图落在
 * 0.62–0.70，脸部特写落在 0.70–0.86——都在带外就是构图不合规。
 *
 * 量的是**编码后**的字节：WebP 是有损压缩，编码前后的颜色会差几个单位，
 * 所以标定与验收必须量同一份东西，否则标定说 0.623、验收量出 0.619，
 * 差这一点就够判不合规。
 */
export async function subjectRatio(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: c } = info
  let subject = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c
      if (data[i + 3] < 128) continue
      const d = Math.hypot(data[i] - PLATE.r, data[i + 1] - PLATE.g, data[i + 2] - PLATE.b)
      if (d > PLATE_TOLERANCE) subject++
    }
  }
  return subject / (Math.PI * (w / 2) * (w / 2))
}

async function main() {
  const sourceDir = process.argv[2] ?? join('..', '..', 'src')
  for (const key of KEYS) {
    const source = join(sourceDir, `${key}.png`)
    if (!existsSync(source)) {
      throw new Error(`缺少源图：${source}`)
    }
    for (const size of TIERS) {
      // 24 档用「脸部特写」取景：脸占圆约八成，去掉道具与气泡
      const box = size === 24 ? FRAMING[key].head : FRAMING[key][`bust${size}`]
      const buffer = await normalize(source, box, size)
      // **原样落盘**：normalize 返回的已经是编码好的 WebP 字节，再走一遍
      // sharp(buffer).toFile() 会把它解码再编码一次（有损压缩叠一次），于是
      // 「标定时量的」与「验收时量的」不是同一份字节——剪影那种大片纯色尤其敏感。
      writeFileSync(outPath(key, size), buffer)
    }
    console.log(`${key}: ${TIERS.join('/')} 已生成`)
  }
  console.log(`底色统一为 rgb(${PLATE.r},${PLATE.g},${PLATE.b})`)
}

// 直接运行时才产出（被 import 时只提供函数）。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main()
}
