// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MentionProfile, MentionText } from '../renderer/src/components/MentionText.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entries = [
  { id: 'eng', name: '工程师' },
  { id: 'codebot', name: 'CodeBot' },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.querySelectorAll('.mention-card').forEach((node) => {
    node.remove()
  })
})

function render(props: {
  text: string
  onProfile?: (id: string) => MentionProfile | undefined
  onMention?: (entry: { id: string; name: string }) => void
}): void {
  act(() => {
    root = createRoot(container)
    root.render(
      <MentionText
        text={props.text}
        entries={entries}
        {...(props.onProfile === undefined ? {} : { onProfile: props.onProfile })}
        {...(props.onMention === undefined ? {} : { onMention: props.onMention })}
      />,
    )
  })
}

/** 取不到就当场报错：断言之前静默拿到 undefined 只会把错报歪。 */
function must<T>(node: T | null | undefined, what: string): T {
  if (node === null || node === undefined) throw new Error(`找不到：${what}`)
  return node
}

function link(): HTMLButtonElement {
  return must(container.querySelector<HTMLButtonElement>('button.mention-link'), '@提及链接')
}

/**
 * React 的 onMouseEnter 是从 mouseover 合成的，派发原生 mouseenter 它收不到。
 *
 * 名片还有一层**意图延迟**（指针停住 250ms 才开），所以这里要推进计时器。
 */
function hover(node: Element): void {
  act(() => {
    vi.useFakeTimers()
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    vi.advanceTimersByTime(300)
  })
}

/** 指针移开：再等一会儿名片就收掉。 */
function unhover(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    vi.advanceTimersByTime(200)
  })
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.mention-card')
}

describe('MentionText', () => {
  it('把 @某人 画成一枚标签，其余文字照旧', () => {
    render({ text: '请 @工程师 看一下' })
    expect(container.querySelectorAll('button.mention-link')).toHaveLength(1)
    expect(link().textContent).toBe('@工程师')
    expect(container.textContent).toBe('请 @工程师 看一下')
  })

  it('名单里没有的名字不画成链接', () => {
    render({ text: '@陌生人 你好' })
    expect(container.querySelectorAll('button.mention-link')).toHaveLength(0)
    expect(container.textContent).toBe('@陌生人 你好')
  })

  it('悬停出名片：头像、名字、模型、工具数都在', () => {
    render({
      text: '请 @工程师 看一下',
      onProfile: (id) => {
        return {
          model: id === 'eng' ? 'GPT-5 · OpenAI' : '别的模型',
          tools: 3,
          badge: '内置',
          traits: [{ label: '严谨', band: '稳' }],
        }
      },
    })
    expect(card()).toBeNull()
    hover(link())
    const shown = must(card(), '悬停后应浮出名片')
    expect(shown.textContent).toContain('工程师')
    expect(shown.textContent).toContain('GPT-5 · OpenAI')
    expect(shown.textContent).toContain('3 个')
    expect(shown.textContent).toContain('严谨')
  })

  it('名片浮在文档上，不占气泡里的位置', () => {
    render({ text: '@工程师' })
    hover(link())
    expect(card()?.parentElement).toBe(document.body)
  })

  it('点一下把 @某人 送回输入框', () => {
    const onMention = vi.fn()
    render({ text: '请 @工程师 看一下', onMention })
    act(() => {
      link().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onMention).toHaveBeenCalledTimes(1)
    expect(onMention).toHaveBeenCalledWith({ id: 'eng', name: '工程师' })
  })

  it('移开指针后名片收掉', () => {
    render({ text: '@工程师' })
    hover(link())
    expect(card()).not.toBeNull()
    unhover(link())
    expect(card()).toBeNull()
  })

  it('扫过去不开：指针不停住就没有名片', () => {
    render({ text: '@工程师' })
    act(() => {
      vi.useFakeTimers()
      link().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(80)
    })
    expect(card()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(card()).not.toBeNull()
  })
})
