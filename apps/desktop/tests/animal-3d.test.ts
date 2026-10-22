// @vitest-environment jsdom
/**
 * 立体动物形象：数据、资产与字段格式。
 *
 * 形象本体是**照片级 3D 渲染**的动物头（apps/desktop/assets/animals/*.webp，
 * 透明底），每只三张脸：正面 / 左 3/4 / 右 3/4。图形在资产层，渲染层只**引用**
 * ——"渲染层里不写图形"是仓库的既有不变量（见 brand.test.tsx），这里是同一件事
 * 的正向断言：资产确实在 assets/ 下，而且每一份都齐。
 *
 * 毛色不另存一套图：8 种毛色 = 8 条 CSS filter 链。所以这一层要验的是"链是合法
 * 的、8 种互不相同、且每种都能落在动物上"——毛色是产品承诺，不能是空壳。
 *
 * @module @ryharness/desktop/tests/animal-3d
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ANIMAL_FACES,
  ANIMAL_HUES,
  ANIMALS,
  animalAssetUrl,
  animalAvatar,
  animalHueFilter,
  animalHueOf,
  animalOf,
  isAnimalAvatar,
  parseAnimalAvatar,
} from '../renderer/src/lib/animal-3d.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = join(DESKTOP, 'assets', 'animals')

function assetText(name: string): string {
  return readFileSync(join(ASSET_DIR, name), 'utf8')
}

describe('形象资产', () => {
  it('每只动物 × 每张脸都有一份', () => {
    const files = readdirSync(ASSET_DIR).filter((name) => {
      return name.endsWith('.webp')
    })
    expect(files.length).toBe(ANIMALS.length * ANIMAL_FACES.length)
    for (const animal of ANIMALS) {
      for (const face of ANIMAL_FACES) {
        expect(files).toContain(`${animal.kind}-${face}.webp`)
      }
    }
  })

  it('每份都是像样的 WebP（几十 KB 以内，不是空壳）', () => {
    for (const animal of ANIMALS) {
      for (const face of ANIMAL_FACES) {
        const bytes = readFileSync(join(ASSET_DIR, `${animal.kind}-${face}.webp`))
        // RIFF....WEBP 头
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
        expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
        expect(bytes.length).toBeGreaterThan(4096)
        expect(bytes.length).toBeLessThan(160 * 1024)
      }
    }
  })

  it('六张脸彼此不同（不然换脸是假的）', () => {
    for (const animal of ANIMALS) {
      const faces = ANIMAL_FACES.map((face) => {
        return assetText(`${animal.kind}-${face}.webp`)
      })
      expect(new Set(faces).size).toBe(ANIMAL_FACES.length)
    }
  })

  it('猫不在家族里：全应用只有那一只品牌橘猫', () => {
    expect(
      ANIMALS.map((animal) => {
        return animal.kind
      }),
    ).not.toContain('cat')
  })
})

describe('毛色', () => {
  it('八种毛色，每种一条合法的 filter 链', () => {
    expect(ANIMAL_HUES.length).toBe(8)
    const filters = new Set<string>()
    for (const hue of ANIMAL_HUES) {
      const filter = animalHueFilter('fox', hue.hue)
      expect(filter.length).toBeGreaterThan(0)
      // 合法链路：hue-rotate 换色相 → saturate/brightness 调
      expect(filter).toContain('hue-rotate(')
      expect(filter).toContain('saturate(')
      filters.add(filter)
    }
    expect(filters.size).toBe(ANIMAL_HUES.length)
  })

  it('同一目标色相下，不同动物转到的是同一个颜色（不是各转各的）', () => {
    // 选「天青」时，狐狸、兔子、熊猫都该落到同一个色相上——否则同一个选项
    // 出来六种颜色，用户会觉得是坏的。
    const target = ANIMAL_HUES.find((h) => {
      return h.hue === 200
    })
    expect(target).toBeDefined()
    for (const animal of ANIMALS) {
      const filter = animalHueFilter(animal.kind, 200)
      const shift = Number(/hue-rotate\((-?\d+)deg\)/.exec(filter)?.[1] ?? '0')
      // 旋转量 = 目标色相 − 该动物自己的原色相
      const expected = (((200 - animal.baseHue) % 360) + 360) % 360
      expect(shift).toBe(expected)
    }
  })

  it('色相角度合法（0~360 的整数）', () => {
    for (const hue of ANIMAL_HUES) {
      expect(Number.isInteger(hue.hue)).toBe(true)
      expect(hue.hue).toBeGreaterThanOrEqual(0)
      expect(hue.hue).toBeLessThanOrEqual(360)
    }
  })

  it('未知色相回落到第一个，不抛错', () => {
    expect(animalHueOf(999)).toBe(ANIMAL_HUES[0])
    expect(animalHueFilter('fox', 999)).toContain('hue-rotate(')
  })
})

describe('资源索引与头像字段', () => {
  it('按种类+脸取得到资源 URL', () => {
    expect(animalAssetUrl('fox', 'front')).toBeDefined()
    expect(animalAssetUrl('fox', 'front')).toContain('fox-front')
    expect(animalAssetUrl('fox', 'left')).toContain('fox-left')
    expect(animalAssetUrl('fox', 'right')).toContain('fox-right')
    // 表情与动作也在册：少一张，运行时就是"点了没反应"
    expect(animalAssetUrl('fox', 'smile')).toContain('fox-smile')
    expect(animalAssetUrl('fox', 'blink')).toContain('fox-blink')
    expect(animalAssetUrl('fox', 'wave')).toContain('fox-wave')
  })

  it('造出来、认出来、解析回来', () => {
    const avatar = animalAvatar('fox', 200)
    expect(avatar).toBe('an3d:fox:200')
    expect(isAnimalAvatar(avatar)).toBe(true)
    expect(parseAnimalAvatar(avatar)).toEqual({ kind: 'fox', hue: 200 })
  })

  it('不是这个形态的字段不认（老数据要平滑降级）', () => {
    expect(isAnimalAvatar('db:dylan:abc')).toBe(false)
    expect(isAnimalAvatar('cat')).toBe(false)
    expect(isAnimalAvatar(undefined)).toBe(false)
    expect(parseAnimalAvatar('db:dylan:abc')).toBeUndefined()
  })

  it('不认识的种类/越界色相都判为无效', () => {
    expect(parseAnimalAvatar('an3d:dragon:30')).toBeUndefined()
    expect(parseAnimalAvatar('an3d:cat:30')).toBeUndefined()
    expect(parseAnimalAvatar('an3d:fox:999')).toBeUndefined()
  })

  it('查得到展示名', () => {
    expect(animalOf('fox')?.label).toBe('狐')
    expect(animalOf('dragon')).toBeUndefined()
  })
})
