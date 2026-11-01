/**
 * 命令注册表的用例。
 *
 * 这里盯的是三件要紧的事：**重名必须报错**（否则用户敲了 A 却跑了 B）、
 * **不是命令不能被当成命令跑**、以及**命令抛错时要给出可读的原因**。
 */
import { describe, expect, it } from 'vitest'
import type { CommandDefinition, CommandResult } from '../src/index.ts'
import { CommandError, CommandRegistry, describeCommandFailure } from '../src/index.ts'

/** 造一条命令：把执行过程记下来，方便断言参数。 */
function command(name: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name,
    description: `${name} 的说明`,
    execute: async () => {
      return { text: `${name} 跑完了` }
    },
    ...overrides,
  }
}

describe('命令注册表', () => {
  it('注册之后清单里就有它', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal'))

    expect(registry.list()).toEqual([{ name: 'goal', description: 'goal 的说明', aliases: [] }])
  })

  it('清单按名字排序，界面补全好做', () => {
    const registry = new CommandRegistry()
    registry.register(command('zebra'))
    registry.register(command('apple'))

    expect(registry.list().map((item) => item.name)).toEqual(['apple', 'zebra'])
  })

  it('别名也进清单', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal', { aliases: ['g', 'target'] }))

    expect(registry.list()[0].aliases).toEqual(['g', 'target'])
  })

  it('重名注册直接报错，不静默覆盖', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal'))

    expect(() => registry.register(command('goal'))).toThrow(CommandError)
    expect(() => registry.register(command('goal'))).toThrow(/已经注册过/)
  })

  it('别名撞上别的命令名：报错', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal'))

    expect(() => registry.register(command('other', { aliases: ['goal'] }))).toThrow(/已经是别的命令/)
  })

  it('两个命令用同一个别名：报错', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal', { aliases: ['g'] }))

    expect(() => registry.register(command('other', { aliases: ['g'] }))).toThrow(/被别的命令用过/)
  })

  it('名字不合法或者缺说明：报错', () => {
    const registry = new CommandRegistry()

    expect(() => registry.register(command('Goal'))).toThrow(/不合法/)
    expect(() => registry.register(command('goal', { description: '' }))).toThrow(/缺说明/)
    expect(() => registry.register(command('goal', { aliases: ['坏别名'] }))).toThrow(/别名不合法/)
  })

  it('执行命令：参数原样传进去', async () => {
    const registry = new CommandRegistry()
    let seen: { input: string; raw: string; line: string } | undefined
    registry.register(
      command('goal', {
        execute: async (args) => {
          seen = { input: args.input, raw: args.raw, line: args.line }
          return { text: '好' }
        },
      }),
    )

    const result = await registry.execute('/goal 继续')

    expect(result.ran).toBe(true)
    expect(result.name).toBe('goal')
    expect(result.text).toBe('好')
    expect(result.isError).toBeUndefined()
    expect(seen).toEqual({ input: '继续', raw: ' 继续', line: '/goal 继续' })
  })

  it('别名也能跑，跑的是同一条命令', async () => {
    const registry = new CommandRegistry()
    registry.register(command('goal', { aliases: ['g'] }))

    const result = await registry.execute('/g 继续')

    expect(result.ran).toBe(true)
    expect(result.name).toBe('goal')
  })

  it('普通消息：明说「这不是命令」，不跑任何东西', async () => {
    const registry = new CommandRegistry()
    let ran = false
    registry.register(
      command('goal', {
        execute: async () => {
          ran = true
          return { text: '不该跑到这里' }
        },
      }),
    )

    const result = await registry.execute('今天天气不错')

    expect(result.ran).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.text).toBe('这不是命令')
    expect(result.name).toBeUndefined()
    expect(ran).toBe(false)
  })

  it('命令不存在：说清楚是哪一条', async () => {
    const registry = new CommandRegistry()

    const result = await registry.execute('/nope')

    expect(result.ran).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.name).toBe('nope')
    expect(result.text).toBe('没有这个命令：/nope')
  })

  it('命令自己抛错：记成失败，但不炸出去', async () => {
    const registry = new CommandRegistry()
    registry.register(
      command('goal', {
        execute: async () => {
          throw new Error('数据库连不上')
        },
      }),
    )

    const result = await registry.execute('/goal')

    expect(result.ran).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('跑失败')
    expect(result.text).toContain('数据库连不上')
  })

  it('命令说自己是错的，错误标记与产物都原样带出来', async () => {
    const registry = new CommandRegistry()
    const result: CommandResult = {
      text: '没找到那个会话',
      isError: true,
      artifacts: [{ name: 'report.md', path: '/ws/report.md', kind: 'file' }],
    }
    registry.register(
      command('goal', {
        execute: async () => {
          return result
        },
      }),
    )

    const execution = await registry.execute('/goal')

    expect(execution.isError).toBe(true)
    expect(execution.text).toBe('没找到那个会话')
    expect(execution.artifacts).toEqual([{ name: 'report.md', path: '/ws/report.md', kind: 'file' }])
  })

  it('注销之后命令就没了', async () => {
    const registry = new CommandRegistry()
    const dispose = registry.register(command('goal'))
    expect(registry.find('goal')).toBeDefined()

    dispose()

    expect(registry.find('goal')).toBeUndefined()
    expect((await registry.execute('/goal')).ran).toBe(false)
  })

  it('find 按名字或别名都能找到', () => {
    const registry = new CommandRegistry()
    registry.register(command('goal', { aliases: ['g'] }))

    expect(registry.find('goal')?.name).toBe('goal')
    expect(registry.find('g')?.name).toBe('goal')
    expect(registry.find('nothing')).toBeUndefined()
  })
})

describe('失败说明', () => {
  it('异常、字符串、其它东西都能翻成一句话', () => {
    expect(describeCommandFailure(new Error('炸了'))).toBe('炸了')
    expect(describeCommandFailure('直接给的话')).toBe('直接给的话')
    expect(describeCommandFailure(42)).toBe('42')
  })
})
