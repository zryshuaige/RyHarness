/**
 * 内置模型目录的「事实核验」：写进 providers.json 的每个模型 id 都必须真实存在、
 * 当前未下线，而且模板的默认模型得在这份目录里。
 *
 * 为什么值得单独钉一条：模型 id 写错不会在编译期或启动期暴露——配置文件照写不误，
 * 界面照常显示，只在用户真的发一次请求时才由供应商 400 告诉他。内置目录停在 2024
 * 年的三个模型、而用户眼前的模型广场早已是另一串名字，就是这么来的。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDERS,
  loadProvidersConfig,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  PROVIDER_PRESETS,
} from '../src/config.ts'
import { AGENT_TEMPLATES } from '../src/seed.ts'

/**
 * SiliconFlow 官方更新公告里已下线 / 已被迁移走的模型 id（截至 2026-10）。
 *
 * 这份名单随平台滚动变长。写进测试是为了让「把一个已下线的 id 加回内置目录」当场
 * 变红：这种条目在界面上和活的模型长得一模一样，只有用户点了才知道它已经没了。
 * 来源：docs.siliconflow.com/cn/release-notes/overview 的历次「模型下线通知 / 模型迁移通知」。
 */
const RETIRED_MODEL_IDS = [
  'deepseek-ai/deepseek-vl2',
  'deepseek-ai/DeepSeek-V3.1-Nex-N1',
  'zai-org/GLM-4.5',
  'zai-org/GLM-4.5V',
  'zai-org/GLM-4.6',
  'zai-org/GLM-4.6V',
  'zai-org/GLM-4.7',
  // GLM-5 已自动迁移到 GLM-5.1，同理继续迁到 5.1 才是活路。
  'zai-org/GLM-5',
  'moonshotai/Kimi-K2-Thinking',
  'moonshotai/Kimi-K2-Instruct',
  // Kimi-K2.5 已自动迁移到 Kimi-K2.6。
  'moonshotai/Kimi-K2.5',
  'MiniMaxAI/MiniMax-M2',
  'MiniMaxAI/MiniMax-M2.1',
  'Qwen/Qwen2.5-14B-Instruct',
  'Qwen/Qwen2.5-32B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct-128K',
  'Qwen/Qwen3-30B-A3B',
  'Qwen/Qwen3-30B-A3B-Thinking-2507',
  'Qwen/Qwen3-235B-A22B',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'Qwen/Qwen3-Next-80B-A3B-Instruct',
  'Qwen/Qwen3-Next-80B-A3B-Thinking',
]

const siliconflow = DEFAULT_PROVIDERS.siliconflow
const siliconflowPreset = PROVIDER_PRESETS.find((preset) => {
  return preset.id === 'siliconflow'
})

describe('SiliconFlow 内置模型目录', () => {
  it('推荐列表覆盖主流系列与不同定位，而不是三五条老模型', () => {
    const ids = siliconflow?.models.map((model) => {
      return model.id
    })
    expect(ids?.length ?? 0).toBeGreaterThanOrEqual(12)
    for (const family of ['deepseek-ai/', 'Qwen/', 'zai-org/', 'moonshotai/', 'MiniMaxAI/']) {
      expect(
        ids?.some((id) => {
          return id.startsWith(family)
        }),
        family,
      ).toBe(true)
    }
    // 代码向至少留一条：目录里没有它，用户只能自己去模型广场翻 Coder。
    expect(
      ids?.some((id) => {
        return id.includes('Coder')
      }),
    ).toBe(true)
  })

  it('每条都带合法的上下文长度：内核按它算输入预算，写错等于让用户白攒历史', () => {
    for (const model of siliconflow?.models ?? []) {
      expect(model.contextWindow, model.id).toBeTypeOf('number')
      expect(model.contextWindow ?? 0, model.id).toBeGreaterThanOrEqual(MIN_CONTEXT_WINDOW_TOKENS)
      expect(model.contextWindow ?? 0, model.id).toBeLessThanOrEqual(MAX_CONTEXT_WINDOW_TOKENS)
    }
  })

  it('没有已下线或已被迁移走的 id（用户点了才发现，就晚了）', () => {
    for (const model of siliconflow?.models ?? []) {
      expect(RETIRED_MODEL_IDS, model.id).not.toContain(model.id)
    }
  })

  it('预设推荐列表与内置路由写的是同一份事实', () => {
    expect(siliconflowPreset?.models).toEqual(
      siliconflow?.models.map((model) => {
        return model.id
      }),
    )
  })
})

describe('模板默认模型', () => {
  it('每个模板的默认模型都在内置目录里（新建助理就落在别处的模型上 = 一条死路）', () => {
    const ids = siliconflow?.models.map((model) => {
      return model.id
    })
    for (const template of Object.values(AGENT_TEMPLATES)) {
      expect(ids, template.key).toContain(template.defaultModel)
    }
  })

  it('默认模型是当前这一代的 Flash（不是 Pro，也不是上一代）', () => {
    // 为什么是 Flash 而不是 Pro：两者同代同窗口，Flash 更快更便宜，而它是用户
    // 打开应用后每一句话都在付的钱的那一档。旗舰留在目录里，想用的人自己挑。
    for (const template of Object.values(AGENT_TEMPLATES)) {
      expect(template.defaultModel, template.key).toBe('deepseek-ai/DeepSeek-V4-Flash')
    }
  })

  it('默认模型同时是目录里的第一项（记忆/进化副驾取的就是第一个模型）', () => {
    // resolveSidecarLlm 取「第一个已配凭据供应商的第一个模型」，目录顺序直接决定
    // 副驾跑在哪个模型上。默认档与目录首位分家时，两者会各自漂向不同的答案。
    expect(siliconflow?.models[0]?.id).toBe('deepseek-ai/DeepSeek-V4-Flash')
  })
})

/**
 * 内置目录的升级刷新。
 *
 * 老安装的 providers.json 里 SiliconFlow 只挂着早期那三五个模型。目录不刷的
 * 直接后果不是「列表旧了」，而是「改助理用的模型」这件事在界面上是坏的：
 * 存量 agent 引用的模型名不在目录里 → 保存被校验挡下 → 而用户在下拉框里根本
 * 找不到自己一直在用的那个。这条刷新就是为了让升级后的老用户也能改模型。
 */
describe('内置模型目录随升级刷新', () => {
  function writeConfig(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-catalog-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    const path = join(dir, 'config', 'providers.json')
    writeFileSync(path, JSON.stringify(content))
    return path
  }

  const shippedIds = DEFAULT_PROVIDERS.siliconflow?.models.map((model) => {
    return model.id
  })

  it('老安装的旧目录会被刷成随包发出的那份（否则改模型功能是坏的）', () => {
    const path = writeConfig({
      providers: {
        siliconflow: {
          baseURL: 'https://api.siliconflow.cn/v1',
          displayName: 'SiliconFlow',
          models: [{ id: 'deepseek-ai/DeepSeek-V3' }, { id: 'Qwen/Qwen2.5-72B-Instruct' }],
        },
      },
    })
    const loaded = loadProvidersConfig(path)
    expect(
      loaded.providers.siliconflow?.models.map((model) => {
        return model.id
      }),
    ).toEqual(shippedIds)
  })

  it('刷新也落到磁盘上（用户打开 providers.json 看到的与界面里一致）', () => {
    const path = writeConfig({
      providers: {
        siliconflow: { baseURL: 'https://api.siliconflow.cn/v1', displayName: 'SiliconFlow', models: [] },
      },
    })
    loadProvidersConfig(path)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      providers: { siliconflow: { models: { id: string }[] } }
    }
    expect(
      onDisk.providers.siliconflow.models.map((model) => {
        return model.id
      }),
    ).toEqual(shippedIds)
  })

  it('凭据与地址原样保留——刷的是我们发的默认值，不是用户填的', () => {
    const path = writeConfig({
      providers: {
        siliconflow: {
          baseURL: 'https://api.siliconflow.cn/v1',
          apiKeyEnv: 'MY_KEY',
          displayName: '我自己起的名',
          models: [{ id: 'stale-model' }],
        },
      },
    })
    const loaded = loadProvidersConfig(path)
    expect(loaded.providers.siliconflow?.apiKeyEnv).toBe('MY_KEY')
    expect(loaded.providers.siliconflow?.baseURL).toBe('https://api.siliconflow.cn/v1')
    expect(loaded.providers.siliconflow?.displayName).toBe('我自己起的名')
  })

  it('自定义路由的目录一律不动：那份列表是用户自己勾的', () => {
    const mine = [{ id: 'my-own-model' }]
    const path = writeConfig({
      providers: {
        mine: { baseURL: 'http://localhost:1234/v1', displayName: '我的网关', models: mine, custom: true },
      },
    })
    expect(loadProvidersConfig(path).providers.mine?.models).toEqual(mine)
  })

  it('已经是最新目录时不再重写磁盘（启动路径上不多一次 IO）', () => {
    const path = writeConfig({
      providers: {
        siliconflow: { baseURL: 'https://api.siliconflow.cn/v1', displayName: 'SiliconFlow', models: shippedIds },
      },
    })
    loadProvidersConfig(path)
    const first = readFileSync(path, 'utf8')
    loadProvidersConfig(path)
    expect(readFileSync(path, 'utf8')).toBe(first)
  })
})
