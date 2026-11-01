/**
 * 沙箱闸在工具层的表现：会话把权限收紧后，工具即使还在白名单里也不能动手。
 *
 * 这一族用例盯的是**第二层闸**：助理的权限档位决定的是「这位助理平时有什么工具」，
 * 而会话级覆盖决定的是「这一轮能不能动」。两件事都生效时，后者要压住前者。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@ryharness/agent'
import { fsEdit, fsWrite, shellExec } from '@ryharness/tools'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function workspace(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-sandbox-gate-'))
  roots.push(root)
  return { root, ctx: { workspaceRoot: root } }
}

/** 同一份工作区，但把沙箱模式钉成某一档。 */
function withMode(ctx: ToolContext, sandboxMode: 'read-only' | 'workspace-write' | 'full-access'): ToolContext {
  return { ...ctx, sandboxMode }
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('沙箱闸（工具层）', () => {
  it('只读：fs_write 不写，文件根本没出现', async () => {
    const { root, ctx } = workspace()
    const target = join(root, 'a.txt')
    const result = await fsWrite.execute({ path: 'a.txt', content: 'hello' }, withMode(ctx, 'read-only'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('只读')
    expect(existsSync(target)).toBe(false)
  })

  it('工作区可写：fs_write 照常写', async () => {
    const { root, ctx } = workspace()
    const result = await fsWrite.execute({ path: 'b.txt', content: 'hello' }, withMode(ctx, 'workspace-write'))
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('hello')
  })

  it('只读：fs_edit 不改，文件内容原样', async () => {
    const { root, ctx } = workspace()
    const target = join(root, 'c.txt')
    writeFileSync(target, 'old text', 'utf8')
    const result = await fsEdit.execute(
      { path: 'c.txt', oldText: 'old text', newText: 'new text' },
      withMode(ctx, 'read-only'),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('只读')
    expect(readFileSync(target, 'utf8')).toBe('old text')
  })

  it('只读：shell_exec 不执行命令', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'echo sandbox-guard' }, withMode(ctx, 'read-only'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('只读')
  })

  it('工作区可写：命令要写到工作区之外时拦下来', async () => {
    const { ctx } = workspace()
    const outside = join(roots[0] as string, '..', 'outside-target.txt')
    const result = await shellExec.execute({ command: `echo x > "${outside}"` }, withMode(ctx, 'workspace-write'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('工作区之外')
  })

  it('全权：不套围栏，命令照跑', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'echo sandbox-guard' }, withMode(ctx, 'full-access'))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('sandbox-guard')
  })
})
