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
    // 小队成员只取立绘素材已经画出来的模板（coding=dog / writing=fox），首屏三人
    // 才有真头像；管家与翻译的素材还没出，模板给的是剪影占位，见 seed.ts 的说明。
    expect(
      rows.map((row) => {
        return row.id
      }),
    ).toEqual(['ryen', 'ryen-team-coding', 'ryen-team-writing'])
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
    const forked = instantiateTemplate('coding', { name: '工程师二代' })
    expect(forked.isBuiltin).toBe(false)
    expect(forked.provider).toBe('siliconflow')
    expect(forked.model).toBe(coding?.defaultModel)
    expect(forked.tools).toEqual([...(coding?.defaultTools ?? [])])
  })

  it('模板名就是职能名：不点开系统提示也看得出它是干什么的', () => {
    // 「阿码」这类拟声拟形的双字昵称在通讯录和会话列表里读不出职能，名字因此直接用
    // 职能名（对标「产品经理」「算法设计师」），动物气质交给 description 与人格。
    expect(
      ['general', 'coding', 'writing', 'translation', 'file-organizer'].map((key) => {
        return AGENT_TEMPLATES[key]?.name
      }),
    ).toEqual(['Ryen', '工程师', '文案', '翻译', '管家'])
    for (const template of Object.values(AGENT_TEMPLATES)) {
      // description 是模板卡与通讯录里唯一的一行摘要，格式固定为「名字：定位与人设」，
      // 且不能只是重复名字——那等于什么都没说。
      const prefix = `${template.name}：`
      expect(template.description.startsWith(prefix)).toBe(true)
      expect(template.description.length).toBeGreaterThan(prefix.length + 4)
      // 系统提示里的自称跟着名字走，否则这位助理会顶着别人的名字说话。
      expect(template.suggestedSystemPrompt).toContain(template.name)
    }
    // Ryen 是品牌名不是职能名，展示层由 description 把「总管」补出来。
    expect(AGENT_TEMPLATES.general?.description).toContain('总管')
  })

  it('头像与人格里的动物对得上号，不再拿彩色笑脸冒充动物', () => {
    // 回归点：模板曾写「猫头鹰/狐狸/水獭/松鼠」，头像却给 DiceBear funEmoji 族的
    // db:mascot:owl|otter|squirrel。那一族的 seed 只是随机哈希，画的是彩色表情脸，
    // 于是「工程师」顶着紫色笑脸自称猫头鹰——人设与长相两处各说各话。
    for (const template of Object.values(AGENT_TEMPLATES)) {
      // 只认真立绘键（cat/dog/fox/mask）。db:{family}:{seed} 那套是用户自己换头像时
      // 攒下的历史值，模板不该再产出——库里已有的照旧由 Avatar 正常画出来。
      expect(template.avatar).toMatch(/^(cat|dog|fox|mask)$/)
    }
    // 有素材的助理用真素材，人格里的动物也跟着素材改口。
    expect(AGENT_TEMPLATES.coding?.avatar).toBe('dog')
    expect(AGENT_TEMPLATES.coding?.persona.appearance).toContain('柴犬')
    expect(AGENT_TEMPLATES.coding?.description).toContain('柴犬')
    expect(AGENT_TEMPLATES.writing?.avatar).toBe('fox')
    expect(AGENT_TEMPLATES.writing?.persona.appearance).toContain('灰狐')
    // 素材还没画出来的助理诚实占位，而不是配一张不相干的脸。
    expect(AGENT_TEMPLATES.translation?.avatar).toBe('mask')
    expect(AGENT_TEMPLATES['file-organizer']?.avatar).toBe('mask')
  })
})
