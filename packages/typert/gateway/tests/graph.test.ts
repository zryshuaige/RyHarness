/**
 * 类型图：反射 + 注解 + 查重。
 */
import { describe, expect, it } from 'vitest'
import { buildTypeGraph, findEntry, formatGraph } from '../src/index.ts'
import { GREETING_ANNOTATIONS, GreetingService, SelfNamedService } from './helpers.ts'

/** 造一张带注解的图。 */
function greetingGraph(): ReturnType<typeof buildTypeGraph> {
  return buildTypeGraph([
    {
      namespace: 'greeting',
      service: new GreetingService(),
      methods: GREETING_ANNOTATIONS,
    },
  ])
}

describe('类型图', () => {
  it('图里有命名空间、服务与方法', () => {
    const graph = greetingGraph()
    expect(graph.version).toBe(1)
    expect(graph.namespaces).toEqual(['greeting'])
    expect(graph.services).toHaveLength(1)
    expect(graph.services[0]?.serviceKey).toBe('GreetingService')
    expect(graph.entries.map((entry) => entry.name).sort()).toEqual([
      'add',
      'aliasName',
      'boom',
      'greet',
      'shout',
      'slow',
    ])
  })

  it('注解把类型贴到参数与返回值上', () => {
    const graph = greetingGraph()
    const greet = findEntry(graph, 'greeting', 'greet')
    expect(greet?.method.params.map((param) => `${param.name}: ${param.type}`)).toEqual([
      'name: string',
      'greeting: string',
    ])
    expect(greet?.method.returns).toBe('string')
    expect(greet?.method.params[1]?.optional).toBe(true)
  })

  it('异步方法被标出来', () => {
    const graph = greetingGraph()
    expect(findEntry(graph, 'greeting', 'shout')?.method.async).toBe(true)
    expect(findEntry(graph, 'greeting', 'greet')?.method.async).toBe(false)
  })

  it('没写注解的方法类型是 unknown', () => {
    const graph = buildTypeGraph([{ namespace: 'raw', service: new GreetingService() }])
    const greet = findEntry(graph, 'raw', 'greet')
    expect(greet?.method.returns).toBe('unknown')
    expect(greet?.method.params[0]?.type).toBe('unknown')
    // 参数名还是反射得出来的。
    expect(greet?.method.params.map((param) => param.name)).toEqual(['name', 'greeting'])
  })

  it('同一个命名空间里两个 remote 抢同一个名字：装配时就报错', () => {
    expect(() =>
      buildTypeGraph([
        { namespace: 'greeting', service: new GreetingService() },
        { namespace: 'greeting', service: new GreetingService() },
      ]),
    ).toThrowError(/greeting/)
  })

  it('冲突的失败带机器码与详情', () => {
    let caught: unknown
    try {
      buildTypeGraph([
        { namespace: 'greeting', service: new GreetingService() },
        { namespace: 'greeting', service: new GreetingService() },
      ])
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'gateway/conflict' })
    expect(caught).toMatchObject({ details: { namespace: 'greeting', method: 'greet' } })
  })

  it('不同命名空间可以用同一个方法名', () => {
    const graph = buildTypeGraph([
      { namespace: 'a', service: new GreetingService() },
      { namespace: 'b', service: new GreetingService() },
    ])
    expect(graph.namespaces).toEqual(['a', 'b'])
    expect(findEntry(graph, 'a', 'greet')).toBeDefined()
    expect(findEntry(graph, 'b', 'greet')).toBeDefined()
  })

  it('注解的参数个数与实现对不上时拒绝', () => {
    expect(() =>
      buildTypeGraph([
        {
          namespace: 'greeting',
          service: new GreetingService(),
          methods: { greet: { params: [{ name: 'name', type: 'string' }], returns: 'string' } },
        },
      ]),
    ).toThrowError(/对不上/)
  })

  it('可选参数后面还有必填参数时拒绝', () => {
    expect(() =>
      buildTypeGraph([
        {
          namespace: 'greeting',
          service: new GreetingService(),
          methods: {
            add: {
              params: [
                { name: 'a', type: 'number', optional: true },
                { name: 'b', type: 'number' },
              ],
              returns: 'number',
            },
          },
        },
      ]),
    ).toThrowError(/可选参数/)
  })

  it('命名空间可以由本地对象的 typertRemote 决定', () => {
    const graph = buildTypeGraph([{ service: new SelfNamedService() }])
    expect(graph.namespaces).toEqual(['auto'])
    expect(graph.services[0]?.serviceKey).toBe('SelfNamedService')
  })

  it('既没写命名空间、本地对象也没有绑定时拒绝', () => {
    class Plain {
      hello(): string {
        return 'hi'
      }
    }
    expect(() => buildTypeGraph([{ service: new Plain() }])).toThrowError(/命名空间/)
  })

  it('图能写成人能读的几行字', () => {
    const lines = formatGraph(greetingGraph())
    expect(lines).toContain('greeting.greet(name: string, greeting?: string) -> string')
    expect(lines).toContain('greeting.add(a: number, b: number) -> number')
  })

  it('查不到的方法给 undefined', () => {
    const graph = greetingGraph()
    expect(findEntry(graph, 'greeting', 'nope')).toBeUndefined()
    expect(findEntry(graph, 'nope', 'greet')).toBeUndefined()
  })
})
