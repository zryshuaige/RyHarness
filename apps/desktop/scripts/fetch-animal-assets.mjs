/**
 * 下载动物形象原图到 assets/animals-raw/。
 *
 * 素材是 AI 生成的**3D 渲染**动物头（正面 + 左 3/4 + 右 3/4）。原图是白底 1K 大图
 * （不入库），抠图裁切后产出入库的 512px 透明 WebP。
 *
 * ## 素材是怎么来的
 *
 * 用本机的 agentic 图像生成（`mcode-tools connector call
 * connector__matrix__generate_image`）。正面图文生图，侧脸图拿正面图当参考做图生图
 * （`input_urls`）——这样同一只动物在三张脸之间是同一只，而且**构图一致**（侧脸
 * 图必须占画面里同一个位置、同一个大小，否则换脸时整只动物会缩一下、往上跳
 * 一下；img2img 的提示词里必须写死"copy the reference image's framing exactly"）。
 *
 * 正面图的提示词模板（每只动物替换主色与物种词）：
 *
 *   Cute stylized 3D {animal} head mascot, Pixar-style animated film character,
 *   smooth rounded soft shapes, big expressive glossy eyes, {特征},
 *   fluffy simplified fur in {饱和主色} with a cream white muzzle,
 *   warm soft studio lighting, adorable and approachable, centered head portrait,
 *   circular composition with even white margins on all four sides, nothing cropped,
 *   plain pure white background, high quality 3D render
 *
 * 两个要点：
 * - **主色要饱和**：毛色靠 CSS filter 染色，饱和的主色才转得出色相（灰的转不动）。
 * - **要有白胸/白嘴**：染色用 `hue-rotate`，它对无彩色像素不生效——白胸会原样
 *   保住，染出来的动物才不是"全身一色"。
 *
 * node_id 是素材的永久标识：写在这里，重跑时按名字对上，而不是靠下载顺序猜。
 * 换一批素材时改这张表 + 重跑 `node scripts/fetch-animal-assets.mjs`。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rawDir = resolve(join(here, '..', 'assets', 'animals-raw'))

/** [动物种类, 脸, node_id]。脸 = front/left/right（视角）/ smile/blink（表情）/ wave（动作）。 */
const ASSETS = [
  ['fox', 'front', '454437427228822'],
  ['fox', 'left', '454437790520362'],
  ['fox', 'right', '454437855581218'],
  ['fox', 'smile', '454443973067763'],
  ['fox', 'blink', '454444592390284'],
  ['fox', 'wave', '454443312873854'],
  ['rabbit', 'front', '454437044236581'],
  ['rabbit', 'left', '454437951726044'],
  ['rabbit', 'right', '454437873828198'],
  ['rabbit', 'smile', '454444900139457'],
  ['rabbit', 'blink', '454444616291019'],
  ['rabbit', 'wave', '454444331065769'],
  ['bear', 'front', '454437721620612'],
  ['bear', 'left', '454437790520364'],
  ['bear', 'right', '454437609673144'],
  ['bear', 'smile', '454444900139463'],
  ['bear', 'blink', '454444833460681'],
  ['bear', 'wave', '454444424802462'],
  ['panda', 'front', '454437427228824'],
  ['panda', 'left', '454438054174930'],
  ['panda', 'right', '454437855581230'],
  ['panda', 'smile', '454444800254290'],
  ['panda', 'blink', '454444848160981'],
  ['panda', 'wave', '454444102152316'],
  ['mouse', 'front', '454436879700350'],
  ['mouse', 'left', '454438054174956'],
  ['mouse', 'right', '454438003610028'],
  ['mouse', 'smile', '454445021574093'],
  ['mouse', 'blink', '454444833460699'],
  ['mouse', 'wave', '454445083283544'],
  ['dog', 'front', '454436809404720'],
  ['dog', 'left', '454438719783995'],
  ['dog', 'right', '454438862296037'],
  ['dog', 'smile', '454445407846656'],
  ['dog', 'blink', '454444808400986'],
  ['dog', 'wave', '454444592390320'],
]

mkdirSync(rawDir, { recursive: true })

for (const [kind, view, nodeId] of ASSETS) {
  const url = JSON.parse(
    execFileSync('mcode-tools', ['get_asset_url', nodeId], {
      encoding: 'utf8',
      // Windows 上 mcode-tools 是 .cmd 包装，不加 shell 找不到可执行文件
      shell: true,
    }),
  ).download_url
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${kind}-${view}: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  // 扩展名按内容判断：抠图脚本按 basename 去扩展名，出来的名字一致
  const ext = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpg' : 'png'
  const out = join(rawDir, `${kind}-${view}.${ext}`)
  writeFileSync(out, buffer)
  console.log(`[fetch] ${kind}-${view} ${(buffer.length / 1024).toFixed(0)}KB`)
}
console.log(`[fetch] 共 ${ASSETS.length} 张 → ${rawDir}`)
