// @vitest-environment jsdom
/**
 * 「我的形象」定制面板。
 *
 * 三件事要成立：
 * - 面板**先显示用户已经存好的那只**（个人资料是异步读回来的，首帧时 profile
 *   还没到，面板不能停在默认猫上）；
 * - 换动物 / 毛色，预览**立刻跟着变**（毛色是 CSS filter 链，GPU 上跑，零资产生成）；
 * - 「保存形象」存的是 `an3d:<种类>:<色相>`，且没改动时按钮是"已保存"态。
 *
 * @module @ryharness/desktop/tests/animal-studio
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnimalStudio, specOf, specOrDefault } from '../renderer/src/components/AnimalStudio.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
})

function render(props: Partial<Parameters<typeof AnimalStudio>[0]> = {}): void {
  act(() => {
    root?.render(<AnimalStudio current={{ kind: 'dog', hue: 30 }} onSave={vi.fn()} onPickOther={vi.fn()} {...props} />)
  })
}

describe('形象字段与设定', () => {
  it('认得出立体动物的字段', () => {
    expect(specOf('an3d:fox:200')).toEqual({ kind: 'fox', hue: 200 })
    expect(specOf('db:dylan:x')).toBeUndefined()
  })

  it('不是立体动物时按默认起步（狗 / 暖橘）', () => {
    expect(specOrDefault(undefined)).toEqual({ kind: 'dog', hue: 30 })
    expect(specOrDefault('db:dylan:x')).toEqual({ kind: 'dog', hue: 30 })
  })
})

describe('定制面板', () => {
  it('两组选择器都是 radiogroup（方向键可用，Tab 只占一位）', () => {
    render()
    const groups = container.querySelectorAll('[role="radiogroup"]')
    expect(groups.length).toBe(2)
    for (const group of groups) {
      const radios = group.querySelectorAll('[role="radio"]')
      expect(radios.length).toBeGreaterThan(0)
      // 组内恰好一枚可 Tab 到达
      expect(
        [...radios].filter((radio) => {
          return radio.getAttribute('tabindex') === '0'
        }),
      ).toHaveLength(1)
    }
  })

  it('预览用的是选中的那一只（换动物立刻跟着变）', () => {
    render()
    const before = container.querySelector('.animal-studio-preview .avatar-3d')?.innerHTML ?? ''
    const fox = [...container.querySelectorAll('.animal-studio-pick')].find((button) => {
      return button.textContent?.includes('狐')
    }) as HTMLButtonElement
    act(() => {
      fox?.click()
    })
    const after = container.querySelector('.animal-studio-preview .avatar-3d')?.innerHTML ?? ''
    expect(after).not.toBe(before)
  })

  it('保存时给的是 an3d 字段', () => {
    const onSave = vi.fn()
    render({ onSave })
    const hue = container.querySelectorAll('.animal-studio-hue')[3] as HTMLButtonElement
    act(() => {
      hue.click()
    })
    const save = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.includes('保存形象')
    }) as HTMLButtonElement
    act(() => {
      save.click()
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0]).toMatch(/^an3d:[a-z]+:\d+$/)
  })

  it('没改动时按钮是"已保存"且点不动（不让人以为没存上）', () => {
    const onSave = vi.fn()
    render({ onSave })
    const save = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.includes('已保存')
    }) as HTMLButtonElement
    expect(save).toBeDefined()
    expect(save.disabled).toBe(true)
  })

  it('服务端不支持保存时，保存键是禁用的且说实话（不能写"已保存"）', () => {
    render({ disabled: true })
    const save = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.includes('形象')
    }) as HTMLButtonElement
    expect(save).toBeDefined()
    expect(save.disabled).toBe(true)
    expect(save.textContent).not.toContain('已保存')
  })

  it('「换别的头像」把控制权交回宿主（老的选择器还在）', () => {
    const onPickOther = vi.fn()
    render({ onPickOther })
    const other = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.includes('换别的头像')
    }) as HTMLButtonElement
    act(() => {
      other.click()
    })
    expect(onPickOther).toHaveBeenCalledTimes(1)
  })

  it('用户存好的那只会在面板里被选中（异步资料到了之后不能停在默认狗上）', () => {
    render({ current: { kind: 'fox', hue: 200 } })
    const selected = [...container.querySelectorAll('.animal-studio-pick.is-selected')].map((button) => {
      return button.textContent
    })
    expect(
      selected.some((text) => {
        return text?.includes('狐')
      }),
    ).toBe(true)
  })
})
