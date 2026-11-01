/**
 * checkpoint 的写入、读取与崩溃恢复。
 *
 * 这里最要紧的一条是顺序：**调用请求落盘 → 工具执行 → 结果落盘 → 宿主才让结果进历史**。
 * 崩在中间时，恢复入口必须能指出「哪条调用没跑完」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CheckpointJournal,
  defaultCheckpointPath,
  readCheckpointRecords,
  recoverCheckpoint,
  runCheckpointedToolCall,
} from '../src/index.ts'

const roots: string[] = []

function newFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-guard-ckpt-'))
  roots.push(root)
  return join(root, 'checkpoint.jsonl')
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

describe('写入与读取', () => {
  it('写进去的记录读回来一样', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.appendTurnStart({ turnId: 't1', intent: '把 README 翻译成中文' })
    journal.appendCall({ turnId: 't1', callId: 'c1', name: 'fs_read', arguments: '{"path":"README.md"}' })
    journal.appendResult({ turnId: 't1', callId: 'c1', content: '# RyHarness', isError: false })
    journal.appendTurnEnd({ turnId: 't1' })
    journal.close()

    const { records, damagedLines } = readCheckpointRecords(filePath)

    expect(damagedLines).toBe(0)
    expect(records).toHaveLength(4)
    expect(records[0]).toMatchObject({ kind: 'turn-start', turnId: 't1', intent: '把 README 翻译成中文' })
    expect(records[1]).toMatchObject({ kind: 'call', callId: 'c1', name: 'fs_read', arguments: '{"path":"README.md"}' })
    expect(records[2]).toMatchObject({ kind: 'result', callId: 'c1', content: '# RyHarness', isError: false })
    expect(records[3]).toMatchObject({ kind: 'turn-end', turnId: 't1' })
  })

  it('文件还不存在：读出来是空的，不是错误', () => {
    const { records, damagedLines } = readCheckpointRecords(join(newFile(), 'nope.jsonl'))

    expect(records).toEqual([])
    expect(damagedLines).toBe(0)
  })

  it('续写同一个文件：序号接着走', () => {
    const filePath = newFile()
    const first = new CheckpointJournal({ filePath })
    first.appendTurnStart({ turnId: 't1', intent: '第一件事' })
    first.close()

    const second = new CheckpointJournal({ filePath })
    second.appendTurnStart({ turnId: 't2', intent: '第二件事' })
    second.close()

    const { records } = readCheckpointRecords(filePath)
    expect(records.map((record) => record.seq)).toEqual([1, 2])
  })

  it('写坏了的行被跳过，前面的记录照样读得出来', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.appendCall({ turnId: 't1', callId: 'c1', name: 'fs_read', arguments: '{}' })
    journal.close()
    // 模拟崩在写一半的行上。
    writeFileSync(filePath, '{"kind":"call","seq":2,"turnId":"t1","at":1,"callId":"c2"', { flag: 'a' })

    const { records, damagedLines } = readCheckpointRecords(filePath)

    expect(records).toHaveLength(1)
    expect(damagedLines).toBe(1)
  })

  it('不认识的记录类型：当作坏行跳过', () => {
    const filePath = newFile()
    writeFileSync(filePath, '{"kind":"mystery","seq":1,"turnId":"t1","at":1}\n', { flag: 'w' })

    const { records, damagedLines } = readCheckpointRecords(filePath)

    expect(records).toEqual([])
    expect(damagedLines).toBe(1)
  })

  it('关掉之后再写：明确报错，而不是默默丢数据', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.close()

    expect(() => journal.appendTurnStart({ turnId: 't1', intent: 'x' })).toThrow(/已关闭/)
  })
})

describe('崩溃恢复入口', () => {
  it('崩在中间：只写了调用、没写结果，恢复入口拿到那条没跑完的调用', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.appendTurnStart({ turnId: 't1', intent: '删掉临时文件' })
    journal.appendCall({ turnId: 't1', callId: 'c1', name: 'shell_exec', arguments: '{"cmd":"rm tmp"}' })
    journal.close()

    const recovery = recoverCheckpoint(filePath)

    expect(recovery.unfinished).toHaveLength(1)
    expect(recovery.unfinished[0]).toMatchObject({
      turnId: 't1',
      callId: 'c1',
      name: 'shell_exec',
      arguments: '{"cmd":"rm tmp"}',
    })
    expect(recovery.intent).toBe('删掉临时文件')
    expect(recovery.turnId).toBe('t1')
  })

  it('结果写下去了：这条调用就算跑完了', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.appendCall({ turnId: 't1', callId: 'c1', name: 'fs_read', arguments: '{}' })
    journal.appendResult({ turnId: 't1', callId: 'c1', content: 'ok', isError: false })
    journal.close()

    expect(recoverCheckpoint(filePath).unfinished).toEqual([])
  })

  it('多条调用混着：只报出真正没跑完的那几条', () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    journal.appendCall({ turnId: 't1', callId: 'c1', name: 'fs_read', arguments: '{}' })
    journal.appendResult({ turnId: 't1', callId: 'c1', content: 'ok', isError: false })
    journal.appendCall({ turnId: 't1', callId: 'c2', name: 'fs_write', arguments: '{}' })
    journal.close()

    const recovery = recoverCheckpoint(filePath)

    expect(recovery.unfinished.map((call) => call.callId)).toEqual(['c2'])
  })
})

describe('先落盘，再进历史', () => {
  it('工具执行时，调用请求已经在盘上了', async () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })
    const seen: string[] = []

    const result = await runCheckpointedToolCall({
      journal,
      turnId: 't1',
      callId: 'c1',
      name: 'fs_read',
      arguments: '{"path":"a.md"}',
      execute: async () => {
        seen.push(...readCheckpointRecords(filePath).records.map((record) => record.kind))
        return { content: '内容' }
      },
    })
    journal.close()

    expect(seen).toEqual(['call'])
    expect(result.content).toBe('内容')
    const { records } = readCheckpointRecords(filePath)
    expect(records.map((record) => record.kind)).toEqual(['call', 'result'])
  })

  it('工具抛错：那次调用也落一条错误结果（它已经发生过了）', async () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })

    const result = await runCheckpointedToolCall({
      journal,
      turnId: 't1',
      callId: 'c1',
      name: 'fs_write',
      arguments: '{}',
      execute: () => Promise.reject(new Error('磁盘满了')),
    })
    journal.close()

    expect(result.isError).toBe(true)
    expect(result.content).toContain('磁盘满了')
    expect(recoverCheckpoint(filePath).unfinished).toEqual([])
  })

  it('工具抛的不是 Error：也落得下一句话', async () => {
    const filePath = newFile()
    const journal = new CheckpointJournal({ filePath })

    const result = await runCheckpointedToolCall({
      journal,
      turnId: 't1',
      callId: 'c1',
      name: 'fs_write',
      arguments: '{}',
      execute: () => Promise.reject('字符串错误'),
    })
    journal.close()

    expect(result.content).toContain('字符串错误')
  })
})

describe('文件路径', () => {
  it('默认路径：按会话分目录', () => {
    expect(defaultCheckpointPath('/data', 'conv-1')).toBe(join('/data', 'conv-1', 'checkpoint.jsonl'))
  })

  it('会话 id 里的怪字符被换掉，路径不会跑出根目录', () => {
    const root = join(tmpdir(), 'ryharness-guard-paths')
    const path = defaultCheckpointPath(root, '../../etc/passwd')

    // 解析完还在根目录底下，才说明这段 id 没把路径带出去。
    expect(resolve(path).startsWith(resolve(root) + sep)).toBe(true)
  })

  it('会话 id 就是 ..：换成安全名字', () => {
    expect(defaultCheckpointPath('/data', '..')).toBe(join('/data', 'unknown', 'checkpoint.jsonl'))
    expect(defaultCheckpointPath('/data', '')).toBe(join('/data', 'unknown', 'checkpoint.jsonl'))
  })
})
