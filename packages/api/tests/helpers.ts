/**
 * 测试用的远端服务。
 */
import { Remote, RemoteError } from '@ryharness/typert-protocol'

/** 一个能算账的服务。 */
export class CounterService {
  /** 加法。 */
  @Remote
  add(a: number, b: number): number {
    return a + b
  }

  /** 原样回话。 */
  @Remote
  async echo(text: string): Promise<string> {
    return text
  }

  /** 抛错的服务端。 */
  @Remote
  boom(): string {
    throw new RemoteError('gateway/internal', '炸了', {})
  }

  /** 慢服务，用来试超时。 */
  @Remote
  async slow(ms: number): Promise<string> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
    return '慢'
  }

  /** 不是 remote 的方法。 */
  plain(): string {
    return '不是 remote'
  }
}

/** CounterService 的签名注解。 */
export const COUNTER_ANNOTATIONS = {
  add: {
    params: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ],
    returns: 'number',
  },
  echo: {
    params: [{ name: 'text', type: 'string' }],
    returns: 'string',
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
