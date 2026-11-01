/**
 * 配置表单的服务。
 *
 * 上游 dsh 的分工是「active profile 存改动，Loader 负责应用」：插件自己带一份 Config
 * schema，界面按 schema 画表单，改完存进 active profile，Loader 读改动热生效。我们
 * 把这三块收在一个服务里：
 *
 *   - {@link SettingsService.register} 登记一个插件的 schema 与初值；
 *   - {@link SettingsService.list} 给界面一份「描述符 + 当前值 + 版本号」；
 *   - {@link SettingsService.update} 按 schema 校验后写入，版本号 +1，并调宿主的
 *     `apply` 回调把新值应用到活着的插件上。
 *
 * 两条不肯让步的规矩：
 *
 * 1. **版本对不上就报冲突**，不静默覆盖。两个窗口同时改一个插件，后保存的那个如果
 *    直接盖上去，先保存的那个改动就白做了，而界面上看不出任何异常。
 * 2. **应用失败就回滚**。`apply` 抛错时值必须退回原来的：不然界面显示新值、插件
 *    跑的还是旧值，用户会以为改了没用，于是反复点。
 * @module @ryharness/settings/service
 */

import { describeError, SettingsError } from './errors.ts'
import { describeSchema, type SettingsSchema } from './schema.ts'
import type { SettingsSnapshot, SettingsStore } from './store.ts'
import type { SettingsDescriptor, SettingsPluginView, SettingsUpdate, SettingsValues } from './types.ts'
import { acceptsValue, validateValues } from './validate.ts'

/** 服务的构造参数。 */
export interface SettingsServiceOptions {
  /**
   * 落盘的存取接口。
   *
   * 缺省就不落盘（改动只在内存里，进程退出即丢）——测试与临时用法。正式接入要给。
   */
  readonly store?: SettingsStore
  /**
   * 把新值应用到活着的插件上（热生效）。
   *
   * 拿到的是**整份值**（改过的键 + 没改的键），因为插件读的是自己那一份配置，不是
   * 增量。这个回调抛错时，服务会把值回滚并把错误抛给调用方。
   */
  readonly apply?: (pluginId: string, values: SettingsValues) => void | Promise<void>
}

/** 服务内部记的一个插件。 */
interface RegisteredPlugin {
  readonly pluginId: string
  readonly descriptors: readonly SettingsDescriptor[]
  values: SettingsValues
  revision: number
}

/**
 * 插件配置表单服务。
 *
 * 一个实例管一组插件的配置。宿主在组合根里建一个，插件挂载时把自己的 schema 登记
 * 进来，界面通过它读表单、提交改动。
 */
export class SettingsService {
  private readonly plugins = new Map<string, RegisteredPlugin>()
  /** 落盘里读到的状态：插件还没登记时先存着，别在下次保存时抹掉。 */
  private readonly persisted = new Map<string, SettingsSnapshot>()
  private readonly store: SettingsStore | undefined
  private readonly apply: SettingsServiceOptions['apply']

  constructor(options: SettingsServiceOptions = {}) {
    this.store = options.store
    this.apply = options.apply
    if (this.store !== undefined) {
      for (const snapshot of this.store.load()) this.persisted.set(snapshot.pluginId, snapshot)
    }
  }

  /**
   * 登记一个插件的配置。
   *
   * 初值的来路有三条，**后一条压前一条**：
   *   1. schema 里的默认值；
   *   2. 宿主给的值（插件启动时的配置）；
   *   3. 落盘里的值（用户上次改过的）——用户改过的当然要压过代码里的默认值。
   * @param pluginId - 插件 id。
   * @param schema - 插件自己的配置 schema。
   * @param values - 宿主给的值（可选）。
   * @returns 这个插件现在的配置面板。
   * @throws SettingsError - 插件已登记（`DUPLICATE`）或宿主给的值不合法（`VALIDATION`）。
   */
  register(pluginId: string, schema: SettingsSchema, values?: SettingsValues): SettingsPluginView {
    if (this.plugins.has(pluginId)) {
      throw new SettingsError('DUPLICATE', `插件 "${pluginId}" 的配置已经登记过了`)
    }
    const descriptors = describeSchema(schema)
    const current: SettingsValues = {}
    for (const descriptor of descriptors) {
      if (descriptor.default !== undefined) current[descriptor.key] = descriptor.default
    }
    if (values !== undefined) {
      const issues = validateValues(descriptors, values)
      if (issues.length > 0) {
        throw new SettingsError('VALIDATION', issues[0].message, issues[0].key)
      }
      Object.assign(current, values)
    }
    let revision = 0
    const snapshot = this.persisted.get(pluginId)
    if (snapshot !== undefined) {
      revision = snapshot.revision
      const byKey = new Map(
        descriptors.map((descriptor) => {
          return [descriptor.key, descriptor]
        }),
      )
      for (const [key, value] of Object.entries(snapshot.values)) {
        const descriptor = byKey.get(key)
        // 旧值认不得（schema 改过）就丢掉，退回默认值：别把过期值带进活着的插件。
        if (descriptor !== undefined && acceptsValue(descriptor, value)) current[key] = value
      }
    }
    const plugin: RegisteredPlugin = { pluginId, descriptors, values: current, revision }
    this.plugins.set(pluginId, plugin)
    return this.view(plugin)
  }

  /** 所有已登记插件的配置面板。 */
  list(): SettingsPluginView[] {
    return [...this.plugins.values()].map((plugin) => {
      return this.view(plugin)
    })
  }

  /**
   * 一个插件的配置面板。
   * @param pluginId - 插件 id。
   * @returns 配置面板。
   * @throws SettingsError - 没有这个插件（`UNKNOWN_PLUGIN`）。
   */
  get(pluginId: string): SettingsPluginView {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) {
      throw new SettingsError('UNKNOWN_PLUGIN', `没有这个插件的配置：${pluginId}`)
    }
    return this.view(plugin)
  }

  /**
   * 改一个插件的配置。
   *
   * 顺序是有讲究的：**先校验、再应用、后落盘**。校验不过就一个字节都不动；应用失败
   * 就还没落盘，回滚等于什么都不用做；落盘失败则把值退回去，并尽力把旧值重新应用
   * 到活着的插件上（否则界面退回旧值、插件还跑着新值）。
   * @param pluginId - 插件 id。
   * @param patch - 这次要改的值（只写要改的键）与期望的版本号。
   * @returns 改完之后的配置面板。
   * @throws SettingsError - 插件不存在（`UNKNOWN_PLUGIN`）、版本对不上（`CONFLICT`）、
   *   值不合法（`VALIDATION`）、应用失败（`APPLY_FAILED`）、落盘失败（`PERSIST_FAILED`）。
   */
  async update(pluginId: string, patch: SettingsUpdate): Promise<SettingsPluginView> {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) {
      throw new SettingsError('UNKNOWN_PLUGIN', `没有这个插件的配置：${pluginId}`)
    }
    if (patch.revision !== undefined && patch.revision !== plugin.revision) {
      throw new SettingsError(
        'CONFLICT',
        `配置已经被别人改过了（现在是第 ${plugin.revision} 版，你手上是第 ${patch.revision} 版），请重新拉一遍再改`,
        undefined,
        plugin.revision,
      )
    }
    const issues = validateValues(plugin.descriptors, patch.values)
    if (issues.length > 0) {
      throw new SettingsError('VALIDATION', issues[0].message, issues[0].key)
    }
    const previousValues = plugin.values
    const nextValues: SettingsValues = { ...previousValues, ...patch.values }
    if (this.apply !== undefined) {
      try {
        await this.apply(pluginId, { ...nextValues })
      } catch (error) {
        throw new SettingsError('APPLY_FAILED', `新值没生效，已经退回原来的配置：${describeError(error)}`)
      }
    }
    plugin.values = nextValues
    plugin.revision += 1
    if (this.store !== undefined) {
      try {
        this.store.save(this.snapshots())
      } catch (error) {
        plugin.values = previousValues
        plugin.revision -= 1
        // 尽力把旧值重新应用上去：应用不上也只能报出来，不能装作没事。
        if (this.apply !== undefined) {
          try {
            await this.apply(pluginId, { ...previousValues })
          } catch {
            // 旧值也应用不了：这台插件已经出问题了，报错文案里带着新值那条原因。
          }
        }
        throw new SettingsError('PERSIST_FAILED', `配置没保存下来，已经退回原来的配置：${describeError(error)}`)
      }
    }
    return this.view(plugin)
  }

  /**
   * 注销一个插件的配置（插件被卸下时调）。
   * @param pluginId - 插件 id。
   * @returns 之前登记过就返回 true。
   */
  unregister(pluginId: string): boolean {
    const removed = this.plugins.delete(pluginId)
    if (!removed) return false
    this.persisted.delete(pluginId)
    if (this.store !== undefined) this.store.save(this.snapshots())
    return true
  }

  /** 给界面看的面板：值与描述符都拷一份出去，调用方改不到内部状态。 */
  private view(plugin: RegisteredPlugin): SettingsPluginView {
    return {
      pluginId: plugin.pluginId,
      descriptors: plugin.descriptors.map((descriptor) => {
        return { ...descriptor }
      }),
      values: { ...plugin.values },
      revision: plugin.revision,
    }
  }

  /**
   * 要落盘的全部状态。
   *
   * 已登记的插件写当前值；**还没登记**的插件保留落盘里的旧状态——插件登记的先后顺序
   * 不固定，要是这里把它们抹了，下次启动就丢了用户改过的东西。
   */
  private snapshots(): SettingsSnapshot[] {
    const out: SettingsSnapshot[] = []
    const seen = new Set<string>()
    for (const plugin of this.plugins.values()) {
      seen.add(plugin.pluginId)
      out.push({ pluginId: plugin.pluginId, values: { ...plugin.values }, revision: plugin.revision })
    }
    for (const [pluginId, snapshot] of this.persisted) {
      if (seen.has(pluginId)) continue
      out.push({ pluginId, values: { ...snapshot.values }, revision: snapshot.revision })
    }
    return out
  }
}
