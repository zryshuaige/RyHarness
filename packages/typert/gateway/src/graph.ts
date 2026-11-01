/**
 * 类型图的构建与查询。
 *
 * 构建这一步同时做三件事：反射出方法、把注解里的类型贴上去、**查重**。
 *
 * 查重为什么放在构建时：两个 remote 抢同一个名字是**装配错误**，不是运行时才
 * 该发现的坑。等它变成「客户端调 `greet` 不知道该调谁」的时候，排查成本已经
 * 高得离谱。这里直接抛错，并把冲突的命名空间与方法名写进错误详情。
 * @module @ryharness/typert-gateway/graph
 */

import { badRequest, conflictFailure } from './errors.ts'
import { isAsyncFunction, isIdentifier, readMethod, readRemoteMarkers, reflectParameters } from './reflect.ts'
import type {
  RemoteBinding,
  RemoteEntry,
  RemoteMethodAnnotation,
  RemoteMethodDescriptor,
  RemoteParamDescriptor,
  RemoteServiceDescriptor,
  TypeGraph,
} from './types.ts'
import { TYPE_GRAPH_VERSION } from './types.ts'

/** 命名空间与方法名的合法字符：和连接层的端点分段同一套规则。 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/u

/**
 * 检查一个命名空间或方法名能不能上线。
 * @param subject - 这串是什么（写进错误信息）。
 * @param value - 待检查的值。
 */
function assertSegment(subject: string, value: string): void {
  if (value === '.' || value === '..' || !SEGMENT_PATTERN.test(value)) {
    throw badRequest(`${subject} "${value}" 含有不能上线传输的字符`)
  }
}

/**
 * 读出绑定里的命名空间。
 *
 * 没写就问本地对象：`TypertRemoteService` 会把 `typertRemote` 挂在实例上，
 * 里面就有它自己的命名空间。
 * @param binding - 一个挂载项。
 * @returns 命名空间。
 */
function resolveNamespace(binding: RemoteBinding): string {
  if (binding.namespace !== undefined) return binding.namespace
  const declared: unknown = Reflect.get(binding.service, 'typertRemote')
  if (typeof declared === 'object' && declared !== null) {
    const namespace = Reflect.get(declared, 'namespace')
    if (typeof namespace === 'string' && namespace.length > 0) return namespace
  }
  throw badRequest('挂载项没有给命名空间，本地对象上也没有 typertRemote.namespace')
}

/**
 * 读出绑定里的服务标识。
 * @param binding - 一个挂载项。
 * @param namespace - 命名空间。
 * @returns 服务标识。
 */
function resolveServiceKey(binding: RemoteBinding, namespace: string): string {
  if (binding.serviceKey !== undefined) return binding.serviceKey
  const constructorRef = Reflect.get(binding.service, 'constructor')
  if (typeof constructorRef === 'function') {
    const name = Reflect.get(constructorRef, 'name')
    if (typeof name === 'string' && name.length > 0) return name
  }
  return namespace
}

/**
 * 把注解贴到反射出来的参数上。
 * @param method - 类里的方法名。
 * @param params - 反射出来的参数。
 * @param annotation - 注解；没有就是 undefined。
 * @returns 贴好类型的参数。
 */
function applyParamAnnotation(
  method: string,
  params: readonly RemoteParamDescriptor[],
  annotation: RemoteMethodAnnotation | undefined,
): readonly RemoteParamDescriptor[] {
  const annotated = annotation?.params
  if (annotated === undefined) return params
  if (annotated.length !== params.length) {
    throw badRequest(`方法 "${method}" 的注解写了 ${annotated.length} 个参数，实现是 ${params.length} 个，对不上`)
  }
  return annotated.map((param, index) => {
    if (!isIdentifier(param.name)) {
      throw badRequest(`方法 "${method}" 的第 ${index + 1} 个参数名 "${param.name}" 不是合法标识符`)
    }
    if (param.type.trim().length === 0) {
      throw badRequest(`方法 "${method}" 的参数 "${param.name}" 没写类型`)
    }
    const reflected = params[index] as RemoteParamDescriptor
    return {
      name: param.name,
      type: param.type.trim(),
      optional: param.optional ?? reflected.optional,
      rest: reflected.rest,
    }
  })
}

/**
 * 检查可选参数是不是都在末尾。
 *
 * TypeScript 的位置参数一旦有可选的，后面的也必须可选——生成出来的客户端要是
 * 出现 `f(a?: string, b: string)`，TS 直接报错。与其让生成器吐坏代码，不如在
 * 构建图的时候就说清楚。
 * @param method - 类里的方法名。
 * @param params - 参数描述。
 */
function assertOptionalTrailing(method: string, params: readonly RemoteParamDescriptor[]): void {
  let seenOptional = false
  for (const param of params) {
    if (param.optional) seenOptional = true
    else if (seenOptional) {
      throw badRequest(`方法 "${method}" 的可选参数后面还有必填参数，位置参数不支持这种写法`)
    }
  }
}

/**
 * 反射一个挂载项里的全部 remote 方法。
 * @param binding - 挂载项。
 * @returns 方法描述，按标记顺序。
 */
function reflectService(binding: RemoteBinding): readonly RemoteMethodDescriptor[] {
  const markers = readRemoteMarkers(binding.service)
  const out: RemoteMethodDescriptor[] = []
  for (const marker of markers) {
    const fn = readMethod(binding.service, marker.method)
    if (fn === undefined) continue
    const exportName = marker.exportName ?? marker.method
    assertSegment('方法名', exportName)
    const reflected = reflectParameters(fn)
    const annotation = binding.methods?.[marker.method]
    const params = applyParamAnnotation(marker.method, reflected, annotation)
    assertOptionalTrailing(marker.method, params)
    const returns = annotation?.returns?.trim()
    out.push({
      method: marker.method,
      exportName,
      params,
      returns: returns === undefined || returns.length === 0 ? 'unknown' : returns,
      async: isAsyncFunction(fn),
    })
  }
  return out
}

/**
 * 图里一个方法在宿主侧的可调用形态。
 *
 * 图是**数据**（能序列化、能发给客户端），这里多带一个本地对象实例——那是
 * 宿主自己才有的东西，不进图。
 */
export interface MountedRemoteMethod {
  /** 命名空间。 */
  readonly namespace: string
  /** 线上的方法名。 */
  readonly exportName: string
  /** 类里的方法名。 */
  readonly methodName: string
  /** 本地对象实例。 */
  readonly service: object
  /** 方法描述。 */
  readonly descriptor: RemoteMethodDescriptor
}

/** 类型图 + 宿主侧的可调用形态。 */
export interface TypeGraphBundle {
  /** 类型图。 */
  readonly graph: TypeGraph
  /** 宿主侧的方法清单。 */
  readonly mounted: readonly MountedRemoteMethod[]
}

/**
 * 按挂载项建一张类型图（连同宿主侧的可调用形态）。
 * @param bindings - 要挂载的本地对象。
 * @returns 类型图与可调用形态。
 * @throws RemoteError `gateway/conflict`（同名冲突）或 `gateway/bad-request`（挂载项本身写错）。
 */
export function buildTypeGraphBundle(bindings: readonly RemoteBinding[]): TypeGraphBundle {
  const services: RemoteServiceDescriptor[] = []
  const entries: RemoteEntry[] = []
  const mounted: MountedRemoteMethod[] = []
  const namespaces: string[] = []
  const taken = new Map<string, string>()
  for (const binding of bindings) {
    const namespace = resolveNamespace(binding)
    assertSegment('命名空间', namespace)
    const serviceKey = resolveServiceKey(binding, namespace)
    const methods = reflectService(binding)
    const service: RemoteServiceDescriptor = { namespace, serviceKey, methods }
    services.push(service)
    if (!namespaces.includes(namespace)) namespaces.push(namespace)
    for (const method of methods) {
      const key = `${namespace} ${method.exportName}`
      const owner = taken.get(key)
      if (owner !== undefined) {
        throw conflictFailure(namespace, method.exportName)
      }
      taken.set(key, serviceKey)
      entries.push({ namespace, name: method.exportName, service, method })
      mounted.push({
        namespace,
        exportName: method.exportName,
        methodName: method.method,
        service: binding.service,
        descriptor: method,
      })
    }
  }
  return {
    graph: {
      version: TYPE_GRAPH_VERSION,
      namespaces,
      services,
      entries,
    },
    mounted,
  }
}

/**
 * 按挂载项建一张类型图。
 * @param bindings - 要挂载的本地对象。
 * @returns 类型图。
 * @throws RemoteError `gateway/conflict`（同名冲突）或 `gateway/bad-request`（挂载项本身写错）。
 */
export function buildTypeGraph(bindings: readonly RemoteBinding[]): TypeGraph {
  return buildTypeGraphBundle(bindings).graph
}

/**
 * 判断一个值是不是一张类型图。
 *
 * 线上回来的东西是 `unknown`——不校验就当类型图用，等于把对端的谎话当成真话。
 * @param value - 任意值。
 * @returns 是不是类型图。
 */
export function isTypeGraph(value: unknown): value is TypeGraph {
  if (typeof value !== 'object' || value === null) return false
  if (Reflect.get(value, 'version') !== TYPE_GRAPH_VERSION) return false
  const namespaces = Reflect.get(value, 'namespaces')
  const services = Reflect.get(value, 'services')
  const entries = Reflect.get(value, 'entries')
  return Array.isArray(namespaces) && Array.isArray(services) && Array.isArray(entries)
}

/**
 * 在图里找一个方法。
 * @param graph - 类型图。
 * @param namespace - 命名空间。
 * @param method - 线上的方法名。
 * @returns 找到的条目；没有就是 undefined。
 */
export function findEntry(graph: TypeGraph, namespace: string, method: string): RemoteEntry | undefined {
  return graph.entries.find((entry) => entry.namespace === namespace && entry.name === method)
}

/**
 * 把一张类型图写成人能读的几行字。
 *
 * 给日志、报错与 README 用——「宿主到底暴露了什么」这件事，一行字比翻对象强。
 * @param graph - 类型图。
 * @returns 每行一个方法。
 */
export function formatGraph(graph: TypeGraph): readonly string[] {
  return graph.entries.map((entry) => {
    const params = entry.method.params
      .map((param) => `${param.name}${param.optional ? '?' : ''}: ${param.type}`)
      .join(', ')
    return `${entry.namespace}.${entry.name}(${params}) -> ${entry.method.returns}`
  })
}
