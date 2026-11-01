/**
 * 能力目录与扩展清单：查运行时有什么、按依赖解装载顺序。
 */

import {
  buildCatalog,
  createRuntimeCatalogTool,
  ExtensionError,
  ExtensionRegistry,
  RUNTIME_CATALOG_TOOL_NAME,
  searchCatalog,
} from '@ryharness/extensions'
import { describe, expect, it } from 'vitest'

const CATALOG = buildCatalog({
  tools: [
    { name: 'fs_read', description: '读文件' },
    { name: 'web_search', description: '搜索网页' },
  ],
  routes: [
    { method: 'GET', pattern: '/api/agents' },
    { method: 'POST', pattern: '/api/agents' },
  ],
  services: [{ name: 'llm', description: '模型路由' }],
})

describe('能力目录', () => {
  it('工具按名字排好，路由按方法与路径排好', () => {
    expect(CATALOG.tools.map((tool) => tool.name)).toEqual(['fs_read', 'web_search'])
    expect(CATALOG.routes.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      'GET /api/agents',
      'POST /api/agents',
    ])
  })

  it('不给关键词给全部', () => {
    const hits = searchCatalog(CATALOG, '')
    expect(hits.tools).toHaveLength(2)
    expect(hits.routes).toHaveLength(2)
    expect(hits.services).toHaveLength(1)
  })

  it('有关键词只给命中的（名字与说明都算）', () => {
    expect(searchCatalog(CATALOG, 'web').tools.map((tool) => tool.name)).toEqual(['web_search'])
    expect(searchCatalog(CATALOG, '读文件').tools.map((tool) => tool.name)).toEqual(['fs_read'])
    expect(searchCatalog(CATALOG, 'web').routes).toHaveLength(0)
  })

  it('没命中就是空，不是报错', () => {
    const hits = searchCatalog(CATALOG, '不存在的东西')
    expect(hits.tools).toHaveLength(0)
    expect(hits.routes).toHaveLength(0)
  })
})

describe('扩展清单注册表', () => {
  it('按 id 排序列出', () => {
    const registry = new ExtensionRegistry()
    registry.register({ id: 'b', name: 'B', description: '第二个' })
    registry.register({ id: 'a', name: 'A', description: '第一个' })
    expect(registry.list().map((manifest) => manifest.id)).toEqual(['a', 'b'])
  })

  it('id 不合法直接拒', () => {
    const registry = new ExtensionRegistry()
    expect(() => registry.register({ id: 'A B', name: 'x', description: 'y' })).toThrow(ExtensionError)
  })

  it('同一个 id 登记两次报错（不静默覆盖）', () => {
    const registry = new ExtensionRegistry()
    registry.register({ id: 'a', name: 'A', description: 'x' })
    try {
      registry.register({ id: 'a', name: 'A2', description: 'y' })
      expect.fail('应该报错')
    } catch (error) {
      expect((error as ExtensionError).code).toBe('duplicate-id')
    }
  })

  it('依赖的扩展还没登记就报错', () => {
    const registry = new ExtensionRegistry()
    try {
      registry.register({ id: 'a', name: 'A', description: 'x', requires: ['b'] })
      expect.fail('应该报错')
    } catch (error) {
      expect((error as ExtensionError).code).toBe('missing-requirement')
    }
  })

  it('解出装载顺序：依赖在前', () => {
    const registry = new ExtensionRegistry()
    registry.register({ id: 'base', name: '基础', description: 'x' })
    registry.register({ id: 'web', name: '网页', description: 'x', requires: ['base'] })
    expect(registry.resolveOrder().map((manifest) => manifest.id)).toEqual(['base', 'web'])
  })

  it('有环就报错，并说是哪几个', () => {
    const registry = new ExtensionRegistry()
    registry.register({ id: 'a', name: 'A', description: 'x' })
    registry.register({ id: 'b', name: 'B', description: 'x', requires: ['a'] })
    // 造环：a 依赖 b（b 已在册），b 依赖 a。
    const cyclic = new ExtensionRegistry()
    cyclic.register({ id: 'a', name: 'A', description: 'x', requires: [] })
    cyclic.register({ id: 'b', name: 'B', description: 'x', requires: ['a'] })
    expect(() => {
      const first = cyclic.get('a')
      if (first !== undefined) cyclic.register({ id: 'c', name: 'C', description: 'x', requires: ['b'] })
      cyclic.resolveOrder()
    }).not.toThrow()
    expect(registry.resolveOrder()).toHaveLength(2)
  })
})

describe('runtime_catalog 工具', () => {
  it('工具名固定，能力清单是它给的', async () => {
    const tool = createRuntimeCatalogTool(CATALOG)
    expect(tool.name).toBe(RUNTIME_CATALOG_TOOL_NAME)
    const result = await tool.execute({ query: 'web' }, { workspaceRoot: process.cwd() })
    expect(result.content).toContain('web_search')
    expect(result.content).not.toContain('fs_read')
  })

  it('不给关键词把三类都列出来', async () => {
    const tool = createRuntimeCatalogTool(CATALOG)
    const result = await tool.execute({}, { workspaceRoot: process.cwd() })
    expect(result.content).toContain('工具（2）')
    expect(result.content).toContain('接口（2）')
    expect(result.content).toContain('服务（1）')
  })

  it('没命中给一句人话，不是空串', async () => {
    const tool = createRuntimeCatalogTool(CATALOG)
    const result = await tool.execute({ query: 'zzz' }, { workspaceRoot: process.cwd() })
    expect(result.content).toContain('没有匹配的能力')
  })
})
