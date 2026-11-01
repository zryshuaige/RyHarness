/**
 * 从 schema 推出表单描述符。
 *
 * 上游 dsh 的做法是「每个插件自带一份 Config schema，界面按 schema 画表单」。我们
 * 照这个思路，但**不引 JSON Schema 库**：插件的配置项就那么几种（开关、文本、数字、
 * 下拉、口令），自己写一份极小的 schema 形状足够，还省掉一份依赖和一层看不懂的
 * 抽象。
 *
 * schema 长这样：
 *
 * ```ts
 * const schema: SettingsSchema = {
 *   type: 'object',
 *   properties: {
 *     timeout: { type: 'number', title: '超时（毫秒）', default: 30_000, minimum: 1 },
 *     retries: { type: 'number', title: '重试次数', default: 3 },
 *     mode: { type: 'select', title: '运行模式', enum: ['fast', 'safe'] },
 *     token: { type: 'string', title: '令牌', format: 'password' },
 *     nested: {
 *       type: 'object',
 *       properties: { enabled: { type: 'boolean', title: '嵌套开关' } },
 *     },
 *   },
 * }
 * ```
 *
 * 推出的是一组描述符：嵌套对象**摊平**成点号键路径（`nested.enabled`），因为界面
 * 上的每个输入框只需要知道自己对应配置里的哪一个位置。
 * @module @ryharness/settings/schema
 */

import { SettingsError } from './errors.ts'
import type { SettingsDescriptor, SettingsFieldType, SettingsValue } from './types.ts'

/** schema 里一个标量属性的形状（能画成一个控件的那种）。 */
export interface SettingsScalarSchema {
  /** 字段类型。 */
  readonly type: 'boolean' | 'string' | 'number' | 'select'
  /** 中文名；不给就用键的最后一段。 */
  readonly title?: string
  /** 一句话说明。 */
  readonly description?: string
  /** 候选值：给 `select` 用（`type: 'string'` + `enum` 也当 select 处理）。 */
  readonly enum?: readonly string[]
  /** 默认值。 */
  readonly default?: SettingsValue
  /** `format: 'password'` 把字符串变成口令框（界面上不显示明文）。 */
  readonly format?: 'password'
  /** 数值下限。 */
  readonly minimum?: number
  /** 数值上限。 */
  readonly maximum?: number
}

/** schema 里一个嵌套对象的形状：摊平成点号键路径。 */
export interface SettingsObjectSchema {
  readonly type: 'object'
  /** 子属性；不给就是这份 schema 画不出来。 */
  readonly properties?: Readonly<Record<string, SettingsPropertySchema>>
}

/** schema 里一个属性的形状（标量或嵌套对象）。 */
export type SettingsPropertySchema = SettingsScalarSchema | SettingsObjectSchema

/** 一份配置 schema。 */
export interface SettingsSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, SettingsPropertySchema>>
}

/**
 * 推出这份 schema 的全部描述符。
 *
 * 顺序即表单顺序：按 schema 里 `properties` 的书写顺序，嵌套的排在它父亲的位置上。
 * @param schema - 插件自己的配置 schema。
 * @returns 一组描述符。
 * @throws SettingsError - schema 不合法时（`INVALID_SCHEMA`）。
 */
export function describeSchema(schema: SettingsSchema): SettingsDescriptor[] {
  const out: SettingsDescriptor[] = []
  walk(schema.properties, '', out)
  return out
}

/**
 * schema 里所有默认值（键是描述符的 key）。
 *
 * 注册插件时用它当初值：宿主没给值的那一项，就落到 schema 说的默认值上。
 * @param schema - 插件自己的配置 schema。
 * @returns 默认值表。
 */
export function defaultValues(schema: SettingsSchema): Record<string, SettingsValue> {
  const out: Record<string, SettingsValue> = {}
  for (const descriptor of describeSchema(schema)) {
    if (descriptor.default !== undefined) out[descriptor.key] = descriptor.default
  }
  return out
}

/** 递归摊平嵌套属性。 */
function walk(
  properties: Readonly<Record<string, SettingsPropertySchema>>,
  prefix: string,
  out: SettingsDescriptor[],
): void {
  for (const [name, property] of Object.entries(properties)) {
    const key = prefix === '' ? name : `${prefix}.${name}`
    if (property.type === 'object') {
      if (property.properties === undefined) {
        throw new SettingsError('INVALID_SCHEMA', `配置项 "${key}" 是对象，但没给子项（properties）`)
      }
      walk(property.properties, key, out)
      continue
    }
    out.push(descriptorOf(key, name, property))
  }
}

/** 一个属性 → 一个描述符。 */
function descriptorOf(key: string, name: string, property: SettingsScalarSchema): SettingsDescriptor {
  const type = fieldTypeOf(property)
  const options = type === 'select' ? property.enum : undefined
  if (type === 'select' && (options === undefined || options.length === 0)) {
    throw new SettingsError('INVALID_SCHEMA', `配置项 "${key}" 是下拉框，但没给候选值（enum）`)
  }
  return {
    key,
    // 没给标题就用键的最后一段：嵌套时是 `nested.enabled` → `enabled`。
    label: property.title ?? name.split('.').pop() ?? name,
    type,
    ...(property.description === undefined ? {} : { description: property.description }),
    ...(options === undefined ? {} : { options }),
    ...(rangeOf(property) === undefined ? {} : { range: rangeOf(property) }),
    ...(property.default === undefined ? {} : { default: property.default }),
  }
}

/** 属性里的数值范围（没给就是没有）。 */
function rangeOf(property: SettingsScalarSchema): { minimum?: number; maximum?: number } | undefined {
  if (property.minimum === undefined && property.maximum === undefined) return undefined
  return {
    ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
    ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
  }
}

/** 属性 → 控件类型（嵌套对象已经在 walk 里摊平，走不到这里）。 */
function fieldTypeOf(property: SettingsScalarSchema): SettingsFieldType {
  if (property.type === 'select') return 'select'
  if (property.type === 'string') {
    if (property.format === 'password') return 'password'
    // 给了候选值的字符串当下拉处理：写 schema 的人省得再改 type。
    if (property.enum !== undefined && property.enum.length > 0) return 'select'
  }
  return property.type
}
