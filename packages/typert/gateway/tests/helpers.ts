/**
 * 测试用的假远端服务。
 *
 * 这些类带 `@Remote` 装饰器——标记是**实例构造时**写到原型上的，所以反射、
 * 装配这些用例都得先 `new` 一个出来。
 */
import { Remote, RemoteError } from '@ryharness/typert-protocol'

/** 一个普通的服务：几个 remote 方法，加一个不是 remote 的方法。 */
export class GreetingService {
  /** 打招呼。第二个参数有默认值，所以是可选的。 */
  @Remote
  greet(name: string, greeting = '你好'): string {
    return `${greeting}，${name}`
  }

  /** 线上名字和方法名不一样。 */
  @Remote('aliasName')
  loud(text: string): string {
    return `${text}！`
  }

  /** 异步方法。 */
  @Remote
  async shout(text: string): Promise<string> {
    return `${text.toUpperCase()}!`
  }

  /** 加法，用来验证参数按位置传。 */
  @Remote
  add(a: number, b: number): number {
    return a + b
  }

  /** 抛错的 remote 方法：宿主侧抛的错要原样带到客户端。 */
  @Remote
  boom(): string {
    throw new RemoteError('gateway/internal', '炸了', {})
  }

  /** 慢方法，用来试超时。 */
  @Remote
  async slow(ms: number): Promise<string> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
    return '慢'
  }

  /** 不是 remote 的方法：不该出现在图里。 */
  plain(): string {
    return '不是 remote'
  }
}

/** 继承来的 remote 方法也要能被反射到。 */
export class ChildGreetingService extends GreetingService {
  /** 子类自己加的一个。 */
  @Remote
  child(): string {
    return '子类'
  }
}

/** 命名空间由 `typertRemote` 决定的服��。 */
export class SelfNamedService extends GreetingService {
  /** 协议包挂上来的绑定。 */
  readonly typertRemote: { readonly service: object; readonly serviceKey: string; readonly namespace: string }

  constructor() {
    super()
    this.typertRemote = { service: this, serviceKey: 'self', namespace: 'auto' }
  }
}

/** 最后一个参数叫 `signal` 的方法：宿主会把取消信号塞进去。 */
export class SignalService {
  /** 等到被取消为止。 */
  @Remote
  async waitForCancel(signal: AbortSignal): Promise<string> {
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(undefined)
      })
    })
    return signal.aborted ? '已取消' : '没取消'
  }
}

/** GreetingService 的注解：类型由人补，运行时反射拿不到。 */
export const GREETING_ANNOTATIONS = {
  greet: {
    params: [
      { name: 'name', type: 'string' },
      { name: 'greeting', type: 'string', optional: true },
    ],
    returns: 'string',
  },
  loud: {
    params: [{ name: 'text', type: 'string' }],
    returns: 'string',
  },
  shout: {
    params: [{ name: 'text', type: 'string' }],
    returns: 'string',
  },
  add: {
    params: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ],
    returns: 'number',
  },
  boom: {
    params: [],
    returns: 'string',
  },
  slow: {
    params: [{ name: 'ms', type: 'number' }],
    returns: 'string',
  },
} as const
