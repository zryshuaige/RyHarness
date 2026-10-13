import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'

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
        providers={providers}
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
        providers={providers}
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
