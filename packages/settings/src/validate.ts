/**
 * 按描述符校验一份改动。
 *
 * 校验的意义只有一条：**别让错的值进到活着的插件里**。插件拿到一个类型不对的值，
 * 轻则行为诡异，重则当场崩在用户面前；而崩在用户面前之前，这里拦下来还能告诉用户
 * 「是哪个框填错了」。
 *
 * 所以错误信息必须点名到字段：`字段 "timeout" 类型不对：期望 number，实际是 string`。
 * 只说「参数不合法」的表单，等于让用户自己猜。
 * @module @ryharness/settings/validate
 */

import type { SettingsDescriptor, SettingsValue, SettingsValues } from './types.ts'

/** 一处校验不过的地方。 */
export interface SettingsValidationIssue {
  /** 出错的键路径。 */
  readonly key: string
  /** 一句中文原因。 */
  readonly message: string
}

/**
 * 校验一份改动。
 *
 * 认两种不过：值本身不合法（类型、候选、范围），以及**改了不存在的配置项**——后者
 * 也要拦：拼错键名时如果放过去，用户会以为改生效了，其实什么都没改。
 * @param descriptors - 这个插件的描述符。
 * @param values - 要改的值（只写要改的键）。
 * @returns 所有不过的地方（空数组 = 全过）。
 */
export function validateValues(
  descriptors: readonly SettingsDescriptor[],
  values: SettingsValues,
): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = []
  const byKey = new Map(
    descriptors.map((descriptor) => {
      return [descriptor.key, descriptor]
    }),
  )
  for (const [key, value] of Object.entries(values)) {
    const descriptor = byKey.get(key)
    if (descriptor === undefined) {
      issues.push({ key, message: `没有这个配置项："${key}"` })
      continue
    }
    const issue = checkValue(descriptor, value)
    if (issue !== undefined) issues.push(issue)
  }
  return issues
}

/**
 * 这个描述符认不认这个值。
 *
 * 注册时用来挑落盘里的旧值：schema 改过之后，旧值可能已经不合新 schema（比如字段从
 * 数字改成了字符串），这种旧值要丢掉、退回默认值，而不是原样带进活着的插件。
 * @param descriptor - 描述符。
 * @param value - 要判断的值。
 * @returns 认就返回 true。
 */
export function acceptsValue(descriptor: SettingsDescriptor, value: SettingsValue): boolean {
  return checkValue(descriptor, value) === undefined
}

/** 校验单个值；过了返回 undefined。 */
function checkValue(descriptor: SettingsDescriptor, value: SettingsValue): SettingsValidationIssue | undefined {
  switch (descriptor.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : issue(descriptor.key, `类型不对：期望 boolean，实际是 ${typeName(value)}`)
    case 'string':
    case 'password':
      return typeof value === 'string'
        ? undefined
        : issue(descriptor.key, `类型不对：期望 string，实际是 ${typeName(value)}`)
    case 'number':
      return checkNumber(descriptor, value)
    case 'select':
      return checkSelect(descriptor, value)
  }
}

/** 数值：类型 + 范围。 */
function checkNumber(descriptor: SettingsDescriptor, value: SettingsValue): SettingsValidationIssue | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return issue(descriptor.key, `类型不对：期望 number，实际是 ${typeName(value)}`)
  }
  const minimum = descriptor.range?.minimum
  const maximum = descriptor.range?.maximum
  if (minimum !== undefined && value < minimum) {
    return issue(descriptor.key, `太小了：不能小于 ${minimum}，收到 ${value}`)
  }
  if (maximum !== undefined && value > maximum) {
    return issue(descriptor.key, `太大了：不能大于 ${maximum}，收到 ${value}`)
  }
  return undefined
}

/** 下拉：值得在候选里。 */
function checkSelect(descriptor: SettingsDescriptor, value: SettingsValue): SettingsValidationIssue | undefined {
  if (typeof value !== 'string') {
    return issue(descriptor.key, `类型不对：期望 string，实际是 ${typeName(value)}`)
  }
  const options = descriptor.options ?? []
  if (!options.includes(value)) {
    return issue(descriptor.key, `不在候选里：只能是 ${options.join(' / ')}，收到 "${value}"`)
  }
  return undefined
}

/** 组一条问题。 */
function issue(key: string, reason: string): SettingsValidationIssue {
  return { key, message: `字段 "${key}" ${reason}` }
}

/** 值的类型名（写进错误信息里）。 */
function typeName(value: SettingsValue): string {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'string'
}
