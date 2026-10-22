// @vitest-environment jsdom
/**
 * 自绘下拉（components/Select.tsx）的核心行为。
 *
 * 这批用例盯的是四条真实承诺，每一条都对应一次用户会遇到的坏体验：
 *   1. 键盘全程可用（↑↓/Home/End/Enter/Esc/Tab），焦点不逃出这个控件；
 *   2. 选项多时能搜（模型目录动辄二十项）；
 *   3. 当前值不在目录里时如实列出来——原生 `<select>` 会静默落到第一项，
 *      用户于是以为是自己操作错了，而不是"这个组合存不下来"；
 *   4. 弹层贴视口：贴窗口底部时向上翻，且 max-height 由可用空间给、绝不越界
 *      （这就是"点开就跑到屏幕外"那条用户报告）。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Select, type SelectOption } from '../renderer/src/components/Select.tsx'
import {
  currentValue,
  groupLabels,
  listedValues,
  must,
  openSelect,
  optionRows,
  optionValues,
  pickOption,
  popoverOpen,
  selectTrigger,
  triggerLabel,
} from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const voices: SelectOption[] = [
  { value: 'none', label: '不朗读' },
  { value: 'system-huihui', label: '慧慧（系统女声）', group: '系统语音' },
  { value: 'system-kangkang', label: '康康（系统男声）', group: '系统语音' },
  { value: 'sf-claire', label: '温柔女声', group: 'SiliconFlow 云端语音' },
  { value: 'sf-alex', label: '沉稳男声', group: 'SiliconFlow 云端语音' },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

/** jsdom 里没有布局：`place()` 拿到的全是 0，弹层仍然会渲染（maxHeight 给得出数）。 */
function rect(box: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...box,
  } as DOMRect
}

/**
 * 键盘事件派发到当前焦点所在的那个元素上。
 *
 * 不是一律往 window 上派：收起状态下按 ↑↓ 走的是触发按钮自己的 React 事件（打开弹层），
 * 而弹层打开之后按的键走的是挂在 window 捕获阶段的那一套。派给焦点元素时两条都收得到。
 */
function press(key: string): void {
  const target = document.activeElement ?? document.body
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function typeSearch(text: string): void {
  const input = must(document.querySelector<HTMLInputElement>('.select-search-input'), '搜索框')
  const setter = must(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
    'input.value 的原生 setter',
  )
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render(props: Partial<React.ComponentProps<typeof Select>> = {}): Promise<void> {
  const { value = 'none', ...rest } = props
  await act(async () => {
    root = createRoot(container)
    root.render(<Select value={value} options={voices} ariaLabel="音色" onChange={() => {}} {...rest} />)
    await Promise.resolve()
  })
}

/** 高亮项（键盘位置）落在谁身上。 */
function activeValue(): string | undefined {
  return document.querySelector<HTMLElement>('.select-option.is-active')?.dataset.value
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  document.querySelectorAll('.select-popover').forEach((node) => {
    node.remove()
  })
  vi.restoreAllMocks()
})

describe('下拉：可访问性与结构', () => {
  it('触发器是一个带名字的 combobox，展开/收起状态与弹层对得上', async () => {
    await render()
    const trigger = selectTrigger(container, '音色')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('role')).toBe('combobox')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toBe('音色')
    expect(popoverOpen()).toBe(false)

    const popover = openSelect(container, '音色')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // aria-controls 指向真实存在的 listbox（不是空指一个不存在的 id）。
    expect(popover.querySelector('[role="listbox"]')?.id).toBe(trigger.getAttribute('aria-controls'))
    press('Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(popoverOpen()).toBe(false)
  })

  it('分组小标题不是选项：键盘走位不会停在它上面', async () => {
    await render({ value: 'system-huihui' })
    selectTrigger(container, '音色').focus()
    const popover = openSelect(container, '音色')
    expect(groupLabels(popover)).toEqual(['系统语音', 'SiliconFlow 云端语音'])
    expect(optionValues(popover)).toEqual(['none', 'system-huihui', 'system-kangkang', 'sf-claire', 'sf-alex'])
    // 打开时高亮落在当前值上，而不是第一项。
    expect(activeValue()).toBe('system-huihui')
    press('ArrowDown')
    expect(activeValue()).toBe('system-kangkang')
    press('ArrowDown')
    expect(activeValue()).toBe('sf-claire')
    // 高亮项经 aria-activedescendant 挂在控件上（焦点不在选项上，也就没有焦点逃逸）。
    const trigger = selectTrigger(container, '音色')
    expect(document.activeElement).toBe(trigger)
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant') ?? '')?.dataset.value).toBe(
      'sf-claire',
    )
  })
})

describe('下拉：键盘', () => {
  it('↑↓ 到头就停住，Home/End 跳两端，Enter 选中并收起', async () => {
    const picked: string[] = []
    await render({ onChange: (next: string) => picked.push(next) })
    selectTrigger(container, '音色').focus()
    press('ArrowDown')
    expect(activeValue()).toBe('none')

    press('ArrowUp')
    expect(activeValue()).toBe('none')
    press('ArrowDown')
    press('ArrowDown')
    expect(activeValue()).toBe('system-kangkang')

    press('End')
    expect(activeValue()).toBe('sf-alex')
    press('Home')
    expect(activeValue()).toBe('none')

    press('ArrowDown')
    press('Enter')
    expect(picked).toEqual(['system-huihui'])
    expect(popoverOpen()).toBe(false)
  })

  it('Enter 落在当前值上时不重复回调 onChange（没改就不该报一次改动）', async () => {
    const picked: string[] = []
    await render({ value: 'sf-alex', onChange: (next: string) => picked.push(next) })
    press('ArrowDown')
    press('Enter')
    expect(picked).toEqual([])
    expect(popoverOpen()).toBe(false)
  })

  it('Esc 只关自己：事件不往外冒泡（否则一次 Esc 会把整个弹窗一起带走）', async () => {
    await render()
    const outside: string[] = []
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') outside.push('outer')
    })
    openSelect(container, '音色')
    press('Escape')
    expect(popoverOpen()).toBe(false)
    expect(outside).toEqual([])
  })

  it('Tab 收起但不拦默认：焦点该去哪去哪', async () => {
    await render()
    const next = document.createElement('button')
    next.type = 'button'
    next.textContent = '下一个'
    container.appendChild(next)
    openSelect(container, '音色')
    press('Tab')
    expect(popoverOpen()).toBe(false)
  })

  it('点外面收起；点弹层内部不收', async () => {
    await render()
    const popover = openSelect(container, '音色')
    act(() => {
      popover.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(popoverOpen()).toBe(true)
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(popoverOpen()).toBe(false)
  })

  it('焦点被别处带走时也收起（不留一个空弹层在屏幕上）', async () => {
    await render()
    openSelect(container, '音色')
    const other = document.createElement('input')
    document.body.appendChild(other)
    act(() => {
      other.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(popoverOpen()).toBe(false)
    other.remove()
  })
})

describe('下拉：搜索', () => {
  it('可搜索时焦点落在搜索框上，筛完只剩匹配项且高亮第一项', async () => {
    await render({ searchable: true, value: 'sf-claire' })
    openSelect(container, '音色')
    const input = must(document.querySelector<HTMLInputElement>('.select-search-input'), '搜索框')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-expanded')).toBe('true')

    typeSearch('系统')
    const popover = must(document.querySelector<HTMLElement>('.select-popover'), '弹层')
    expect(optionValues(popover)).toEqual(['system-huihui', 'system-kangkang'])
    expect(activeValue()).toBe('system-huihui')
    press('Enter')
    expect(popoverOpen()).toBe(false)
  })

  it('搜不到时说明「没有匹配」而不是留一张空列表', async () => {
    await render({ searchable: true })
    openSelect(container, '音色')
    typeSearch('zzz')
    expect(document.querySelector('.select-popover')?.textContent).toContain('没有匹配的选项')
  })

  it('搜索按取值也认（模型 id 常常只是标签的另一种写法）', async () => {
    const models: SelectOption[] = [
      { value: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3 — 64K 上下文', group: '长上下文' },
      { value: 'Qwen/Qwen2.5-7B', label: 'Qwen2.5-7B — 上下文未知', group: '其余' },
    ]
    await render({ options: models, searchable: true, value: 'deepseek-ai/DeepSeek-V3' })
    openSelect(container, '音色')
    typeSearch('qwen2.5-7b')
    expect(optionValues(must(document.querySelector<HTMLElement>('.select-popover'), '弹层'))).toEqual([
      'Qwen/Qwen2.5-7B',
    ])
  })
})

describe('下拉：当前值不在目录里', () => {
  it('触发器显示兜底文案，不是第一项的名字', async () => {
    // 旧库里的音色 id 已经从目录里下线了。这正是不能静默落到第一项的那种情况。
    await render({ value: 'sf-gone', placeholder: '已下架的旧音色' })
    expect(triggerLabel(container, '音色')).toBe('已下架的旧音色')
  })

  it('调用方把它如实列进选项时，那一项就是选中态', async () => {
    await render({
      value: 'sf-gone',
      placeholder: '已下架的旧音色',
      options: [{ value: 'sf-gone', label: '已下架的旧音色', title: 'sf-gone' }, ...voices],
    })
    const popover = openSelect(container, '音色')
    const row = optionRows(popover).find((node) => {
      return node.dataset.value === 'sf-gone'
    })
    expect(row?.getAttribute('aria-selected')).toBe('true')
    // 原始 id 收进 title（排障线索），不冒充用户要读的音色名。
    expect(row?.getAttribute('title')).toBe('sf-gone')
  })

  it('没有 placeholder 时显示原值本身，而不是空白', async () => {
    await render({ value: 'sf-gone' })
    expect(triggerLabel(container, '音色')).toBe('sf-gone')
  })
})

describe('下拉：贴视口定位', () => {
  /** 让触发器在窗口里摆出指定的下沿位置。 */
  function stubTriggerRect(bottom: number, top: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('select-trigger')) return rect({ top, bottom, left: 40, right: 240, height: 36 })
      return rect({})
    })
  }

  it('下方放得下就向下弹，max-height 由可用空间给', async () => {
    await render()
    stubTriggerRect(300, 264)
    const popover = openSelect(container, '音色')
    expect(popover.style.bottom).toBe('')
    expect(popover.style.top).toBe('308px')
    // 视口 768 高、下方还剩 460，取两者小的那个（弹层自身也有上限）。
    expect(Number.parseFloat(popover.style.maxHeight)).toBeLessThanOrEqual(460)
  })

  it('贴窗口底部时向上弹（这就是"点开就跑到屏幕外"那条报告）', async () => {
    await render()
    stubTriggerRect(760, 724)
    const popover = openSelect(container, '音色')
    expect(popover.style.top).toBe('')
    // 向上翻时用 bottom 锚定：那样不必先知道弹层有多高。
    expect(popover.style.bottom).toBe(`${window.innerHeight - 724 + 8}px`)
    const height = Number.parseFloat(popover.style.maxHeight)
    // 上方只有 716 像素可用，且底边 768 + 8 呼吸之外不能越界。
    expect(height).toBeLessThanOrEqual(716)
    expect(window.innerHeight - height).toBeGreaterThanOrEqual(0)
  })

  it('横贴视口时左沿被夹回安全边，弹层不会跑出窗口右边', async () => {
    await render()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('select-trigger')) return rect({ top: 100, bottom: 136, left: 980, right: 1180 })
      return rect({})
    })
    const popover = openSelect(container, '音色')
    const left = Number.parseFloat(popover.style.left)
    const width = Number.parseFloat(popover.style.width)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(window.innerWidth)
  })

  it('窗口尺寸变了要重算位置（不重算就等于把旧坐标带到新窗口上）', async () => {
    await render()
    stubTriggerRect(300, 264)
    openSelect(container, '音色')
    const popover = must(document.querySelector<HTMLElement>('.select-popover'), '弹层')
    expect(popover.style.top).toBe('308px')
    act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    // 400 高的窗口里，下方只剩 92 像素：改向上弹。
    expect(document.querySelector<HTMLElement>('.select-popover')?.style.top).toBe('')
    expect(document.querySelector<HTMLElement>('.select-popover')?.style.bottom).not.toBe('')
  })
})

describe('下拉：选项变更与禁用', () => {
  it('选项变了就把高亮拉回仍然存在的那一项', async () => {
    const picked: string[] = []
    await render({ value: 'sf-alex', onChange: (next: string) => picked.push(next) })
    openSelect(container, '音色')
    expect(activeValue()).toBe('sf-alex')
    // 目录刷新后当前值那一项没了：高亮不能悬空（既没有 aria-activedescendant 可指，
    // 键盘也会停在原地动不了），要落到还在的第一项。
    await act(async () => {
      root?.render(
        <Select
          value="sf-alex"
          options={voices.filter((option) => {
            return option.value !== 'sf-alex'
          })}
          ariaLabel="音色"
          onChange={(next) => picked.push(next)}
        />,
      )
      await Promise.resolve()
    })
    expect(activeValue()).toBe('none')
    press('Enter')
    expect(picked).toEqual(['none'])
    expect(popoverOpen()).toBe(false)
  })

  it('disabled 时点不开，也不该被键盘打开', async () => {
    const picked: string[] = []
    await render({ disabled: true, onChange: (next: string) => picked.push(next) })
    const trigger = selectTrigger(container, '音色')
    expect(trigger.disabled).toBe(true)
    act(() => {
      trigger.click()
    })
    expect(popoverOpen()).toBe(false)
    press('ArrowDown')
    expect(popoverOpen()).toBe(false)
  })
})

describe('下拉：鼠标选中', () => {
  it('mousedown 就选中并收起（不等 click：默认行为会让焦点先跑掉）', async () => {
    const picked: string[] = []
    await render({ onChange: (next: string) => picked.push(next) })
    const popover = openSelect(container, '音色')
    const row = must(
      optionRows(popover).find((node) => {
        return node.dataset.value === 'sf-alex'
      }),
      '选项 sf-alex',
    )
    act(() => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(picked).toEqual(['sf-alex'])
    expect(popoverOpen()).toBe(false)
  })

  it('悬停把键盘高亮带走（鼠标与键盘说的是同一个位置）', async () => {
    await render()
    const popover = openSelect(container, '音色')
    act(() => {
      // React 的 onMouseEnter 是从 mouseover 合成的，派发原生 mouseenter 它收不到。
      must(optionRows(popover)[3], '第 4 个选项').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(activeValue()).toBe('sf-claire')
  })

  it('helper 的 pickOption 走的就是这条路', async () => {
    const picked: string[] = []
    await render({ onChange: (next: string) => picked.push(next) })
    pickOption(container, '音色', 'sf-claire')
    expect(picked).toEqual(['sf-claire'])
    expect(currentValue(container, '音色')).toBe('none')
    expect(listedValues(container, '音色')).toHaveLength(5)
  })
})
