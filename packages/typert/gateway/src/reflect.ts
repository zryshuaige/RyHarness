/**
 * 运行时反射：从带 `@Remote` 的实例上读出「有哪些方法、参数叫什么」。
 *
 * 反射读的是**协议包写在原型上的标记**：`@Remote` 装饰器在实例构造时把
 * `{ version, methods }` 挂到原型上（键是
 * `'@ryharness/typert-protocol/remote-methods'`）。本包只读不改，键名是协议包
 * 与本包之间唯一的一处耦合，注释里写明了来源。
 *
 * **为什么反射的是实例而不是类**：标记是实例构造时才落下去的（装饰器的
 * initializer 跟着实例走）。想从一个类读出方法清单，得先有一个实例——这是
 * 运行时反射与上游「编译期生成器」最实在的一处差别，README 里单列了一节。
 * @module @ryharness/typert-gateway/reflect
 */

import type { RemoteParamDescriptor } from './types.ts'

/**
 * 协议包写在原型上的标记键。
 *
 * 协议包没有把这个键导出成常量（它是内部实现），本包按字面量读。改协议包的
 * 标记键时这里要跟着改——这是两包之间唯一的字符串级耦合。
 */
const REMOTE_METHOD_MARKER = '@ryharness/typert-protocol/remote-methods'

/** 一条标记里的方法记录。 */
export interface RemoteMethodMarker {
  /** 类里的方法名。 */
  readonly method: string
  /** 线上的导出名；没写就是与方法名相同。 */
  readonly exportName?: string
}

/**
 * 读一个对象上任意字段，字段不存在或类型不对时给 undefined。
 * @param source - 读哪个对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * 解析一条方法标记。
 * @param value - 标记数组里的一项。
 * @returns 解析出来的标记；形状不对时是 undefined。
 */
function parseMarker(value: unknown): RemoteMethodMarker | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const method = readString(value, 'method')
  if (method === undefined || method.length === 0) return undefined
  const exportName = readString(value, 'exportName')
  return exportName === undefined ? { method } : { method, exportName }
}

/**
 * 解析原型上的标记描述。
 * @param value - 描述器的值。
 * @returns 解析出来的标记列表；版本不认识或形状不对时是 undefined。
 */
function parseMarkerDescriptor(value: unknown): readonly RemoteMethodMarker[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (Reflect.get(value, 'version') !== 1) return undefined
  const methods: unknown = Reflect.get(value, 'methods')
  if (!Array.isArray(methods)) return undefined
  const out: RemoteMethodMarker[] = []
  for (const item of methods) {
    const marker = parseMarker(item)
    if (marker !== undefined) out.push(marker)
  }
  return out
}

/**
 * 读出一个实例上所有 `@Remote` 标记。
 *
 * 沿原型链往上找：继承来的方法，标记写在父类的原型上，只看实例自己的原型会
 * 漏掉它们。
 *
 * **同名只留最近的**：装饰器的初始化器跟着实例走，父类的方法在子类实例上也会
 * 被写到子类的原型上——于是同一条标记会出现在两层原型上。取最近的那一份就
 * 够了，再往上的重复是同一件事的另一次记录。
 * @param service - 本地对象实例。
 * @returns 全部标记，按「离实例近的先」排。
 */
export function readRemoteMarkers(service: object): readonly RemoteMethodMarker[] {
  const out: RemoteMethodMarker[] = []
  const seen = new Set<string>()
  let proto: object | null = Object.getPrototypeOf(service)
  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, REMOTE_METHOD_MARKER)
    if (descriptor !== undefined) {
      const markers = parseMarkerDescriptor(descriptor.value)
      if (markers !== undefined) {
        for (const marker of markers) {
          if (seen.has(marker.method)) continue
          seen.add(marker.method)
          out.push(marker)
        }
      }
    }
    proto = Object.getPrototypeOf(proto)
  }
  return out
}

/**
 * 判断一段文本是不是合法的 JavaScript 标识符。
 *
 * 解构参数（`{ a, b }`）不是一个标识符，这种情况没法拿它当参数名生成代码，
 * 反射时会换成 `arg0` 这样的占位名。
 * @param text - 待判断的文本。
 * @returns 是不是标识符。
 */
export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(text)
}

/**
 * 找到函数源码里参数列表的起止位置。
 * @param source - 函数源码。
 * @returns 参数列表的 `[start, end)`（含括号），找不到时是 undefined。
 */
function findParameterList(source: string): readonly [number, number] | undefined {
  const open = source.indexOf('(')
  if (open < 0) return undefined
  let depth = 0
  let quote = ''
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] as string
    if (quote !== '') {
      if (char === quote && source[index - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return [open + 1, index]
    }
  }
  return undefined
}

/**
 * 按顶层逗号切分参数列表。
 * @param text - 参数列表内部文本。
 * @returns 每一段参数文本。
 */
function splitParameters(text: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const char of text) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) parts.push(current)
  return parts
}

/**
 * 从一段参数文本里读出参数名，并判断它是不是可选的。
 * @param text - 一段参数文本。
 * @param index - 这个参数的序号（用来给占位名编号）。
 * @returns 参数名、可选性、是不是剩余参数。
 */
function parseParameter(text: string, index: number): { name: string; optional: boolean; rest: boolean } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { name: `arg${index}`, optional: true, rest: false }
  const rest = trimmed.startsWith('...')
  const body = rest ? trimmed.slice(3).trim() : trimmed
  const equals = body.indexOf('=')
  const head = (equals < 0 ? body : body.slice(0, equals)).trim()
  const optional = equals >= 0 || rest
  const name = isIdentifier(head) ? head : `arg${index}`
  return { name, optional, rest }
}

/**
 * 判断一个值是不是可调用的。
 * @param value - 任意值。
 * @returns 是不是函数。
 */
export function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

/**
 * 反射一个方法的参数。
 *
 * 参数名与「有没有默认值」是从函数源码里读出来的——运行时拿不到 TS 类型，
 * 但拿得到参数的名字与个数，这已经够把调用对上位置。
 * @param fn - 方法函数。
 * @returns 参数描述，按位置。
 */
export function reflectParameters(fn: (...args: never[]) => unknown): readonly RemoteParamDescriptor[] {
  const source = fn.toString()
  const list = findParameterList(source)
  if (list === undefined) return []
  const [start, end] = list
  const parts = splitParameters(source.slice(start, end))
  return parts.map((part, index) => {
    const parsed = parseParameter(part, index)
    return { name: parsed.name, type: 'unknown', optional: parsed.optional, rest: parsed.rest }
  })
}

/**
 * 判断一个方法是不是异步的。
 * @param fn - 方法函数。
 * @returns 是不是 async。
 */
export function isAsyncFunction(fn: (...args: never[]) => unknown): boolean {
  return fn.constructor.name === 'AsyncFunction'
}

/**
 * 从实例上取出一个方法。
 * @param service - 本地对象实例。
 * @param method - 方法名。
 * @returns 方法函数；不是函数时是 undefined。
 */
export function readMethod(service: object, method: string): ((...args: unknown[]) => unknown) | undefined {
  const value: unknown = Reflect.get(service, method)
  return isCallable(value) ? value : undefined
}
