/**
 * 技能注册表的用例。
 *
 * 这里盯的是三件容易出错的事：**同名时谁赢**、**目录里不能混进正文**、
 * **找不到与名字不合法要给出不同的原因**。前两件错了，模型会拿到错的正文；
 * 第三件错了，模型只会反复重试同一个名字。
 */
import { describe, expect, it } from 'vitest'
import type { Skill, SkillProvider, SkillSummary } from '../src/index.ts'
import { SkillError, SkillRegistry } from '../src/index.ts'

/** 造一条技能。 */
function skill(name: string, source: string, content = '正文'): Skill {
  return { name, title: name, description: `${name} 的说明`, content, source }
}

/** 造一个来源：目录里只有摘要，正文按名字取。 */
function provider(name: string, skills: readonly Skill[], priority?: number): SkillProvider {
  return {
    name,
    priority,
    list: async () => {
      return skills.map((item) => {
        const summary: SkillSummary = {
          name: item.name,
          title: item.title,
          description: item.description,
          source: item.source,
        }
        return summary
      })
    },
    resolve: async (target) => skills.find((item) => item.name === target),
  }
}

describe('技能注册表', () => {
  it('空注册表：目录是空的', async () => {
    const registry = new SkillRegistry()

    expect(await registry.list()).toEqual([])
  })

  it('内嵌技能进目录，并且目录按名字排序', async () => {
    const registry = new SkillRegistry()
    registry.register(skill('zebra', 'runtime'))
    registry.register(skill('apple', 'runtime'))

    const catalog = await registry.list()

    expect(catalog.map((item) => item.name)).toEqual(['apple', 'zebra'])
    expect(catalog[0].source).toBe('runtime')
  })

  it('目录里只有名字与说明，没有正文', async () => {
    const registry = new SkillRegistry()
    registry.register(skill('apple', 'runtime', '一段很长的正文'))

    const catalog = await registry.list()

    expect(Object.keys(catalog[0])).not.toContain('content')
    expect('content' in catalog[0]).toBe(false)
  })

  it('resolve 给回全文', async () => {
    const registry = new SkillRegistry()
    registry.register(skill('apple', 'runtime', '一段很长的正文'))

    const loaded = await registry.resolve('apple')

    expect(loaded.content).toBe('一段很长的正文')
    expect(loaded.name).toBe('apple')
  })

  it('同名技能：先注册的来源赢', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(provider('first', [skill('dup', 'first', '第一份')]))
    registry.registerProvider(provider('second', [skill('dup', 'second', '第二份')]))

    const catalog = await registry.list()

    expect(catalog).toHaveLength(1)
    expect(catalog[0].source).toBe('first')
    expect((await registry.resolve('dup')).content).toBe('第一份')
  })

  it('同名技能：优先级高的赢，与注册先后无关', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(provider('low', [skill('dup', 'low', '低优先级')], 500))
    registry.registerProvider(provider('high', [skill('dup', 'high', '高优先级')], 10))

    const catalog = await registry.list()

    expect(catalog[0].source).toBe('high')
    expect((await registry.resolve('dup')).content).toBe('高优先级')
  })

  it('被盖住的那一路会记进 conflicts，不是悄悄消失', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(provider('first', [skill('dup', 'first')]))
    registry.registerProvider(provider('second', [skill('dup', 'second')]))

    await registry.list()
    const conflicts = registry.conflicts()

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toEqual({ name: 'dup', winner: 'first', loser: 'second' })
  })

  it('内嵌技能比 provider 优先', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(provider('disk', [skill('dup', 'disk', '磁盘上的')]))
    registry.register(skill('dup', 'runtime', '内嵌的'))

    const catalog = await registry.list()

    expect(catalog[0].source).toBe('runtime')
    expect((await registry.resolve('dup')).content).toBe('内嵌的')
  })

  it('内嵌技能重名：先登记的赢，冲突记下来', async () => {
    const registry = new SkillRegistry()
    registry.register(skill('dup', 'runtime', '第一份'))
    registry.register(skill('dup', 'other', '第二份'))

    expect((await registry.resolve('dup')).content).toBe('第一份')
    expect(registry.conflicts()).toEqual([{ name: 'dup', winner: 'runtime', loser: 'other' }])
  })

  it('provider 名重复：直接报错', () => {
    const registry = new SkillRegistry()
    registry.registerProvider(provider('same', []))

    expect(() => registry.registerProvider(provider('same', []))).toThrow(SkillError)
    expect(() => registry.registerProvider(provider('same', []))).toThrow(/已经注册过/)
  })

  it('一个来源坏了，其它来源照常，坏的那个记进 failures', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider({
      name: 'broken',
      list: async () => {
        throw new Error('磁盘炸了')
      },
      resolve: async () => undefined,
    })
    registry.registerProvider(provider('ok', [skill('apple', 'ok')]))

    const catalog = await registry.list()

    expect(catalog.map((item) => item.name)).toEqual(['apple'])
    expect(registry.failures()).toEqual([{ provider: 'broken', reason: '磁盘炸了' }])
  })

  it('名字不合法与找不到，是两种不同的错', async () => {
    const registry = new SkillRegistry()

    await expect(registry.resolve('空名字')).rejects.toThrow(/名字不合法/)
    await expect(registry.resolve('')).rejects.toThrow(/名字不合法/)
    await expect(registry.resolve('missing')).rejects.toThrow(/没有这个技能/)
  })

  it('注册时名字不合法或缺说明：报错，不进目录', async () => {
    const registry = new SkillRegistry()

    expect(() => registry.register(skill('坏名字', 'runtime'))).toThrow(SkillError)
    expect(() =>
      registry.register({ name: 'ok', title: 'ok', description: '', content: 'x', source: 'runtime' }),
    ).toThrow(/缺说明/)
    expect(await registry.list()).toEqual([])
  })

  it('注销来源之后，它的技能从目录里消失', async () => {
    const registry = new SkillRegistry()
    const dispose = registry.registerProvider(provider('disk', [skill('apple', 'disk')]))
    expect(await registry.list()).toHaveLength(1)

    dispose()

    expect(await registry.list()).toEqual([])
    expect(await registry.resolve('apple').catch((error: unknown) => error)).toBeInstanceOf(SkillError)
  })

  it('来源报告目录变了，订阅者会被叫醒', async () => {
    const registry = new SkillRegistry()
    let notify: (() => void) | undefined
    registry.registerProvider({
      name: 'disk',
      list: async () => [],
      resolve: async () => undefined,
      onChange: (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      },
    })
    let hits = 0
    registry.onChange(() => {
      hits += 1
    })

    notify?.()

    expect(hits).toBeGreaterThan(0)
  })

  it('provider 没有名字：报错', () => {
    const registry = new SkillRegistry()

    expect(() =>
      registry.registerProvider({
        name: '',
        list: async () => [],
        resolve: async () => undefined,
      }),
    ).toThrow(/必须有名字/)
  })

  it('注销来源之后，它再报变化也不会惊动订阅者', () => {
    const registry = new SkillRegistry()
    // 假的来源自己留一份订阅集合：退订到底有没有真的退，看它还会不会叫注册表。
    const listeners = new Set<() => void>()
    let notify: (() => void) | undefined
    const dispose = registry.registerProvider({
      name: 'disk',
      list: async () => [],
      resolve: async () => undefined,
      onChange: (listener) => {
        listeners.add(listener)
        notify = () => {
          for (const item of listeners) item()
        }
        return () => {
          listeners.delete(listener)
        }
      },
    })
    let hits = 0
    registry.onChange(() => {
      hits += 1
    })

    dispose()
    const afterDispose = hits
    notify?.()

    expect(hits).toBe(afterDispose)
  })

  it('退订之后，订阅者不再被叫醒', () => {
    const registry = new SkillRegistry()
    let hits = 0
    const off = registry.onChange(() => {
      hits += 1
    })
    const before = hits

    off()
    registry.register(skill('apple', 'runtime'))

    expect(hits).toBe(before)
  })

  it('来源说这个技能在目录里，正文却取不到：报「取不到」', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider({
      name: 'disk',
      list: async () => [{ name: 'ghost', title: 'ghost', description: '说明', source: 'disk' }],
      resolve: async () => undefined,
    })

    await expect(registry.resolve('ghost')).rejects.toThrow(/正文取不到/)
  })

  it('来源取回来的正文跟名字对不上：报错，不冒充', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider({
      name: 'disk',
      list: async () => [{ name: 'ghost', title: 'ghost', description: '说明', source: 'disk' }],
      resolve: async () => skill('other', 'disk'),
    })

    await expect(registry.resolve('ghost')).rejects.toThrow(/与名字对不上/)
  })
})
