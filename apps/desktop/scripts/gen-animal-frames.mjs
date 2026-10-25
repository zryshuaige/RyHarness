/**
 * 动物形象**动画帧表**的生成与下载（构建期跑一次）。
 *
 * 产物：`apps/desktop/assets/animals-raw/frames/<set>-<state>.jpg`（4×4 帧表，不入库）
 * 配套：`apps/desktop/assets/animals-raw/frames/manifest.json`（帧表的 node_id，永久标识）
 *
 * ## 为什么要有帧表
 *
 * 此前"动物在动"靠的是 CSS 变换：1–2px 的位移、1° 左右的摇摆、2% 的缩放。那是**一张
 * 静止的头在抖**，不是动物在干活——用户要的是"动物真的在敲键盘、真的在想"。那就只能
 * 给它真的帧。
 *
 * ## 为什么是 4×4 帧表
 *
 * 逐帧单独生成的话，同一只动物在第 3 帧和第 7 帧会长得不一样（脸型变、耳朵位置变），
 * 播起来像换人。一次生成一张 4×4 的帧表，16 帧由**同一次生成**画出来，角色一致性
 * 最高；帧与帧之间只有爪子、眼睛、耳朵在动。
 *
 * ## 素材是怎么来的
 *
 * 用本机的 agentic 图像生成（`mcode-tools connector call
 * connector__matrix__generate_image`）。每一张帧表都以**现有的静态形象**为参考图
 * （`input_urls`），于是动画里的这只动物就是头像位那只：立绘走 `assets/portraits/`
 * 的写实毛发风，立体动物走 `assets/animals/` 的 3D 卡通风。
 *
 * 参考图要先传成临时 URL（`mcode-tools upload_temp_url`），所以这个脚本自己上传。
 *
 * node_id 写在 manifest.json 里：重跑时按名字对上，而不是靠下载顺序猜。
 *
 * 用法：node scripts/gen-animal-frames.mjs [--only <set>-<state>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const rawDir = join(desktop, 'assets', 'animals-raw', 'frames')
const manifestPath = join(rawDir, 'manifest.json')

/** 帧表列数 / 行数：一行四个、总共四行 = 16 帧。 */
const COLS = 4
const ROWS = 4

/**
 * 每一套形象的描述。
 *
 * - `set`：帧集键，落进文件名与资源表。
 * - `style`：`3d` = Pixar 卡通渲染（立体动物通道）；`real` = 写实毛发渲染（立绘通道）。
 * - `ref`：作为图生图参考的现有静态形象。
 * - `subject`：提示词里的主语与特征描述。
 */
const SETS = [
  {
    set: 'an3d-dog',
    style: '3d',
    ref: 'assets/animals/dog-front.webp',
    subject:
      'a cute 3D cartoon Shiba Inu puppy head, Pixar style, soft fluffy cream fur, big amber eyes, small black nose',
  },
  {
    set: 'an3d-fox',
    style: '3d',
    ref: 'assets/animals/fox-front.webp',
    subject:
      'a cute 3D cartoon red fox head, Pixar style, soft fluffy orange-red fur, big amber eyes, small black nose, white cheeks',
  },
  {
    set: 'an3d-rabbit',
    style: '3d',
    ref: 'assets/animals/rabbit-front.webp',
    subject:
      'a cute 3D cartoon white rabbit head, Pixar style, soft fluffy white fur with long upright ears, big glossy dark eyes, small pink nose',
  },
  {
    set: 'an3d-bear',
    style: '3d',
    ref: 'assets/animals/bear-front.webp',
    subject:
      'a cute 3D cartoon brown bear cub head, Pixar style, soft fluffy warm brown fur, big warm brown eyes, small dark brown nose',
  },
  {
    set: 'an3d-panda',
    style: '3d',
    ref: 'assets/animals/panda-front.webp',
    subject:
      'a cute 3D cartoon giant panda head, Pixar style, soft fluffy black and white fur, big dark eyes, small black nose',
  },
  {
    set: 'an3d-mouse',
    style: '3d',
    ref: 'assets/animals/mouse-front.webp',
    subject:
      'a cute 3D cartoon little mouse head, Pixar style, soft fluffy grey fur, huge round ears, big glossy dark eyes, small pink nose',
  },
  {
    set: 'cat',
    style: 'real',
    ref: 'assets/portraits/cat-256.webp',
    subject: 'a real orange tabby cat, head and shoulders, soft detailed fur, big amber eyes, small pink nose',
  },
  {
    set: 'dog',
    style: 'real',
    ref: 'assets/portraits/dog-256.webp',
    subject: 'a real Shiba Inu dog, head and shoulders, soft detailed sesame fur, big dark eyes, small black nose',
  },
  {
    set: 'fox',
    style: 'real',
    ref: 'assets/portraits/fox-256.webp',
    subject: 'a real silver grey fox, head and shoulders, soft detailed silver fur, big amber eyes, small black nose',
  },
  {
    set: 'brand',
    style: 'brand',
    ref: 'assets/icon-256.png',
    subject:
      'the same app-icon badge as the reference image: a warm amber rounded-square plate with a cute orange tabby kitten peeking over the top edge, two small white front paws resting on the plate bottom edge, big glossy eyes',
  },
]

/** 三种状态：敲键盘、托腮想、张嘴说话。 */
const STATES = [
  {
    state: 'typing',
    /** 动作描述（进提示词）。 */
    motion:
      'typing on a keyboard: both small front paws rest on the keys, then one paw lifts while the other presses a key, then both press down, then the other paw lifts, repeating; the eyes glance down at the keys and the head bobs gently with every keystroke',
  },
  {
    state: 'thinking',
    motion:
      'thinking with one front paw resting against its chin, the eyes slide slowly from side to side as if puzzling something out, one ear twitches, the brow furrows and the eyes half close, then the eyes widen and look straight ahead, repeating',
  },
  {
    state: 'talking',
    motion:
      'speaking: the mouth opens and closes as if talking, the head bobs gently with the rhythm, the ears perk and tilt a little, the eyes blink now and then; the whole body stays in place',
  },
]

/**
 * 帧表的 node_id —— **永久标识**，写在这里。
 *
 * 原图不入库（`assets/animals-raw/` 在 .gitignore 里），所以标识必须留在仓库里：
 * 重跑时按名字对上，而不是靠下载顺序猜。格式与 fetch-animal-assets.mjs 的那张表一样。
 */
const SOURCES = [
  ['an3d-dog-typing', '456158419472662'],
  ['an3d-dog-thinking', '456158903697497'],
  ['an3d-fox-typing', '456158362665528'],
  ['an3d-fox-thinking', '456158675104031'],
  ['an3d-rabbit-typing', '456158959481056'],
  ['an3d-rabbit-thinking', '456159179911628'],
  ['an3d-bear-typing', '456159126770636'],
  ['an3d-bear-thinking', '456159459356870'],
  ['an3d-panda-typing', '456159452934413'],
  ['an3d-panda-thinking', '456159002325104'],
  ['an3d-mouse-typing', '456159049449905'],
  ['an3d-mouse-thinking', '456158296830142'],
  ['cat-typing', '456159660355714'],
  ['cat-thinking', '456158903697531'],
  ['dog-typing', '456159375991328'],
  ['dog-thinking', '456158688084599'],
  ['fox-typing', '456160006345282'],
  ['fox-thinking', '456159677804705'],
  ['an3d-dog-talking', '456159842427361'],
  ['an3d-fox-talking', '456159660355748'],
  ['an3d-rabbit-talking', '456160126075089'],
  ['an3d-bear-talking', '456159485661564'],
  ['an3d-panda-talking', '456159485661566'],
  ['an3d-mouse-talking', '456159660355752'],
  ['cat-talking', '456159853064568'],
  ['dog-talking', '456160006345323'],
  ['fox-talking', '456160610099589'],
  ['brand-typing', '456159842427390'],
  ['brand-thinking', '456160708391047'],
  ['brand-talking', '456159928852652'],
]

/** 帧表提示词。 */
function promptFor(set, state) {
  const head =
    set.style === '3d'
      ? `the same ${set.subject}, a close-up head portrait cropped at the chest, head filling the frame`
      : set.style === 'real'
        ? `the same ${set.subject}, a head-and-shoulders studio portrait, head filling the frame`
        : set.subject
  const look =
    set.style === '3d'
      ? 'Pixar-style 3D render, soft studio lighting, high quality'
      : set.style === 'real'
        ? 'photorealistic studio photograph, soft even studio lighting, sharp fur detail, shallow depth of field'
        : 'high quality 3D render, soft studio lighting'
  const still =
    set.style === 'brand'
      ? 'Only the kitten moves; the amber plate stays perfectly still and identical in every panel.'
      : 'Identical character design and identical framing in all 16 panels, only the paws, eyes, brows, mouth and ears move.'
  return [
    `Animation sprite sheet: ONE square image divided into a ${COLS}-column by ${ROWS}-row grid of ${COLS * ROWS} equal square panels, packed edge to edge with no gaps, no borders, no separator lines, no text, no numbers.`,
    `The ${COLS * ROWS} panels read left to right and top to bottom as ONE continuous seamless animation loop.`,
    `Subject in every panel: ${head}, EXACTLY the same head position, same size, same camera angle and the same lighting as the reference image.`,
    `A small warm cream-coloured keyboard peeks in at the very bottom edge of every panel, showing only the top row of keys and the animal's two small front paws on it.`,
    `The loop: the animal is ${state.motion}.`,
    still,
    `Plain pure white background, no ground shadow, no text, ${look}.`,
  ].join(' ')
}

/** 跑一条命令。 */
function run(args, input) {
  return execFileSync('mcode-tools', args, {
    encoding: 'utf8',
    shell: true,
    ...(input === undefined ? {} : { input }),
  })
}

/** 上传一张参考图，拿到临时 URL。 */
function uploadRef(relative) {
  const file = join(desktop, relative)
  if (!existsSync(file)) {
    throw new Error(`参考图不存在：${file}`)
  }
  return JSON.parse(run(['upload_temp_url', file])).temp_url
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined

mkdirSync(rawDir, { recursive: true })
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}

/** 参考图按 set 缓存（同一只动物的两张状态共用一张参考）。 */
const refUrls = new Map()
for (const set of SETS) {
  if (refUrls.has(set.set)) continue
  console.log(`[frames] 上传参考图 ${set.set} ← ${set.ref}`)
  refUrls.set(set.set, uploadRef(set.ref))
}

const jobs = []
for (const set of SETS) {
  for (const state of STATES) {
    const key = `${set.set}-${state.state}`
    if (only !== undefined && only !== key) continue
    jobs.push({ key, set, state })
  }
}

if (jobs.length === 0) {
  throw new Error(`没有匹配的任务：${only ?? ''}`)
}

/**
 * 三种来源，按顺序取：
 *
 * 1. **本地已有**：原图就在 raw 目录里（断点续传）——什么都不用做。
 * 2. **node_id 已知**：{@link SOURCES} 表里有的，直接按 id 取回。素材是永久的，
 *    重新生成一遍只会得到另一只狗（同一只动物靠参考图保证，但细节会变）。
 * 3. **都没有**：现生成。
 */
const known = new Map(SOURCES)

/** 把一个 node_id 取回并落盘。 */
async function download(nodeId, key, ref) {
  const url = JSON.parse(run(['get_asset_url', nodeId])).download_url
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${key}: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const ext = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpg' : 'png'
  writeFileSync(join(rawDir, `${key}.${ext}`), buffer)
  manifest[key] = { node_id: nodeId, ref, file: `${key}.${ext}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[frames] ${key} ${(buffer.length / 1024).toFixed(0)}KB node=${nodeId}`)
}

const pending = []
for (const job of jobs) {
  const entry = manifest[job.key]
  if (entry !== undefined && existsSync(join(rawDir, entry.file))) {
    console.log(`[frames] ${job.key} 已有，跳过`)
    continue
  }
  const nodeId = known.get(job.key)
  if (nodeId !== undefined) {
    console.log(`[frames] ${job.key} 按 node_id 取回…`)
    await download(nodeId, job.key, job.set.ref)
    continue
  }
  pending.push(job)
}
if (pending.length === 0) {
  console.log('[frames] 全部齐了，无需生成')
} else {
  console.log(`[frames] 生成 ${pending.length} 张帧表…`)
}

/**
 * 一次只发几张。
 *
 * 18 张 2K 一次发过去，整批会被服务端拒掉（返回体里既没有 success_items 也没有
 * failed_items，看着像"全部失败"）。分批 + 失败重试才稳。
 */
const BATCH = 3
for (let start = 0; start < pending.length; start += BATCH) {
  const chunk = pending.slice(start, start + BATCH)
  const requests = chunk.map((job) => {
    return {
      prompt: promptFor(job.set, job.state),
      aspect_ratio: '1:1',
      resolution: '2K',
      input_urls: [refUrls.get(job.set.set)],
      output_file: `${job.key}.jpg`,
    }
  })
  const argsFile = join(tmpdir(), `ry-frames-${Date.now()}.json`)
  writeFileSync(argsFile, JSON.stringify({ requests }, null, 2))

  let result = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = JSON.parse(run(['connector', 'call', 'connector__matrix__generate_image', '--args-file', argsFile]))
    } catch (error) {
      console.warn(`[frames] 第 ${attempt + 1} 次调用报错：${String(error).slice(0, 200)}`)
      result = null
    }
    if (result !== null && (result.success_items ?? []).length > 0) break
    console.warn(`[frames] 这一批没出图（第 ${attempt + 1} 次），重试…`)
  }
  if (result === null) {
    console.error(`[frames] 这一批彻底失败：${chunk.map((job) => job.key).join(', ')}`)
    continue
  }
  const byName = new Map()
  for (const item of result.success_items ?? []) {
    byName.set(item.file_name.replace(/\.[a-z]+$/i, ''), item)
  }
  for (const item of result.failed_items ?? []) {
    console.error(`[frames] 生成失败：${JSON.stringify(item)}`)
  }
  for (const job of chunk) {
    const item = byName.get(job.key)
    if (item === undefined) {
      console.error(`[frames] ${job.key} 没有产出`)
      continue
    }
    await download(item.node_id, job.key, job.set.ref)
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[frames] 共 ${jobs.length} 张 → ${rawDir}`)
