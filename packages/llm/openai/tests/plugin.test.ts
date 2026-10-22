/**
 * llm-openai 的 cordis 插件入口：装路由、交回可 replace 的句柄、零路由 dormant。
 *
 * 组合根曾经绕过 apply 手工 new OpenAiAdapter；这组用例把「插件能装默认路由」
 * 钉住，避免那个入口再次变成死代码。
 */

import { Context } from '@ryharness/cordis'
import type { AdapterRegistrationHandle } from '@ryharness/llm'
import { LlmRuntime } from '@ryharness/llm'
import { apply } from '@ryharness/llm-openai'
import { describe, expect, it } from 'vitest'

const PROVIDERS = {
  alpha: { baseURL: 'https://alpha.test/v1', apiKey: 'k-alpha', models: [{ id: 'alpha-model' }] },
  beta: { baseURL: 'https://beta.test/v1', apiKey: 'k-beta', models: [{ id: 'beta-model' }] },
}

describe('llm-openai 插件', () => {
  it('apply 注册全部路由，并把 replace 句柄交给宿主', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    let handle: AdapterRegistrationHandle | undefined
    const fiber = await ctx.inject(['llm'], (pluginCtx) => {
      apply(pluginCtx, {
        providers: PROVIDERS,
        onRegistered: (registered) => {
          handle = registered
        },
      })
    })
    expect(
      ctx.llm
        .listProviders()
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(['alpha', 'beta'])
    expect(handle).toBeDefined()
    // 热增删走同一个句柄：替换后旧路由消失、新路由出现。
    handle?.replace(['alpha'])
    expect(ctx.llm.listProviders().map((provider) => provider.id)).toEqual(['alpha'])

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('零路由时保持 dormant：不注册、也不回调句柄', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    let called = false
    await ctx.inject(['llm'], (pluginCtx) => {
      apply(pluginCtx, {
        providers: {},
        onRegistered: () => {
          called = true
        },
      })
    })
    expect(ctx.llm.listProviders()).toEqual([])
    expect(called).toBe(false)
  })
})
