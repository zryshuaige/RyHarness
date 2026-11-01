/**
 * 插件配置表单的类型。
 *
 * 这一层只回答一个问题：**一个设置项长什么样**。键路径（配置里的位置）、控件类型、
 * 中文名、默认值、候选值。界面照描述符画表单，服务照描述符校验——两边看的是同一份
 * 东西，所以界面上能填的，服务一定认；服务认的，界面一定能填。
 *
 * 值只有三种（布尔 / 字符串 / 数字）：够表达绝大多数开关与参数，也够把类型校验做严。
 * 复杂的配置（数组、深层嵌套）不进这一层——那属于插件自己的 `config`，设置页不管。
 * @module @ryharness/settings/types
 */

/** 表单里的一种控件。 */
export type SettingsFieldType = 'boolean' | 'string' | 'number' | 'select' | 'password'

/** 配置值的类型：表单能填的就这三种。 */
export type SettingsValue = boolean | string | number

/** 一份键值表（键是配置里的键路径）。 */
export type SettingsValues = Record<string, SettingsValue>

/**
 * 一个设置项的描述符。
 *
 * 这是「界面与服务之间唯一的约定」：服务不产出 HTML，界面不猜控件类型。
 */
export interface SettingsDescriptor {
  /** 键路径：配置里的位置，嵌套时是 `a.b.c` 这种点号写法。 */
  readonly key: string
  /** 中文名，给人看。 */
  readonly label: string
  /** 控件类型。 */
  readonly type: SettingsFieldType
  /** 一句话说明这个设置是干嘛的。 */
  readonly description?: string
  /** select 的候选值（只有 select 有）。 */
  readonly options?: readonly string[]
  /** 数值范围（只有 number 用得上；校验时照它拦）。 */
  readonly range?: {
    /** 下限。 */
    readonly minimum?: number
    /** 上限。 */
    readonly maximum?: number
  }
  /** 默认值。 */
  readonly default?: SettingsValue
}

/** 界面看到的**一个插件**的配置面板。 */
export interface SettingsPluginView {
  /** 插件 id。 */
  readonly pluginId: string
  /** 这一组设置项的描述符（顺序即表单顺序）。 */
  readonly descriptors: readonly SettingsDescriptor[]
  /** 当前值（键是描述符的 key）。 */
  readonly values: SettingsValues
  /**
   * 版本号：每改一次 +1。
   *
   * 界面提交编辑时把看到的版本号一起带上；对不上说明别人（另一台机器、另一个标签页）
   * 已经改过，这时要重新拉一遍，而不是把人家的改动盖掉。
   */
  readonly revision: number
}

/** 一次编辑。 */
export interface SettingsUpdate {
  /** 要改的值：只写要改的键，没写的键保持原样。 */
  readonly values: SettingsValues
  /** 期望的版本号；给了就对一次，对不上报冲突。 */
  readonly revision?: number
}
