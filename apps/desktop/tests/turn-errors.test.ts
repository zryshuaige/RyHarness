/**
 * lib/turn-errors.ts：内核错误码 → 人话 + 可行动作。
 *
 * 这层是纯函数，所以按「用户会看到什么」钉死：认得出的故障必须说人话、给出能点的
 * 下一步，且不许把包名/环境变量名漏回界面；认不出的故障必须老实递出原文。
 */
import { describe, expect, it } from 'vitest'
import { explainTurnError } from '../renderer/src/lib/turn-errors.ts'

describe('explainTurnError · 凭据类', () => {
  it('MISSING_CREDENTIAL：说人话、指向模型供应商，且不把环境变量名甩回界面', () => {
    const explained = explainTurnError(
      'MISSING_CREDENTIAL',
      '@ryharness/llm-openai: provider "siliconflow" needs its API key in the RYHARNESS_KEY_SILICONFLOW environment variable',
    )
    expect(explained.title).toContain('API Key')
    expect(explained.action).toEqual({ label: '去我的 → 模型供应商', target: 'me' })
    // 原文里的环境变量名不该出现在任何面向用户的字段里。
    const userFacing = `${explained.title} ${explained.hint} ${explained.detail ?? ''}`
    expect(userFacing).not.toContain('RYHARNESS_KEY')
    expect(userFacing).not.toContain('@ryharness/llm-openai')
  })

  it('INVALID_CREDENTIAL：Key 失效与「没配」是两件事，说法也不同', () => {
    const invalid = explainTurnError('INVALID_CREDENTIAL', 'openai (x): HTTP 401 invalid api key')
    const missing = explainTurnError('MISSING_CREDENTIAL', 'whatever')
    expect(invalid.title).not.toBe(missing.title)
    expect(invalid.action?.target).toBe('me')
  })
})

describe('explainTurnError · 模型与供应商', () => {
  it('NO_ADAPTER：这个模型服务没接进来（原文是英文包名）', () => {
    const explained = explainTurnError('NO_ADAPTER', 'no adapter registered for provider "moonshot"')
    expect(explained.action?.target).toBe('me')
    expect(explained.hint).toContain('模型供应商')
  })

  it('模型不存在（NOT_FOUND）指向改 agent 的模型，而不是让用户去配 Key', () => {
    const explained = explainTurnError('NOT_FOUND', 'openai (x): HTTP 404 model_not_found')
    expect(explained.title).toContain('模型不存在')
    expect(explained.action?.target).toBe('contacts')
  })
})

describe('explainTurnError · 可重试类', () => {
  it.each([
    ['RATE_LIMIT', '限流'],
    ['TIMEOUT', '时限'],
    ['SERVER', '模型服务那边出错'],
    ['TRANSPORT', '连不上'],
    ['HTTP', '没发出去'],
  ])('%s → %s，且给的是重试', (code, word) => {
    const explained = explainTurnError(code, '原始报错')
    expect(explained.title).toContain(word)
    expect(explained.action).toEqual({ label: '重试这一轮', target: 'retry' })
  })

  it('QUOTA 与 RATE_LIMIT 分开：额度用完不是「等几十秒」', () => {
    expect(explainTurnError('QUOTA', 'insufficient_quota').title).toContain('额度')
    expect(explainTurnError('QUOTA', 'insufficient_quota').action?.target).toBe('me')
    expect(explainTurnError('RATE_LIMIT', '429').action?.target).toBe('retry')
  })
})

describe('explainTurnError · 容错解析与兜底', () => {
  it('code 认不出时扫原文：内核把普通 Error 抛成 UNKNOWN，线索还在 message 里', () => {
    const cases: [string, string | undefined][] = [
      ['@ryharness/session: unknown agent "ghost"', 'contacts'],
      ['provider "x" needs its API key in the FOO_KEY environment variable', 'me'],
      ['model_not_found: qwen-max', 'contacts'],
      ['HTTP 429 Too Many Requests', 'retry'],
      ['no adapter registered for provider "x"', 'me'],
    ]
    for (const [message, target] of cases) {
      expect(explainTurnError('UNKNOWN', message).action?.target, message).toBe(target)
    }
  })

  it('大小写不敏感：WS 事件里的 code 不是规范大写也能认出来', () => {
    expect(explainTurnError('missing_credential', 'x').action?.target).toBe('me')
    expect(explainTurnError('  Rate_Limit  ', 'x').action?.target).toBe('retry')
  })

  it('彻底认不出：标题说人话、原文照给、并给重试', () => {
    const explained = explainTurnError('INTERNAL', 'something   went\n  wrong')
    expect(explained.title).toBe('这一轮没跑起来')
    expect(explained.action?.target).toBe('retry')
    expect(explained.detail).toBe('something went wrong')
  })

  it('空 code / 空 message 不炸：给兜底标题，没有原文就不带 detail', () => {
    const empty = explainTurnError(undefined, '')
    expect(empty.title).toBe('这一轮没跑起来')
    expect(empty.detail).toBeUndefined()
    expect(empty.action?.target).toBe('retry')
  })

  it('原文过长时截断（红条一行放不下整段响应体）', () => {
    const explained = explainTurnError('WHAT', 'x'.repeat(500))
    expect(explained.detail?.length).toBeLessThanOrEqual(161)
    expect(explained.detail?.endsWith('…')).toBe(true)
  })
})
