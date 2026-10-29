import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loadWorkspaceInstructions } from '@ryharness/context'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ctx-instr-'))
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

describe('工作区指令文件', () => {
  it('找到 AGENTS.md 就装成一段带来源的指引', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '提交前先跑一遍 pnpm lint。', 'utf8')
    const block = loadWorkspaceInstructions({ workspaceRoot: root })
    expect(block?.source).toBe('AGENTS.md')
    expect(block?.truncated).toBe(false)
    expect(block?.text).toContain('AGENTS.md')
    expect(block?.text).toContain('提交前先跑一遍 pnpm lint。')
    // 模型得看得出这是项目规矩，不是用户这轮随口说的。
    expect(block?.text).toContain('不是用户这轮说的话')
  })

  it('没有指令文件时什么都不注入', () => {
    const root = workspace()
    expect(loadWorkspaceInstructions({ workspaceRoot: root })).toBeUndefined()
  })

  it('空文件当作没有（不注入空块）', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '   \n', 'utf8')
    expect(loadWorkspaceInstructions({ workspaceRoot: root })).toBeUndefined()
  })

  it('候选名按顺序取第一个有内容的', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '', 'utf8')
    writeFileSync(join(root, 'RYHARNESS.md'), '第二条规矩。', 'utf8')
    const block = loadWorkspaceInstructions({ workspaceRoot: root })
    expect(block?.source).toBe('RYHARNESS.md')
    expect(block?.text).toContain('第二条规矩。')
  })

  it('候选名可以由调用方给', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '第一条规矩。', 'utf8')
    writeFileSync(join(root, 'NOTES.md'), '第三条规矩。', 'utf8')
    const block = loadWorkspaceInstructions({ workspaceRoot: root, fileNames: ['NOTES.md'] })
    expect(block?.source).toBe('NOTES.md')
    expect(block?.text).not.toContain('第一条规矩。')
  })

  it('超长时截断并写明截了多少', () => {
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(100), 'utf8')
    const block = loadWorkspaceInstructions({ workspaceRoot: root, maxChars: 10 })
    expect(block?.truncated).toBe(true)
    expect(block?.text).toContain('已截断：全文 100 字符，这里只保留前 10 字符')
    expect(block?.text).toContain('x'.repeat(10))
  })

  it('读不出来（指令名其实是个目录）就当它没有', () => {
    const root = workspace()
    mkdirSync(join(root, 'AGENTS.md'))
    expect(loadWorkspaceInstructions({ workspaceRoot: root })).toBeUndefined()
  })

  it('指向工作区外的指令文件不装配', () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'AGENTS.md'), '外面的规矩。', 'utf8')
    // 候选名写成越出根的相对路径：边界挡住，不装配外面的内容。
    const escaping = relative(root, join(outside, 'AGENTS.md'))
    const block = loadWorkspaceInstructions({ workspaceRoot: root, fileNames: [escaping] })
    expect(block).toBeUndefined()
  })
})
