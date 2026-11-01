/**
 * 配置表单的领域错误。
 *
 * 单独一个类，是因为界面要**按错误种类**决定怎么办，而不是去匹配错误文案：
 *   - `VALIDATION` → 用户填错了，把出错的那个字段标出来（`field`），别整页弹红；
 *   - `CONFLICT` → 别人先改过了，界面重新拉一遍（`revision` 里是当前的版本号）；
 *   - `UNKNOWN_PLUGIN` → 插件没了，界面回列表。
 *
 * 文案是人话的中文：这些字符串会直接出现在设置页上。
 * @module @ryharness/settings/errors
 */

/** 配置表单的错误种类。 */
export type SettingsErrorCode =
  /** 插件 id。 */
  | 'UNKNOWN_PLUGIN'
  /** 同一个插件注册了两遍。 */
  | 'DUPLICATE'
  /** schema 本身不合法（比如 select 没给候选值）。 */
  | 'INVALID_SCHEMA'
  /** 值不合法：类型不对、候选里没有、超出范围。 */
  | 'VALIDATION'
  /** 版本号对不上：别人先改过。 */
  | 'CONFLICT'
  /** 新值没能应用到活着的插件上（已回滚）。 */
  | 'APPLY_FAILED'
  /** 新值没能存下来（已回滚）。 */
  | 'PERSIST_FAILED'

/** 配置表单的错误。 */
export class SettingsError extends Error {
  /**
   * @param code - 错误种类，界面按它分支。
   * @param message - 一句能直接给用户看的中文。
   * @param field - 出错的配置项键路径（只有校验类错误有）。
   * @param revision - 当前的版本号（只有冲突错误有，界面拿它重新拉一遍）。
   */
  constructor(
    readonly code: SettingsErrorCode,
    message: string,
    readonly field?: string,
    readonly revision?: number,
  ) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** 异常 → 一句可展示的原因。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
