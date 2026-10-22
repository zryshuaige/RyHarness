/**
 * 工具注册表：注册/注销、重复名诊断、按名查找与插件卸载后的消失。
 *
 * 注册必须真的是「effect」而不是一张进程级 Map：卸载插件 fiber 之后工具还在，
 * 模型就会看到一个已经没人负责实现的名字。这里用 cordis 的 fiber 直接验证。
 */
import type { Tool } from '@ryharness/agent'
import { Context } from '@ryharness/cordis'
import { ToolRegistry } from '@ryharness/tools'
import { describe, expect, it } from 'vitest'

function stubTool(name: string): Tool {
  return {
    name,
    description: `${name} stub`,
    parameters: { type: 'object', properties: {} },
    execute: () => {
      return Promise.resolve({ content: name })
    },
  }
}

async function mounted(): Promise<{ ctx: Context; registry: ToolRegistry }> {
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  return { ctx, registry: ctx.tools }
}

describe('ToolRegistry', () => {
  it('注册后可列出、按名取到；disposer 只注销自己那一次注册', async () => {
    const { registry } = await mounted()
    const read = stubTool('fs_read')
    const remove = registry.register(read)
    expect(registry.list().map((tool) => tool.name)).toEqual(['fs_read'])
    expect(registry.get('fs_read')).toBe(read)
    expect(registry.get('missing')).toBeUndefined()

    remove()
    expect(registry.get('fs_read')).toBeUndefined()
    expect(registry.list()).toEqual([])
    // cordis 的 disposer 幂等：重复调用不能把后来注册的同名工具误删。
    remove()
  })

  it('重复同名注册抛错并点名工具，原注册保持不变', async () => {
    const { registry } = await mounted()
    const first = stubTool('shell_exec')
    registry.register(first)
    expect(() => registry.register(stubTool('shell_exec'))).toThrow(/shell_exec.*already registered/)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('shell_exec')).toBe(first)
  })

  it('空名字在进入注册表之前就被拒绝', async () => {
    const { registry } = await mounted()
    expect(() => registry.register(stubTool(''))).toThrow(/non-empty name/)
    expect(registry.list()).toEqual([])
  })

  it('插件 fiber 卸载后工具全部消失', async () => {
    const { ctx, registry } = await mounted()
    // 注册必须发生在插件自己的 ctx 上：register 是 effect，归属调用方 fiber。
    const tools = [stubTool('fs_read'), stubTool('file_produce')]
    const fiber = await ctx.inject(['tools'], (pluginCtx: Context) => {
      for (const tool of tools) pluginCtx.tools.register(tool)
    })
    expect(registry.list()).toHaveLength(2)

    await fiber.dispose()
    expect(registry.list()).toEqual([])
    expect(registry.get('fs_read')).toBeUndefined()
    // 服务本身还在（ToolRegistry 是另一个 fiber），卸载的只是注册它的插件。
    expect(ctx.get('tools') !== undefined).toBe(true)
  })

  it('注销后可以重新注册同名工具（热重挂路径）', async () => {
    const { registry } = await mounted()
    const remove = registry.register(stubTool('fs_write'))
    remove()
    const replacement = stubTool('fs_write')
    registry.register(replacement)
    expect(registry.get('fs_write')).toBe(replacement)
  })
})
