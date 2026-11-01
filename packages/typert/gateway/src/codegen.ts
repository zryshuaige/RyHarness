/**
 * 生成的客户端：把一张类型图变成一份能直接用的 TypeScript 客户端。
 *
 * 生成的东西有两半：
 *
 * 1. **类型**：每个命名空间一个接口，方法签名照着图里的注解写。调用一个图里
 *    没有的方法，**编译期就报错**。
 * 2. **运行时代理**：一个按图校验的代理对象。访问图里没有的命名空间或方法，
 *    **运行期立刻抛错**，不会把一个「未知方法」发出去等对端回一句看不懂的。
 *
 * 生成代码里那几处 `as` 是**故意的**：运行时代理返回的是 `unknown`，要把它
 * 变成接口声明的具体类型只能这么写一次。类型来自同一张图，写错了生成器和
 * 类型检查会一起指出来。
 * @module @ryharness/typert-gateway/codegen
 */

import { badRequest } from './errors.ts'
import type { RemoteEntry, RemoteInvoker, TypeGraph } from './types.ts'

/** 运行时代理里的一个方法：位置参数，返回一个 Promise。 */
export type RemoteCallFn = (...args: readonly unknown[]) => Promise<unknown>

/** 运行时代理里的一个命名空间。 */
export interface RemoteNamespaceProxy {
  readonly [method: string]: RemoteCallFn
}

/** 运行时代理：一层命名空间、一层方法。 */
export type RemoteClientProxy = Record<string, RemoteNamespaceProxy>

/** 生成客户端的可选项。 */
export interface GenerateClientOptions {
  /** 客户端接口名。缺省是 `TypertRemoteClient`。 */
  readonly clientName?: string
  /** 工厂函数名。缺省是 `create<客户端接口名>`。 */
  readonly factoryName?: string
}

/**
 * 把一段任意文本变成合法的 TypeScript 标识符片段。
 * @param text - 原始文本。
 * @returns 首字母大写、只含字母数字的片段。
 */
function pascalCase(text: string): string {
  const parts = text.split(/[^A-Za-z0-9]+/u).filter((part) => part.length > 0)
  const joined = parts.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')
  return joined.length === 0 ? 'Namespace' : joined
}

/**
 * 给一个命名空间起接口名。
 * @param namespace - 命名空间。
 * @returns 接口名。
 */
export function namespaceTypeName(namespace: string): string {
  return `${pascalCase(namespace)}Remote`
}

/**
 * 给每个命名空间起一个不重样的接口名。
 *
 * 命名空间可以带 `-` 与 `.`（线协议允许），转成标识符之后可能撞名（`my-ns`
 * 与 `my.ns` 都是 `MyNs`），撞了就加序号。
 * @param graph - 类型图。
 * @returns 命名空间 → 接口名。
 */
export function buildNamespaceTypeNames(graph: TypeGraph): ReadonlyMap<string, string> {
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const namespace of graph.namespaces) {
    const base = `${pascalCase(namespace)}Remote`
    let name = base
    let counter = 2
    while (used.has(name)) {
      name = `${base}${counter}`
      counter += 1
    }
    used.add(name)
    names.set(namespace, name)
  }
  return names
}

/**
 * 生成一个方法的参数列表文本。
 * @param entry - 图里的方法。
 * @returns 形如 `name: string, other?: number` 的文本。
 */
function renderParams(entry: RemoteEntry): string {
  return entry.method.params
    .map((param) => `${param.rest ? '...' : ''}${param.name}${param.optional && !param.rest ? '?' : ''}: ${param.type}`)
    .join(', ')
}

/**
 * 生成类型声明（只有接口，没有 import）。
 *
 * 单独拆出来是为了能把它塞进别的文件里用（比如宿主把自己的类型也放在一起）。
 * @param graph - 类型图。
 * @param options - 可选项。
 * @returns TypeScript 源码文本。
 */
export function generateClientTypes(graph: TypeGraph, options: GenerateClientOptions = {}): string {
  const clientName = options.clientName ?? 'TypertRemoteClient'
  const typeNames = buildNamespaceTypeNames(graph)
  const lines: string[] = []
  for (const namespace of graph.namespaces) {
    const entries = graph.entries.filter((entry) => entry.namespace === namespace)
    lines.push(`/** 命名空间 \`${namespace}\` 的远端方法。 */`)
    lines.push(`export interface ${typeNames.get(namespace) ?? 'Remote'} {`)
    for (const entry of entries) {
      lines.push(`  /** 返回 ${entry.method.returns} */`)
      lines.push(`  ${entry.name}(${renderParams(entry)}): Promise<${entry.method.returns}>`)
    }
    lines.push('}')
    lines.push('')
  }
  lines.push('/** 生成的客户端：每个命名空间一个字段。 */')
  lines.push(`export interface ${clientName} {`)
  for (const namespace of graph.namespaces) {
    lines.push(`  readonly ${JSON.stringify(namespace)}: ${typeNames.get(namespace) ?? 'Remote'}`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * 生成一份完整的客户端模块。
 *
 * 模块里有三样东西：类型接口、内嵌的类型图（运行时代理照着它校验）、以及一个
 * 工厂函数（把调用入口包成上面那些接口）。
 * @param graph - 类型图。
 * @param options - 可选项。
 * @returns TypeScript 源码文本。
 */
export function generateClientSource(graph: TypeGraph, options: GenerateClientOptions = {}): string {
  const clientName = options.clientName ?? 'TypertRemoteClient'
  const factoryName = options.factoryName ?? `create${clientName}`
  const lines: string[] = []
  lines.push('/* 由 @ryharness/typert-gateway 生成 —— 不要手改，改了下次生成就没了。 */')
  lines.push("import { createRemoteClientProxy, type RemoteInvoker, type TypeGraph } from '@ryharness/typert-gateway'")
  lines.push('')
  lines.push(generateClientTypes(graph, options))
  lines.push('')
  lines.push('/** 内嵌的类型图：运行时代理照着它校验「这个方法存不存在」。 */')
  lines.push(`const TYPERT_GRAPH: TypeGraph = ${JSON.stringify(graph, null, 2)}`)
  lines.push('')
  lines.push('/** 造一个客户端：调用入口由调用方给（网关客户端、测试替身都行）。 */')
  lines.push(`export function ${factoryName}(invoke: RemoteInvoker): ${clientName} {`)
  lines.push('  const runtime = createRemoteClientProxy(TYPERT_GRAPH, invoke)')
  lines.push('  return {')
  for (const namespace of graph.namespaces) {
    const entries = graph.entries.filter((entry) => entry.namespace === namespace)
    lines.push(`    ${JSON.stringify(namespace)}: {`)
    for (const entry of entries) {
      const args = entry.method.params.map((param) => param.name).join(', ')
      lines.push(
        `      ${JSON.stringify(entry.name)}: (${renderParams(entry)}): Promise<${entry.method.returns}> =>` +
          ` runtime[${JSON.stringify(namespace)}][${JSON.stringify(entry.name)}](${args}) as Promise<${entry.method.returns}>,`,
      )
    }
    lines.push('    },')
  }
  lines.push('  }')
  lines.push('}')
  return lines.join('\n')
}

/**
 * 做一个运行时代理。
 *
 * 访问一个图里没有的命名空间或方法时**立刻抛错**——不把「未知方法」发出去。
 * 命名空间与方法名都是图里的原名，不做改写。
 * @param graph - 类型图。
 * @param invoke - 真正的调用入口。
 * @returns 运行时代理。
 */
export function createRemoteClientProxy(graph: TypeGraph, invoke: RemoteInvoker): RemoteClientProxy {
  const methodsByNamespace = new Map<string, Set<string>>()
  for (const entry of graph.entries) {
    const set = methodsByNamespace.get(entry.namespace)
    if (set === undefined) methodsByNamespace.set(entry.namespace, new Set([entry.name]))
    else set.add(entry.name)
  }
  return new Proxy<RemoteClientProxy>(
    {},
    {
      get(_target, property): unknown {
        if (typeof property !== 'string') return undefined
        // 别让代理变成 thenable：被 await 的时候会把 then 当方法名处理。
        if (property === 'then') return undefined
        const methods = methodsByNamespace.get(property)
        if (methods === undefined) {
          throw badRequest(`类型图里没有这个命名空间：${property}`)
        }
        return new Proxy<RemoteNamespaceProxy>(
          {},
          {
            get(_inner, method): unknown {
              if (typeof method !== 'string') return undefined
              if (method === 'then') return undefined
              if (!methods.has(method)) {
                throw badRequest(`类型图里没有这个方法：${property}.${method}`)
              }
              return (...args: readonly unknown[]): Promise<unknown> => invoke(property, method, args)
            },
          },
        )
      },
    },
  )
}
