import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodePtcRuntime } from '@ryharness/ptc'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 造一个临时目录（用完删掉）。 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ptc-policy-'))
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

describe('文件策略', () => {
  it('允许范围内的文件读得到', async () => {
    const root = workspace()
    writeFileSync(join(root, 'note.txt'), '这里有一句话', 'utf8')
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return readTextFile("note.txt")',
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('这里有一句话')
    await runtime.dispose()
  })

  it('允许范围内的文件写得出', async () => {
    const root = workspace()
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'writeTextFile("out.txt", "写进去的"); return "done"',
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('done')
    await runtime.dispose()
  })

  it('读越界的文件被拒，失败分类是 policy', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), '不该被读到', 'utf8')
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: `return readTextFile("${join(outside, 'secret.txt').replace(/\\/g, '/')}")`,
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    expect(result.failure?.message).toContain('不在允许读的范围里')
    await runtime.dispose()
  })

  it('写越界的文件被拒', async () => {
    const root = workspace()
    const outside = workspace()
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: `writeTextFile("${join(outside, 'x.txt').replace(/\\/g, '/')}", "不该写出去"); return "done"`,
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    await runtime.dispose()
  })

  it('能读的地方不一定能写：writeRoots 单独收紧时写入被拒', async () => {
    const root = workspace()
    writeFileSync(join(root, 'note.txt'), '读得到', 'utf8')
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'writeTextFile("out.txt", "x"); return "done"',
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [] },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    await runtime.dispose()
  })

  it('越界的报错在程序里能接住（它就是个普通异常）', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), '不该被读到', 'utf8')
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: `try { await readTextFile("${join(outside, 'secret.txt').replace(/\\/g, '/')}") } catch (error) { return "接住了：" + error.message }`,
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(true)
    expect(String(result.value)).toContain('接住了')
    await runtime.dispose()
  })

  it('目录列表与存在性判断也受策略管', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.txt'), 'x', 'utf8')
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return [await listDirectory("."), await fileExists("a.txt"), await fileExists("b.txt")].join("|")',
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.value).toBe('a.txt|true|false')
    await runtime.dispose()
  })

  it('符号链接指向工作区外时也读不到', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), '不该被读到', 'utf8')
    let linked = true
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      linked = false
    }
    if (!linked) return
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return readTextFile("link/secret.txt")',
      mode: 'script',
      filePolicy: { cwd: root, readRoots: [root], writeRoots: [root] },
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    await runtime.dispose()
  })
})
