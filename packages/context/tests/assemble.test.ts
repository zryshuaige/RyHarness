import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSnapshotSource, SnapshotMessage, SnapshotSession } from '@ryharness/context'
import { assembleContext, buildTimeContext, contextContentBlocks } from '@ryharness/context'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ctx-assemble-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 残留目录落在系统临时区，不影响仓库。
    }
  }
})

const SNAPSHOT_SOURCE: SessionSnapshotSource = {
  session(conversationId: string): SnapshotSession | undefined {
    return conversationId === 'c1' ? { id: 'c1', title: '查店那件事' } : undefined
  },
  recentMessages(): readonly SnapshotMessage[] {
    return [{ sender: 'user', text: '上次说到城东那几家店' }]
  },
  recentSessions(): readonly SnapshotSession[] {
    return [{ id: 'c1', title: '查店那件事' }]
  },
}

describe('统一装配', () => {
  it('装出的是一组 user 角色的消息', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '一条规矩。', 'utf8')
    const messages = assembleContext({
      workspaceRoot: root,
      userText: '看下 @todo.md',
      now: () => new Date('2026-10-29T13:34:00Z'),
      timeZone: 'Asia/Shanghai',
      blocks: { 'session-snapshot': true },
      snapshotSource: SNAPSHOT_SOURCE,
    })
    expect(messages.length).toBe(4)
    expect(
      messages.every((message) => {
        return message.role === 'user'
      }),
    ).toBe(true)
    expect(
      messages.map((message) => {
        return message.kind
      }),
    ).toEqual(['workspace-instructions', 'time', 'file-references', 'session-snapshot'])
  })

  it('每块能单独关掉', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '一条规矩。', 'utf8')
    const messages = assembleContext({
      workspaceRoot: root,
      userText: '看下 @todo.md',
      now: () => new Date('2026-10-29T13:34:00Z'),
      timeZone: 'UTC',
      blocks: { 'workspace-instructions': false, 'file-references': false },
    })
    expect(
      messages.map((message) => {
        return message.kind
      }),
    ).toEqual(['time'])
  })

  it('全关掉就没有任何注入', () => {
    const root = workspace()
    const messages = assembleContext({
      workspaceRoot: root,
      userText: '看下 @todo.md',
      blocks: {
        'workspace-instructions': false,
        'file-references': false,
        time: false,
        'session-snapshot': false,
      },
    })
    expect(messages).toEqual([])
  })

  it('跨会话快照默认是关的（它把别的会话带进来，得由宿主明确要）', () => {
    const root = workspace()
    const messages = assembleContext({
      workspaceRoot: root,
      snapshotSource: SNAPSHOT_SOURCE,
      blocks: { time: false },
    })
    expect(messages).toEqual([])
  })

  it('没有指令文件、没有 @引用时不装这两块', () => {
    const root = workspace()
    const messages = assembleContext({
      workspaceRoot: root,
      userText: '今天天气不错',
      now: () => new Date('2026-10-29T13:34:00Z'),
      timeZone: 'UTC',
    })
    expect(
      messages.map((message) => {
        return message.kind
      }),
    ).toEqual(['time'])
  })

  it('上限可以由调用方改', () => {
    const root = workspace()
    writeFileSync(join(root, 'big.md'), 'z'.repeat(100), 'utf8')
    const messages = assembleContext({
      workspaceRoot: root,
      userText: '@big.md',
      blocks: { 'workspace-instructions': false, time: false },
      limits: { fileMaxChars: 10 },
    })
    expect(messages[0]?.text).toContain('已截断：全文 100 字符，这里只保留前 10 字符')
  })

  it('开了跨会话快照但那个会话取不到时不装这一块', () => {
    const root = workspace()
    const empty: SessionSnapshotSource = {
      session: () => undefined,
      recentMessages: () => [],
      recentSessions: () => [],
    }
    const messages = assembleContext({
      workspaceRoot: root,
      blocks: { 'workspace-instructions': false, 'file-references': false, time: false },
      snapshotSource: empty,
    })
    expect(messages).toEqual([])
  })
})

describe('当前时间', () => {
  it('时间可以注入，时区也认', () => {
    const shanghai = buildTimeContext({ now: () => new Date('2026-10-29T13:34:00Z'), timeZone: 'Asia/Shanghai' })
    expect(shanghai.local).toBe('2026-10-29 21:34:00')
    expect(shanghai.offset).toBe('UTC+08:00')
    expect(shanghai.text).toContain('Asia/Shanghai')
  })

  it('UTC 与负偏移都算得对', () => {
    const utc = buildTimeContext({ now: () => new Date('2026-10-29T13:34:00Z'), timeZone: 'UTC' })
    expect(utc.local).toBe('2026-10-29 13:34:00')
    expect(utc.offset).toBe('UTC+00:00')
    const newYork = buildTimeContext({ now: () => new Date('2026-10-29T13:34:00Z'), timeZone: 'America/New_York' })
    expect(newYork.local).toBe('2026-10-29 09:34:00')
    expect(newYork.offset).toBe('UTC-04:00')
  })

  it('不注入时间源时取系统时间', () => {
    const block = buildTimeContext()
    expect(block.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('注入消息的内容块', () => {
  it('转成模型侧的文本块', () => {
    expect(contextContentBlocks({ role: 'user', kind: 'time', text: '现在几点' })).toEqual([
      { type: 'text', text: '现在几点' },
    ])
  })
})
