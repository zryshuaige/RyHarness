/**
 * 描述符推导：一份 schema 变成一组能画表单的描述符。
 *
 * 这些用例盯的是「界面看到的那个框」到底长什么样：键路径怎么摊平、中文名从哪来、
 * 下拉框的候选从哪来、哪些 schema 是压根画不出来的。
 */
import { describe, expect, it } from 'vitest'
import { defaultValues, describeSchema, SettingsError, type SettingsSchema } from '../src/index.ts'

const schema: SettingsSchema = {
  type: 'object',
  properties: {
    verbose: { type: 'boolean', title: '打印调试日志', default: false },
    endpoint: { type: 'string', title: '服务地址', description: '请求发到哪儿' },
    timeout: { type: 'number', title: '超时（毫秒）', default: 30_000, minimum: 1, maximum: 600_000 },
    mode: { type: 'select', title: '运行模式', enum: ['fast', 'safe'], default: 'safe' },
    token: { type: 'string', title: '令牌', format: 'password' },
    legacy: { type: 'string', title: '老配置', enum: ['a', 'b'] },
    nested: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', title: '嵌套开关' },
        depth: { type: 'number', title: '嵌套深度', default: 2 },
      },
    },
  },
}

describe('从 schema 推描述符', () => {
  it('每个标量字段出一条描述符，键就是配置里的键', () => {
    const descriptors = describeSchema(schema)
    expect(descriptors.map((descriptor) => descriptor.key)).toEqual([
      'verbose',
      'endpoint',
      'timeout',
      'mode',
      'token',
      'legacy',
      'nested.enabled',
      'nested.depth',
    ])
  })

  it('中文名取 title，没有 title 就用键的最后一段', () => {
    const descriptors = describeSchema(schema)
    expect(descriptors[0]?.label).toBe('打印调试日志')
    const noTitle = describeSchema({
      type: 'object',
      properties: { plain: { type: 'string' } },
    })
    expect(noTitle[0]?.label).toBe('plain')
  })

  it('控件类型按 schema 翻译：字符串加 format 变口令框，带候选的字符串变下拉', () => {
    const descriptors = describeSchema(schema)
    const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
    expect(byKey.get('verbose')?.type).toBe('boolean')
    expect(byKey.get('endpoint')?.type).toBe('string')
    expect(byKey.get('timeout')?.type).toBe('number')
    expect(byKey.get('mode')?.type).toBe('select')
    expect(byKey.get('token')?.type).toBe('password')
    expect(byKey.get('legacy')?.type).toBe('select')
  })

  it('下拉框带候选值与默认值', () => {
    const descriptors = describeSchema(schema)
    const mode = descriptors.find((descriptor) => descriptor.key === 'mode')
    expect(mode?.options).toEqual(['fast', 'safe'])
    expect(mode?.default).toBe('safe')
  })

  it('数值字段带范围，供校验用', () => {
    const descriptors = describeSchema(schema)
    const timeout = descriptors.find((descriptor) => descriptor.key === 'timeout')
    expect(timeout?.range?.minimum).toBe(1)
    expect(timeout?.range?.maximum).toBe(600_000)
  })

  it('只给上限也行：范围里有上限就没有下限', () => {
    const descriptors = describeSchema({
      type: 'object',
      properties: { ratio: { type: 'number', title: '比例', maximum: 1 } },
    })
    expect(descriptors[0]?.range?.maximum).toBe(1)
    expect(descriptors[0]?.range?.minimum).toBeUndefined()
  })

  it('嵌套对象摊平成点号键路径，默认值也跟着摊平', () => {
    const descriptors = describeSchema(schema)
    expect(descriptors.find((descriptor) => descriptor.key === 'nested.enabled')?.label).toBe('嵌套开关')
    expect(defaultValues(schema)).toEqual({ verbose: false, timeout: 30_000, mode: 'safe', 'nested.depth': 2 })
  })

  it('下拉框没给候选值就说清楚是哪一项画不出来', () => {
    expect(() =>
      describeSchema({
        type: 'object',
        properties: { broken: { type: 'select', title: '坏的下拉' } },
      }),
    ).toThrowError(SettingsError)
    try {
      describeSchema({ type: 'object', properties: { broken: { type: 'select', title: '坏的下拉' } } })
    } catch (error) {
      expect(error instanceof SettingsError ? error.code : '').toBe('INVALID_SCHEMA')
      expect((error as Error).message).toContain('broken')
    }
  })

  it('对象字段没给子项也算画不出来', () => {
    expect(() => describeSchema({ type: 'object', properties: { hole: { type: 'object' } } })).toThrowError(/hole/)
  })
})
