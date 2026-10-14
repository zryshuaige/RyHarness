import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { BRAND_AVATAR } from '../renderer/src/components/avatars/avatars.tsx'
import { AvatarPicker, ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'

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

  it('内置 agent 不显示编辑/删除，用户自建的显示', () => {
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
    // Ryen 内置卡片上没有这两个按钮：整个页面只应出现一次"编辑"（小译那张卡）。
    expect(html.match(/>编辑</g)?.length).toBe(1)
  })
})

/**
 * 品牌可达性：橘猫此前只活在数据里（agent.avatar === 'cat'），选择器里没有对应格子，
 * 用户无法把任何 agent 设成品牌橘猫。
 */
describe('头像选择器', () => {
  it('首位是品牌橘猫单选格，且用的就是 Cat 母版而非首字母色块', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="db:dylan:seed1" onChange={() => {}} />)
    const radios = html.match(/role="radio"/g) ?? []
    // 橘猫 + 2 个 DiceBear 风格
    expect(radios.length).toBe(3)
    // 橘猫格排在所有 DiceBear 格之前
    expect(html.indexOf('title="橘猫（RyAgent 品牌）"')).toBeLessThan(html.indexOf('title="人物（CC BY 4.0）"'))
    // 橘猫格渲染成真正的猫（.avatar-cat + svg.cat），不是首字母色块
    const catCell = html.slice(html.indexOf('title="橘猫（RyAgent 品牌）"'), html.indexOf('title="人物（CC BY 4.0）"'))
    expect(catCell).toContain('avatar-cat')
    expect(catCell).toContain('<svg class="cat"')
    expect(catCell).not.toContain('avatar-fallback')
    expect(catCell).toContain('>橘猫<')
  })

  it('value === cat 时预览仍是橘猫，标签念「橘猫」而不是已停用的风格名', () => {
    const html = renderToStaticMarkup(<AvatarPicker value={BRAND_AVATAR} onChange={() => {}} />)
    expect(html).toContain('当前：橘猫')
    expect(html).not.toContain('lorelei')
    // 预览 64px 与格子 40px 两处都得是猫：曾经预览会退化成首字母色块
    expect(html.match(/avatar-cat/g)?.length).toBe(2)
    expect(html).not.toContain('avatar-fallback')
    expect(html).not.toContain('lorelei')
    // 选中的是橘猫，不是任何 DiceBear 风格
    expect(html).toMatch(/aria-checked="true"[^>]*title="橘猫（RyAgent 品牌）"/)
  })

  it('不认识的值（含已停用风格）落到首个在册风格，界面不报不存在的风格名', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="db:lorelei:s1" onChange={() => {}} />)
    expect(html).toContain('当前：人物')
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
})
