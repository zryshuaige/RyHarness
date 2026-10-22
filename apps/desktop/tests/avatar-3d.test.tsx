// @vitest-environment jsdom
/**
 * 立体头像外壳（Avatar3D）。
 *
 * 钉住四件事：
 * - 壳是真的在（class 在、尺寸在、内容还是原来的头像）；
 * - 立体动物走**三视图**通道：正面 / 左 3/4 / 右 3/4 三张脸都在，data-view 决定
 *   哪张是亮的；
 * - **倾斜与换脸都不进 React state**：mousemove 只改 CSS 变量和 data 属性，
 *   组件零重渲染（列表里几十张头像时，这是"跟手"与"卡顿"的分界线）；
 * - 降级：系统开了「减少动态效果」或指针是粗指针（触屏）时不挂监听。
 *
 * @module @ryharness/desktop/tests/avatar-3d
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Avatar3D } from '../renderer/src/components/avatars/Avatar3D.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

/** matchMedia 桩：默认"什么都不特殊"。 */
function stubMatchMedia(matches: (query: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    return {
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  })
}

/** 补一个 jsdom 没有的尺寸（getBoundingClientRect 全是 0，事件算不出偏移）。 */
function withSize(node: HTMLElement, size = 56): void {
  node.getBoundingClientRect = () => {
    return {
      left: 0,
      top: 0,
      width: size,
      height: size,
      right: size,
      bottom: size,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }
  }
}

/** 等一帧：变量是合帧（rAF）写的，同步断言读不到。 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(null)
      })
    })
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stubMatchMedia(() => false)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

describe('立体头像外壳', () => {
  it('壳在、尺寸在、内容还是原来的头像', () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="cat" name="Ryen" size={56} />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    expect(shell).not.toBeNull()
    expect(shell.style.width).toBe('56px')
    expect(shell.querySelector('.avatar')).not.toBeNull()
  })

  it('立体动物走六张脸：三个视角 + 两个表情 + 一个动作，默认亮正面', () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:fox:30" name="Ryen" size={56} tilt />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    expect(shell.dataset.face).toBe('front')
    expect(container.querySelectorAll('.avatar-3d-face').length).toBe(6)
    expect(container.querySelector('.avatar-3d-face-front')).not.toBeNull()
    expect(container.querySelector('.avatar-3d-face-left')).not.toBeNull()
    expect(container.querySelector('.avatar-3d-face-right')).not.toBeNull()
    expect(container.querySelector('.avatar-3d-face-smile')).not.toBeNull()
    expect(container.querySelector('.avatar-3d-face-blink')).not.toBeNull()
    expect(container.querySelector('.avatar-3d-face-wave')).not.toBeNull()
  })

  it('小头像只挂正面那一张（列表里几十张卡，少下载五张）', () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:fox:30" name="Ryen" size={56} />)
    })
    expect(container.querySelectorAll('.avatar-3d-face').length).toBe(1)
    expect(container.querySelector('.avatar-3d-face-front')).not.toBeNull()
  })

  it('立体动物的毛色是 filter 链（不是另一套图）', () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:fox:200" name="Ryen" size={56} />)
    })
    const img = container.querySelector('.avatar-3d-face-front') as HTMLImageElement
    // 染色是 GPU 上跑的 filter 链，不是另一套图
    expect(img.style.filter).toContain('hue-rotate(')
    expect(img.style.filter).toContain('saturate(')
    // 有色主色的动物不�� sepia：它会把胸口那片浅色一起染脏。
    // 黑白配色（熊猫）才需要先上棕调才有色相可转。
    expect(img.style.filter).not.toContain('sepia(')
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:panda:200" name="Ryen" size={56} />)
    })
    const panda = container.querySelector('.avatar-3d-face-front') as HTMLImageElement
    expect(panda.style.filter).toContain('sepia(1)')
  })

  it('倾斜只写 CSS 变量，不触发重渲染', async () => {
    const renders: number[] = []
    function Probe(): React.ReactElement {
      renders.push(1)
      return <Avatar3D avatarKey="cat" name="Ryen" size={56} tilt />
    }
    act(() => {
      root?.render(<Probe />)
    })
    const before = renders.length
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    withSize(shell)
    act(() => {
      // 监听是悬停才挂的：先进来，再动
      shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      shell.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true }))
    })
    await nextFrame()
    // 变量写了（角度不为 0）
    expect(shell.style.getPropertyValue('--tilt-y')).not.toBe('')
    // 但组件没有重渲染
    expect(renders.length).toBe(before)
  })

  it('鼠标偏右就换到右 3/4 的脸（转的是真的侧脸，不是贴图假象）', async () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:fox:30" name="Ryen" size={56} tilt />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    withSize(shell)
    act(() => {
      shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      shell.dispatchEvent(new MouseEvent('pointermove', { clientX: 54, clientY: 28, bubbles: true }))
    })
    await nextFrame()
    expect(shell.dataset.face).toBe('right')
  })

  it('指针停在上面时抬爪打招呼', async () => {
    act(() => {
      root?.render(<Avatar3D avatarKey="an3d:fox:30" name="Ryen" size={56} tilt />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    withSize(shell)
    act(() => {
      shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
    })
    await nextFrame()
    expect(shell.dataset.face).toBe('wave')
  })

  it('系统开了「减少动态效果」时不挂监听（静态呈现）', async () => {
    stubMatchMedia((query) => {
      return query.includes('prefers-reduced-motion')
    })
    act(() => {
      root?.render(<Avatar3D avatarKey="cat" name="Ryen" size={56} tilt />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    withSize(shell)
    act(() => {
      shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      shell.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true }))
    })
    await nextFrame()
    expect(shell.style.getPropertyValue('--tilt-y')).toBe('')
  })

  it('触屏（粗指针）不挂监听', async () => {
    stubMatchMedia((query) => {
      return query.includes('pointer: coarse')
    })
    act(() => {
      root?.render(<Avatar3D avatarKey="cat" name="Ryen" size={56} tilt />)
    })
    const shell = container.querySelector('.avatar-3d') as HTMLElement
    withSize(shell)
    act(() => {
      shell.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
      shell.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true }))
    })
    await nextFrame()
    expect(shell.style.getPropertyValue('--tilt-y')).toBe('')
  })
})
