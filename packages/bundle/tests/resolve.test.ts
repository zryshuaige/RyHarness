/**
 * 分层装配：后一层盖前一层，结果按插件 id 排。
 */

import { BundleError, BundleRegistry, resolveBundle, resolveBundles } from '@ryharness/bundle'
import { describe, expect, it } from 'vitest'

const BASE = {
  name: 'base',
  layers: [
    {
      id: 'core',
      plugins: [
        { id: 'core-tools', enabled: true },
        { id: 'todo', enabled: true },
        { id: 'web', enabled: false },
      ],
    },
  ],
}

const WEB = {
  name: 'web',
  layers: [
    {
      id: 'web-layer',
      plugins: [
        { id: 'web', enabled: true, config: { backend: 'api' } },
        { id: 'todo', enabled: false },
      ],
    },
  ],
}

describe('叠层', () => {
  it('一层就是它自己', () => {
    const resolved = resolveBundle(BASE)
    expect(resolved.plugins.map((plugin) => plugin.id)).toEqual(['core-tools', 'todo', 'web'])
    expect(resolved.overridden).toHaveLength(0)
  })

  it('后一层盖前一层', () => {
    const resolved = resolveBundle({ name: 'base+web', layers: [...BASE.layers, ...WEB.layers] })
    const web = resolved.plugins.find((plugin) => plugin.id === 'web')
    expect(web?.enabled).toBe(true)
    expect(web?.config).toEqual({ backend: 'api' })
    const todo = resolved.plugins.find((plugin) => plugin.id === 'todo')
    expect(todo?.enabled).toBe(false)
  })

  it('被覆盖的记下来：谁盖了谁', () => {
    const resolved = resolveBundle({ name: 'base+web', layers: [...BASE.layers, ...WEB.layers] })
    expect(resolved.overridden.map((entry) => entry.id).sort()).toEqual(['todo', 'web'])
    expect(
      resolved.overridden.every((entry) => {
        return entry.byLayer === 'web-layer'
      }),
    ).toBe(true)
  })

  it('结果按插件 id 排，与层里写的顺序无关', () => {
    const a = resolveBundle({
      name: 'x',
      layers: [
        {
          id: 'l1',
          plugins: [
            { id: 'z', enabled: true },
            { id: 'a', enabled: true },
          ],
        },
      ],
    })
    const b = resolveBundle({
      name: 'y',
      layers: [
        {
          id: 'l1',
          plugins: [
            { id: 'a', enabled: true },
            { id: 'z', enabled: true },
          ],
        },
      ],
    })
    expect(a.plugins.map((plugin) => plugin.id)).toEqual(b.plugins.map((plugin) => plugin.id))
  })

  it('bundle 没名字报 invalid-name', () => {
    expect(() => resolveBundle({ name: '  ', layers: BASE.layers })).toThrow(BundleError)
  })

  it('空层不装（空层多半是写错了）', () => {
    expect(() => resolveBundle({ name: 'x', layers: [{ id: 'empty', plugins: [] }] })).toThrow(BundleError)
  })
})

describe('叠两个 bundle', () => {
  it('后面的盖前面的', () => {
    const resolved = resolveBundles([BASE, WEB])
    expect(resolved.plugins.find((plugin) => plugin.id === 'web')?.enabled).toBe(true)
    expect(resolved.name).toBe('base+web')
  })

  it('一个都没给时报 not-found', () => {
    expect(() => resolveBundles([])).toThrow(BundleError)
  })
})

describe('bundle 注册表', () => {
  it('按名字取一个并叠好', () => {
    const registry = new BundleRegistry()
    registry.register(BASE)
    expect(registry.resolve('base').plugins).toHaveLength(3)
  })

  it('同一个名字登记两次报错', () => {
    const registry = new BundleRegistry()
    registry.register(BASE)
    expect(() => registry.register(BASE)).toThrow(BundleError)
  })

  it('取不存在的报 not-found', () => {
    const registry = new BundleRegistry()
    expect(() => registry.resolve('nope')).toThrow(BundleError)
  })

  it('清单按名字排', () => {
    const registry = new BundleRegistry()
    registry.register({ ...BASE, name: 'b' })
    registry.register({ ...BASE, name: 'a' })
    expect(registry.list().map((bundle) => bundle.name)).toEqual(['a', 'b'])
  })
})
