// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'
import type { MessageAttachment } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const members = [
  { id: 'ryen', name: 'Ryen' },
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
})

function render(onSend: (text: string) => void = () => {}): void {
  act(() => {
    root = createRoot(container)
    root.render(<ChatInput members={members} onSend={onSend} />)
  })
}

/** 附件用例的渲染入口：onSend 收 (text, attachments)，onUpload 是可控的落库桩。 */
function renderInput(props: {
  onSend?: (text: string, attachments?: MessageAttachment[]) => void
  onUpload?: (file: File) => Promise<MessageAttachment>
}): void {
  act(() => {
    root = createRoot(container)
    root.render(<ChatInput members={members} onSend={props.onSend ?? (() => {})} onUpload={props.onUpload} />)
  })
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!
}

/** 受控组件输入：走原生 setter + input 事件，光标置于末尾。 */
function typeText(value: string): void {
  const node = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.setSelectionRange(value.length, value.length)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function keyDown(key: string): void {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** 输入法组合中的回车：keydown 事件带 isComposing 标志。 */
function keyDownComposing(key: string): void {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }))
  })
}

function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event)
  })
}

/** 带 dataTransfer 的拖放事件（jsdom 没有 DataTransfer，这里手搓一个）。 */
function dragEvent(type: string, files: File[] = [], related: Node | null = null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, items: [], types: files.length > 0 ? ['Files'] : [] },
  })
  Object.defineProperty(event, 'relatedTarget', { value: related })
  return event
}

/** 剪贴板里的文件（jsdom 没有 ClipboardEvent，同样手搓）。 */
function pasteEvent(files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [], types: ['Files'] } })
  return event
}

function file(name: string, type: string, size = 1024): File {
  const blob = new File([new Uint8Array(size)], name, { type })
  return blob
}

describe('ChatInput @补全菜单', () => {
  it('输入 @R 弹出候选菜单', () => {
    render()
    typeText('@R')
    const menu = container.querySelector('.mention-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('Ryen')
  })

  it('Esc 关闭菜单且不污染输入文本（无零宽字符）', () => {
    const sent: string[] = []
    render((text) => {
      sent.push(text)
    })
    typeText('@R')
    expect(container.querySelector('.mention-menu')).not.toBeNull()
    keyDown('Escape')
    // 退场体系：菜单先挂 .is-leaving 播退场动画，LEAVE_MS 后才真正卸载（见 use-leaving.test.tsx）
    expect(container.querySelector('.mention-menu.is-leaving')).not.toBeNull()
    expect(container.querySelector('.mention-menu:not(.is-leaving)')).toBeNull()
    // 文本原样保留，没有混入 U+200B 等魔法字符
    expect(textarea().value).toBe('@R')
    // 退场途中继续输入（同一 @ 查询）应立刻打断退场并恢复菜单
    typeText('@Ry')
    expect(container.querySelector('.mention-menu:not(.is-leaving)')).not.toBeNull()
  })

  it('Esc 关闭后 Enter 直接发送原文', () => {
    const sent: string[] = []
    render((text) => {
      sent.push(text)
    })
    typeText('@R')
    keyDown('Escape')
    keyDown('Enter')
    expect(sent).toEqual(['@R'])
  })

  it('菜单打开时 Enter 补全选中项', () => {
    render()
    typeText('@Code')
    keyDown('Enter')
    expect(textarea().value).toBe('@CodeBot ')
  })
})

describe('ChatInput 输入法组合保护', () => {
  it('isComposing 的回车是选词，不是发送（拼音半截不上屏）', () => {
    const sent: string[] = []
    render((text) => {
      sent.push(text)
    })
    typeText('ni')
    keyDownComposing('Enter')
    expect(sent).toEqual([])
    // 选词提交后文字还在输入框里
    expect(textarea().value).toBe('ni')
  })

  it('compositionstart/end 兜底：部分 IME 不给 keydown 带 isComposing', () => {
    const sent: string[] = []
    render((text) => {
      sent.push(text)
    })
    typeText('你好')
    fire(textarea(), new CompositionEvent('compositionstart', { bubbles: true }))
    keyDown('Enter')
    expect(sent).toEqual([])
    fire(textarea(), new CompositionEvent('compositionend', { bubbles: true }))
    keyDown('Enter')
    expect(sent).toEqual(['你好'])
  })

  it('组合中连 @补全菜单也不被 Enter 关掉（选词优先）', () => {
    render()
    typeText('@R')
    fire(textarea(), new CompositionEvent('compositionstart', { bubbles: true }))
    keyDown('Enter')
    expect(container.querySelector('.mention-menu:not(.is-leaving)')).not.toBeNull()
  })
})

describe('ChatInput 附件通道', () => {
  it('粘贴图片进预览条，上传成功后随消息一起发出', async () => {
    const sent: { text: string; attachments?: MessageAttachment[] }[] = []
    renderInput({
      onSend: (text, attachments) => {
        sent.push({ text, attachments })
      },
      onUpload: (f) => {
        return Promise.resolve({ name: f.name, size: f.size, mime: f.type })
      },
    })
    typeText('看看这张图')
    fire(textarea(), pasteEvent([file('shot.png', 'image/png', 2048)]))

    // 上传中：预览条已上屏，正文没被动过
    expect(container.querySelector('.attach-strip')?.textContent).toContain('shot.png')
    expect(textarea().value).toBe('看看这张图')

    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('.attach-item.is-ready')?.textContent).toContain('2.0 KB')

    keyDown('Enter')
    expect(sent).toEqual([{ text: '看看这张图', attachments: [{ name: 'shot.png', size: 2048, mime: 'image/png' }] }])
    // 发送后预览条清空
    expect(container.querySelector('.attach-strip')).toBeNull()
  })

  it('上传中不发：宁可按钮禁用也不发缺文件的请求', async () => {
    let resolve: ((value: MessageAttachment) => void) | undefined
    const sent: string[] = []
    renderInput({
      onSend: (text) => {
        sent.push(text)
      },
      onUpload: () => {
        return new Promise<MessageAttachment>((r) => {
          resolve = r
        })
      },
    })
    typeText('带图')
    fire(textarea(), pasteEvent([file('a.png', 'image/png')]))
    expect(container.querySelector<HTMLButtonElement>('.send-btn')?.disabled).toBe(true)
    keyDown('Enter')
    expect(sent).toEqual([])

    await act(async () => {
      resolve?.({ name: 'a.png', size: 1024, mime: 'image/png' })
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLButtonElement>('.send-btn')?.disabled).toBe(false)
  })

  it('上传失败给出中文原因、可重试、可移除', async () => {
    renderInput({
      onUpload: () => {
        return Promise.reject(new Error('附件太大'))
      },
    })
    await act(async () => {
      fire(textarea(), pasteEvent([file('big.zip', 'application/zip')]))
      await Promise.resolve()
      await Promise.resolve()
    })
    const item = container.querySelector('.attach-item.is-error')
    expect(item?.textContent).toContain('big.zip')
    expect(item?.textContent).toContain('附件太大')
    expect(container.querySelector('.attach-retry')).not.toBeNull()

    fire(container.querySelector('.attach-retry')!, new MouseEvent('click', { bubbles: true }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.attach-item.is-error')).not.toBeNull()

    fire(container.querySelector('.attach-remove')!, new MouseEvent('click', { bubbles: true }))
    expect(container.querySelector('.attach-strip')).toBeNull()
  })

  it('拖放：hover 态出现，落下即入队', async () => {
    renderInput({
      onUpload: (f) => {
        return Promise.resolve({ name: f.name, size: f.size, mime: f.type })
      },
    })
    const zone = container.querySelector('.attach-zone')!
    fire(zone, dragEvent('dragover', [file('drop.md', 'text/markdown')]))
    expect(container.querySelector('.attach-zone.is-dragover')).not.toBeNull()

    fire(zone, dragEvent('drop', [file('drop.md', 'text/markdown')]))
    expect(container.querySelector('.attach-zone.is-dragover')).toBeNull()
    expect(container.querySelector('.attach-strip')?.textContent).toContain('drop.md')

    fire(zone, dragEvent('dragleave', []))
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('.attach-item.is-ready')).not.toBeNull()
  })

  it('没有上传通道时附件如实标成不可上传，不假装成功', async () => {
    renderInput({})
    await act(async () => {
      fire(textarea(), pasteEvent([file('x.png', 'image/png')]))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.attach-item.is-error')?.textContent).toContain('当前未开放附件上传')
  })
})
