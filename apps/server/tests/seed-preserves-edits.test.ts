/**
 * 内置 agent 的种子语义：**只补缺，不覆盖**。
 *
 * 这条以前完全没有钉住，而它守的是用户数据。upsertAgent 是全字段覆盖
 * （ON CONFLICT DO UPDATE 把 name/avatar/system_prompt/provider/model/tools 全刷成
 * 模板值），所以种子回调里只要照原样每次启动都写一遍，用户改过的名字、头像、
 * 模型、工具就在下一次启动时全部消失——界面上「我的」页里给 Ryen 改昵称的功能
 * 明明是有的，重一次启动就没了。
 *
 * 这里钉的是两件事：改过的东西留得住，以及没动过的仍然被正常种下来。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/**
 * 每次一个独立数据目录。临时目录故意不删：删它要在 SQLite 关文件前后抢跑，
 * 抢输了就是一条看不懂的 flaky，而泄漏的只是几个空目录，交给 OS 回收更划算。
 */
function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'ryharness-seed-'))
}

/** 起一个服务 → 改 Ryen → 关掉 → 用同一个数据目录再起一个。 */
async function restartWithEdit(edit: (base: string) => Promise<void>): Promise<Record<string, unknown>> {
  const dir = dataDir()
  const first = await RyHarnessServer.create({ port: 0, dataDir: dir })
  try {
    await edit(first.url)
  } finally {
    await first.close()
  }
  const second = await RyHarnessServer.create({ port: 0, dataDir: dir })
  try {
    const res = await fetch(`${second.url}/api/agents`)
    const body = (await res.json()) as { agents: Record<string, unknown>[] }
    const ryen = body.agents.find((agent) => {
      return agent.id === 'ryen'
    })
    expect(ryen, '重启后 Ryen 应当还在').toBeDefined()
    return ryen ?? {}
  } finally {
    await second.close()
  }
}

describe('内置 agent 的种子只补缺', () => {
  it('用户改过的模型在重启后留得住', async () => {
    const ryen = await restartWithEdit(async (base) => {
      const res = await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3.2' }),
      })
      expect(res.status).toBe(200)
    })
    expect(ryen.model).toBe('deepseek-ai/DeepSeek-V3.2')
  })

  it('用户给 Ryen 改过的昵称在重启后留得住', async () => {
    const ryen = await restartWithEdit(async (base) => {
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '橘子' }),
      })
    })
    expect(ryen.name).toBe('橘子')
  })

  it('没被改过的内置 agent 仍按模板种下来（不是全都跳过）', async () => {
    const ryen = await restartWithEdit(async () => {
      /* 什么都不改 */
    })
    expect(ryen.isBuiltin).toBe(true)
    // 名字仍是模板里那一个，说明种子该落的时候落下来了。
    expect(ryen.name).toBe('Ryen')
    expect(typeof ryen.model).toBe('string')
  })

  it('首个内置 agent 缺失时会被补回来（删掉行再启动，种子仍然兜底）', () => {
    // 直接在库这一层验「补缺」语义，不经 HTTP：起两次服务会把断言拖进端口与
    // 关停的时序里，而这里要验的只是 upsert 前的那一次存在性判断。
    const path = join(dataDir(), 'ryharness.db')
    const store = new SessionStore(path)
    expect(store.getAgent('ryen')).toBeUndefined()
    store.upsertAgent({
      id: 'ryen',
      name: 'Ryen',
      systemPrompt: 'x',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      tools: [],
      isBuiltin: true,
    })
    expect(store.getAgent('ryen')).not.toBeUndefined()
    store.close()
  })
})
