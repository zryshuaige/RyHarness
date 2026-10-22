/**
 * 「用户保存了 key 之后应用起不来」这条路的守门。
 *
 * 真机症状：内置条目 SiliconFlow 的 providers.json 里带着 `apiKeyEnv`（首启落种
 * 就写上了），用户在设置里粘了 key，key 存在本机 api-keys.json。于是合并后的那一条
 * 供应商**同时**带 `apiKeyEnv` 与 `apiKey`，而适配器构造时校验的是「恰好一个」——
 * 直接抛 `provider "siliconflow" must set exactly one of apiKeyEnv / apiKey`，
 * 整个服务起不来，应用只弹一个「启动失败」。
 *
 * 这条链路此前没有测试：mergeApiKeys 与 toAdapterConfig 都没被任何用例碰到过，
 * 而它们恰好是「配置文件 + 用户存的 key → 能跑的适配器」这条路上唯一的两个函数。
 */
import { OpenAiAdapter } from '@ryharness/llm-openai'
import type { ProvidersConfigFile } from '@ryharness/server'
import { describe, expect, it } from 'vitest'
import { mergeApiKeys, toAdapterConfig } from '../src/config.ts'

/** 内置条目的形状：只有 apiKeyEnv，明文 key 不落 providers.json。 */
function builtinStyle(): ProvidersConfigFile {
  return {
    providers: {
      siliconflow: {
        baseURL: 'https://api.siliconflow.cn/v1',
        apiKeyEnv: 'SILICONFLOW_API_KEY',
        displayName: 'SiliconFlow',
        models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
      },
    },
  }
}

describe('凭据合并：保存 key 之后仍要能起得来', () => {
  it('归一后的路由恰好带一个凭据来源（两条并存=适配器构造直接抛）', () => {
    const merged = mergeApiKeys(builtinStyle(), { siliconflow: 'sk-user-pasted' })
    // 合并本身只管内存，不碰 apiKeyEnv——落盘的 providers.json 要保留那个引用
    // （明文 key 不落盘，逃生口靠它）。收敛发生在适配器配置那一步。
    const provider = toAdapterConfig(merged, () => undefined).providers.siliconflow
    if (provider === undefined) throw new Error('siliconflow 这条路由不见了')
    expect((provider.apiKey === undefined) !== (provider.apiKeyEnv === undefined)).toBe(true)
    expect(provider.apiKey).toBe('sk-user-pasted')
  })

  it('落盘形状不受影响：合并不摘 apiKeyEnv（它是明文不落盘后的逃生口）', () => {
    const merged = mergeApiKeys(builtinStyle(), { siliconflow: 'sk-user-pasted' })
    expect(merged.providers.siliconflow?.apiKeyEnv).toBe('SILICONFLOW_API_KEY')
  })

  it('走完整条路：配置文件 + 用户存的 key → 适配器构造不抛', () => {
    const config = mergeApiKeys(builtinStyle(), { siliconflow: 'sk-user-pasted' })
    // 用户没设那个环境变量，所以这条路由最终靠 apiKey 起。
    const adapterConfig = toAdapterConfig(config, () => undefined)
    expect(() => {
      return new OpenAiAdapter(adapterConfig)
    }).not.toThrow()
  })

  it('开发逃生口仍然成立：环境变量真的设了时，它优先于设置里存的 key', () => {
    const env = (name: string): string | undefined => {
      return name === 'SILICONFLOW_API_KEY' ? 'sk-from-env' : undefined
    }
    const config = mergeApiKeys(builtinStyle(), { siliconflow: 'sk-user-pasted' })
    const adapterConfig = toAdapterConfig(config, env)
    expect(() => {
      return new OpenAiAdapter(adapterConfig)
    }).not.toThrow()
    // 环境变量优先：请求用的应当是它，不是设置里存的那一份。
    expect(adapterConfig.providers.siliconflow?.apiKeyEnv).toBe('SILICONFLOW_API_KEY')
    expect(adapterConfig.providers.siliconflow?.apiKey).toBeUndefined()
  })

  it('自带明文 key 的条目不会被设置里的 key 覆盖', () => {
    const config = mergeApiKeys(
      {
        providers: {
          custom: {
            baseURL: 'http://127.0.0.1:9000/v1',
            apiKey: 'sk-in-file',
            displayName: '私有服务',
            models: [{ id: 'm' }],
          },
        },
      },
      { custom: 'sk-from-settings' },
    )
    expect(config.providers.custom?.apiKey).toBe('sk-in-file')
  })

  it('没有明文 key 的自定义条目也能起得来（补成恰好一个凭据来源）', () => {
    const config = mergeApiKeys(
      {
        providers: {
          added: {
            baseURL: 'https://api.deepseek.com',
            displayName: 'DeepSeek',
            models: [{ id: 'deepseek-flash' }],
          },
        },
      },
      { added: 'sk-deepseek' },
    )
    const adapterConfig = toAdapterConfig(config, () => undefined)
    expect(() => {
      return new OpenAiAdapter(adapterConfig)
    }).not.toThrow()
    expect(adapterConfig.providers.added?.apiKey).toBe('sk-deepseek')
  })
})
