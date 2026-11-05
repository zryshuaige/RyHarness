/**
 * 子进程服务：一组 provider 之上的门面。
 *
 * 服务做的事很碎，但都是「不这么做就会有人踩」的那类：
 * - **默认值**：时限、输出上限、环境白名单在服务这里定一次，消费方不用各写一遍。
 * - **登记**：跑起来的进程都记在册，服务下线时一次性收干净——漏掉一个后台进程，
 *   桌面应用退出后它还活着，下一次启动就多一份。
 * - **范围**：进程可以归到某个范围里，整组查活、整组终止。
 *
 * 服务**不碰命令语义**：一条命令该不该超时、超时了该给模型看什么，那是 shell 工具
 * 与 terminal 的事。
 * @module @ryharness/subprocess/service
 */

import { localProvider } from './local.ts'
import { createProcessRange } from './range.ts'
import { addStreamToRange, type ManagedStreamProcess, type SpawnStreamOptions, spawnManagedStream } from './stream.ts'
import type {
  ExecutableResolution,
  ManagedProcess,
  ManagedRangeSupport,
  ProcessRange,
  ResolveExecutableOptions,
  SubprocessCapabilities,
  SubprocessProvider,
  SubprocessSpawnOptions,
} from './types.ts'

/** 服务的构造参数。 */
export interface SubprocessServiceOptions {
  /** provider；缺省用本机 provider。 */
  readonly provider?: SubprocessProvider
  /** 环境白名单；缺省用 provider 自己的。 */
  readonly envAllowlist?: readonly string[]
  /** 默认时限（毫秒）；缺省不限时。 */
  readonly defaultTimeoutMs?: number
  /** stdout 默认上限（字节）。 */
  readonly maxStdoutBytes?: number
  /** stderr 默认上限（字节）。 */
  readonly maxStderrBytes?: number
}

/**
 * 子进程服务。
 *
 * 一个实例服务一段宿主运行时：谁在跑、跑成什么样、下线时怎么收，都归它。
 */
export class SubprocessService {
  /** 实际干活的 provider。 */
  readonly provider: SubprocessProvider
  private readonly options: SubprocessServiceOptions
  private readonly tracked = new Set<ManagedProcess>()
  private readonly trackedStreams = new Set<ManagedStreamProcess>()
  private readonly ranges = new Map<string, ProcessRange>()

  constructor(options: SubprocessServiceOptions = {}) {
    this.options = options
    this.provider = options.provider ?? localProvider
  }

  /** provider 的能力与降级说明。 */
  get capabilities(): SubprocessCapabilities {
    return this.provider.capabilities
  }

  /**
   * 找可执行文件。
   * @param options - 命令名与候选目录。
   * @returns 找到就给出路径，没找到给出结构化原因。
   */
  resolveExecutable(options: ResolveExecutableOptions): ExecutableResolution {
    return this.provider.resolveExecutable(options)
  }

  /**
   * 托管启动一个进程。
   *
   * 启动完的进程会记在册：服务下线时统一收。传了 `rangeId` 的进程还会被登记到
   * 对应的范围里（范围不存在就现建一个）。
   * @param options - 启动参数。
   * @returns 进程句柄。
   */
  spawn(options: SubprocessSpawnOptions): ManagedProcess {
    const merged: SubprocessSpawnOptions = {
      ...options,
      ...(options.envAllowlist === undefined && this.options.envAllowlist !== undefined
        ? { envAllowlist: this.options.envAllowlist }
        : {}),
      ...(options.timeoutMs === undefined && this.options.defaultTimeoutMs !== undefined
        ? { timeoutMs: this.options.defaultTimeoutMs }
        : {}),
      ...(options.maxStdoutBytes === undefined && this.options.maxStdoutBytes !== undefined
        ? { maxStdoutBytes: this.options.maxStdoutBytes }
        : {}),
      ...(options.maxStderrBytes === undefined && this.options.maxStderrBytes !== undefined
        ? { maxStderrBytes: this.options.maxStderrBytes }
        : {}),
    }
    const started = this.provider.spawn(merged)
    this.tracked.add(started)
    void started.done.then(() => {
      this.tracked.delete(started)
    })
    if (options.rangeId !== undefined) this.ensureRange(options.rangeId).add(started)
    return started
  }

  /**
   * 建一个进程范围。
   *
   * 档位跟着 provider 的能力走：provider 没有原生托管范围时，这里给的是
   * `emulated`（模拟），并把 provider 的降级说明原样挂在范围上。
   * @param label - 范围的名字（给人看的）。
   * @returns 进程范围。
   */
  createRange(label?: string): ProcessRange {
    const support: ManagedRangeSupport = this.capabilities.nativeManagedRange ? 'native' : 'emulated'
    const range = createProcessRange({
      label: label ?? '未命名范围',
      support,
      notes: this.capabilities.notes,
    })
    this.ranges.set(range.id, range)
    return range
  }

  /**
   * 起一个**长驻**的带原始流的进程（语言服务器、MCP 服务器、持久终端这类）。
   *
   * 与 {@link SubprocessService.spawn} 的区别：那个是「跑一条命令、拿结果」，
   * 这个是「一直活着、调用方自己管协议流」。两者都归这个服务管，所以服务下线时
   * 两种都会被收掉。
   * @param options - 启动参数。
   * @returns 托管句柄。
   */
  spawnStream(options: SpawnStreamOptions): ManagedStreamProcess {
    const started = spawnManagedStream(this.provider, {
      ...options,
      ...(options.envAllowlist === undefined && this.options.envAllowlist !== undefined
        ? { envAllowlist: this.options.envAllowlist }
        : {}),
    })
    this.trackedStreams.add(started)
    void started.done.then(() => {
      this.trackedStreams.delete(started)
    })
    if (options.rangeId !== undefined) {
      addStreamToRange(this.ensureRange(options.rangeId), started)
    }
    return started
  }

  /** 服务里还活着的进程。 */
  listAlive(): readonly ManagedProcess[] {
    return [...this.tracked].filter((started) => !started.finished)
  }

  /**
   * 按 id 取一个进程范围。
   * @param id - 范围 id。
   * @returns 范围；没有则 undefined。
   */
  getRange(id: string): ProcessRange | undefined {
    return this.ranges.get(id)
  }

  /**
   * 服务下线：把还活着的进程全收掉。
   *
   * 漏掉这一步的代价很具体：桌面应用退出后后台还挂着一个语言服务器，下一次启动
   * 就多一份，端口还可能占着。
   */
  async dispose(): Promise<void> {
    const alive = this.listAlive()
    await Promise.all(alive.map((started) => started.kill('服务下线')))
    this.tracked.clear()
    // 长驻的也要收：语言服务器与 MCP 服务器挂着不走的话，桌面应用退出后它们
    // 还活着，下一次启动就多一份，端口还可能占着。
    const streams = [...this.trackedStreams]
    await Promise.all(streams.map((started) => started.kill('服务下线')))
    this.trackedStreams.clear()
  }

  /** 按 id 取范围；没有就现建一个（并登记）。 */
  private ensureRange(id: string): ProcessRange {
    const existing = this.ranges.get(id)
    if (existing !== undefined) return existing
    const support: ManagedRangeSupport = this.capabilities.nativeManagedRange ? 'native' : 'emulated'
    const range = createProcessRange({ id, label: id, support, notes: this.capabilities.notes })
    this.ranges.set(id, range)
    return range
  }
}
