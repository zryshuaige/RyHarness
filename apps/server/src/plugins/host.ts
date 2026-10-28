/**
 * 插件宿主：内置插件清单、开关持久化与真实的挂载/卸载。
 *
 * 开关不是只写一份配置：PATCH 之后必须让 `ctx.plugin()` 的 fiber 真正 dispose
 * （工具从注册表消失、路由从 LLM 运行时撤退），再挂载时重新 apply。cordis 的
 * fiber disposer 本身会逆序执行 effect，宿主只负责按**装载顺序的逆序** dispose
 * 各插件 fiber，关闭时的清理顺序因此与启动顺序严格对称。
 * @module @ryharness/server/plugins/host
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context, Fiber, Inject, Plugin } from '@ryharness/cordis'
import type { SkillSpec, SkillView } from './skills.ts'

/** 插件页面里的分组：核心、功能、语音、工具。 */
export type PluginGroup = 'core' | 'feature' | 'voice' | 'tool'

/**
 * 插件对外声明自己提供了什么。
 *
 * 声明是**给人看的**，注册表才是事实（工具/路由都随 fiber 装卸）。两者对不上时
 * 设置页会把差的那几项标出来（见 {@link PluginView.missing}），而不是照着声明
 * 显示一个其实并不存在的能力。
 */
export interface PluginCapabilities {
  /** 注册到 ctx.tools 的工具名（按名字白名单被 agent 取用）。 */
  readonly tools?: readonly string[]
  /** 注册到 ctx.routes 的 HTTP 面，形如 `GET /api/...`。 */
  readonly routes?: readonly string[]
}

/**
 * 运行时事实快照：当前注册表里真实存在的工具与路由。
 *
 * 由组合根提供（读 `ctx.tools.list()` 与 `ctx.routes.list()`），宿主用它核对
 * 插件的声明。插件自己的注册随 fiber 装卸，所以快照必须**现取**，不能缓存。
 */
export interface PluginReality {
  /** 已注册的工具名。 */
  readonly tools: readonly string[]
  /** 已注册的路由，形如 `GET /api/...`。 */
  readonly routes: readonly string[]
}

/** 一个可装载的插件：元数据给设置页，apply/config 原样交给 cordis。 */
export interface PluginEntry {
  /** 稳定 id（也是 plugins.json 的键）。 */
  readonly id: string
  /** 设置页显示名。 */
  readonly name: string
  /** 一句话说明：这个插件替用户做了什么。 */
  readonly description: string
  /** 设置页的分组；缺省时由前端归入其它。 */
  readonly group?: PluginGroup
  /** 这个插件提供了什么（工具名与 HTTP 路由）。 */
  readonly capabilities?: PluginCapabilities
  /** 关闭后会发生什么，一句人话；给确认弹窗与影响说明用。 */
  readonly impact?: string
  /**
   * 这个插件自带的 skill（可复用的工作法）。
   *
   * skill 是「不需要写代码的那部分能力」：一段能直接进 agent 系统提示的工作法。
   * 插件关掉，skill 跟着一起消失（{@link PluginHost.skills} 只返回启用中的）。
   */
  readonly skills?: readonly SkillSpec[]
  /** 内置插件：依赖它的登录/供应商或工具底座，不允许在设置里关掉。 */
  readonly core?: boolean
  /** cordis 插件入口（函数或带 apply 的对象）。 */
  readonly apply: Plugin.Function
  /** 依赖的服务名：缺省时在插件里访问 ctx.* 会因未 inject 直接抛错。 */
  readonly inject?: Inject
  /** 传给 apply 的配置；缺省不传。 */
  readonly config?: unknown
}

/** 插件运行状态：running = 已挂载；error = 上次挂载失败（见 error 字段）。 */
export type PluginStatus = 'running' | 'stopped' | 'error'

/** GET /api/plugins 的一行。 */
export interface PluginView {
  id: string
  name: string
  description: string
  /** 设置页分组；插件没有声明时缺省。 */
  group?: PluginGroup
  /** 插件声明的工具与路由（只读展示，不代表当前一定在注册表里）。 */
  capabilities?: PluginCapabilities
  /** 插件自带的 skill（只读展示）。 */
  skills?: readonly SkillView[]
  /** 关闭后会发生什么。 */
  impact?: string
  /**
   * 声明里有、运行时却没有的能力（工具名或 `GET /api/...` 路由）。
   *
   * 只有**启用中且已挂载**的插件会被核对——关掉的插件本就不该有工具留在注册表里。
   * 差集为空（正常情况）时这个字段缺省。
   */
  missing?: readonly string[]
  enabled: boolean
  core: boolean
  status: PluginStatus
  /** status=error 时的原因；其余情况缺省。 */
  error?: string
}

/** 开关操作的领域错误；路由据此映射 HTTP 状态，不把英文异常直接抛给界面。 */
export class PluginError extends Error {
  constructor(
    readonly code: 'UNKNOWN_PLUGIN' | 'CORE_PLUGIN',
    message: string,
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

/** plugins.json 的形状：缺省条目视为启用。 */
type PluginStates = Record<string, { enabled: boolean }>

/** 插件开关文件（dataDir/config/plugins.json）。 */
function pluginsConfigPath(dataDir: string): string {
  return join(dataDir, 'config', 'plugins.json')
}

/** 读开关文件：坏文件与缺字段都按「启用」处理，不让一份配置挡住启动。 */
function readStates(path: string): Map<string, boolean> {
  const states = new Map<string, boolean>()
  if (!existsSync(path)) return states
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return states
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue
      const enabled = (value as { enabled?: unknown }).enabled
      if (typeof enabled === 'boolean') states.set(id, enabled)
    }
  } catch {
    // 开关丢了等于全部启用，比服务起不来好。
  }
  return states
}

/** 原子写入（先 .tmp 再 rename），与 providers.json / 会话界面态同一套写法。 */
function writeStates(path: string, states: PluginStates): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(states, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * 插件清单 + 生命周期。
 *
 * 每个插件一个 fiber：`ctx.plugin()` 的 effect 归该 fiber，插件里注册的工具/路由
 * 随 dispose 自动注销；宿主只在「关开关」与「停机」两处显式 dispose。
 */
export class PluginHost {
  private readonly entries = new Map<string, PluginEntry>()
  private readonly fibers = new Map<string, Fiber>()
  private readonly errors = new Map<string, string>()
  private readonly states: Map<string, boolean>
  private started = false

  constructor(
    private readonly ctx: Context,
    entries: readonly PluginEntry[],
    private readonly dataDir: string,
    /**
     * 运行时事实的取法（读两个注册表）。缺省时不做核对——声明与事实对不上
     * 只会让设置页显示得不准，不会让插件多出一个工具。
     */
    private readonly probe?: () => PluginReality,
  ) {
    for (const entry of entries) {
      if (this.entries.has(entry.id)) {
        throw new Error(`@ryharness/server: duplicate plugin id "${entry.id}"`)
      }
      this.entries.set(entry.id, entry)
    }
    this.states = readStates(pluginsConfigPath(dataDir))
  }

  /** 插件清单（装载顺序）。开关值缺省为启用，core 恒为启用。 */
  list(): PluginView[] {
    return [...this.entries.values()].map((entry) => {
      return this.view(entry)
    })
  }

  /**
   * **启用中**的插件自带的 skill。
   *
   * skill 随插件的开关走：关掉插件，它的 skill 就不再能被注入（RyVibe 那次会话
   * 也就不再有盘问方法）。core 插件恒为启用。
   */
  skills(): SkillSpec[] {
    const out: SkillSpec[] = []
    for (const entry of this.entries.values()) {
      if (!this.enabled(entry)) continue
      for (const skill of entry.skills ?? []) out.push(skill)
    }
    return out
  }

  /**
   * 这个插件此刻是不是启用中。
   *
   * 组合根用它把「随插件开关走」的东西也纳入开关口径：此前 skill 注入看开关、
   * 问答注入不看，同一个插件关掉后一半能力还在——这个方法就是问「这个 id 在不在」
   * 的入口。
   * @param id - 插件 id。
   * @returns 启用中返回 true；未知 id 也返回 false（未知即不存在）。
   */
  isEnabled(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    return this.enabled(entry)
  }

  /**
   * 启动时按清单顺序挂载已启用的插件。
   *
   * core 插件失败必须让启动失败（没有工具或模型路由的应用没有可用形态）；
   * 非 core 插件失败只记录状态，设置页能看见原因，聊天与其它插件照常。
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const entry of this.entries.values()) {
      if (!this.enabled(entry)) continue
      try {
        await this.mount(entry)
      } catch (error) {
        this.errors.set(entry.id, messageOf(error))
        if (entry.core === true) throw error
      }
    }
  }

  /**
   * 切换开关并立即生效：先挂/卸，成功后才落盘。
   *
   * 失败时保持原状态（调用方回 5xx），不能出现「配置里写着关掉、进程里还跑着」
   * 或反过来的分裂。
   * @param id - 插件 id。
   * @param enabled - 目标状态。
   * @returns 切换后的视图。
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginView> {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new PluginError('UNKNOWN_PLUGIN', `unknown plugin: ${id}`)
    if (entry.core === true && !enabled) {
      throw new PluginError('CORE_PLUGIN', `plugin "${id}" is built in and cannot be disabled`)
    }
    if (enabled) {
      if (!this.fibers.has(id)) {
        try {
          await this.mount(entry)
        } catch (error) {
          // 重挂失败要把原因记进运行态：否则插件页上它还是「运行中」，而实际什么
          // 都没挂上——用户看到的是一个说自己在跑、其实没跑的东西。
          this.errors.set(id, messageOf(error))
          throw error
        }
      }
    } else if (this.fibers.has(id)) {
      await this.unmount(id)
    }
    this.states.set(id, enabled)
    this.save()
    return this.view(entry)
  }

  /** 逆序卸载全部已挂载插件；关闭时由 server 的 doClose 调用。 */
  async close(): Promise<void> {
    const mounted = [...this.fibers.entries()].reverse()
    this.fibers.clear()
    for (const [, fiber] of mounted) await fiber.dispose()
    this.started = false
  }

  private enabled(entry: PluginEntry): boolean {
    if (entry.core === true) return true
    return this.states.get(entry.id) ?? true
  }

  private async mount(entry: PluginEntry): Promise<void> {
    this.errors.delete(entry.id)
    // 用对象形态包一层：entry 自带的 inject 必须跟着插件走，否则 apply 里读
    // ctx.tools / ctx.llm 会被 cordis 当成「未声明依赖」直接拒绝。
    const plugin: Plugin.Object = { name: entry.id, apply: entry.apply, inject: entry.inject }
    const fiber = await this.ctx.plugin(plugin, entry.config)
    this.fibers.set(entry.id, fiber)
  }

  private async unmount(id: string): Promise<void> {
    const fiber = this.fibers.get(id)
    if (fiber === undefined) return
    this.fibers.delete(id)
    await fiber.dispose()
  }

  private view(entry: PluginEntry): PluginView {
    const error = this.errors.get(entry.id)
    const running = this.fibers.has(entry.id)
    const status: PluginStatus = running ? 'running' : error === undefined ? 'stopped' : 'error'
    const missing = this.missingOf(entry, running)
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      ...(entry.group === undefined ? {} : { group: entry.group }),
      ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
      ...(entry.skills === undefined || entry.skills.length === 0
        ? {}
        : {
            skills: entry.skills.map((skill) => {
              return { ...skill, pluginId: entry.id }
            }),
          }),
      ...(entry.impact === undefined ? {} : { impact: entry.impact }),
      enabled: this.enabled(entry),
      core: entry.core === true,
      status,
      ...(error === undefined ? {} : { error }),
      ...(missing.length === 0 ? {} : { missing }),
    }
  }

  /**
   * 声明里有、运行时却没有的东西。
   *
   * 只核对**已挂载**的插件：关掉的插件工具本就不在注册表里，那不是「声明错了」。
   * 探针缺省（没接线）时一律当作对得上——核对是加分项，不是加载的前提。
   */
  private missingOf(entry: PluginEntry, running: boolean): string[] {
    if (!running) return []
    const capabilities = entry.capabilities
    if (capabilities === undefined) return []
    if (this.probe === undefined) return []
    const reality = this.probe()
    const missing: string[] = []
    for (const tool of capabilities.tools ?? []) {
      if (!reality.tools.includes(tool)) missing.push(tool)
    }
    for (const route of capabilities.routes ?? []) {
      if (!reality.routes.includes(route)) missing.push(route)
    }
    return missing
  }

  /** 落盘当前清单的开关值（core 也写 true：读的人不必再猜缺省语义）。 */
  private save(): void {
    const states: PluginStates = {}
    for (const entry of this.entries.values()) {
      states[entry.id] = { enabled: this.enabled(entry) }
    }
    writeStates(pluginsConfigPath(this.dataDir), states)
  }
}

/** 异常 → 一句可展示的原因。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
