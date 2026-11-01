/**
 * 能力目录与扩展清单注册表。
 *
 * 两件事：
 * - **目录**：把宿主运行时的事实（工具、路由、服务）整理成一份可查的清单；模型
 *   拿着它就知道「这个运行时到底能干什么」，不用瞎猜工具名。
 * - **注册表**：登记扩展清单，校验依赖关系，解出装载顺序。
 * @module @ryharness/extensions/catalog
 */

import { ExtensionError, type ExtensionManifest, type RuntimeCatalog, type RuntimeCatalogInput } from './types.ts'

/** 扩展 id 的形状：小写字母、数字、连字符、点。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/u

/**
 * 把宿主给的事实整理成一份目录。
 *
 * 工具按名字排序、路由按方法与路径排序：**目录是要给人看的**，顺序稳定才能让
 * 两次查询的差异有意义。
 * @param input - 运行时事实。
 * @returns 目录。
 */
export function buildCatalog(input: RuntimeCatalogInput): RuntimeCatalog {
  return {
    tools: [...(input.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    routes: [...(input.routes ?? [])].sort((a, b) => {
      const byPattern = a.pattern.localeCompare(b.pattern)
      return byPattern === 0 ? a.method.localeCompare(b.method) : byPattern
    }),
    services: [...(input.services ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * 按关键词查目录。
 *
 * 关键词为空时给**全部**（模型问「有什么」就是要全部）；有关键词时按名字与说明
 * 子串匹配，工具、路由、服务分别给。
 * @param catalog - 目录。
 * @param query - 关键词（空串 = 全给）。
 * @returns 命中的那一部分。
 */
export function searchCatalog(
  catalog: RuntimeCatalog,
  query: string,
): { tools: RuntimeCatalog['tools']; routes: RuntimeCatalog['routes']; services: RuntimeCatalog['services'] } {
  const keyword = query.trim().toLowerCase()
  if (keyword.length === 0) {
    return { tools: catalog.tools, routes: catalog.routes, services: catalog.services }
  }
  const hit = (text: string): boolean => text.toLowerCase().includes(keyword)
  return {
    tools: catalog.tools.filter((tool) => hit(tool.name) || hit(tool.description)),
    routes: catalog.routes.filter((route) => hit(route.method) || hit(route.pattern)),
    services: catalog.services.filter((service) => hit(service.name) || hit(service.description)),
  }
}

/**
 * 扩展清单注册表。
 *
 * 职责边界：**只管清单与依赖**，不碰真正的装载（那是插件宿主的事）。它回答的是
 * 「有哪些扩展、按什么顺序装」。
 */
export class ExtensionRegistry {
  private readonly manifests = new Map<string, ExtensionManifest>()

  /**
   * 登记一份扩展清单。
   *
   * 依赖**当场校验**：依赖的扩展不在册就是错的，等装到一半才发现更糟。
   * @param manifest - 扩展清单。
   */
  register(manifest: ExtensionManifest): void {
    if (!ID_PATTERN.test(manifest.id)) {
      throw new ExtensionError('invalid-id', `扩展 id 不合法：${manifest.id}`)
    }
    if (this.manifests.has(manifest.id)) {
      throw new ExtensionError('duplicate-id', `扩展 "${manifest.id}" 已经登记过了`)
    }
    for (const requirement of manifest.requires ?? []) {
      if (!this.manifests.has(requirement)) {
        throw new ExtensionError('missing-requirement', `扩展 "${manifest.id}" 依赖的 "${requirement}" 还没登记`)
      }
    }
    this.manifests.set(manifest.id, manifest)
  }

  /** 已登记的扩展（按 id 排）。 */
  list(): ExtensionManifest[] {
    return [...this.manifests.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 按 id 取一份清单。 */
  get(id: string): ExtensionManifest | undefined {
    return this.manifests.get(id)
  }

  /**
   * 解出装载顺序（依赖在前）。
   *
   * 有环就报错并指出环上的那几个 id——「装到一半发现循环依赖」比一开始就报错糟糕得多。
   * @returns 按依赖顺序排好的清单。
   */
  resolveOrder(): ExtensionManifest[] {
    const ordered: ExtensionManifest[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        const cycle = [...visiting].filter((candidate) => {
          return candidate === id || true
        })
        throw new ExtensionError('circular-dependency', `扩展之间有循环依赖：${[...cycle].join(' → ')} → ${id}`)
      }
      const manifest = this.manifests.get(id)
      if (manifest === undefined) return
      visiting.add(id)
      for (const requirement of [...(manifest.requires ?? [])].sort()) visit(requirement)
      visiting.delete(id)
      visited.add(id)
      ordered.push(manifest)
    }
    for (const id of [...this.manifests.keys()].sort()) visit(id)
    return ordered
  }
}
