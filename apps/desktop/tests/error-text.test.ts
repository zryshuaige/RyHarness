/**
 * lib/error-text.ts：REST 失败的人话层，以及 api.ts 那条根因。
 *
 * 这层是纯函数，按「用户会看到什么」钉死：认得出的服务端字面量必须翻成人话，
 * 认不出的必须退回调用点给的中文兜底（**不是**英文原话），服务端原文只在折叠的
 * 「详情」里出现。ApiRequestError 的 status / code / raw 是程序要用的三样东西，
 * 改人话不能把它们一起改掉。
 *
 * 映射表逐条对着 apps/server/src/routes/*.ts 与 router.ts / app.ts 里真的 `error:`
 * 出去的原句写的，所以这里也按那些原句来断言——服务端改字面量时，红的就是这里。
 */
import { describe, expect, it } from 'vitest'
import { ApiClient, ApiRequestError } from '../renderer/src/api.ts'
import { errorDetail, humanError } from '../renderer/src/lib/error-text.ts'

describe('humanError · 认得出的服务端字面量', () => {
  it.each([
    ['conversation not found', '这个会话已经不在了，可能刚被删掉。'],
    ['agent not found: 6f2c0a1b', '这位助理已经不在了，可能刚被删掉。'],
    ['message not found', '这条消息已经不在了。'],
    ['entry not found: e7', '这条经验记录已经不在了。'],
    ['memory not found', '这条记忆已经不在了。'],
    ['provider not found: siliconflow', '这家模型服务已经不在供应商列表里。'],
    ['unknown plugin: todo', '这个插件已经不在服务端的插件清单里。'],
    ['file not found: 方案.docx', '工作区里没有这个文件了。'],
    ['not found: POST /api/plugins', '本机服务没有这个接口，界面可能比服务端新。'],
    ['missing or invalid API token', '本机服务的访问凭据对不上，重启应用会重新发放。'],
    ['memory system disabled', '记忆功能被关掉了，先在设置里打开它。'],
    ['evolution system disabled', '自我进化被关掉了，先在设置里打开它。'],
    ['embeddings are not configured; nothing to rebuild', '还没配置向量模型，重建索引暂时做不了。'],
    ['file name must be a leaf name', '这个名字带了目录，只写文件名就行。'],
    ['file name is too long', '文件名太长了，换一个短一点的。'],
    ['too many files with the same name', '工作区里已经有同名文件了，换个名字。'],
    ['file is larger than 20 MB', '文件太大了，先压缩或截一段再发。'],
    ['builtin agent "ryen" cannot be deleted', '内置助理不能删掉。'],
    ['provider "siliconflow" is used by 2 agent(s)', '还有助理在用这家模型服务，先去通讯录改绑再删。'],
    ['write failed: EPERM', '内容没能写到本机，重试一次。'],
    ['restore failed', '没能恢复这条记忆，再试一次。'],
    ['consolidation failed', '这一轮整理没能跑完，稍后再试。'],
  ])('%s → %s', (raw, expected) => {
    expect(humanError(raw, '兜底句不该出现')).toBe(expected)
  })

  it('换行与多空格不影响匹配（服务端字面量偶尔带换行）', () => {
    expect(humanError('conversation\n   not found', '兜底')).toBe('这个会话已经不在了，可能刚被删掉。')
  })

  it('服务端已经回了中文：原样递出，不翻第二遍', () => {
    const already = '已经添加过指向同一个地址的供应商「SiliconFlow」，不用重复添加'
    expect(humanError(already, '兜底')).toBe(already)
  })
})

describe('humanError · 认不出就退回调用点的中文兜底', () => {
  it('陌生英文不递回去，给兜底句', () => {
    const text = humanError(new Error('ECONNRESET while reading socket'), '这次没能保存，再试一次')
    expect(text).toBe('这次没能保存，再试一次')
    expect(text).not.toContain('ECONNRESET')
  })

  it('HTTP 500 这种没有语义的原话也不上屏', () => {
    const text = humanError(new ApiRequestError('HTTP 500', 500), '这次没能保存，再试一次')
    expect(text).toBe('这次没能保存，再试一次')
    expect(text).not.toContain('HTTP')
  })

  it('空消息与非 Error 的抛出物：兜底句，不炸', () => {
    expect(humanError(new Error(''), '兜底甲')).toBe('兜底甲')
    expect(humanError(undefined, '兜底乙')).toBe('兜底乙')
    expect(humanError({ weird: true }, '兜底丙')).toBe('兜底丙')
    expect(humanError(404, '兜底丁')).toBe('兜底丁')
  })

  it('兜底句是调用点给的：同一个失败在两处说两句话', () => {
    const failure = new ApiRequestError('something broke internally', 500)
    expect(humanError(failure, '关闭插件失败，再点一次开关')).toBe('关闭插件失败，再点一次开关')
    expect(humanError(failure, '删除会话失败，再确认一次')).toBe('删除会话失败，再确认一次')
  })
})

describe('humanError · 上游模型服务的失败交给内核那套解释', () => {
  it('限流：按 code 说人话，并给出可照做的下一步', () => {
    const text = humanError(new ApiRequestError('HTTP 429 Too Many Requests', 429, 'RATE_LIMIT'), '兜底')
    expect(text).toContain('限流')
    expect(text).toContain('重试')
  })

  it('没有 Key：指向「我的 → 模型供应商」而不是让用户去设环境变量', () => {
    const text = humanError(
      new ApiRequestError(
        '@ryharness/llm-openai: provider "siliconflow" needs its API key in the RYHARNESS_KEY_SILICONFLOW variable',
        502,
        'MISSING_CREDENTIAL',
      ),
      '兜底',
    )
    expect(text).toContain('API Key')
    expect(text).not.toContain('RYHARNESS_KEY')
    expect(text).not.toContain('@ryharness/llm-openai')
  })

  it('模型没接进来：按 code 命中，不退到兜底', () => {
    const text = humanError(new ApiRequestError('no adapter registered for provider "mock"', 502, 'NO_ADAPTER'), '兜底')
    expect(text).toContain('模型供应商')
  })

  it('通用码不走内核解释：路由器的 404 也叫 NOT_FOUND，按码说成「模型不存在」是错的', () => {
    const text = humanError(new ApiRequestError('not found: GET /api/todos', 404, 'NOT_FOUND'), '待办清单没读出来')
    expect(text).toBe('本机服务没有这个接口，界面可能比服务端新。')
  })
})

describe('ApiRequestError：只改人话，程序要用的三样东西原样留着', () => {
  it('message 是人话，status / code / raw 都还在', () => {
    const failure = new ApiRequestError('conversation not found', 404, 'NOT_FOUND')
    expect(failure.message).toBe('这个会话已经不在了，可能刚被删掉。')
    expect(failure.message).not.toContain('conversation not found')
    expect(failure.status).toBe(404)
    expect(failure.code).toBe('NOT_FOUND')
    expect(failure.raw).toBe('conversation not found')
    expect(failure.name).toBe('ApiRequestError')
    expect(failure).toBeInstanceOf(Error)
  })

  it('插件关闭的 404 仍按 status / code 分支（RightPanel 的 isPluginOff 就靠这两个）', () => {
    const off = new ApiRequestError('not found: GET /api/todos', 404, 'NOT_FOUND')
    const business = new ApiRequestError('没有这个会话', 404, 'TODO_UNKNOWN_CONVERSATION')
    const ok = (failure: ApiRequestError): boolean => {
      return failure.status === 404 && (failure.code === undefined || failure.code === 'NOT_FOUND')
    }
    expect(ok(off)).toBe(true)
    expect(ok(business)).toBe(false)
  })

  it('没有 code 时 code 仍是 undefined（不是空串，别把 `undefined` 判据弄坏）', () => {
    expect(new ApiRequestError('HTTP 502', 502).code).toBeUndefined()
  })

  it('真发一次请求：message 是中文，raw 留着服务端原话', async () => {
    const api = new ApiClient('http://127.0.0.1:32100')
    const original = globalThis.fetch
    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'memory system disabled' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      await expect(api.listAgentMemories('ryen')).rejects.toMatchObject({
        message: '记忆功能被关掉了，先在设置里打开它。',
        status: 409,
        raw: 'memory system disabled',
      })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('errorDetail：折叠详情里给原文', () => {
  it('ApiRequestError 给服务端原话（折叠的详情要能对得上服务端日志）', () => {
    expect(errorDetail(new ApiRequestError('conversation not found', 404))).toBe('conversation not found')
  })

  it('普通 Error 给 message；给不出时返回 undefined（调用方据此连「详情」都不渲染）', () => {
    expect(errorDetail(new Error('向量库打不开'))).toBe('向量库打不开')
    expect(errorDetail(new Error('   '))).toBeUndefined()
    expect(errorDetail(undefined)).toBeUndefined()
  })

  it('和人话是同一件事的两副面孔：一处中文、一处原文，互不污染', () => {
    const failure = new ApiRequestError('agent not found: 6f2c', 404)
    expect(humanError(failure, '兜底')).toBe('这位助理已经不在了，可能刚被删掉。')
    expect(errorDetail(failure)).toBe('agent not found: 6f2c')
  })
})
