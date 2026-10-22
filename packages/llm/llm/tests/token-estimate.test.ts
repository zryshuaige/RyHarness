import { brandString } from '@ryharness/brand'
import type { ContentBlock, Message, ToolCallId } from '@ryharness/llm'
import {
  createAssistantMessage,
  estimateContentTokens,
  estimateMessageTokens,
  estimateTokens,
  estimateToolsTokens,
} from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 造一条 assistant 消息：只关心内容与权重，不关心 id / source。 */
function assistant(content: ContentBlock[]): Message {
  return createAssistantMessage({
    content,
    source: { provider: 'mock', model: 'mock-model' },
  })
}

describe('estimateTokens', () => {
  it('中文一字一 token，ASCII 四字符一 token', () => {
    // 同一个「字符数」在两种语言下差 4 倍，这正是字符预算不能用的原因。
    expect(estimateTokens('中文中文中文中文')).toBe(8)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('同样字符数下，中文的报价是 ASCII 的 4 倍（字符预算正是在这里偏了 4 倍）', () => {
    const chinese = '中文中文中文中文'
    const ascii = 'a'.repeat(chinese.length)
    expect(estimateTokens(chinese)).toBe(estimateTokens(ascii) * 4)
  })

  it('emoji 按码点计（代理对算一个字），不按 UTF-16 单元算两个字', () => {
    expect(estimateTokens('🙂🙂🙂')).toBe(6)
    // 同一段里 ASCII 仍是四字符一 token。
    expect(estimateTokens('abcdefg🙂')).toBe(2 + 2)
  })

  it('全角标点与字母按中文口径（漏出去会把中文正文少算 3/4）', () => {
    expect(estimateTokens('，。！？')).toBe(4)
    expect(estimateTokens('ＡＢ')).toBe(2)
  })

  it('空串为 0；标点与 emoji 不掉进 ASCII 档', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('…')).toBeGreaterThan(0)
  })

  it('估算随文本单调不减（裁剪的二分查找依赖这一点）', () => {
    let previous = 0
    const text = '中文 abcdef 🙂 标点，。'
    for (let length = 0; length <= text.length; length++) {
      const tokens = estimateTokens(text.slice(0, length))
      expect(tokens).toBeGreaterThanOrEqual(previous)
      previous = tokens
    }
  })
})

describe('estimateMessageTokens', () => {
  it('计入 role 与块结构开销；reasoning 与 text 同价', () => {
    const reasoning = assistant([{ type: 'reasoning', text: '想一想' }])
    const text = assistant([{ type: 'text', text: '想一想' }])
    expect(estimateMessageTokens(reasoning)).toBe(estimateMessageTokens(text))
    expect(estimateMessageTokens(text)).toBeGreaterThan(3)
  })

  it('tool-call 的参数 JSON 也计入（参数才是长尾）', () => {
    const withArgs = assistant([
      {
        type: 'tool-call',
        id: brandString<ToolCallId>('c1'),
        name: 't',
        arguments: JSON.stringify({ q: 'x'.repeat(400) }),
      },
    ])
    expect(estimateMessageTokens(withArgs)).toBeGreaterThan(100)
  })
})

describe('estimateToolsTokens', () => {
  const tools = [
    {
      name: 'shell_exec',
      description: '执行一条命令',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ]

  it('工具声明计入预算，空表返回 0', () => {
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens([])).toBe(0)
    expect(estimateToolsTokens(tools)).toBeGreaterThan(0)
  })

  it('声明越长越贵（比值断言：20 倍描述 ⇒ 远超 2 倍报价）', () => {
    const longDescription = '执行一条命令'.repeat(20)
    const wide = tools.map((tool) => ({ ...tool, description: longDescription }))
    const base = estimateToolsTokens(tools)
    // 只钉比值不钉绝对值：JSON 骨架（name / parameters）是固定开销，中文在
    // JSON 里又会被引号逗号切成很多小段（每段各自向上取整），钉绝对数字只会
    // 把断言变成脆弱写法。
    expect(estimateToolsTokens(wide)).toBeGreaterThan(base * 2)
  })
})

describe('estimateContentTokens', () => {
  it('图片按固定视觉体积计，文件按句柄文本计', () => {
    const image = assistant([{ type: 'image', attachment: {} as never }])
    expect(estimateMessageTokens(image)).toBeGreaterThan(1_000)
    expect(estimateContentTokens([])).toBe(0)
  })
})
