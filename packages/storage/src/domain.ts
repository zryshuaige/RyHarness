/**
 * 形状校验：一条记录声明自己该长什么样，写进去之前先对一遍。
 *
 * 校验口径来自 `DomainShape` 的定义，两条规矩：
 * 1. **声明了的字段**：缺了要报错（除非标了 `required: false`），类型不对要报错。
 * 2. **没声明的字段**：也要报错。形状是白名单而不是黑名单——拼错的字段名
 *    悄悄存进去，几个月后没人知道它为什么不对。
 *
 * 第 2 条是这里和「随便校验一下类型」的分野，也是本包唯一值得存在的理由：
 * 存进去的东西自己知道该长什么样。
 * @module @ryharness/storage/domain
 */

import { StorageValidationError } from './errors.ts'
import type { DomainFieldType, DomainShape } from './types.ts'

/** 一个字段没过检时，原因是什么。 */
export interface DomainIssue {
  /** 出问题的字段名；`<root>` 表示整体不是对象。 */
  readonly field: string
  /** 为什么不过。 */
  readonly reason: string
}

/** 判断一个值是不是普通对象（不是数组、不是 null）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 值的类型名（给错误文案用），跟 `typeof` 对得上但更像人话。 */
export function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 这个值符合声明的类型吗。
 *
 * 'object' 指普通对象：数组与 null 都不算——它们各有各的类型，
 * 混进 object 里等于让形状的一部分形同虚设。
 */
export function matchesType(value: unknown, type: DomainFieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * 字段实际值是不是「没给」。
 *
 * `undefined` 与「键压根不存在」一回事：形状里没给它值就当没给。
 */
function isAbsent(data: Record<string, unknown>, field: string): boolean {
  return !Object.hasOwn(data, field) || data[field] === undefined
}

/**
 * 按形状检查一份数据，返回所有没过的地方。
 *
 * 返回**全部**问题而不是第一个：一次改完比一次报一个省事，
 * 而形状不大时逐条找的成本可以忽略。
 * @param shape - 这个 kind 声明的形状。
 * @param data - 要检查的数据。
 * @returns 问题清单（空数组表示通过）。
 */
export function checkShape(shape: DomainShape, data: unknown): DomainIssue[] {
  const issues: DomainIssue[] = []
  if (!isPlainObject(data)) {
    issues.push({ field: '<root>', reason: `应当是对象，实际是 ${describeType(data)}` })
    return issues
  }
  const declared = shape.fields
  for (const [name, field] of Object.entries(declared)) {
    if (isAbsent(data, name)) {
      if (field.required !== false) issues.push({ field: name, reason: '缺少必填字段' })
      continue
    }
    if (!matchesType(data[name], field.type)) {
      issues.push({
        field: name,
        reason: `应当是 ${field.type}，实际是 ${describeType(data[name])}`,
      })
    }
  }
  for (const name of Object.keys(data)) {
    if (!Object.hasOwn(declared, name)) {
      issues.push({ field: name, reason: '形状里没有声明这个字段' })
    }
  }
  return issues
}

/**
 * 按形状检查一份数据，不合格就抛错。
 *
 * @param kind - 出问题的 kind（写进错误里）。
 * @param shape - 这个 kind 声明的形状。
 * @param data - 要检查的数据。
 * @throws StorageValidationError - 有字段没过检时。
 */
export function assertShape(kind: string, shape: DomainShape, data: unknown): void {
  const issues = checkShape(shape, data)
  const first = issues[0]
  if (first === undefined) return
  const reason = issues.length > 1 ? `${first.reason}（另有 ${issues.length - 1} 处问题）` : first.reason
  throw new StorageValidationError(kind, first.field, reason)
}
