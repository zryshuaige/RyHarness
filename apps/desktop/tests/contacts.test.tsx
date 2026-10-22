import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { BRAND_AVATAR } from '../renderer/src/components/avatars/avatars.tsx'
import { AvatarPicker, ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')

/** 去注释后的样式源码：注释里提到的选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 某条顶层规则的声明块（选择器逐字比对，含 :has() 这类带参数的）。 */
const ruleBody = (css: string, selector: string): string => {
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      prelude.split(',').some((part) => {
        return part.trim() === selector
      })
    ) {
      return body
    }
  }
  return ''
}

/** 某个 @media 块内部的整段文本。 */
const blockAfter = (css: string, marker: string): string => {
  const start = css.indexOf(marker)
  if (start < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
  }
  return ''
}

const templates: AgentTemplate[] = [
  {
    key: 'general',
    name: '通用助理',
    description: '什么都能聊',
    suggestedSystemPrompt: '你是通用助理。',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultTools: ['fs_read'],
  },
  {
    key: 'translator',
    name: '翻译官',
    description: '中英互译',
    suggestedSystemPrompt: '你是翻译官。',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultTools: [],
  },
]

const providers: ProviderInfo[] = [
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    apiKeyConfigured: true,
    models: [{ id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3' }],
  },
]

const agents: AgentDef[] = [
  {
    id: 'ryen',
    name: 'Ryen',
    avatar: 'cat',
    systemPrompt: '你是 Ryen。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: [],
    isBuiltin: true,
  },
  {
    id: 'mine',
    name: '小译',
    avatar: 'db:dylan:seed1',
    systemPrompt: '你是翻译官，专精中英互译。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: ['fs_read'],
    isBuiltin: false,
  },
]

describe('通讯录', () => {
  it('模板轨把 templateKey 传给新建回调（此前点"翻译"也开通用助理表单）', () => {
    const onCreateAgent = vi.fn()
    const html = renderToStaticMarkup(
      <ContactsPage
        agents={agents}
        templates={templates}
        onChat={() => {}}
        onCreateAgent={onCreateAgent}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(html).toContain('翻译官')
    // 模板卡存在且可点（onClick 在渲染期不可断言，这里只保证模板都渲染出来了）。
    expect(html).toContain('可用模板（2）')
  })

  it('内置 agent 可以编辑但不能删除；用户自建的编辑与删除都有', () => {
    const html = renderToStaticMarkup(
      <ContactsPage
        agents={agents}
        templates={templates}
        onChat={() => {}}
        onCreateAgent={() => {}}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(html).toContain('编辑')
    expect(html).toContain('删除')
    // 每张卡一个「编辑」——包括内置的 Ryen。它是用户每天在用的一位助理，
    // 把她钉死在出厂模型上等于逼用户绕开产品去换模型（删除另有 409 兜着）。
    expect(html.match(/>编辑</g)?.length).toBe(agents.length)
    // 「删除」只出现在用户自建的那一张上：内置的删了会在下次启动被种子重新种回来。
    expect(html.match(/>删除</g)?.length).toBe(1)
  })
})

/**
 * 品牌可达性：橘猫此前只活在数据里（agent.avatar === 'cat'），选择器里没有对应格子，
 * 用户无法把任何 agent 设成品牌橘猫。
 *
 * 这一屏还多两条约束（第二轮打回）：脸只留动物立绘 + 吉祥物一族，人像插画族不再与
 * 它们并排；「当前：xx」那一行预览去掉了（结果那张脸由右栏身份卡担任），选中态由
 * 格子自己承担——所以下面断言的是**新的正确行为**，不是把旧断言删掉。
 */
describe('头像选择器', () => {
  it('首位是品牌橘猫单选格，且用的就是 Cat 母版而非首字母色块', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
    const radios = html.match(/role="radio"/g) ?? []
    // 品牌橘猫 + 3 张立绘（柴犬/灰狐/剪影）+ 吉祥物一族
    expect(radios.length).toBe(5)
    // 橘猫格排在立绘格之前，立绘格排在 DiceBear 格之前
    expect(html.indexOf('title="橘猫（RyHarness 品牌）"')).toBeLessThan(html.indexOf('title="计划型：清单'))
    expect(html.indexOf('title="计划型：清单')).toBeLessThan(html.indexOf('title="吉祥物：随机生成的彩色表情脸'))
    // 橘猫格渲染成真正的猫（.avatar-cat + 位图徽标），不是首字母色块
    const catCell = html.slice(html.indexOf('title="橘猫（RyHarness 品牌）"'), html.indexOf('title="计划型：清单'))
    expect(catCell).toContain('avatar-cat')
    expect(catCell).toContain('<img class="cat cat-circle"')
    expect(catCell).not.toContain('avatar-fallback')
    expect(catCell).toContain('>橘猫<')
  })

  it('人像插画族不再与立绘/吉祥物同排（同屏三套画风 = 混排）', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
    // 「人物」这一格不存在了
    expect(html).not.toContain('title="人物')
    expect(html).not.toContain('>人物<')
    // 吉祥物还在：它与彩色表情脸/动物立绘是同一套画风语言
    expect(html).toContain('吉祥物：随机生成的彩色表情脸')
  })

  /**
   * 键盘可达性：ARIA 的 radiogroup 规范要求方向键在组内移动选择。
   *
   * 此前这排格子只有 role="radio"，没有 roving tabindex——键盘用户只能一路 Tab
   * 过去（按六次 Tab 才换得到一张脸），←→↑↓ 完全无效。ARIA APG 的做法是
   * roving tabindex：组内恰好一枚 tabIndex=0，其余为 -1，方向键移动焦点即选中。
   */
  describe('键盘可达性', () => {
    it('组内恰好一枚 tabIndex=0（roving tabindex），其余是 -1', () => {
      const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
      const tabbable = html.match(/tabindex="0"/g) ?? []
      const untabbable = html.match(/tabindex="-1"/g) ?? []
      expect(tabbable.length, '可 Tab 到达的 radio 只能有一枚').toBe(1)
      expect(untabbable.length, '其余 radio 都要 tabindex=-1').toBe(4)
    })

    it('可 Tab 到达的那一枚就是当前选中的那张', () => {
      const html = renderToStaticMarkup(<AvatarPicker value="fox" onChange={() => {}} />)
      // 灰狐这一格同时带 aria-checked="true" 与 tabindex="0"
      expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"/)
      // 选中的那一格只有一个
      expect(html.match(/aria-checked="true"/g)?.length).toBe(1)
    })

    it('每一格都有人设说明（aria-describedby），不再只靠 title', () => {
      const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
      // 每枚 radio 都指向一个存在的说明元素
      const described = html.match(/aria-describedby="(face-hint-[^"]+)"/g) ?? []
      expect(described.length).toBe(5)
      for (const [, id] of html.matchAll(/aria-describedby="(face-hint-[^"]+)"/g)) {
        expect(html, `说明元素 ${id} 必须存在`).toContain(`id="${id as string}"`)
      }
    })

    it('占位立绘（剪影）带降权标记，不与正式立绘同权重', () => {
      const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
      expect(html).toContain('is-placeholder')
      // 降权标记只落在占位那一格上
      expect(html.match(/is-placeholder/g)?.length).toBe(1)
    })
  })

  it('value === cat 时选中的是橘猫，且没有第二处同款预览（首屏不该出现三张一样的脸）', () => {
    const html = renderToStaticMarkup(<AvatarPicker value={BRAND_AVATAR} onChange={() => {}} />)
    // 预览行去掉了：猫只出现在橘猫这一格上（此前是「预览 + 格子」两处）
    expect(html.match(/avatar-cat/g)?.length).toBe(1)
    expect(html).not.toContain('avatar-fallback')
    expect(html).not.toContain('当前：')
    // 选中的是橘猫，不是任何 DiceBear 族
    expect(html).toMatch(/aria-checked="true"[^>]*title="橘猫（RyHarness 品牌）"/)
  })

  /**
   * 移出的是「这一屏的选择」，不是渲染：库里已有的 db:dylan:* 旧值照常画得出来，
   * 且要有一句说明为什么一格都没选中——静默空着会被读成「这张脸丢了」。
   */
  it('旧的人像插画族头像照常显示，并有「不在候选里」的说明而不是静默空着', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="db:dylan:seed1" onChange={() => {}} />)
    expect(html).toContain('「人物」插画族的旧头像')
    // 一格都没选中：如实地不勾，比勾错一格强
    expect(html.match(/aria-checked="true"/g)).toBeNull()
  })

  it('不认识的值（含已停用风格）同样说清「不在候选里」，界面不报不存在的风格名', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="db:lorelei:s1" onChange={() => {}} />)
    expect(html).toContain('早于在册风格的旧值')
    expect(html).not.toContain('lorelei')
  })
})

describe('Agent 表单弹窗', () => {
  it('内容区可滚动、操作条吸底（小屏上"保存"按钮够不到）', () => {
    const html = renderToStaticMarkup(
      <CreateAgentModal
        templates={templates}
        providers={providers}
        onSubmit={() => Promise.resolve()}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('modal-scroll')
    expect(html).toContain('modal-actions-sticky')
  })

  it('编辑模式不显示模板选择，标题带 agent 名字', () => {
    const html = renderToStaticMarkup(
      <CreateAgentModal
        templates={templates}
        providers={providers}
        editing={agents[1] as AgentDef}
        onSubmit={() => Promise.resolve()}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('编辑 小译')
    expect(html).not.toContain('从模板开始')
    expect(html).toContain('保存修改')
  })

  it('初始模板决定初始人设（模板轨传参的落点）', () => {
    const html = renderToStaticMarkup(
      <CreateAgentModal
        templates={templates}
        providers={providers}
        initialTemplateKey="translator"
        onSubmit={() => Promise.resolve()}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('你是翻译官。')
  })

  /**
   * 折叠态的结构不变量：供应商 / 模型 / 工具白名单不进首屏，但当前值摘要必须在上。
   *
   * 折叠的意义是「别一上来就是一排原生控件」，不是「把选择藏起来」——藏起来的代价是
   * 用户不知道自己建出来的助理归谁跑、能碰到什么。
   */
  it('高级设置默认折叠，但折叠态能看到当前值摘要', () => {
    const html = renderToStaticMarkup(
      <CreateAgentModal
        templates={templates}
        providers={providers}
        onSubmit={() => Promise.resolve()}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('高级设置')
    expect(html).toContain('SiliconFlow · DeepSeek-V3 · 1 个工具')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('工具白名单')
    expect(html).not.toContain('>供应商<')
    // 身份卡常驻：它是这个流程的结果预览，不随任何折叠区进出。
    expect(html).toContain('agent-card')
    expect(html).toContain('助理卡')
  })

  /**
   * 「换一批」挂在身份分区的标题行上。
   *
   * 它原先和一块 52px 的头像预览各占一行，而右栏身份卡已经把同一张脸放到最大的一处，
   * 于是同一张脸在首屏出现三次，并且把「性格」这个第一卖点挤到了折叠线以下。
   */
  it('「换一批」在身份分区的标题行里（预览行整体退场）', () => {
    const html = renderToStaticMarkup(
      <CreateAgentModal
        templates={templates}
        providers={providers}
        onSubmit={() => Promise.resolve()}
        onClose={() => {}}
      />,
    )
    const identity = html.indexOf('它是谁')
    const head = html.slice(identity, html.indexOf('face-grid'))
    expect(head).toContain('换一批')
    expect(head).toContain('studio-section-action')
    // 预览行整体退场：一次都不再出现
    expect(html).not.toContain('face-picker-head')
    expect(html).not.toContain('当前：')
  })

  /**
   * 布局的回归护栏：性格区必须在首屏，而「首屏有多大」是两条 CSS 决定的。
   *
   * 通用弹窗的内容区上限是 min(66vh, 620px)——够一个删除确认，不够一个建人工作台；
   * 工作台用 .modal:has(.studio) 单独抬到 78vh。两侧都要钉：只钉工作台会让人顺手把
   * .modal 的上限也改了，别的弹窗跟着一起被撑变形。
   */
  it('工作台弹窗把内容区上限抬到 78vh，通用弹窗的 66vh 不动', () => {
    const sheet = (name: string): string => {
      return strip(readFileSync(resolve(SRC, name), 'utf8'))
    }
    const vh = (css: string, selector: string): number => {
      // 上限写法有两种：通用的 `.modal { max-height: 86vh }` 与工作台的
      // `max-height: min(92vh, 820px)`，两种都要认。
      return Number(/max-height:\s*(?:min\()?(\d+)vh/.exec(ruleBody(css, selector))?.[1] ?? 0)
    }
    const studioScroll = vh(sheet('styles-product.css'), '.modal:has(.studio) .modal-scroll')
    expect(vh(sheet('styles.css'), '.modal'), '.modal 的通用上限').toBe(86)
    expect(vh(sheet('styles-product.css'), '.modal-scroll'), '.modal-scroll 的通用上限').toBe(66)
    expect(vh(sheet('styles-product.css'), '.modal:has(.studio)'), '工作台弹窗自身上限').toBeGreaterThanOrEqual(90)
    expect(studioScroll, '工作台内容区上限').toBeGreaterThan(66)
    // 窄窗必须降级：单列内容更长，给满高度会把遮罩的呼吸压没。
    const narrow = blockAfter(sheet('styles-product.css'), '@media (max-width: 1024px)')
    expect(vh(narrow, '.modal:has(.studio) .modal-scroll'), '窄窗档').toBeLessThan(studioScroll)
  })
})
