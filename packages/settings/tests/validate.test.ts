/**
 * 校验：不合的值要拦下来，而且要说清**是哪个字段**不对。
 *
 * 「参数不合法」这种话对用户没用——他得自己一个个框试。所以每条断言都盯住字段名
 * 与原因。
 */
import { describe, expect, it } from 'vitest'
import {
  acceptsValue,
  describeSchema,
  type SettingsDescriptor,
  type SettingsValues,
  validateValues,
} from '../src/index.ts'

const descriptors: readonly SettingsDescriptor[] = describeSchema({
  type: 'object',
  properties: {
    verbose: { type: 'boolean', title: '调试日志' },
    endpoint: { type: 'string', title: '服务地址' },
    timeout: { type: 'number', title: '超时', minimum: 1, maximum: 1000 },
    mode: { type: 'select', title: '模式', enum: ['fast', 'safe'] },
  },
})

/** 校验一份改动，返回第一条问题。 */
function firstIssue(values: SettingsValues): { key: string; message: string } | undefined {
  return validateValues(descriptors, values)[0]
}

describe('按 schema 校验改动', () => {
  it('类型都对就放过', () => {
    expect(validateValues(descriptors, { verbose: true, endpoint: 'x', timeout: 10, mode: 'fast' })).toEqual([])
  })

  it('类型不对时报出字段名与期望类型', () => {
    const issue = firstIssue({ timeout: 'soon' })
    expect(issue?.key).toBe('timeout')
    expect(issue?.message).toContain('timeout')
    expect(issue?.message).toContain('number')
  })

  it('布尔与字符串也不能串', () => {
    expect(firstIssue({ verbose: 'yes' })?.message).toContain('boolean')
    expect(firstIssue({ endpoint: 42 })?.message).toContain('string')
  })

  it('下拉的值必须在候选里', () => {
    const issue = firstIssue({ mode: 'turbo' })
    expect(issue?.key).toBe('mode')
    expect(issue?.message).toContain('fast')
    expect(issue?.message).toContain('safe')
  })

  it('数值超出范围要被拦下，并说清上下限', () => {
    expect(firstIssue({ timeout: 0 })?.message).toContain('不能小于 1')
    expect(firstIssue({ timeout: 5000 })?.message).toContain('不能大于 1000')
  })

  it('改了不存在的配置项也要拦：拼错键名不能当成改成功了', () => {
    const issue = firstIssue({ timout: 10 })
    expect(issue?.key).toBe('timout')
    expect(issue?.message).toContain('没有这个配置项')
  })

  it('一次改多个字段时，每一处都单独报出来', () => {
    const issues = validateValues(descriptors, { timeout: 'x', mode: 'turbo' })
    expect(issues.map((issue) => issue.key)).toEqual(['timeout', 'mode'])
  })

  it('下拉框收到数字：先说类型不对，不说「不在候选里」', () => {
    const issue = firstIssue({ mode: 42 })
    expect(issue?.key).toBe('mode')
    expect(issue?.message).toContain('string')
  })

  it('数值字段收到布尔：类型名要写对', () => {
    const issue = firstIssue({ timeout: true })
    expect(issue?.key).toBe('timeout')
    expect(issue?.message).toContain('boolean')
  })

  it('接受判断：这个描述符认不认这个值（schema 改过时用来筛旧值）', () => {
    const timeout = descriptors.find((descriptor) => descriptor.key === 'timeout')
    const mode = descriptors.find((descriptor) => descriptor.key === 'mode')
    expect(timeout).toBeDefined()
    expect(mode).toBeDefined()
    if (timeout === undefined || mode === undefined) return
    expect(acceptsValue(timeout, 10)).toBe(true)
    expect(acceptsValue(timeout, 5000)).toBe(false)
    expect(acceptsValue(mode, 'fast')).toBe(true)
    expect(acceptsValue(mode, 'turbo')).toBe(false)
  })
})
