/**
 * 宿主侧的挂载：类型图与冲突检查。
 */
import { describe, expect, it } from 'vitest'
import { RemoteHost } from '../src/index.ts'
import { COUNTER_ANNOTATIONS, CounterService } from './helpers.ts'

describe('宿主挂载', () => {
  it('没挂东西时类型图是空的', () => {
    const host = new RemoteHost()
    expect(host.graph.namespaces).toEqual([])
    expect(host.graph.entries).toEqual([])
  })

  it('挂一个对象，类型图里就有它的方法', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService(), methods: COUNTER_ANNOTATIONS })
    expect(host.graph.namespaces).toEqual(['counter'])
    expect(host.graph.entries.map((entry) => entry.name).sort()).toEqual(['add', 'boom', 'echo', 'slow'])
  })

  it('不是 remote 的方法不进图', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService() })
    expect(host.graph.entries.map((entry) => entry.name)).not.toContain('plain')
  })

  it('同一个命名空间里两个 remote 抢同一个名字：挂载时就报错', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService() })
    expect(() => host.mount({ namespace: 'counter', service: new CounterService() })).toThrowError(/counter/)
  })

  it('不同命名空间可以用同一个方法名', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'a', service: new CounterService() })
    host.mount({ namespace: 'b', service: new CounterService() })
    expect(host.graph.namespaces).toEqual(['a', 'b'])
  })

  it('服务标识默认取构造函数名', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService() })
    expect(host.graph.services[0]?.serviceKey).toBe('CounterService')
  })

  it('服务标识可以自己写', () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService(), serviceKey: '账房' })
    expect(host.graph.services[0]?.serviceKey).toBe('账房')
  })
})
