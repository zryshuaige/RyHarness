/**
 * `skill` 工具的用例。
 *
 * 这一族的核心是**模型看到目录、点名才取正文**，所以这里盯的是：说明里有没有
 * 目录、目录里有没有混进正文、以及取不到的时候给模型的答复对不对。
 */
import { describe, expect, it } from 'vitest'
import {
  createSkillTool,
  renderSkillCatalog,
  renderSkillContent,
  SKILL_TOOL_NAME,
  SkillRegistry,
} from '../src/index.ts'

/** 一个只带必要字段的工具上下文。 */
const ctx = { workspaceRoot: '/ws' }

/** 造一个装着几条技能的注册表。 */
function registryWith(skills: { name: string; description: string; content: string }[]): SkillRegistry {
  const registry = new SkillRegistry()
  for (const item of skills) {
    registry.register({
      name: item.name,
      title: item.name,
      description: item.description,
      content: item.content,
      source: 'runtime',
    })
  }
  return registry
}

describe('skill 工具', () => {
  it('工具名就叫 skill', () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    expect(tool.name).toBe(SKILL_TOOL_NAME)
    expect(SKILL_TOOL_NAME).toBe('skill')
  })

  it('说明里带目录：只有名字与说明', async () => {
    const registry = registryWith([{ name: 'apple', description: '关于苹果的做法', content: '一段很长的正文' }])
    await registry.list()
    const tool = createSkillTool({ registry })

    expect(tool.description).toContain('`apple`')
    expect(tool.description).toContain('关于苹果的做法')
    expect(tool.description).not.toContain('一段很长的正文')
  })

  it('目录变了，说明里的目录跟着变', async () => {
    const registry = registryWith([{ name: 'apple', description: '苹果', content: 'x' }])
    await registry.list()
    const tool = createSkillTool({ registry })

    registry.register({ name: 'pear', title: 'pear', description: '梨', content: 'y', source: 'runtime' })
    await registry.list()

    expect(tool.description).toContain('`pear`')
  })

  it('一个技能都没有时，说明里直说没有', () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    expect(tool.description).toContain('当前没有可用技能')
  })

  it('按名字取回正文', async () => {
    const registry = registryWith([{ name: 'apple', description: '苹果', content: '第一行\n第二行' }])
    const tool = createSkillTool({ registry })

    const result = await tool.execute({ name: 'apple' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('<skill_content name="apple">')
    expect(result.content).toContain('第一行\n第二行')
  })

  it('技能不存在：给出可读的错误，而不是空结果', async () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    const result = await tool.execute({ name: 'missing' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Error:')
    expect(result.content).toContain('没有这个技能')
  })

  it('名字不合法：明确说是名字的问题', async () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    const result = await tool.execute({ name: '不合法的名字' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('名字不合法')
  })

  it('参数不是字符串：当作缺参数', async () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    const missing = await tool.execute({}, ctx)
    const wrongType = await tool.execute({ name: 42 }, ctx)

    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('缺少参数 name')
    expect(wrongType.isError).toBe(true)
    expect(wrongType.content).toContain('缺少参数 name')
  })

  it('工具参数只认 name 一个字段', () => {
    const tool = createSkillTool({ registry: registryWith([]) })

    expect(tool.parameters.required).toEqual(['name'])
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['name'])
  })
})

describe('渲染', () => {
  it('目录为空时是一句话', () => {
    expect(renderSkillCatalog([])).toBe('当前没有可用技能。')
  })

  it('正文裹在 skill_content 里', () => {
    const text = renderSkillContent({
      name: 'apple',
      title: '苹果',
      description: '说明',
      source: 'runtime',
      content: '正文',
    })

    expect(text).toContain('<skill_content name="apple">')
    expect(text).toContain('<skill_instructions>')
    expect(text).toContain('正文')
  })
})
