import { describe, expect, it } from 'vitest'
// 直接引源码模块：包入口（src/index.ts）只转发了模板目录与实例化函数，
// 小队名单目前不经它对外暴露。
import { AGENT_TEMPLATES, ensureSeedAgents, instantiateTemplate, STARTER_TEAMMATES } from '../src/seed.ts'

interface SeedInput {
  id: string
  name: string
  avatar?: string
  systemPrompt: string
  provider: string
  model: string
  tools: string[]
  isBuiltin: boolean
}

function collect(): SeedInput[] {
  const rows: SeedInput[] = []
  ensureSeedAgents((input) => {
    rows.push(input)
  })
  return rows
}

describe('首启种子', () => {
  it('Ryen 之外还种下两位模板 agent，通讯录一开就是一个小队', () => {
    const rows = collect()
    expect(
      rows.map((row) => {
        return row.id
      }),
    ).toEqual(['ryen', 'ryen-team-coding', 'ryen-team-organizer'])
    for (const row of rows) {
      expect(row.isBuiltin).toBe(true)
      expect(row.systemPrompt.length).toBeGreaterThan(0)
      expect(row.provider).toBe('siliconflow')
    }
  })

  it('小队成员直接取模板的人设与工具，不另写一套', () => {
    const rows = collect()
    for (const teammate of STARTER_TEAMMATES) {
      const template = AGENT_TEMPLATES[teammate.templateKey]
      const row = rows.find((candidate) => {
        return candidate.id === teammate.id
      })
      expect(row).toBeDefined()
      expect(row?.name).toBe(template?.name)
      expect(row?.systemPrompt).toBe(template?.suggestedSystemPrompt)
      expect(row?.tools).toEqual([...(template?.defaultTools ?? [])])
      expect(row?.model).toBe(template?.defaultModel)
    }
  })

  it('重复启动只会覆盖同三条记录（id 固定，不会每次长出新 agent）', () => {
    expect(
      collect().map((row) => {
        return row.id
      }),
    ).toEqual(
      collect().map((row) => {
        return row.id
      }),
    )
    const ids = STARTER_TEAMMATES.map((teammate) => {
      return teammate.id
    })
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('ryen')
  })

  it('instantiateTemplate 仍然发得出可用的 agent（小队成员也是能进群聊的）', () => {
    const coding = AGENT_TEMPLATES.coding
    const forked = instantiateTemplate('coding', { name: '阿码二代' })
    expect(forked.isBuiltin).toBe(false)
    expect(forked.provider).toBe('siliconflow')
    expect(forked.model).toBe(coding?.defaultModel)
    expect(forked.tools).toEqual([...(coding?.defaultTools ?? [])])
  })
})
