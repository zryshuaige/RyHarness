// @vitest-environment jsdom
/**
 * 动物形象的动作帧：素材、映射与渲染。
 *
 * 这一层要钉的是**产品承诺**：动物在动的时候是"真的在动"——有帧、有套数、有节奏，
 * 而不是一张静止的头在抖。
 *
 * 钉住的四件事：
 *
 *   1. **素材齐全**：每个形象 × 每种状态都有一张精灵图，格式与体积都是像样的
 *      （不是空壳、不是占位图）。
 *   2. **帧表真的不一样**：同一套形象的不同状态、以及同一状态的不同形象，
 *      精灵图必须互不相同——否则"打字"和"思考"播出来是同一出戏。
 *   3. **映射正确**：头像字段 → 帧集、动作 → 帧状态，两条都不能错。
 *   4. **渲染接线**：该播的时候播帧、不该播的时候播静态图；尺寸太小时不播。
 *
 * @module @ryharness/desktop/tests/avatar-frames
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AVATAR_FRAME_MIN_SIZE,
  type AvatarFrameSet,
  type AvatarFrameState,
  FRAME_COLS,
  FRAME_COUNT,
  FRAME_ROWS,
  frameAllowed,
  frameCycleMs,
  frameSetOf,
  frameSheetStyle,
  frameSheetUrl,
  frameStateOf,
} from '../renderer/src/lib/avatar-frames.ts'
import { avatarTemperamentOf } from '../renderer/src/lib/avatar-motion.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAME_DIR = join(DESKTOP, 'assets', 'animals', 'frames')

/** 全部帧集。 */
const SETS: readonly AvatarFrameSet[] = [
  'an3d-dog',
  'an3d-fox',
  'an3d-rabbit',
  'an3d-bear',
  'an3d-panda',
  'an3d-mouse',
  'cat',
  'dog',
  'fox',
  'brand',
]

/** 全部帧状态。 */
const STATES: readonly AvatarFrameState[] = ['typing', 'thinking', 'talking']

describe('动作帧素材', () => {
  it('每个形象 × 每种状态都有一张精灵图', () => {
    for (const set of SETS) {
      for (const state of STATES) {
        expect(existsSync(join(FRAME_DIR, `${set}-${state}.webp`)), `${set}-${state}`).toBe(true)
      }
    }
  })

  it('目录里没有多余的文件（每一份都有对应的帧集）', () => {
    const files = readdirSync(FRAME_DIR).filter((name) => {
      return name.endsWith('.webp')
    })
    expect(files.length).toBe(SETS.length * STATES.length)
  })

  it('每张都是 4×4 的精灵图（1024×1024，每格 256px）', async () => {
    for (const set of SETS) {
      for (const state of STATES) {
        const meta = await sharp(join(FRAME_DIR, `${set}-${state}.webp`)).metadata()
        expect(meta.width, `${set}-${state}`).toBe(FRAME_COLS * 256)
        expect(meta.height, `${set}-${state}`).toBe(FRAME_ROWS * 256)
        // 透明底：没有 alpha 通道的话，白底会直接糊在头像上
        expect(meta.hasAlpha, `${set}-${state}`).toBe(true)
      }
    }
  })

  it('每份都是像样的 WebP（几十 KB 起，不是空壳）', () => {
    for (const set of SETS) {
      for (const state of STATES) {
        const bytes = readFileSync(join(FRAME_DIR, `${set}-${state}.webp`))
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
        expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
        expect(bytes.length, `${set}-${state}`).toBeGreaterThan(16 * 1024)
        expect(bytes.length, `${set}-${state}`).toBeLessThan(400 * 1024)
      }
    }
  })

  it('不同的状态播出来不是同一出戏', () => {
    for (const set of SETS) {
      const sheets = STATES.map((state) => {
        return readFileSync(join(FRAME_DIR, `${set}-${state}.webp`)).toString('base64')
      })
      expect(new Set(sheets).size, set).toBe(STATES.length)
    }
  })

  it('不同的形象也不是同一张图', () => {
    const sheets = SETS.map((set) => {
      return readFileSync(join(FRAME_DIR, `${set}-typing.webp`)).toString('base64')
    })
    expect(new Set(sheets).size).toBe(SETS.length)
  })

  it('一套精灵图里的 16 帧彼此不同（不然不是动画，是同一张图重复了 16 次）', async () => {
    for (const set of SETS) {
      const raw = await sharp(join(FRAME_DIR, `${set}-typing.webp`))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const { width, height, channels } = raw.info
      /** 取第 index 帧（4×4 网格，行优先）的像素。 */
      const frame = (index: number): Uint8Array => {
        const cellX = (index % FRAME_COLS) * 256
        const cellY = Math.floor(index / FRAME_COLS) * 256
        const out = new Uint8Array(256 * 256 * 4)
        for (let y = 0; y < 256; y++) {
          const from = ((cellY + y) * width + cellX) * channels
          out.set(raw.data.subarray(from, from + 256 * channels), y * 256 * 4)
        }
        return out
      }
      /** 两帧的平均差（0 = 一模一样）。 */
      const diff = (a: Uint8Array, b: Uint8Array): number => {
        let sum = 0
        for (let i = 0; i < a.length; i++) {
          sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
        }
        return sum / a.length
      }
      // 相邻两帧之间必须有肉眼可见的差别（这是"动物真的在动"的硬证据）
      for (let index = 0; index < FRAME_COUNT - 1; index++) {
        const d = diff(frame(index), frame(index + 1))
        expect(d, `${set} 第 ${index} 帧与第 ${index + 1} 帧`).toBeGreaterThan(0.6)
      }
      // 首尾也要接得上（循环播放时不会突然跳一下）
      expect(diff(frame(0), frame(FRAME_COUNT - 1)), set).toBeGreaterThan(0.6)
      expect(height).toBe(FRAME_ROWS * 256)
    }
  })
})

describe('头像字段与动作的映射', () => {
  it('立体动物走自己的帧集', () => {
    expect(frameSetOf('an3d:dog:30')).toBe('an3d-dog')
    expect(frameSetOf('an3d:panda:200')).toBe('an3d-panda')
  })

  it('立绘与品牌猫各走各的', () => {
    expect(frameSetOf('dog')).toBe('dog')
    expect(frameSetOf('fox')).toBe('fox')
    // 品牌橘猫是徽标，不是立绘通道里的那张橘猫
    expect(frameSetOf('cat')).toBe('brand')
  })

  it('没有形象素材的一律不播帧', () => {
    expect(frameSetOf(undefined)).toBeUndefined()
    expect(frameSetOf('db:dylan:seed')).toBeUndefined()
    expect(frameSetOf('mask')).toBeUndefined()
    expect(frameSetOf('🐈')).toBeUndefined()
  })

  it('思考与说话各对应一套', () => {
    expect(frameStateOf('pondering')).toBe('thinking')
    expect(frameStateOf('speaking')).toBe('talking')
  })

  it('按帧集与状态取得到精灵图 URL', () => {
    expect(frameSheetUrl('dog', 'typing')).toContain('dog-typing')
    expect(frameSheetUrl('brand', 'talking')).toContain('brand-talking')
    expect(frameSheetUrl('an3d-panda', 'thinking')).toContain('an3d-panda-thinking')
  })

  it('闲置、在听、打招呼没有帧（那些走 CSS 微动效）', () => {
    expect(frameStateOf('idle')).toBeUndefined()
    expect(frameStateOf('breathing')).toBeUndefined()
    expect(frameStateOf('listening')).toBeUndefined()
    expect(frameStateOf('greeting')).toBeUndefined()
  })
})

describe('节奏', () => {
  it('帧率落在 7–20fps：低了会一顿一顿，高了只是多烧电', () => {
    for (const motion of ['cat', 'dog', 'fox', 'plain'] as const) {
      for (const temperament of [
        undefined,
        { extroversion: 90, rigor: 10, humor: 80 },
        { extroversion: 10, rigor: 90, humor: 20 },
      ]) {
        const profile = avatarTemperamentOf(temperament, motion)
        for (const state of STATES) {
          const cycle = frameCycleMs(state, profile)
          const fps = (FRAME_COUNT / cycle) * 1000
          expect(fps, `${motion}/${state}`).toBeGreaterThanOrEqual(6)
          expect(fps, `${motion}/${state}`).toBeLessThanOrEqual(22)
        }
      }
    }
  })

  it('性格会影响节奏：外向的说话更快，严谨的思考更慢', () => {
    const loud = avatarTemperamentOf({ extroversion: 95, rigor: 5, humor: 50 }, 'cat')
    const calm = avatarTemperamentOf({ extroversion: 5, rigor: 95, humor: 50 }, 'cat')
    expect(frameCycleMs('talking', loud)).toBeLessThan(frameCycleMs('talking', calm))
  })

  it('样式变量齐全：一轮循环的时长是 4 的整数倍', () => {
    const profile = avatarTemperamentOf(undefined, 'cat')
    const style = frameSheetStyle('dog', 'typing', profile) as Record<string, string>
    const cycle = Number.parseInt(style['--avatar-frame-cycle-ms'] ?? '0', 10)
    expect(cycle).toBeGreaterThan(0)
    // 16 帧 × 每帧一份时间，必须整除——否则最后一帧与第一帧接不上
    expect(cycle % FRAME_COLS).toBe(0)
  })
})

describe('渲染接线', () => {
  it('有帧的形象在说话时播帧', () => {
    const markup = renderToStaticMarkup(<Avatar avatarKey="dog" name="柴犬" size={40} action="speaking" />)
    expect(markup).toContain('avatar-frames')
    expect(markup).toContain('avatar-frames-sheet')
    expect(markup).toContain('dog-talking')
  })

  it('立体动物播帧时照样染色（用户选的毛色不能在动画里丢掉）', () => {
    const markup = renderToStaticMarkup(<Avatar avatarKey="an3d:fox:200" name="狐" size={40} action="speaking" />)
    expect(markup).toContain('avatar-frames')
    expect(markup).toContain('hue-rotate(')
  })

  it('明确点名时播点名的那一套（打字行演的是打字）', () => {
    const markup = renderToStaticMarkup(
      <Avatar avatarKey="dog" name="柴犬" size={32} action="pondering" frameState="typing" />,
    )
    expect(markup).toContain('dog-typing')
  })

  it('闲置时是静态图（帧动画不是常驻的）', () => {
    const markup = renderToStaticMarkup(<Avatar avatarKey="dog" name="柴犬" size={40} />)
    expect(markup).not.toContain('avatar-frames')
    expect(markup).toContain('avatar-portrait-img')
  })

  it('没有帧素材的形象照常渲染（剪影、DiceBear）', () => {
    for (const key of ['mask', 'db:dylan:seed']) {
      const markup = renderToStaticMarkup(<Avatar avatarKey={key} name="助理" size={40} action="speaking" />)
      expect(markup, key).not.toContain('avatar-frames')
    }
  })

  it('尺寸太小不播帧（小头像动起来是闪烁不是生命感）', () => {
    expect(frameAllowed(AVATAR_FRAME_MIN_SIZE)).toBe(true)
    expect(frameAllowed(AVATAR_FRAME_MIN_SIZE - 1)).toBe(false)
    const markup = renderToStaticMarkup(
      <Avatar avatarKey="dog" name="柴犬" size={AVATAR_FRAME_MIN_SIZE - 1} action="speaking" />,
    )
    expect(markup).not.toContain('avatar-frames')
  })
})
