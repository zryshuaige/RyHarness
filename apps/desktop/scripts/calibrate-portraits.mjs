/**
 * 立绘取景标定：在源图上搜出「主体占圆面积落在目标区间」的裁切框。
 *
 * 为什么需要标定而不是手填坐标：主体占圆的比例是**像素面积**（非底色像素 / 圆面积），
 * 它取决于裁切框留了多少底板，手填的坐标只能给出大致值。而「大致」不够——
 * 验收标准要的是 0.62–0.70 这一条窄带，落在带外就是不合规。
 *
 * 做法：固定构图重心（bust = 头肩中心；head = 头部中心），按边长从大到小试，
 * 每次**跑完整管线**再量产物——量的是最终像素，不是源图。源图四角是白底，
 * 直接在源图上量会把白角算成主体，结论是错的。
 *
 * 用法：node scripts/calibrate-portraits.mjs
 */
import { join } from 'node:path'
import { KEYS, normalize, subjectRatio } from './gen-portraits.mjs'

const SRC = join('..', '..', 'src')

/** 构图重心（源图 1024×1024 里的像素）。bust 看头肩，head 看脸。 */
const CENTERS = {
  cat: { bust: { x: 512, y: 470 }, head: { x: 512, y: 400 } },
  dog: { bust: { x: 512, y: 520 }, head: { x: 512, y: 400 } },
  fox: { bust: { x: 512, y: 470 }, head: { x: 512, y: 380 } },
  mask: { bust: { x: 512, y: 500 }, head: { x: 512, y: 400 } },
}

/**
 * 目标：主体面积 / 圆面积。
 *
 * bust（64/256 档，头肩构图）落在 0.62–0.70 —— 这条窄带就是「立绘成一家」的量化口径。
 * head（24 档，脸部特写）落在 0.70–0.95 —— 特写档的脸本来就该占满大部分圆，
 * 上界只是防止「其实没裁到脸，整张方图缩下来」这种假特写。
 *
 * 每一档单独标定：64 档是 256 档的**重采样**（不是同一张图缩下来），抗锯齿与
 * 色距判定在两个尺寸上不完全一致，所以同一个取景框在 64 与 256 上量出的比例
 * 会差百分之一二。一档一个框才靠得住。
 */
const TARGETS = { bust: [0.62, 0.7], head: [0.7, 0.95] }

function makeBox(center, side) {
  const s = Math.round(side)
  let x0 = Math.round(center.x - s / 2)
  let y0 = Math.round(center.y - s / 2)
  x0 = Math.max(0, Math.min(1024 - s, x0))
  y0 = Math.max(0, Math.min(1024 - s, y0))
  return { x0, y0, x1: x0 + s, y1: y0 + s }
}

for (const key of KEYS) {
  const source = join(SRC, `${key}.png`)
  for (const mode of ['bust', 'head']) {
    const [lo, hi] = TARGETS[mode]
    const center = CENTERS[key][mode]
    // 每一档单独标定：64 档不是 256 档的缩放版（它是重新采样的产物），
    // 两个尺寸上的色距判定与抗锯齿不完全一致，同一个框量出的比例会差百分之一二。
    for (const size of mode === 'bust' ? [256, 64] : [24]) {
      let best = null
      let bestErr = Infinity
      for (let side = 1024; side >= 240; side -= 4) {
        const box = makeBox(center, side)
        const buffer = await normalize(source, box, size)
        const ratio = await subjectRatio(buffer)
        const err = ratio < lo ? lo - ratio : ratio > hi ? ratio - hi : 0
        if (err < bestErr) {
          bestErr = err
          best = { box, ratio }
        }
        if (err === 0) break
      }
      // 粗扫之后再细扫一次（步长 1）：粗扫的步长 4 可能整格跳过命中带。
      if (bestErr > 0) {
        const coarse = best.box.x1 - best.box.x0
        for (let side = coarse - 8; side <= coarse + 8; side += 1) {
          if (side < 200) continue
          const box = makeBox(center, side)
          const buffer = await normalize(source, box, size)
          const ratio = await subjectRatio(buffer)
          const err = ratio < lo ? lo - ratio : ratio > hi ? ratio - hi : 0
          if (err < bestErr) {
            bestErr = err
            best = { box, ratio }
          }
          if (err === 0) break
        }
      }
      console.log(
        `${key}.${mode === 'bust' ? `bust${size}` : 'head'}: side=${best.box.x1 - best.box.x0} ratio=${best.ratio.toFixed(3)} ` +
          `box={ x0: ${best.box.x0}, y0: ${best.box.y0}, x1: ${best.box.x1}, y1: ${best.box.y1} }` +
          (bestErr > 0 ? `  (未命中带, 偏差 ${bestErr.toFixed(3)})` : ''),
      )
    }
  }
}
