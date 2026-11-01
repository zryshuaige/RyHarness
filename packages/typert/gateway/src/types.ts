/**
 * 类型图的数据形状。
 *
 * 「类型图」= 一张表：命名空间 → 服务 → 方法 → 参数与返回类型。它回答三个问题：
 * 宿主那边到底暴露了什么、客户端能按名字调什么、生成的客户端该长什么样。
 *
 * **为什么类型是文本**：TS 的类型在运行时被抹掉了，反射拿不到 `string` 还是
 * `number`。所以图里存的是**类型表达式文本**（`'string'`、`'number[]'`），
 * 由开发者用注解补上；没补的地方一律写 `'unknown'`，不猜。生成客户端时这段
 * 文本原样进 TypeScript 源码，于是类型安全来自注解而不是来自运行时的把戏。
 * @module @ryharness/typert-gateway/types
 */

/** 类型图格式版本。图结构变了就换版本，客户端据此拒绝不认识的老图。 */
export const TYPE_GRAPH_VERSION = 1

/**
 * 一个 remote 参数的描述。
 *
 * 参数按**位置**排列：远端调用传的是位置参数，和类里方法的签名一一对应。
 */
export interface RemoteParamDescriptor {
  /** 参数名。反射能从函数源码里读出来，注解能覆盖它。 */
  readonly name: string
  /** 类型表达式文本；没注解时是 `'unknown'`。 */
  readonly type: string
  /** 是否可选：有默认值，或者注解里标了 `optional`。 */
  readonly optional: boolean
  /** 是否是剩余参数（`...rest`）。 */
  readonly rest: boolean
}

/** 一个 remote 方法的描述。 */
export interface RemoteMethodDescriptor {
  /** 类里的方法名。 */
  readonly method: string
  /** 线上的名字：`@Remote('x')` 时是 `x`，否则与方法名相同。 */
  readonly exportName: string
  /** 参数，按位置。 */
  readonly params: readonly RemoteParamDescriptor[]
  /** 返回类型表达式文本；没注解时是 `'unknown'`。 */
  readonly returns: string
  /** 方法是不是 `async`（决定生成客户端要不要 `await`）。 */
  readonly async: boolean
}

/** 一个命名空间下的一组方法（通常对应一个本地对象）。 */
export interface RemoteServiceDescriptor {
  /** 线上的命名空间。 */
  readonly namespace: string
  /** 本地对象的标识（一般是类名或宿主给的服务键）。 */
  readonly serviceKey: string
  /** 这一组方法。 */
  readonly methods: readonly RemoteMethodDescriptor[]
}

/** 类型图里一个可调用的方法：命名空间 + 方法名就能定位到它。 */
export interface RemoteEntry {
  /** 命名空间。 */
  readonly namespace: string
  /** 线上的方法名。 */
  readonly name: string
  /** 所属服务的描述。 */
  readonly service: RemoteServiceDescriptor
  /** 方法自身的描述。 */
  readonly method: RemoteMethodDescriptor
}

/** 一张类型图。 */
export interface TypeGraph {
  /** 图格式版本。 */
  readonly version: typeof TYPE_GRAPH_VERSION
  /** 全部命名空间，按挂载顺序。 */
  readonly namespaces: readonly string[]
  /** 全部服务描述。 */
  readonly services: readonly RemoteServiceDescriptor[]
  /** 全部可调用方法。 */
  readonly entries: readonly RemoteEntry[]
}

/** 一个参数的类型注解。 */
export interface RemoteParamAnnotation {
  /** 参数名。必须和反射读出来的名字对上，对不上算注解写错。 */
  readonly name: string
  /** 类型表达式文本，例如 `'string'`、`'number[]'`、`'Foo | null'`。 */
  readonly type: string
  /** 是否可选。 */
  readonly optional?: boolean
}

/**
 * 一个方法的签名注解。
 *
 * 运行时只有参数名与个数，**类型必须由人写**——这是本包与上游「编译期代码
 * 生成器」的根本差别（见 README 的差距一节）。
 */
export interface RemoteMethodAnnotation {
  /** 参数类型，按位置。 */
  readonly params?: readonly RemoteParamAnnotation[]
  /** 返回类型表达式文本。 */
  readonly returns?: string
}

/**
 * 一个待挂载的本地对象。
 *
 * `service` 是**实例**不是类：`@Remote` 装饰器把标记写在原型上，而这个标记是
 * 实例构造时才落下去的（见协议包的 `Remote` 实现）。想反射一个类，得先有一个
 * 实例。
 */
export interface RemoteBinding {
  /** 线上的命名空间。同一个命名空间可以挂多个对象，但方法名不能重。 */
  readonly namespace?: string
  /** 本地对象实例。 */
  readonly service: object
  /**
   * 本地对象的标识（写进类型图给人看）。缺省取构造函数名。
   */
  readonly serviceKey?: string
  /**
   * 方法签名注解，键是**类里的方法名**（不是线上的导出名）。
   *
   * 没写注解的方法照样能调，只是参数与返回类型在图里是 `unknown`。
   */
  readonly methods?: Readonly<Record<string, RemoteMethodAnnotation>>
}

/** 一个方法在宿主侧的可调用形态：按位置传参，返回一个 Promise。 */
export type RemoteCall = (...args: readonly unknown[]) => Promise<unknown>

/**
 * 客户端侧的调用入口。
 *
 * 生成出来的客户端代理最终都落到这一个函数上，所以换传输、换网关都不用改
 * 生成的代码。
 */
export type RemoteInvoker = (namespace: string, method: string, args: readonly unknown[]) => Promise<unknown>
