/**
 * 反射：读出带 `@Remote` 的实例上有哪些方法、参数叫什么。
 */
import { describe, expect, it } from 'vitest'
import { readRemoteMarkers, reflectParameters } from '../src/index.ts'
import { ChildGreetingService, GreetingService } from './helpers.ts'

describe('运行时反射', () => {
  it('读出全部 remote 方法，普通方法不算', () => {
    const markers = readRemoteMarkers(new GreetingService())
    const names = markers.map((marker) => marker.method).sort()
    expect(names).toEqual(['add', 'boom', 'greet', 'loud', 'shout', 'slow'])
    expect(names).not.toContain('plain')
  })

  it('线上名字与方法名分开记', () => {
    const markers = readRemoteMarkers(new GreetingService())
    const loud = markers.find((marker) => marker.method === 'loud')
    expect(loud?.exportName).toBe('aliasName')
    const greet = markers.find((marker) => marker.method === 'greet')
    expect(greet?.exportName).toBeUndefined()
  })

  it('参数名与默认值能读出来', () => {
    const service = new GreetingService()
    const params = reflectParameters(service.greet)
    expect(params.map((param) => param.name)).toEqual(['name', 'greeting'])
    expect(params[0]?.optional).toBe(false)
    // 第二个参数有默认值，所以是可选的。
    expect(params[1]?.optional).toBe(true)
    expect(params.map((param) => param.type)).toEqual(['unknown', 'unknown'])
  })

  it('继承来的方法也能反射到', () => {
    const markers = readRemoteMarkers(new ChildGreetingService())
    const names = markers.map((marker) => marker.method)
    expect(names).toContain('greet')
    expect(names).toContain('child')
  })

  it('没有装饰器的普通类反射出空表', () => {
    class Plain {
      hello(): string {
        return 'hi'
      }
    }
    expect(readRemoteMarkers(new Plain())).toEqual([])
  })
})
